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
    terminateSessionsForRole: vi.fn(),
    findCreatableRoles: vi.fn(),
  },
  mockAuditLog: vi.fn(),
}));

vi.mock('../role.repository.js', () => ({ roleRepository: mockRoleRepo }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));
// `prisma` is NOT mocked: the service opens a real `$transaction` (audit
// 2026-10-03, API-7) and hands its client to the mocked repository and the
// mocked auditLog, so the tests can assert the two received the SAME client.

import { roleService } from '../role.service.js';
import { AppError } from '../../../lib/errors.js';

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
      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ROLE_CREATED' }), expect.anything());
      // The row and its audit row went through ONE transaction client (API-7).
      expect(mockRoleRepo.create.mock.calls[0][1]).toBe(mockAuditLog.mock.calls[0][1]);
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

    /**
     * Audit 2026-10-03, API-15. A system role's `hierarchyLevel` / `isActive`
     * used to be dropped silently with `success: true`. A request to CHANGE
     * one is now a 400; echoing the stored value is not a change and still
     * passes, because the Roles page sends `hierarchyLevel` on every save.
     */
    it('system role: echoing the stored hierarchyLevel passes and is dropped from the write', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'ADMIN', isSystem: true, hierarchyLevel: 5, isActive: true, permissions: [] });
      mockRoleRepo.update.mockResolvedValue({ name: 'ADMIN', color: '#000' });

      await roleService.update('ADMIN', { color: '#000', hierarchyLevel: 5 }, ctx);

      const updateCall = mockRoleRepo.update.mock.calls[0];
      expect(updateCall[1]).not.toHaveProperty('hierarchyLevel');
      expect(updateCall[1]).toHaveProperty('color', '#000');
    });

    it('system role: a CHANGED hierarchyLevel is refused loudly, nothing written', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'ADMIN', isSystem: true, hierarchyLevel: 5, isActive: true, permissions: [] });

      await expect(roleService.update('ADMIN', { color: '#000', hierarchyLevel: 10 }, ctx))
        .rejects.toThrow(/hierarchyLevel cannot be changed on the system role/);
      expect(mockRoleRepo.update).not.toHaveBeenCalled();
      expect(mockAuditLog).not.toHaveBeenCalled();
    });

    it('system role: deactivation is refused, not silently ignored', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'ADMIN', isSystem: true, hierarchyLevel: 5, isActive: true, permissions: [] });

      await expect(roleService.update('ADMIN', { isActive: false }, ctx))
        .rejects.toThrow(/isActive cannot be changed on the system role/);
      expect(mockRoleRepo.update).not.toHaveBeenCalled();
    });

    /** Audit 2026-10-03, DATA-11: a permission CHANGE carries the operator's reason. */
    it('a permission change without a reason is refused (REASON_REQUIRED), nothing written', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'CUSTOM', isSystem: false, hierarchyLevel: 2, isActive: true, permissions: ['USER_READ'] });

      await expect(roleService.update('CUSTOM', { permissions: ['USER_READ', 'AUDIT_READ'] }, ctx))
        .rejects.toMatchObject({ code: 'REASON_REQUIRED', statusCode: 400 });
      expect(mockRoleRepo.update).not.toHaveBeenCalled();
    });

    it('a permission change WITH a reason is written and the reason lands on the audit row', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'CUSTOM', isSystem: false, hierarchyLevel: 2, isActive: true, permissions: ['USER_READ'] });
      mockRoleRepo.update.mockResolvedValue({ name: 'CUSTOM', permissions: ['USER_READ', 'AUDIT_READ'] });

      await roleService.update('CUSTOM', { permissions: ['USER_READ', 'AUDIT_READ'], reason: 'QA needs the trail' }, ctx);

      const [entry, tx] = mockAuditLog.mock.calls[0];
      expect(entry.action).toBe('ROLE_UPDATED');
      expect(entry.reason).toBe('QA needs the trail');
      // Same transaction client for the write and the record (API-7).
      expect(mockRoleRepo.update.mock.calls[0][2]).toBe(tx);
    });

    it('an UNCHANGED permission list (the form echoing it back) needs no reason', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'CUSTOM', isSystem: false, hierarchyLevel: 2, isActive: true, permissions: ['AUDIT_READ', 'USER_READ'] });
      mockRoleRepo.update.mockResolvedValue({ name: 'CUSTOM' });

      await roleService.update('CUSTOM', { displayName: 'Renamed', permissions: ['USER_READ', 'AUDIT_READ'] }, ctx);
      expect(mockRoleRepo.update).toHaveBeenCalled();
    });

    /** Audit 2026-10-03, API-15: deactivating a role revokes access now. */
    it('deactivating a custom role ends its users\' sessions in the SAME transaction', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'CUSTOM', isSystem: false, hierarchyLevel: 2, isActive: true, permissions: [] });
      mockRoleRepo.update.mockResolvedValue({ name: 'CUSTOM', isActive: false });
      mockRoleRepo.terminateSessionsForRole.mockResolvedValue({ count: 3, sessionIds: ['s1', 's2', 's3'] });

      await roleService.update('CUSTOM', { isActive: false }, ctx);

      const [name, reason, tx] = mockRoleRepo.terminateSessionsForRole.mock.calls[0];
      expect(name).toBe('CUSTOM');
      expect(reason).toBe('role_deactivated');
      expect(tx).toBe(mockAuditLog.mock.calls[0][1]);
      expect(mockAuditLog.mock.calls[0][0].afterValue).toMatchObject({ sessionsTerminated: 3 });
    });

    it('re-activating, or saving an already-active role, ends no sessions', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'CUSTOM', isSystem: false, hierarchyLevel: 2, isActive: false, permissions: [] });
      mockRoleRepo.update.mockResolvedValue({ name: 'CUSTOM', isActive: true });

      await roleService.update('CUSTOM', { isActive: true }, ctx);
      expect(mockRoleRepo.terminateSessionsForRole).not.toHaveBeenCalled();
    });

    it('throws NotFoundError', async () => {
      mockRoleRepo.findByName.mockResolvedValue(null);
      await expect(roleService.update('MISSING', {}, ctx)).rejects.toThrow('not found');
    });
  });

  describe('delete', () => {
    it('deletes role with no assigned users, audit row in the same transaction', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'OLD_ROLE', displayName: 'Old', hierarchyLevel: 1, permissions: [] });
      mockRoleRepo.delete.mockResolvedValue({});

      const result = await roleService.delete('OLD_ROLE', ctx, 'no longer used');
      expect(result.success).toBe(true);
      expect(mockRoleRepo.delete.mock.calls[0][1]).toBe(mockAuditLog.mock.calls[0][1]);
      expect(mockAuditLog.mock.calls[0][0]).toMatchObject({ action: 'ROLE_DELETED', reason: 'no longer used' });
    });

    // The "has users" count now runs INSIDE the repository's delete, in the
    // delete's own transaction (API-20); the service sees it as the 409 the
    // repository throws, and writes no audit row for a delete that did not happen.
    it('rejects deletion when role has users', async () => {
      mockRoleRepo.findByName.mockResolvedValue({ name: 'BUSY_ROLE' });
      const busy = new AppError(409, 'ROLE_HAS_USERS', 'Cannot delete role with assigned users');
      (busy as any).usersCount = 5;
      mockRoleRepo.delete.mockRejectedValue(busy);

      await expect(roleService.delete('BUSY_ROLE', ctx)).rejects.toThrow('assigned users');
      expect(mockAuditLog).not.toHaveBeenCalled();
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
