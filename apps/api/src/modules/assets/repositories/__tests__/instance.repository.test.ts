import { describe, it, expect, beforeEach, vi } from 'vitest';

// Tier 1.5 (2026-05-29): mocks widened to cover the typed-asset-dispatch
// helper. Helper internally:
//   - calls prisma.assetTemplate.findUnique (kindFromTemplateId)
//   - calls prisma.assetInstance.findUnique with { include: { template } } (kindFromInstanceId)
//   - calls prisma.assetInstance.findMany with template-include (bulk kind resolve in softDeleteMany)
//   - wraps writes in prisma.$transaction(cb) — cb receives a tx with block/area/ahu/filter + assetInstance delegates
const { mockPrisma } = vi.hoisted(() => {
  const writeDelegate = () => ({ create: vi.fn(), update: vi.fn(), updateMany: vi.fn() });
  return {
    mockPrisma: {
      assetInstance: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
      assetTemplate: { findUnique: vi.fn() },
      block: writeDelegate(),
      area: writeDelegate(),
      ahu: writeDelegate(),
      filter: writeDelegate(),
      // $transaction passes the same mockPrisma through as the tx client so
      // typedDelegate(tx, kind) inside the helper resolves to our stubbed
      // block/area/ahu/filter mocks above.
      $transaction: vi.fn(async (cb: any) => cb(mockPrisma)),
    },
  };
});

vi.mock('../../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import { instanceRepository } from '../instance.repository.js';
import { _clearKindCache } from '../../../../lib/typed-asset-dispatch.js';

describe('instance.repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Tier 1.5: the dispatch helper caches templateId → kind in a per-process
    // Map. Clear it between tests so each test can stub a fresh kind.
    _clearKindCache();
  });

  describe('findMany', () => {
    it('returns paginated instances', async () => {
      mockPrisma.assetInstance.findMany.mockResolvedValue([{ id: 'i1', name: 'Pump-1' }]);
      mockPrisma.assetInstance.count.mockResolvedValue(1);
      const result = await instanceRepository.findMany({}, 0, 10);
      expect(result.instances).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('findById', () => {
    it('returns instance with template', async () => {
      mockPrisma.assetInstance.findUnique.mockResolvedValue({
        id: 'i1', name: 'Pump-1',
        template: { id: 't1', name: 'Pump' },
      });
      const result = await instanceRepository.findById('i1');
      expect(result?.name).toBe('Pump-1');
    });
  });

  describe('findByIdSimple', () => {
    it('returns instance without joins', async () => {
      mockPrisma.assetInstance.findUnique.mockResolvedValue({ id: 'i1', name: 'Pump-1' });
      const result = await instanceRepository.findByIdSimple('i1');
      expect(result?.id).toBe('i1');
    });
  });

  describe('create', () => {
    it('creates a new instance (BLOCK kind → dual-writes blocks + asset_instances)', async () => {
      mockPrisma.assetTemplate.findUnique.mockResolvedValue({ templateKind: 'BLOCK' });
      mockPrisma.block.create.mockResolvedValue({ id: 'i2', name: 'Valve-1' });
      mockPrisma.assetInstance.create.mockResolvedValue({ id: 'i2', name: 'Valve-1' });
      const result = await instanceRepository.create({
        name: 'Valve-1', templateId: 't1', status: 'ACTIVE',
      });
      expect(result.name).toBe('Valve-1');
      // Dispatch helper writes both sides.
      expect(mockPrisma.block.create).toHaveBeenCalled();
      expect(mockPrisma.assetInstance.create).toHaveBeenCalled();
    });

    it('creates an OTHER-kind instance (asset_instances only — D1=C)', async () => {
      mockPrisma.assetTemplate.findUnique.mockResolvedValue({ templateKind: 'OTHER' });
      mockPrisma.assetInstance.create.mockResolvedValue({ id: 'i3', name: 'Misc-1' });
      const result = await instanceRepository.create({
        name: 'Misc-1', templateId: 'tOther', status: 'ACTIVE',
      });
      expect(result.name).toBe('Misc-1');
      // OTHER must NOT touch any typed table.
      expect(mockPrisma.block.create).not.toHaveBeenCalled();
      expect(mockPrisma.area.create).not.toHaveBeenCalled();
      expect(mockPrisma.ahu.create).not.toHaveBeenCalled();
      expect(mockPrisma.filter.create).not.toHaveBeenCalled();
      expect(mockPrisma.assetInstance.create).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('updates instance data (dual-writes typed + asset_instances)', async () => {
      mockPrisma.assetInstance.findUnique.mockResolvedValue({ template: { templateKind: 'BLOCK' } });
      mockPrisma.block.update.mockResolvedValue({ id: 'i1', status: 'MAINTENANCE' });
      mockPrisma.assetInstance.update.mockResolvedValue({ id: 'i1', status: 'MAINTENANCE' });
      const result = await instanceRepository.update('i1', { status: 'MAINTENANCE' });
      expect(result.status).toBe('MAINTENANCE');
      expect(mockPrisma.block.update).toHaveBeenCalled();
      expect(mockPrisma.assetInstance.update).toHaveBeenCalled();
    });
  });

  describe('softDeleteMany', () => {
    it('soft-deletes multiple instances grouped by kind', async () => {
      mockPrisma.assetInstance.findMany.mockResolvedValue([
        { id: 'i1', template: { templateKind: 'BLOCK' } },
        { id: 'i2', template: { templateKind: 'BLOCK' } },
        { id: 'i3', template: { templateKind: 'OTHER' } },
      ]);
      mockPrisma.block.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.assetInstance.updateMany.mockResolvedValue({ count: 3 });
      const result = await instanceRepository.softDeleteMany(['i1', 'i2', 'i3'], 'admin');
      expect(result.count).toBe(3);
      // Two BLOCK ids → block.updateMany called once with both; OTHER stays
      // on asset_instances; final asset_instances.updateMany covers all 3.
      expect(mockPrisma.block.updateMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.assetInstance.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('findChildren', () => {
    it('returns child instances', async () => {
      mockPrisma.assetInstance.findMany.mockResolvedValue([
        { id: 'c1', parentId: 'i1' },
        { id: 'c2', parentId: 'i1' },
      ]);
      const result = await instanceRepository.findChildren('i1');
      expect(result).toHaveLength(2);
    });
  });
});
