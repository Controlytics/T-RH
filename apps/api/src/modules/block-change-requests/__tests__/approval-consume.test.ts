import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    blockChangeRequest: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
  },
}));
vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../notifications/notification.service.js', () => ({ createNotification: vi.fn().mockResolvedValue(undefined) }));

import { blockChangeService } from '../block-change.service.js';

beforeEach(() => vi.clearAllMocks());

/**
 * Enterprise-audit finding (2026-07-13): approvals were never consumed and never
 * expired, so one approval was a permanent, unlimited licence to clean a filter
 * in another block. `consumeApprovalTx` existed since 2026-05-05 but had ZERO
 * callers. It is now spent inside start-cycle's transaction.
 */
describe('consumeApprovalTx', () => {
  const tx = (count: number) => ({ blockChangeRequest: { updateMany: vi.fn().mockResolvedValue({ count }) } });

  it('flips exactly the APPROVED row for this filter→block to EXPIRED', async () => {
    const t = tx(1);
    const consumed = await blockChangeService.consumeApprovalTx(t, 'filter-1', 'block-2');

    expect(consumed).toBe(1);
    expect(t.blockChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { filterId: 'filter-1', toBlockId: 'block-2', status: 'APPROVED' },
      data: { status: 'EXPIRED' },
    });
  });

  it('returns 0 when the approval was already spent — the caller must reject', async () => {
    // This is the lost-race signal: validateBlockChange's hasApproval read
    // happens outside the transaction, so two concurrent starts can both see an
    // approval. Only the one whose updateMany actually matches may proceed.
    expect(await blockChangeService.consumeApprovalTx(tx(0), 'filter-1', 'block-2')).toBe(0);
  });

  it('uses the caller-supplied tx client, never the global prisma', async () => {
    // Consuming outside the caller's row lock is what reopens the race.
    const t = tx(1);
    await blockChangeService.consumeApprovalTx(t, 'filter-1', 'block-2');
    expect(mockPrisma.blockChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it('no longer exposes a non-transactional consume', () => {
    expect((blockChangeService as any).consumeApproval).toBeUndefined();
  });
});

/**
 * `autoExpireHours` was editable on Config → Role Assignments and read by NO
 * code — an approval never aged out. Now evaluated at read time.
 */
describe('hasApproval — autoExpireHours', () => {
  const approvedAt = (hoursAgo: number) => ({
    id: 'r1', processedAt: new Date(Date.now() - hoursAgo * 3_600_000), createdAt: new Date(0),
  });
  const withHours = (h: unknown) => mockPrisma.systemConfig.findUnique.mockResolvedValue({ configValue: { autoExpireHours: h } });

  it('accepts an approval inside the window', async () => {
    mockPrisma.blockChangeRequest.findFirst.mockResolvedValue(approvedAt(1));
    withHours(24);
    expect(await blockChangeService.hasApproval('f1', 'b2')).toBe(true);
  });

  it('rejects an approval older than the window', async () => {
    mockPrisma.blockChangeRequest.findFirst.mockResolvedValue(approvedAt(25));
    withHours(24);
    expect(await blockChangeService.hasApproval('f1', 'b2')).toBe(false);
  });

  it('treats 0 as never-expires', async () => {
    mockPrisma.blockChangeRequest.findFirst.mockResolvedValue(approvedAt(10_000));
    withHours(0);
    expect(await blockChangeService.hasApproval('f1', 'b2')).toBe(true);
  });

  it('treats a missing/garbage config value as never-expires rather than locking operators out', async () => {
    mockPrisma.blockChangeRequest.findFirst.mockResolvedValue(approvedAt(10_000));
    withHours('not-a-number');
    expect(await blockChangeService.hasApproval('f1', 'b2')).toBe(true);
  });

  it('falls back to createdAt for a legacy row with no processedAt', async () => {
    mockPrisma.blockChangeRequest.findFirst.mockResolvedValue({
      id: 'r1', processedAt: null, createdAt: new Date(Date.now() - 1 * 3_600_000),
    });
    withHours(24);
    expect(await blockChangeService.hasApproval('f1', 'b2')).toBe(true);
  });

  it('returns false when there is no approval at all', async () => {
    mockPrisma.blockChangeRequest.findFirst.mockResolvedValue(null);
    expect(await blockChangeService.hasApproval('f1', 'b2')).toBe(false);
  });
});

describe('create — mass assignment', () => {
  it('ignores caller-supplied status/manualEntry and stamps the requester', async () => {
    mockPrisma.blockChangeRequest.findFirst.mockResolvedValue(null);
    mockPrisma.blockChangeRequest.create.mockResolvedValue({ id: 'r1' });

    const ctx: any = { userId: 'EMP-1', userSub: 'sub-1', userRole: 'OPERATOR' };
    await blockChangeService.create(ctx, {
      filterId: 'f1', filterName: 'F1',
      fromBlockId: 'b1', fromBlockName: 'B1',
      toBlockId: 'b2', toBlockName: 'B2',
      reason: 'why',
      // Forged fields — a requester self-approving their own cross-block request.
      status: 'APPROVED', manualEntry: true, processedBy: 'someone',
    } as any);

    const data = mockPrisma.blockChangeRequest.create.mock.calls[0][0].data;
    expect(data.status).toBeUndefined();
    expect(data.manualEntry).toBeUndefined();
    expect(data.processedBy).toBeUndefined();
    expect(data).toMatchObject({ filterId: 'f1', toBlockId: 'b2', requestedBy: 'sub-1', requestedByName: 'EMP-1' });
  });
});
