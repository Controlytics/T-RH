import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({
  prisma: {
    cleaningStageApproval: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    filterDetails: { findMany: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../lib/audit.js', () => ({ auditLog: vi.fn() }));

// Reads system_config; irrelevant to these paths and stubbed so the stale guard
// is reached. requireDifferentApprover:false keeps segregation-of-duties out of
// the way — the assertion under test is the stale 409, not SoD.
vi.mock('../../filter-operations/stage-interlock.js', () => ({
  getInterlockConfig: vi.fn(async () => ({ requireDifferentApprover: false })),
  prettyStage: (s: string) => s,
}));

import { stageApprovalService } from '../service.js';
import { prisma } from '../../../lib/prisma.js';
import { auditLog } from '../../../lib/audit.js';

const ctx = { userId: 'qa1', userRole: 'QA', userSub: 'sub-qa1', ipAddress: '127.0.0.1', userAgent: 't', sessionId: 's' } as any;

/** A PENDING approval parked at DRY_OUT on cycle c1. */
function approval(over: Record<string, unknown> = {}) {
  return {
    id: 'a1', cycleId: 'c1', filterId: 'f1', stageKey: 'DRY_OUT', status: 'PENDING',
    approverRole: 'QA', rejectToStateKey: 'DRY_IN', attemptSeq: 1,
    detailsSnapshot: { filterName: 'FLT-001' },
    requestedBy: 'sub-op1', requestedByName: 'op1', requestedAt: new Date(),
    ...over,
  };
}

/** tx passthrough — the supersede transaction body runs against these mocks. */
function txPassthrough(updateManyResult = { count: 1 }) {
  const updateMany = vi.fn().mockResolvedValue(updateManyResult);
  vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) =>
    cb({ cleaningStageApproval: { updateMany } }),
  );
  return updateMany;
}

describe('stageApprovalService.queue — orphan close (SUPERSEDED)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('closes an orphan as SUPERSEDED and withholds it from the queue', async () => {
    vi.mocked(prisma.cleaningStageApproval.findMany).mockResolvedValue([approval()] as any);
    // Filter has moved on to CLEANING_CYCLE_COMPLETED — the live 40-row signature.
    vi.mocked(prisma.filterDetails.findMany).mockResolvedValue([
      { assetInstanceId: 'f1', currentLifecycleState: 'CLEANING_CYCLE_COMPLETED', currentCycleId: 'c1' },
    ] as any);
    const updateMany = txPassthrough();

    const out = await stageApprovalService.queue(ctx);

    // (a) not offered — it could only ever 409.
    expect(out).toEqual([]);
    // (b) closed, and only from PENDING (atomic claim).
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'a1', status: 'PENDING' }, data: expect.objectContaining({ status: 'SUPERSEDED' }) }),
    );
    // (c) an inspector can see who/what/why.
    expect(auditLog).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(auditLog).mock.calls[0][0];
    expect(entry).toMatchObject({
      action: 'STAGE_APPROVAL_SUPERSEDED',
      targetType: 'cleaning_stage_approval',
      targetId: 'a1',
      userId: 'qa1',
      beforeValue: { status: 'PENDING' },
    });
    expect(entry.reason).toMatch(/advanced past this gated stage/);
    expect((entry.afterValue as any).currentState).toBe('CLEANING_CYCLE_COMPLETED');
    // Nobody signed this — it must not masquerade as a decision.
    expect(entry.signatureMeaning).toBeUndefined();
  });

  it('leaves a filter still parked at the gate actionable and untouched', async () => {
    vi.mocked(prisma.cleaningStageApproval.findMany).mockResolvedValue([approval()] as any);
    vi.mocked(prisma.filterDetails.findMany).mockResolvedValue([
      { assetInstanceId: 'f1', currentLifecycleState: 'DRY_OUT', currentCycleId: 'c1' },
    ] as any);
    txPassthrough();

    const out = await stageApprovalService.queue(ctx);

    expect(out).toHaveLength(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('treats a filter rolled onto a DIFFERENT cycle as an orphan', async () => {
    vi.mocked(prisma.cleaningStageApproval.findMany).mockResolvedValue([approval()] as any);
    // Same stage key, but a later cycle — the approval belongs to a cycle that is gone.
    vi.mocked(prisma.filterDetails.findMany).mockResolvedValue([
      { assetInstanceId: 'f1', currentLifecycleState: 'DRY_OUT', currentCycleId: 'c2' },
    ] as any);
    txPassthrough();

    expect(await stageApprovalService.queue(ctx)).toEqual([]);
    expect(auditLog).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a concurrent close writes no second audit row', async () => {
    vi.mocked(prisma.cleaningStageApproval.findMany).mockResolvedValue([approval()] as any);
    vi.mocked(prisma.filterDetails.findMany).mockResolvedValue([
      { assetInstanceId: 'f1', currentLifecycleState: 'STORAGE_IN', currentCycleId: 'c1' },
    ] as any);
    // Someone else's queue read already flipped it: the claim matches 0 rows.
    txPassthrough({ count: 0 });

    expect(await stageApprovalService.queue(ctx)).toEqual([]);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('a failed close still returns the actionable rows and never re-offers the orphan', async () => {
    vi.mocked(prisma.cleaningStageApproval.findMany).mockResolvedValue([
      approval({ id: 'a1', filterId: 'f1' }),          // orphan, close will throw
      approval({ id: 'a2', filterId: 'f2' }),          // healthy
    ] as any);
    vi.mocked(prisma.filterDetails.findMany).mockResolvedValue([
      { assetInstanceId: 'f1', currentLifecycleState: 'CLEANING_CYCLE_COMPLETED', currentCycleId: 'c1' },
      { assetInstanceId: 'f2', currentLifecycleState: 'DRY_OUT', currentCycleId: 'c1' },
    ] as any);
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('deadlock'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await stageApprovalService.queue(ctx);

    expect(out.map((r) => r.id)).toEqual(['a2']);
  });

  it('a missing filter_details row counts as an orphan (not a crash)', async () => {
    vi.mocked(prisma.cleaningStageApproval.findMany).mockResolvedValue([approval()] as any);
    vi.mocked(prisma.filterDetails.findMany).mockResolvedValue([] as any);
    txPassthrough();

    expect(await stageApprovalService.queue(ctx)).toEqual([]);
    expect(vi.mocked(auditLog).mock.calls[0][0].afterValue).toMatchObject({ currentState: null });
  });

  it('short-circuits with no filter lookup when nothing is pending', async () => {
    vi.mocked(prisma.cleaningStageApproval.findMany).mockResolvedValue([] as any);
    expect(await stageApprovalService.queue(ctx)).toEqual([]);
    expect(prisma.filterDetails.findMany).not.toHaveBeenCalled();
  });

  it('scopes to the approver role for non-SUPER_ADMIN, all roles for SUPER_ADMIN', async () => {
    vi.mocked(prisma.cleaningStageApproval.findMany).mockResolvedValue([] as any);
    await stageApprovalService.queue(ctx);
    expect(prisma.cleaningStageApproval.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'PENDING', approverRole: 'QA' } }),
    );
    await stageApprovalService.queue({ ...ctx, userRole: 'SUPER_ADMIN' });
    expect(prisma.cleaningStageApproval.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { status: 'PENDING' } }),
    );
  });
});

describe('stageApprovalService approve/reject — stale guard stays intact', () => {
  beforeEach(() => vi.clearAllMocks());

  // The guard is correct and must NOT be weakened by the queue-side close: a row
  // that slipped through (stale between read and decide) still has to 409.
  it.each(['approve', 'reject'] as const)('%s 409s APPROVAL_STALE once the filter left the gate', async (action) => {
    vi.mocked(prisma.cleaningStageApproval.findUnique).mockResolvedValue(approval() as any);
    vi.mocked(prisma.filterDetails.findUnique).mockResolvedValue({
      currentLifecycleState: 'CLEANING_CYCLE_COMPLETED', currentCycleId: 'c1',
    } as any);

    await expect(stageApprovalService[action](ctx, 'a1', 'some remarks'))
      .rejects.toMatchObject({ statusCode: 409, code: 'APPROVAL_STALE' });
  });
});
