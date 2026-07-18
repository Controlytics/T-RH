import { prisma } from '../../../lib/prisma.js';

/**
 * Recursively collect all descendant IDs of a given instance.
 */
export async function collectDescendantIds(parentId: string): Promise<string[]> {
  const children = await prisma.assetInstance.findMany({
    where: { parentId, isActive: true },
    select: { id: true },
  });
  const ids: string[] = [];
  for (const child of children) {
    ids.push(child.id);
    const grandchildren = await collectDescendantIds(child.id);
    ids.push(...grandchildren);
  }
  return ids;
}
