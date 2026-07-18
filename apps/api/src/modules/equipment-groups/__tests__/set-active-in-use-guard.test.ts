import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    equipmentGroup: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    cleaningCycle: { count: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));
vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));

import { EquipmentGroupsService } from '../equipment-groups.service.js';

const service = new EquipmentGroupsService();
const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' } as any;

const BLOCK = 'b1';

/**
 * Equipment-group DELETE deactivation guard.
 *
 * `delete()` is a soft delete (isActive=false). It refuses (409 IN_USE) while
 * IN_PROGRESS cycles reference the group, and — the block-fallback half — refuses
 * to remove the block's LAST active group while UNBOUND in-progress cycles exist
 * (equipmentGroupId = NULL), since those resolve a group from the block's ACTIVE
 * groups at advance() time and would be stranded on zero. Pinned cycles
 * (equipmentGroupId set) resolve config from the version snapshot regardless of
 * isActive, so they are immune; the unbound ones are the ones that break.
 *
 * (2026-07-16: the Enable/Disable toggle — `setActive()` — was removed when a
 * block became allowed to have multiple active equipment groups. `delete()` is
 * now the only path through this guard; the tests exercise it there.)
 */
describe('equipment-group delete() deactivation guard', () => {
  /** The tx handle prisma.$transaction hands the callback. */
  const txStub = () => ({
    equipmentGroup: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
      count: mockPrisma.equipmentGroup.count,
    },
    cleaningCycle: { count: mockPrisma.cleaningCycle.count },
    $queryRaw: mockPrisma.$queryRaw,
  });

  let tx: ReturnType<typeof txStub>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.equipmentGroup.findFirst.mockResolvedValue({ id: 'g1', name: 'FD', blockId: BLOCK, isActive: true });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    tx = txStub();
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
    // Default: no cycles anywhere, one sibling still active.
    cycleCounts({});
    mockPrisma.equipmentGroup.count.mockResolvedValue(1);
  });

  /**
   * Answer cleaningCycle.count from the WHERE clause rather than a
   * mockResolvedValueOnce queue: vi.clearAllMocks() does not drain Once queues,
   * so a queue outliving its test silently feeds the next one (it masked a real
   * mutation here). This is order- and call-count-independent.
   */
  const cycleCounts = ({ pinned = 0, unbound = 0 }: { pinned?: number; unbound?: number }) => {
    mockPrisma.cleaningCycle.count.mockImplementation(async ({ where }: any) =>
      where.equipmentGroupId === null ? unbound : pinned,
    );
  };

  // ── pinned-cycle guard ──
  describe('pinned in-progress cycles', () => {
    it('refuses to delete a group referenced by IN_PROGRESS cycles', async () => {
      cycleCounts({ pinned: 8 });

      await expect(service.delete(ctx, 'g1')).rejects.toMatchObject({ statusCode: 409, code: 'IN_USE' });
      expect(tx.equipmentGroup.update).not.toHaveBeenCalled();
    });

    it('counts the pinned in-progress cycles for this group', async () => {
      await service.delete(ctx, 'g1');

      expect(mockPrisma.cleaningCycle.count).toHaveBeenCalledWith({
        where: { equipmentGroupId: 'g1', status: 'IN_PROGRESS' },
      });
    });

    it('soft-deletes (isActive=false) when nothing references the group', async () => {
      await service.delete(ctx, 'g1');
      expect(tx.equipmentGroup.update).toHaveBeenCalledWith({ where: { id: 'g1' }, data: { isActive: false } });
    });
  });

  // ── block-fallback guard (last active group + unbound cycles) ──
  describe('last-active-group guard for unbound cycles', () => {
    /** No sibling left active, and `n` unbound in-progress cycles in the block. */
    const lastGroupWithUnbound = (n: number) => {
      mockPrisma.equipmentGroup.count.mockResolvedValue(0); // no other active group
      cycleCounts({ pinned: 0, unbound: n });
    };

    it('refuses to delete the block\'s LAST active group when unbound cycles exist', async () => {
      lastGroupWithUnbound(3);

      await expect(service.delete(ctx, 'g1')).rejects.toMatchObject({ statusCode: 409, code: 'IN_USE' });
      expect(tx.equipmentGroup.update).not.toHaveBeenCalled();
    });

    it('scopes the unbound-cycle lookup to this block and to cycles with no group', async () => {
      lastGroupWithUnbound(1);
      await service.delete(ctx, 'g1').catch(() => {});

      expect(mockPrisma.cleaningCycle.count).toHaveBeenLastCalledWith({
        where: { cleaningAreaId: BLOCK, equipmentGroupId: null, status: 'IN_PROGRESS' },
      });
    });

    // The predicate must not be over-broad: 2 active groups -> 1 is exactly how
    // an operator legitimately removes one of a block's several active groups.
    // Only 1 -> 0 with unbound cycles breaks.
    it('ALLOWS deleting when a sibling group stays active, even with unbound cycles', async () => {
      mockPrisma.equipmentGroup.count.mockResolvedValue(1); // a sibling remains
      cycleCounts({ pinned: 0, unbound: 5 }); // unbound cycles exist but are safe

      await service.delete(ctx, 'g1');
      expect(tx.equipmentGroup.update).toHaveBeenCalled();
      // Never needed to ask about unbound cycles — a group remains to bind to.
      expect(mockPrisma.cleaningCycle.count).toHaveBeenCalledTimes(1);
    });

    it('allows deleting the last active group when NO unbound cycles exist', async () => {
      mockPrisma.equipmentGroup.count.mockResolvedValue(0);
      cycleCounts({ pinned: 0, unbound: 0 });

      await service.delete(ctx, 'g1');
      expect(tx.equipmentGroup.update).toHaveBeenCalled();
    });
  });

  // ── TOCTOU ──
  it('locks the block\'s groups before reading the active count', async () => {
    await service.delete(ctx, 'g1');

    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    // The lock must precede the reads it protects, inside the same transaction.
    const lockOrder = mockPrisma.$queryRaw.mock.invocationCallOrder[0];
    const countOrder = mockPrisma.cleaningCycle.count.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(countOrder);
  });

  it('still 404s for an unknown group before touching cycles', async () => {
    mockPrisma.equipmentGroup.findFirst.mockResolvedValue(null);

    await expect(service.delete(ctx, 'nope')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockPrisma.cleaningCycle.count).not.toHaveBeenCalled();
  });
});
