import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFindMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
}));

vi.mock('../../../../lib/prisma.js', () => ({
  prisma: {
    assetInstance: {
      findMany: mockFindMany,
    },
  },
}));

import { collectDescendantIds } from '../descendant-collector.js';

describe('collectDescendantIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when parent has no children', async () => {
    mockFindMany.mockResolvedValue([]);
    const ids = await collectDescendantIds('root');
    expect(ids).toEqual([]);
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { parentId: 'root', isActive: true },
      select: { id: true },
    });
  });

  it('returns direct children IDs', async () => {
    mockFindMany
      .mockResolvedValueOnce([{ id: 'child-1' }, { id: 'child-2' }])
      .mockResolvedValue([]); // No grandchildren

    const ids = await collectDescendantIds('root');
    expect(ids).toContain('child-1');
    expect(ids).toContain('child-2');
    expect(ids).toHaveLength(2);
  });

  it('recursively collects grandchildren', async () => {
    // root -> [A] -> [A1, A2]
    mockFindMany
      .mockResolvedValueOnce([{ id: 'A' }])     // root's children
      .mockResolvedValueOnce([{ id: 'A1' }, { id: 'A2' }]) // A's children
      .mockResolvedValue([]);                     // A1 and A2 have no children

    const ids = await collectDescendantIds('root');
    expect(ids).toEqual(['A', 'A1', 'A2']);
  });

  it('handles deep nesting (3 levels)', async () => {
    // root -> [L1] -> [L2] -> [L3]
    mockFindMany
      .mockResolvedValueOnce([{ id: 'L1' }])
      .mockResolvedValueOnce([{ id: 'L2' }])
      .mockResolvedValueOnce([{ id: 'L3' }])
      .mockResolvedValue([]);

    const ids = await collectDescendantIds('root');
    expect(ids).toEqual(['L1', 'L2', 'L3']);
  });

  it('handles wide trees with multiple branches', async () => {
    // root -> [A, B]
    // A -> [A1], B -> [B1]
    mockFindMany
      .mockResolvedValueOnce([{ id: 'A' }, { id: 'B' }])
      .mockResolvedValueOnce([{ id: 'A1' }])
      .mockResolvedValueOnce([])     // A1 has no children
      .mockResolvedValueOnce([{ id: 'B1' }])
      .mockResolvedValue([]);         // B1 has no children

    const ids = await collectDescendantIds('root');
    expect(ids).toEqual(['A', 'A1', 'B', 'B1']);
  });

  it('only queries isActive: true children', async () => {
    mockFindMany.mockResolvedValue([]);
    await collectDescendantIds('parent-1');

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { parentId: 'parent-1', isActive: true },
      }),
    );
  });
});
