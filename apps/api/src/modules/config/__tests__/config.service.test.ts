import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockConfigRepo,
  mockAuditLog,
  mockGetActionReauthConfig,
  mockInvalidateReauthCache,
  mockIsReauthRequired,
  mockGetDefaultTemplates,
  mockValidateUserId,
  mockPrisma,
} = vi.hoisted(() => ({
  mockConfigRepo: {
    getSystemConfig: vi.fn(),
    upsertSystemConfig: vi.fn(),
    findAllRoleConfigs: vi.fn(),
    findRoleConfig: vi.fn(),
    upsertRoleConfig: vi.fn(),
    findUserConfig: vi.fn(),
    upsertUserConfig: vi.fn(),
    findUserByUsername: vi.fn(),
    findUserById: vi.fn(),
    findAllFieldIds: vi.fn(),
    findFieldId: vi.fn(),
    updateFieldId: vi.fn(),
    getMaxUserIdNum: vi.fn(),
    getMaxUserIdNumAll: vi.fn(),
  },
  mockAuditLog: vi.fn(),
  mockGetActionReauthConfig: vi.fn(),
  mockInvalidateReauthCache: vi.fn(),
  mockIsReauthRequired: vi.fn(),
  mockGetDefaultTemplates: vi.fn(),
  mockValidateUserId: vi.fn(),
  mockPrisma: { role: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() }, $transaction: vi.fn() },
}));

vi.mock('../config.repository.js', () => ({ configRepository: mockConfigRepo }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));
vi.mock('../../../lib/reauth-check.js', () => ({
  getActionReauthConfig: mockGetActionReauthConfig,
  invalidateReauthCache: mockInvalidateReauthCache,
  isReauthRequired: mockIsReauthRequired,
}));
vi.mock('@digilog/shared', async (importOriginal) => ({
  // The REAL reverse map over the REAL tree: getRoleConfig's answer is what
  // the Permissions tab shows, so a stand-in here would test nothing.
  privilegeTogglesFromPermissions: (await importOriginal<typeof import('@digilog/shared')>()).privilegeTogglesFromPermissions,
  getDefaultTemplates: mockGetDefaultTemplates,
  // role.service.ts (imported for assertRoleWithinCallerPrivilege since the
  // 2026-10-03 API-1 fix) builds its permission catalogue from this at import
  // time; without it the whole file failed to load.
  PERMISSIONS: {},
  FEATURE_TO_PERMISSION_MAP: { 'user-management': ['USER_CREATE', 'USER_READ'] },
  FEATURE_PRIVILEGES: [{ id: 'user-management', label: 'User Management' }],
  SIDEBAR_PRIVILEGE_MAP: [
    { sidebarId: 'users', label: 'Users', icon: '', description: '', privilegeIds: ['user-management'] },
    { sidebarId: 'dashboard', label: 'Dashboard', icon: '', description: '', privilegeIds: [] },
  ],
}));
vi.mock('../../../lib/user-id-validator.js', () => ({ validateUserId: mockValidateUserId }));
vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import { configService } from '../config.service.js';

const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'SUPER_ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' };

