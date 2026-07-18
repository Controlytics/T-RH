import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    assetRelationship: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    assetInstance: { update: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import { relationshipRepository } from '../relationship.repository.js';

describe('relationship.repository', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('findMany', () => {
    it('returns relationships with included assets', async () => {
      mockPrisma.assetRelationship.findMany.mockResolvedValue([
        { id: 'r1', sourceAsset: { id: 'a1', name: 'Pump' }, targetAsset: { id: 'a2', name: 'Valve' } },
      ]);
      const result = await relationshipRepository.findMany({ sourceAssetId: 'a1' });
      expect(result).toHaveLength(1);
      expect(result[0].sourceAsset.name).toBe('Pump');
    });
  });

  describe('findById', () => {
    it('returns relationship by id', async () => {
      mockPrisma.assetRelationship.findUnique.mockResolvedValue({ id: 'r1', relationshipType: 'CONTAINS' });
      const result = await relationshipRepository.findById('r1');
      expect(result?.id).toBe('r1');
    });
  });

  describe('findByCompositeKey', () => {
    it('finds by source, target, and type composite', async () => {
      mockPrisma.assetRelationship.findUnique.mockResolvedValue({ id: 'r1' });
      const result = await relationshipRepository.findByCompositeKey('a1', 'a2', 'CONTAINS');
      expect(result?.id).toBe('r1');
      expect(mockPrisma.assetRelationship.findUnique).toHaveBeenCalledWith({
        where: {
          sourceAssetId_targetAssetId_relationshipType: {
            sourceAssetId: 'a1', targetAssetId: 'a2', relationshipType: 'CONTAINS',
          },
        },
      });
    });
  });

  describe('findInverse', () => {
    it('finds inverse relationship', async () => {
      mockPrisma.assetRelationship.findFirst.mockResolvedValue({ id: 'r2', relationshipType: 'CONTAINED_IN' });
      const result = await relationshipRepository.findInverse('a2', 'a1', 'CONTAINED_IN');
      expect(result?.relationshipType).toBe('CONTAINED_IN');
    });
  });

  describe('createPairWithParent', () => {
    it('creates relationship pair in transaction', async () => {
      mockPrisma.$transaction.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
      const result = await relationshipRepository.createPairWithParent(
        { sourceAssetId: 'a1', targetAssetId: 'a2', relationshipType: 'CONTAINS' },
        { sourceAssetId: 'a2', targetAssetId: 'a1', relationshipType: 'CONTAINED_IN' },
      );
      expect(result).toHaveLength(2);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('includes parent update when setParentId is provided', async () => {
      mockPrisma.$transaction.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }, { id: 'a2' }]);
      const result = await relationshipRepository.createPairWithParent(
        { sourceAssetId: 'a1', targetAssetId: 'a2', relationshipType: 'CONTAINS' },
        { sourceAssetId: 'a2', targetAssetId: 'a1', relationshipType: 'CONTAINED_IN' },
        { childId: 'a2', parentId: 'a1' },
      );
      expect(result).toHaveLength(3);
    });
  });

  describe('deletePairWithParent', () => {
    it('deletes relationship and inverse in transaction', async () => {
      mockPrisma.$transaction.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
      const result = await relationshipRepository.deletePairWithParent('r1', 'r2');
      expect(result).toHaveLength(2);
    });

    it('clears parentId when clearParent provided', async () => {
      mockPrisma.$transaction.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }, { id: 'a2' }]);
      const result = await relationshipRepository.deletePairWithParent('r1', 'r2', { instanceId: 'a2' });
      expect(result).toHaveLength(3);
    });

    it('handles missing inverse', async () => {
      mockPrisma.$transaction.mockResolvedValue([{ id: 'r1' }]);
      const result = await relationshipRepository.deletePairWithParent('r1', undefined);
      expect(result).toHaveLength(1);
    });
  });

  describe('countBySourceAsset', () => {
    it('returns count of relationships from source', async () => {
      mockPrisma.assetRelationship.count.mockResolvedValue(5);
      const result = await relationshipRepository.countBySourceAsset('a1');
      expect(result).toBe(5);
    });
  });

  describe('countContainsParents', () => {
    it('returns count of CONTAINS parents for target', async () => {
      mockPrisma.assetRelationship.count.mockResolvedValue(1);
      const result = await relationshipRepository.countContainsParents('a2');
      expect(result).toBe(1);
      expect(mockPrisma.assetRelationship.count).toHaveBeenCalledWith({
        where: { targetAssetId: 'a2', relationshipType: 'CONTAINS' },
      });
    });
  });

  describe('countContainsChildren', () => {
    it('returns count of CONTAINS children for source', async () => {
      mockPrisma.assetRelationship.count.mockResolvedValue(3);
      const result = await relationshipRepository.countContainsChildren('a1');
      expect(result).toBe(3);
    });
  });

  describe('deleteByAssetIds', () => {
    it('deletes relationships involving any of the asset ids', async () => {
      mockPrisma.assetRelationship.deleteMany.mockResolvedValue({ count: 4 });
      const result = await relationshipRepository.deleteByAssetIds(['a1', 'a2']);
      expect(result.count).toBe(4);
    });
  });

  describe('deleteOldContains', () => {
    it('deletes CONTAINS and CONTAINED_IN pairs', async () => {
      mockPrisma.assetRelationship.deleteMany.mockResolvedValue({ count: 2 });
      const result = await relationshipRepository.deleteOldContains('a1', 'a2');
      expect(result.count).toBe(2);
      expect(mockPrisma.assetRelationship.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { sourceAssetId: 'a1', targetAssetId: 'a2', relationshipType: 'CONTAINS' },
            { sourceAssetId: 'a2', targetAssetId: 'a1', relationshipType: 'CONTAINED_IN' },
          ],
        },
      });
    });
  });
});
