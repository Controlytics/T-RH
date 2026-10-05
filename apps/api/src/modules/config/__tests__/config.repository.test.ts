import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    systemConfig: { findUnique: vi.fn(), upsert: vi.fn() },
    roleConfig: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    userConfig: { findUnique: vi.fn(), upsert: vi.fn() },
    fieldIdConfig: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import { configRepository, escapeLikeLiteral } from '../config.repository.js';

describe('config.repository', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getSystemConfig', () => {
    it('returns config by key', async () => {
      mockPrisma.systemConfig.findUnique.mockResolvedValue({
        configKey: 'password-policy',
        configValue: { minLength: 8 },
      });
      const result = await configRepository.getSystemConfig('password-policy');
      expect(result?.configKey).toBe('password-policy');
    });

    it('returns null for missing config', async () => {
      mockPrisma.systemConfig.findUnique.mockResolvedValue(null);
      const result = await configRepository.getSystemConfig('missing');
      expect(result).toBeNull();
    });
  });

  describe('upsertSystemConfig', () => {
    it('upserts config value', async () => {
      mockPrisma.systemConfig.upsert.mockResolvedValue({
        configKey: 'session',
        configValue: { sessionDuration: 12 },
      });
      const result = await configRepository.upsertSystemConfig('session', { sessionDuration: 12 }, 'security', false, 'admin');
      expect(result.configKey).toBe('session');
    });
  });

  describe('findAllRoleConfigs', () => {
    it('returns all role configs', async () => {
      mockPrisma.roleConfig.findMany.mockResolvedValue([{ role: 'ADMIN' }]);
      const result = await configRepository.findAllRoleConfigs();
      expect(result).toHaveLength(1);
    });
  });

  describe('findRoleConfig', () => {
    it('returns config for specific role', async () => {
      mockPrisma.roleConfig.findUnique.mockResolvedValue({ role: 'ADMIN', sidebarItems: [] });
      const result = await configRepository.findRoleConfig('ADMIN');
      expect(result?.role).toBe('ADMIN');
    });
  });

  describe('findAllFieldIds', () => {
    it('returns all field id configs', async () => {
      mockPrisma.fieldIdConfig.findMany.mockResolvedValue([
        { fieldId: 'username', displayName: 'User ID' },
      ]);
      const result = await configRepository.findAllFieldIds();
      expect(result).toHaveLength(1);
    });
  });

  describe('findFieldId', () => {
    it('returns specific field id config', async () => {
      mockPrisma.fieldIdConfig.findUnique.mockResolvedValue({ fieldId: 'email', displayName: 'Email' });
      const result = await configRepository.findFieldId('email');
      expect(result?.fieldId).toBe('email');
    });
  });

  describe('updateFieldId', () => {
    it('updates field display name', async () => {
      mockPrisma.fieldIdConfig.update.mockResolvedValue({ fieldId: 'email', displayName: 'E-mail Address' });
      const result = await configRepository.updateFieldId('email', 'E-mail Address', 'admin');
      expect(result.displayName).toBe('E-mail Address');
    });
  });

  describe('getMaxUserIdNum', () => {
    it('returns max user id number for prefix', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([{ max_num: 42 }]);
      const result = await configRepository.getMaxUserIdNum('USR');
      expect(result[0].max_num).toBe(42);
    });

    // Audit 2026-10-03, API-20: `_` is a LIKE wildcard, so a prefix of `EMP_`
    // matched `EMPX0007` and the next id jumped. The prefix is a literal.
    it('escapes LIKE metacharacters in the prefix and declares the escape character', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([{ max_num: null }]);
      await configRepository.getMaxUserIdNum('EMP_');
      const [sql, param] = mockPrisma.$queryRawUnsafe.mock.calls[0];
      expect(param).toBe('EMP\\_%');
      expect(sql).toMatch(/LIKE \$1 ESCAPE '\\'/);
    });

    it('escapeLikeLiteral escapes backslash, percent and underscore', () => {
      expect(escapeLikeLiteral('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
      expect(escapeLikeLiteral('EMP')).toBe('EMP');
    });
  });
});
