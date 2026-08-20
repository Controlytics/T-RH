import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    role: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    user: { count: vi.fn() },
  },
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import { roleRepository } from '../role.repository.js';

describe('role.repository', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('findAll', () => {
    it('returns all roles ordered by hierarchy', async () => {
      mockPrisma.role.findMany.mockResolvedValue([
        { name: 'SUPER_ADMIN', hierarchyLevel: 6 },
        { name: 'VIEWER', hierarchyLevel: 1 },
      ]);
      const result = await roleRepository.findAll();
      expect(result).toHaveLength(2);
    });
  });

  describe('findActive', () => {
    it('returns only active roles', async () => {
      mockPrisma.role.findMany.mockResolvedValue([{ name: 'ADMIN', isActive: true }]);
      const result = await roleRepository.findActive();
      expect(result).toHaveLength(1);
    });
  });

  describe('findByName', () => {
    it('returns role by name', async () => {
      mockPrisma.role.findUnique.mockResolvedValue({ name: 'ADMIN' });
      const result = await roleRepository.findByName('ADMIN');
      expect(result?.name).toBe('ADMIN');
    });
  });

  describe('create', () => {
    it('creates a new role', async () => {
      mockPrisma.role.create.mockResolvedValue({ name: 'INSPECTOR', hierarchyLevel: 3 });
      const result = await roleRepository.create({
        name: 'INSPECTOR', displayName: 'Inspector', hierarchyLevel: 3,
        permissions: ['INSTRUMENT_READ'], color: '#FF0000', createdBy: 'admin',
      });
      expect(result.name).toBe('INSPECTOR');
    });
  });

  describe('update', () => {
    it('updates role data', async () => {
      mockPrisma.role.update.mockResolvedValue({ name: 'ADMIN', displayName: 'Updated Admin' });
      const result = await roleRepository.update('ADMIN', { displayName: 'Updated Admin' });
      expect(result.displayName).toBe('Updated Admin');
    });
  });

  describe('countUsersByRole', () => {
    it('returns count of users with given role', async () => {
      mockPrisma.user.count.mockResolvedValue(5);
      const result = await roleRepository.countUsersByRole('ADMIN');
      expect(result).toBe(5);
    });
  });

  describe('findCreatableRoles', () => {
    it('returns roles at or below given hierarchy level', async () => {
      mockPrisma.role.findMany.mockResolvedValue([
        { name: 'OPERATOR', hierarchyLevel: 2 },
        { name: 'VIEWER', hierarchyLevel: 1 },
      ]);
      const result = await roleRepository.findCreatableRoles(3);
      expect(result).toHaveLength(2);
    });
  });
});
