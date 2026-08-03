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
  mockPrisma: { role: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() } },
}));

vi.mock('../config.repository.js', () => ({ configRepository: mockConfigRepo }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));
vi.mock('../../../lib/reauth-check.js', () => ({
  getActionReauthConfig: mockGetActionReauthConfig,
  invalidateReauthCache: mockInvalidateReauthCache,
  isReauthRequired: mockIsReauthRequired,
}));
vi.mock('@digilog/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@digilog/shared')>();
  return {
    getDefaultTemplates: mockGetDefaultTemplates,
    FEATURE_TO_PERMISSION_MAP: { 'user-management': ['USER_CREATE', 'USER_READ'] },
    FEATURE_PRIVILEGES: [{ id: 'user-management', label: 'User Management' }],
    SIDEBAR_PRIVILEGE_MAP: [
      { sidebarId: 'users', label: 'Users', icon: '', description: '', privilegeIds: ['user-management'] },
      { sidebarId: 'dashboard', label: 'Dashboard', icon: '', description: '', privilegeIds: [] },
    ],
    // The REAL list, not a fixture. Which actions are always-on is the
    // behaviour under test in getMyActions below; a hardcoded stand-in would
    // keep passing after someone removed the flag from the real catalogue.
    ALWAYS_ON_REAUTH_ACTIONS: actual.ALWAYS_ON_REAUTH_ACTIONS,
  };
});
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

  describe('getRoleConfig', () => {
    it('returns config from DB', async () => {
      mockConfigRepo.findRoleConfig.mockResolvedValue({
        role: 'ADMIN', sidebarItems: ['users'], homeWidgets: [], permissions: { 'user-management': true },
      });

      const result = await configService.getRoleConfig('ADMIN');
      expect(result.role).toBe('ADMIN');
    });

    it('reverse-maps permissions when no feature perms exist', async () => {
      mockConfigRepo.findRoleConfig.mockResolvedValue({
        role: 'ADMIN', sidebarItems: [], homeWidgets: [], permissions: {},
      });
      mockPrisma.role.findUnique.mockResolvedValue({ permissions: ['USER_CREATE', 'USER_READ'] });

      const result = await configService.getRoleConfig('ADMIN');
      expect(result.permissions['user-management']).toBe(true);
    });
  });

  describe('updateRoleConfig — sidebar ↔ permission link', () => {
    it('grants a sidebar item\'s primary permission when the item is enabled (sidebar-only save)', async () => {
      mockConfigRepo.findRoleConfig.mockResolvedValue(null);
      mockConfigRepo.upsertRoleConfig.mockResolvedValue({ role: 'QA', sidebarItems: ['users'], homeWidgets: [], permissions: {} });
      mockPrisma.role.findFirst.mockResolvedValue({ permissions: ['ASSET_READ'] }); // pre-existing unrelated perm

      await configService.updateRoleConfig('QA', { sidebarItems: ['users'] }, ctx as any);

      // role.permissions must now include the primary perms for 'users' (USER_CREATE/USER_READ)
      // while preserving the unrelated ASSET_READ.
      const written = mockPrisma.role.updateMany.mock.calls.at(-1)?.[0].data.permissions as string[];
      expect(written).toEqual(expect.arrayContaining(['ASSET_READ', 'USER_CREATE', 'USER_READ']));
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

    it('includes always-on actions even though they never appear in the config', async () => {
      // Always-on actions are enforced by enforceReauthAlways and are REJECTED
      // as config keys, so building this list from the config alone omitted
      // them — and a client reading /my-actions to decide when to collect a
      // password would skip the challenge on the one action that always needs
      // one.
      mockGetActionReauthConfig.mockResolvedValue({});

      const result = await configService.getMyActions('OPERATOR');
      expect(result.actions).toContain('ACKNOWLEDGE_ALARM');
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
