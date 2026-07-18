import { prisma } from '../../../lib/prisma.js';

/**
 * Walk up the parent chain from sourceId.
 * If targetId is found, there's a cycle.
 */
export async function hasContainsCycle(sourceId: string, targetId: string): Promise<boolean> {
  let currentId: string | null = sourceId;
  const visited = new Set<string>();
  while (currentId) {
    if (currentId === targetId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const record: { parentId: string | null } | null = await prisma.assetInstance.findUnique({
      where: { id: currentId },
      select: { parentId: true },
    });
    currentId = record?.parentId ?? null;
  }
  return false;
}
