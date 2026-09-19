import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRoleRepo, mockAuditLog } = vi.hoisted(() => ({
  mockRoleRepo: {
    findAll: vi.fn(),
    findActive: vi.fn(),
    findByName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    countUsersByRole: vi.fn(),
    findCreatableRoles: vi.fn(),
  },
  mockAuditLog: vi.fn(),
}));

vi.mock('../role.repository.js', () => ({ roleRepository: mockRoleRepo }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));

import { roleService } from '../role.service.js';

const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'SUPER_ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' };

describe('roleService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditLog.mockResolvedValue(undefined);
  });

  describe('listAll', () => {
    it('returns all roles', async () => {
      mockRoleRepo.findAll.mockResolvedValue([{ name: 'ADMIN' }, { name: 'VIEWER' }]);
      const result = await roleService.listAll();
      expect(result).toHaveLength(2);
    });
  });

  describe('listActive', () => {
    it('returns active roles', async () => {
      mockRoleRepo.findActive.mockResolvedValue([{ name: 'ADMIN' }]);
      const result = await roleService.listActive();
      expect(result).toHaveLength(1);
    });
  });

  // SUPER_ADMIN must be invisible to every non-SA caller (and anonymous callers,
  // callerRole=undefined) across all role listings; a SUPER_ADMIN caller still sees it.
  describe('SUPER_ADMIN hiding by caller role', () => {
    const withSA = () => [{ name: 'SUPER_ADMIN' }, { name: 'ADMIN' }, { name: 'OPERATOR' }];

    it('listAll hides SUPER_ADMIN from a non-SA caller', async () => {
      mockRoleRepo.findAll.mockResolvedValue(withSA());
      const result = await roleService.listAll('ADMIN');
      expect(result.map((r: any) => r.name)).not.toContain('SUPER_ADMIN');
      expect(result).toHaveLength(2);
    });

    it('listAll hides SUPER_ADMIN from an anonymous caller (undefined role)', async () => {
      mockRoleRepo.findAll.mockResolvedValue(withSA());
      const result = await roleService.listAll(undefined);
      expect(result.map((r: any) => r.name)).not.toContain('SUPER_ADMIN');
    });

    it('listAll keeps SUPER_ADMIN for a SUPER_ADMIN caller', async () => {
      mockRoleRepo.findAll.mockResolvedValue(withSA());
      const result = await roleService.listAll('SUPER_ADMIN');
      expect(result.map((r: any) => r.name)).toContain('SUPER_ADMIN');
      expect(result).toHaveLength(3);
    });

    it('listActive hides SUPER_ADMIN from a non-SA caller but keeps it for SA', async () => {
      mockRoleRepo.findActive.mockResolvedValue(withSA());
      expect((await roleService.listActive('OPERATOR')).map((r: any) => r.name)).not.toContain('SUPER_ADMIN');
      expect((await roleService.listActive('SUPER_ADMIN')).map((r: any) => r.name)).toContain('SUPER_ADMIN');
    });

  });

  describe('getByName', () => {
    it('returns role by name', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'ADMIN', displayName: 'Administrator' });
      const result = await roleService.getByName('ADMIN');
      expect(result.displayName).toBe('Administrator');
    });

    it('throws NotFoundError', async () => {
      mockRoleRepo.findByName.mockResolvedValue(null);
      await expect(roleService.getByName('MISSING')).rejects.toThrow('not found');
    });
  });

  describe('create', () => {
    it('creates a new role', async () => {
      mockRoleRepo.findByName.mockResolvedValue(null);
      mockRoleRepo.create.mockResolvedValue({ name: 'CUSTOM_ROLE', displayName: 'Custom' });

      const result = await roleService.create({
        name: 'CUSTOM_ROLE', displayName: 'Custom', hierarchyLevel: 3, permissions: [], color: '#ff0000',
      }, ctx);

      expect(result.success).toBe(true);
      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ROLE_CREATED' }));
    });

    it('rejects duplicate role name', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'EXISTS' });

      await expect(roleService.create({
        name: 'EXISTS', displayName: 'Dup', hierarchyLevel: 1,
      }, ctx)).rejects.toThrow('already exists');
    });

    it('rejects invalid name format', async () => {
      await expect(roleService.create({
        name: 'lowercase', displayName: 'Bad', hierarchyLevel: 1,
      }, ctx)).rejects.toThrow();
    });
  });

  describe('update', () => {
    it('updates non-system role fully', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'CUSTOM', isSystem: false });
      mockRoleRepo.update.mockResolvedValue({ name: 'CUSTOM', displayName: 'Updated' });

      const result = await roleService.update('CUSTOM', { displayName: 'Updated', hierarchyLevel: 4 }, ctx);
      expect(result.success).toBe(true);
    });

    it('restricts system role updates to allowed fields', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'ADMIN', isSystem: true });
      mockRoleRepo.update.mockResolvedValue({ name: 'ADMIN', color: '#000' });

      await roleService.update('ADMIN', { color: '#000', hierarchyLevel: 10 }, ctx);

      // hierarchyLevel should NOT be in the update call for system roles
      const updateCall = mockRoleRepo.update.mock.calls[0];
      expect(updateCall[1]).not.toHaveProperty('hierarchyLevel');
    });

    it('throws NotFoundError', async () => {
      mockRoleRepo.findByName.mockResolvedValue(null);
      await expect(roleService.update('MISSING', {}, ctx)).rejects.toThrow('not found');
    });
  });

  describe('delete', () => {
    it('deletes role with no assigned users', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'OLD_ROLE', displayName: 'Old', hierarchyLevel: 1, permissions: [] });
      mockRoleRepo.countUsersByRole.mockResolvedValue(0);
      mockRoleRepo.delete.mockResolvedValue({});

      const result = await roleService.delete('OLD_ROLE', ctx);
      expect(result.success).toBe(true);
    });

    it('rejects deletion when role has users', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'BUSY_ROLE' });
      mockRoleRepo.countUsersByRole.mockResolvedValue(5);

      await expect(roleService.delete('BUSY_ROLE', ctx)).rejects.toThrow('assigned users');
    });

    it('throws NotFoundError', async () => {
      mockRoleRepo.findByName.mockResolvedValue(null);
      await expect(roleService.delete('NOPE', ctx)).rejects.toThrow('not found');
    });
  });

  // A non-SUPER_ADMIN ROLE_MANAGE holder must not be able to escalate privilege
  // via role create/update (grant unheld perms, raise hierarchy, edit own/higher role).
  describe('privilege boundary (role escalation)', () => {
    const adminCtx = { ...ctx, userRole: 'ADMIN' };
    // caller ADMIN holds a modest permission set at hierarchyLevel 5.
    const ADMIN_ROLE = { name: 'ADMIN', hierarchyLevel: 5, isSystem: true, permissions: ['USER_READ', 'USER_CREATE', 'ROLE_MANAGE'] };
    const byName: Record<string, any> = {
      ADMIN: ADMIN_ROLE,
      SUPER_ADMIN: { name: 'SUPER_ADMIN', hierarchyLevel: 6, isSystem: true, permissions: ['AUDIT_DELETE'] },
      VIEWER: { name: 'VIEWER', hierarchyLevel: 1, isSystem: true, permissions: ['USER_READ', 'AUDIT_READ'] },
    };

    it('ADMIN cannot self-grant a permission its own role does not hold', async () => {
      mockRoleRepo.findByName.mockImplementation((n: string) => Promise.resolve(byName[n] ?? null));
      // Editing its own ADMIN role is blocked first (own role), so target a lower role
      // and try to grant AUDIT_DELETE which ADMIN does not hold.
      await expect(roleService.update('VIEWER', { permissions: ['USER_READ', 'AUDIT_DELETE'] }, adminCtx))
        .rejects.toThrow(/cannot grant permissions/i);
      expect(mockRoleRepo.update).not.toHaveBeenCalled();
    });

    it('ADMIN cannot modify its own role', async () => {
      mockRoleRepo.findByName.mockImplementation((n: string) => Promise.resolve(byName[n] ?? null));
      await expect(roleService.update('ADMIN', { color: '#123456' }, adminCtx))
        .rejects.toThrow(/your own role/i);
      expect(mockRoleRepo.update).not.toHaveBeenCalled();
    });

    it('ADMIN cannot modify a role at or above its hierarchy level', async () => {
      mockRoleRepo.findByName.mockImplementation((n: string) => Promise.resolve(byName[n] ?? null));
      await expect(roleService.update('SUPER_ADMIN', { permissions: ['USER_READ'] }, adminCtx))
        .rejects.toThrow(/at or above your own hierarchy level/i);
      expect(mockRoleRepo.update).not.toHaveBeenCalled();
    });

    it('ADMIN cannot create a role at or above its hierarchy level', async () => {
      mockRoleRepo.findByName.mockImplementation((n: string) => Promise.resolve(n === 'NEW_ROLE' ? null : byName[n] ?? null));
      await expect(roleService.create({ name: 'NEW_ROLE', displayName: 'New', hierarchyLevel: 5, permissions: ['USER_READ'] }, adminCtx))
        .rejects.toThrow(/at or above your own/i);
      expect(mockRoleRepo.create).not.toHaveBeenCalled();
    });

    it('ADMIN CAN edit a lower role, keeping its grandfathered permissions', async () => {
      mockRoleRepo.findByName.mockImplementation((n: string) => Promise.resolve(byName[n] ?? null));
      mockRoleRepo.update.mockResolvedValue({ name: 'VIEWER', color: '#abcabc' });
      // AUDIT_READ is already on VIEWER (grandfathered) and ADMIN lacks it — must NOT block a color edit.
      await roleService.update('VIEWER', { color: '#abcabc', permissions: ['USER_READ', 'AUDIT_READ'] }, adminCtx);
      expect(mockRoleRepo.update).toHaveBeenCalled();
    });
  });

  describe('getAllPermissions', () => {
    it('returns permissions list', async () => {
      const result = await roleService.getAllPermissions();
      expect(result.permissions).toBeInstanceOf(Array);
      expect(result.permissions.length).toBeGreaterThan(0);
      expect(result.permissions[0]).toHaveProperty('key');
      expect(result.permissions[0]).toHaveProperty('category');
    });
  });

  describe('getCreatableRoles', () => {
    it('returns roles at or below hierarchy level', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'ADMIN', hierarchyLevel: 5 });
      mockRoleRepo.findCreatableRoles.mockResolvedValue([{ name: 'OPERATOR' }, { name: 'VIEWER' }]);

      const result = await roleService.getCreatableRoles('ADMIN');
      expect(result).toHaveLength(2);
      // findCreatableRoles takes (hierarchyLevel, includeSuperAdmin). The
      // service passes false for ADMIN; only SUPER_ADMIN gets true.
      expect(mockRoleRepo.findCreatableRoles).toHaveBeenCalledWith(5, false);
    });

    it('throws NotFoundError for unknown role', async () => {
      mockRoleRepo.findByName.mockResolvedValue(null);
      await expect(roleService.getCreatableRoles('MISSING')).rejects.toThrow('not found');
    });
  });
});
