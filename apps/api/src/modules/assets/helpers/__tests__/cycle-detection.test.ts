import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFindUnique } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
}));

vi.mock('../../../../lib/prisma.js', () => ({
  prisma: {
    assetInstance: {
      findUnique: mockFindUnique,
    },
  },
}));

import { hasContainsCycle } from '../cycle-detection.js';

describe('hasContainsCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when sourceId has no parent', async () => {
    mockFindUnique.mockResolvedValue({ parentId: null });
    expect(await hasContainsCycle('A', 'B')).toBe(false);
  });

  it('returns true when source is the target (direct cycle)', async () => {
    expect(await hasContainsCycle('A', 'A')).toBe(true);
    // Should not query DB since check is immediate
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('returns true when ancestor chain reaches targetId', async () => {
    // Chain: A -> parent B -> parent C (target)
    mockFindUnique
      .mockResolvedValueOnce({ parentId: 'B' }) // A.parentId = B
      .mockResolvedValueOnce({ parentId: 'C' }); // B.parentId = C

    expect(await hasContainsCycle('A', 'C')).toBe(true);
  });

  it('returns false when ancestor chain does not include targetId', async () => {
    // Chain: A -> B -> null
    mockFindUnique
      .mockResolvedValueOnce({ parentId: 'B' }) // A.parentId = B
      .mockResolvedValueOnce({ parentId: null }); // B.parentId = null

    expect(await hasContainsCycle('A', 'X')).toBe(false);
  });

  it('handles long ancestor chains without infinite loops', async () => {
    // Chain: A -> B -> C -> D -> null (target Z not found)
    mockFindUnique
      .mockResolvedValueOnce({ parentId: 'B' })
      .mockResolvedValueOnce({ parentId: 'C' })
      .mockResolvedValueOnce({ parentId: 'D' })
      .mockResolvedValueOnce({ parentId: null });

    expect(await hasContainsCycle('A', 'Z')).toBe(false);
    expect(mockFindUnique).toHaveBeenCalledTimes(4);
  });

  it('breaks infinite loops via visited set', async () => {
    // Chain: A -> B -> A (circular reference in DB — should not infinite loop)
    mockFindUnique
      .mockResolvedValueOnce({ parentId: 'B' }) // A.parentId = B
      .mockResolvedValueOnce({ parentId: 'A' }); // B.parentId = A (loop)

    // target X is not in the loop, so should return false
    expect(await hasContainsCycle('A', 'X')).toBe(false);
  });

  it('returns false when record not found (null)', async () => {
    mockFindUnique.mockResolvedValue(null);
    expect(await hasContainsCycle('A', 'B')).toBe(false);
  });
});
