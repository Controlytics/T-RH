import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    assetTemplate: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    assetTemplateVersion: { findMany: vi.fn(), create: vi.fn() },
  },
}));

vi.mock('../../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import { templateRepository } from '../template.repository.js';

describe('template.repository', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('findMany', () => {
    it('returns paginated templates', async () => {
      mockPrisma.assetTemplate.findMany.mockResolvedValue([{ id: 't1', name: 'Pump' }]);
      mockPrisma.assetTemplate.count.mockResolvedValue(1);
      const result = await templateRepository.findMany({}, 0, 10);
      expect(result.templates).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('findById', () => {
    it('returns template by id', async () => {
      mockPrisma.assetTemplate.findUnique.mockResolvedValue({ id: 't1', name: 'Pump' });
      const result = await templateRepository.findById('t1');
      expect(result?.name).toBe('Pump');
    });

    it('returns null for missing template', async () => {
      mockPrisma.assetTemplate.findUnique.mockResolvedValue(null);
      const result = await templateRepository.findById('missing');
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('creates a new template', async () => {
      mockPrisma.assetTemplate.create.mockResolvedValue({ id: 't1', name: 'Valve' });
      const result = await templateRepository.create({ name: 'Valve', category: 'equipment' });
      expect(result.name).toBe('Valve');
    });
  });

  describe('update', () => {
    it('updates template data', async () => {
      mockPrisma.assetTemplate.update.mockResolvedValue({ id: 't1', name: 'Updated' });
      const result = await templateRepository.update('t1', { name: 'Updated' });
      expect(result.name).toBe('Updated');
    });
  });

  describe('findVersions', () => {
    it('returns template versions', async () => {
      mockPrisma.assetTemplateVersion.findMany.mockResolvedValue([
        { versionNumber: 1 },
        { versionNumber: 2 },
      ]);
      const result = await templateRepository.findVersions('t1');
      expect(result).toHaveLength(2);
    });
  });
});