describe('configService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditLog.mockResolvedValue(undefined);
  });

  describe('getConfig', () => {
    it('returns parsed config from DB', async () => {
      mockConfigRepo.getSystemConfig.mockResolvedValue({ configValue: { minLength: 8 } });
      const schema = { safeParse: (d: any) => ({ success: true, data: d }) };

      const result = await configService.getConfig('password-policy', schema);
      expect(result.minLength).toBe(8);
    });

    it('returns empty object when no config exists', async () => {
      mockConfigRepo.getSystemConfig.mockResolvedValue(null);
      const schema = { safeParse: () => ({ success: true, data: {} }) };

      const result = await configService.getConfig('password-policy', schema);
      expect(result).toEqual({});
    });

    it('#low-batch: on a parse failure, re-derives SCHEMA DEFAULTS (fail-safe), not {}', async () => {
      // A corrupt stored value must NOT collapse password-policy to {} (which would
      // leave minLength/requireUppercase undefined → rules silently disabled).
      mockConfigRepo.getSystemConfig.mockResolvedValue({ configValue: { minLength: 'BROKEN' } });
      const DEFAULTS = { minLength: 8, requireUppercase: true };
      const schema = {
        // stored value fails; a bare {} parse yields the schema's .default()s
        safeParse: (d: any) =>
          d && d.minLength === 'BROKEN'
            ? { success: false }
            : { success: true, data: DEFAULTS },
      };

      const result = await configService.getConfig('password-policy', schema);
      expect(result).toEqual(DEFAULTS); // NOT {}
    });

    it('#low-batch: falls back to {} only if the schema itself cannot produce defaults', async () => {
      mockConfigRepo.getSystemConfig.mockResolvedValue({ configValue: { x: 1 } });
      const schema = { safeParse: () => ({ success: false }) }; // never succeeds
      const result = await configService.getConfig('some-key', schema);
      expect(result).toEqual({});
    });
  });

  describe('updateConfig', () => {
    it('upserts and audits config change', async () => {
      mockConfigRepo.getSystemConfig.mockResolvedValue({ configValue: { old: true } });
      mockConfigRepo.upsertSystemConfig.mockResolvedValue({});
      const schema = { safeParse: (d: any) => ({ success: true, data: d }) };

      const result = await configService.updateConfig('session', { timeout: 15 }, schema, 'security', true, ctx);
      expect(result.timeout).toBe(15);
      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'CONFIG_CHANGED' }));
    });

    it('throws ValidationError on invalid data', async () => {
      const schema = { safeParse: () => ({ success: false, error: { flatten: () => ({}) } }) };

      await expect(configService.updateConfig('bad', {}, schema, 'x', false, ctx))
        .rejects.toThrow();
    });
  });

  // 2026-10-24: the toggles are what the role HOLDS, by the node's gate —
  // never "any of its grant set" (which includes the READ dependency), and
  // never the stored map, which other writers leave stale.
  describe('getRoleConfig', () => {
    it('returns the stored sidebar and home widgets', async () => {
      mockConfigRepo.findRoleConfig.mockResolvedValue({
        role: 'ADMIN', sidebarItems: ['users'], homeWidgets: ['w'], permissions: {},
      });
      mockPrisma.role.findUnique.mockResolvedValue({ permissions: [] });

      const result = await configService.getRoleConfig('ADMIN');
      expect(result).toMatchObject({ role: 'ADMIN', sidebarItems: ['users'], homeWidgets: ['w'] });
    });

    it('a role holding only INSTRUMENT_READ shows View ON and Create / Edit / Delete OFF', async () => {
      mockConfigRepo.findRoleConfig.mockResolvedValue(null);
      mockPrisma.role.findUnique.mockResolvedValue({ permissions: ['INSTRUMENT_READ', 'AUDIT_READ'] });

      const { permissions } = await configService.getRoleConfig('OPERATOR');
      expect(permissions['instruments.view']).toBe(true);
      expect(permissions['instruments.create']).toBe(false);
      expect(permissions['instruments.delete']).toBe(false);
      expect(permissions['audit.delete']).toBe(false);
    });

    it('ignores a stored toggle the role does not hold — and shows one it does', async () => {
      mockConfigRepo.findRoleConfig.mockResolvedValue({
        role: 'OPERATOR', sidebarItems: [], homeWidgets: [],
        permissions: { 'instruments.create': true, 'functional_locations.create': false },
      });
      mockPrisma.role.findUnique.mockResolvedValue({ permissions: ['FUNCTIONAL_LOCATION_CREATE', 'FUNCTIONAL_LOCATION_READ'] });

      const { permissions } = await configService.getRoleConfig('OPERATOR');
      expect(permissions['instruments.create']).toBe(false);
      expect(permissions['functional_locations.create']).toBe(true);
    });
  });

  describe('updateRoleConfig — sidebar ↔ permission link', () => {
    // The role must EXIST (audit 2026-10-03, API-20): a name with no role row
    // is a 404, not a fresh orphan `role_configs` row.
    beforeEach(() => {
      mockPrisma.role.findUnique.mockResolvedValue({ name: 'QA' });
      // The save runs config row + role permissions + audit row in one transaction.
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockPrisma));
    });

    it('404s for a role that does not exist and writes nothing', async () => {
      mockPrisma.role.findUnique.mockResolvedValue(null);
      await expect(configService.updateRoleConfig('GHOST', { sidebarItems: ['users'] }, ctx as any))
        .rejects.toThrow('Role not found');
      expect(mockConfigRepo.upsertRoleConfig).not.toHaveBeenCalled();
      expect(mockAuditLog).not.toHaveBeenCalled();
    });

    it('grants a sidebar item\'s primary permission when the item is enabled (sidebar-only save)', async () => {
      mockConfigRepo.findRoleConfig.mockResolvedValue(null);
      mockConfigRepo.upsertRoleConfig.mockResolvedValue({ role: 'QA', sidebarItems: ['users'], homeWidgets: [], permissions: {} });
      mockPrisma.role.findFirst.mockResolvedValue({ permissions: ['AUDIT_READ'] }); // pre-existing unrelated perm

      await configService.updateRoleConfig('QA', { sidebarItems: ['users'] }, ctx as any);

      // role.permissions must now include the primary perms for 'users' (USER_CREATE/USER_READ)
      // while preserving the unrelated AUDIT_READ.
      const written = mockPrisma.role.updateMany.mock.calls.at(-1)?.[0].data.permissions as string[];
      expect(written).toEqual(expect.arrayContaining(['AUDIT_READ', 'USER_CREATE', 'USER_READ']));
    });

    it('sidebar-only save is additive — never drops existing permissions', async () => {
      mockConfigRepo.findRoleConfig.mockResolvedValue({ role: 'QA', sidebarItems: [], homeWidgets: [], permissions: {} });
      mockConfigRepo.upsertRoleConfig.mockResolvedValue({ role: 'QA', sidebarItems: [], homeWidgets: [], permissions: {} });
      mockPrisma.role.findFirst.mockResolvedValue({ permissions: ['USER_READ', 'CONFIG_READ'] });

      // Disabling all sidebar items (empty list) must not strip the role's perms.
      await configService.updateRoleConfig('QA', { sidebarItems: [] }, ctx as any);

      const written = mockPrisma.role.updateMany.mock.calls.at(-1)?.[0].data.permissions as string[];
      expect(written).toEqual(expect.arrayContaining(['USER_READ', 'CONFIG_READ']));
    });

    // Application review 2026-10-12, finding 10: the config row, the role's
    // permission array and the audit row are written on ONE transaction
    // client. A distinct sentinel proves it — the default mock hands back
    // `mockPrisma` itself, which would make the global client look the same.
    it('writes the config row, the permissions and the audit row on the transaction client', async () => {
      const tx = { role: { updateMany: vi.fn() }, roleConfig: {} };
      mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
      mockConfigRepo.findRoleConfig.mockResolvedValue(null);
      mockConfigRepo.upsertRoleConfig.mockResolvedValue({ role: 'QA', sidebarItems: ['users'], homeWidgets: [], permissions: {} });
      mockPrisma.role.findFirst.mockResolvedValue({ permissions: [] });

      await configService.updateRoleConfig('QA', { sidebarItems: ['users'] }, ctx as any);

      expect(mockConfigRepo.upsertRoleConfig.mock.calls[0][4]).toBe(tx);
      expect(tx.role.updateMany).toHaveBeenCalled();
      expect(mockPrisma.role.updateMany).not.toHaveBeenCalled();
      expect(mockAuditLog.mock.calls[0][1]).toBe(tx);
    });
  });

  describe('getUserConfig', () => {
    it('returns user config', async () => {
      mockConfigRepo.findUserConfig.mockResolvedValue({ userId: 'u1', sidebarItems: ['a'], homeWidgets: [], permissions: {} });
      const result = await configService.getUserConfig('u1');
      expect(result.sidebarItems).toEqual(['a']);
    });

    it('returns defaults when no config', async () => {
      mockConfigRepo.findUserConfig.mockResolvedValue(null);
      const result = await configService.getUserConfig('u1');
      expect(result.sidebarItems).toEqual([]);
    });
  });

  describe('getMyConfig', () => {
    it('returns user config if present', async () => {
      mockConfigRepo.findUserByUsername.mockResolvedValue({ id: 'u1', role: 'ADMIN' });
      mockConfigRepo.findUserConfig.mockResolvedValue({ sidebarItems: ['x'], homeWidgets: [], permissions: {} });

      const result = await configService.getMyConfig('admin');
      expect(result.sidebarItems).toEqual(['x']);
    });

    it('falls back to role config', async () => {
      mockConfigRepo.findUserByUsername.mockResolvedValue({ id: 'u1', role: 'ADMIN' });
      mockConfigRepo.findUserConfig.mockResolvedValue({ sidebarItems: [], homeWidgets: [], permissions: {} });
      mockConfigRepo.findRoleConfig.mockResolvedValue({ sidebarItems: ['role-item'], homeWidgets: [], permissions: {} });

      const result = await configService.getMyConfig('admin');
      expect(result.sidebarItems).toEqual(['role-item']);
    });
  });

  describe('updateFieldId', () => {
    it('updates field display name', async () => {
      mockConfigRepo.findFieldId.mockResolvedValue({ fieldId: 'username', displayName: 'User ID' });
      mockConfigRepo.updateFieldId.mockResolvedValue({});

      await configService.updateFieldId('username', 'Employee ID', ctx);
      expect(mockConfigRepo.updateFieldId).toHaveBeenCalledWith('username', 'Employee ID', 'admin');
    });

    it('throws for empty display name', async () => {
      await expect(configService.updateFieldId('f', '', ctx)).rejects.toThrow('required');
    });

    it('throws NotFoundError for unknown field', async () => {
      mockConfigRepo.findFieldId.mockResolvedValue(null);
      await expect(configService.updateFieldId('bad', 'X', ctx)).rejects.toThrow('not found');
    });
  });

  describe('checkReauth', () => {
    it('returns required:true when configured', async () => {
      mockIsReauthRequired.mockResolvedValue(true);
      const result = await configService.checkReauth('DELETE_USER', 'ADMIN');
      expect(result.required).toBe(true);
    });
  });

  describe('getMyActions', () => {
    it('returns actions requiring reauth for role', async () => {
      mockGetActionReauthConfig.mockResolvedValue({ DELETE_USER: ['ADMIN'], CREATE_USER: ['ADMIN', 'SUPER_ADMIN'] });

      const result = await configService.getMyActions('ADMIN');
      expect(result.actions).toContain('DELETE_USER');
      expect(result.actions).toContain('CREATE_USER');
    });
  });

  describe('validateUserId', () => {
    it('returns valid result', async () => {
      mockValidateUserId.mockResolvedValue({ valid: true, errors: [] });
      const result = await configService.validateUserId('EMP001');
      expect(result.valid).toBe(true);
    });

    it('throws for empty user ID', async () => {
      await expect(configService.validateUserId('')).rejects.toThrow('required');
    });
  });
});
