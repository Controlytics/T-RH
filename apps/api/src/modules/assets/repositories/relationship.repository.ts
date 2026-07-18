import { prisma } from '../../../lib/prisma.js';

export const relationshipRepository = {
  async findMany(where: Record<string, unknown>) {
    return prisma.assetRelationship.findMany({
      where: where as any,
      include: {
        sourceAsset: { select: { id: true, name: true } },
        targetAsset: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  async findById(id: string) {
    return prisma.assetRelationship.findUnique({ where: { id } });
  },

  async findByCompositeKey(sourceAssetId: string, targetAssetId: string, relationshipType: string) {
    return prisma.assetRelationship.findUnique({
      where: {
        sourceAssetId_targetAssetId_relationshipType: {
          sourceAssetId, targetAssetId, relationshipType: relationshipType as any,
        },
      },
    });
  },

  async findInverse(sourceAssetId: string, targetAssetId: string, relationshipType: string) {
    return prisma.assetRelationship.findFirst({
      where: { sourceAssetId, targetAssetId, relationshipType: relationshipType as any },
    });
  },

  async createPairWithParent(
    rel: Record<string, unknown>,
    inverse: Record<string, unknown>,
    setParentId?: { childId: string; parentId: string },
  ) {
    const ops: any[] = [
      prisma.assetRelationship.create({ data: rel as any }),
      prisma.assetRelationship.create({ data: inverse as any }),
    ];
    if (setParentId) {
      ops.push(
        prisma.assetInstance.update({
          where: { id: setParentId.childId },
          data: { parentId: setParentId.parentId },
        }),
      );
    }
    return prisma.$transaction(ops);
  },

  async deletePairWithParent(
    id: string,
    inverseId: string | undefined,
    clearParent?: { instanceId: string },
  ) {
    const ops: any[] = [prisma.assetRelationship.delete({ where: { id } })];
    if (inverseId) {
      ops.push(prisma.assetRelationship.delete({ where: { id: inverseId } }));
    }
    if (clearParent) {
      ops.push(
        prisma.assetInstance.update({
          where: { id: clearParent.instanceId },
          data: { parentId: null },
        }),
      );
    }
    return prisma.$transaction(ops);
  },

  async countBySourceAsset(assetId: string) {
    return prisma.assetRelationship.count({ where: { sourceAssetId: assetId } });
  },

  async countContainsParents(targetAssetId: string) {
    return prisma.assetRelationship.count({
      where: { targetAssetId, relationshipType: 'CONTAINS' },
    });
  },

  async countContainsChildren(sourceAssetId: string) {
    return prisma.assetRelationship.count({
      where: { sourceAssetId, relationshipType: 'CONTAINS' },
    });
  },

  async deleteByAssetIds(ids: string[]) {
    return prisma.assetRelationship.deleteMany({
      where: {
        OR: [
          { sourceAssetId: { in: ids } },
          { targetAssetId: { in: ids } },
        ],
      },
    });
  },

  async deleteOldContains(parentId: string, childId: string) {
    return prisma.assetRelationship.deleteMany({
      where: {
        OR: [
          { sourceAssetId: parentId, targetAssetId: childId, relationshipType: 'CONTAINS' },
          { sourceAssetId: childId, targetAssetId: parentId, relationshipType: 'CONTAINED_IN' },
        ],
      },
    });
  },
};
