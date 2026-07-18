import { prisma } from '../../../lib/prisma.js';

export const identifierRepository = {
  async findMany(where: Record<string, unknown>) {
    return prisma.assetIdentifier.findMany({
      where: where as any,
      include: { asset: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  },

  async findByValue(value: string) {
    return prisma.assetIdentifier.findUnique({
      where: { identifierValue: value },
      include: {
        asset: {
          include: {
            template: {
              select: { id: true, name: true, icon: true, attributeSchema: true },
            },
            parent: { select: { id: true, name: true } },
            identifiers: true,
          },
        },
      },
    });
  },

  async findById(id: string) {
    return prisma.assetIdentifier.findUnique({ where: { id } });
  },

  async findByIdentifierValue(value: string) {
    return prisma.assetIdentifier.findUnique({ where: { identifierValue: value } });
  },

  async create(data: {
    assetId: string;
    identifierType: string;
    identifierValue: string;
    label?: string;
    isPrimary?: boolean;
    createdBy: string;
  }) {
    return prisma.assetIdentifier.create({ data });
  },

  async delete(id: string) {
    return prisma.assetIdentifier.delete({ where: { id } });
  },

  async deleteByAssetIds(ids: string[]) {
    return prisma.assetIdentifier.deleteMany({
      where: { assetId: { in: ids } },
    });
  },
};
