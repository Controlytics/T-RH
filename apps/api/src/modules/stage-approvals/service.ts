/**
 * Stage Approvals service — the approver side of the cleaning stage interlock.
 *
 * A CleaningStageApproval is created (PENDING) by the operator's advance INTO an
 * interlock stage (see filter-operations/advance.ts). Here the configured
 * approver re-authenticates (the digital signature) and either:
 *   - APPROVE → the operator is released to continue per the cleaning-profile graph.
 *   - REJECT  → the filter's currentLifecycleState moves back (WASH_OUT→WASH_IN,
 *               DRY_OUT→DRY_IN); a deviation FilterEvent is logged; for a DRY_OUT
 *               reject the cycle's dryer fields are cleared so the operator must
 *               actually re-dry. The operator re-cleans and a fresh PENDING is
 *               raised when they re-reach the gated stage.
 *
 * Guards (per locked decisions 2026-06-12):
 *   - role match: decider's role === the approval's frozen approverRole (SUPER_ADMIN
 *     always allowed).
 *   - segregation of duties (config requireDifferentApprover): the operator who
 *     performed the stage cannot sign their own approval.
 *
 * The reauth password check is the digital signature; it happens in routes.ts via
 * enforceReauthAlways before these methods run.
 */
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { computeChecksum } from '../filter-operations/helpers.js';
import { getInterlockConfig, prettyStage } from '../filter-operations/stage-interlock.js';
import { createNotification } from '../notifications/notification.service.js';

const SUMMARY_SELECT = {
  id: true,
  cycleId: true,
  filterId: true,
  stageKey: true,
  status: true,
  approverRole: true,
  rejectToStateKey: true,
  attemptSeq: true,
  detailsSnapshot: true,
  requestedByName: true,
  requestedAt: true,
  decidedByName: true,
  decidedAt: true,
  decisionRemarks: true,
} as const;

/** Decider must hold the approval's frozen role (or be SUPER_ADMIN). */
function assertRoleAllowed(ctx: RequestContext, approverRole: string) {
  if (ctx.userRole === 'SUPER_ADMIN') return;
  if (ctx.userRole !== approverRole) {
    throw new AppError(403, 'WRONG_APPROVER_ROLE', `Only ${approverRole} can act on this approval.`);
  }
}

/** Segregation of duties — the performer cannot sign their own stage. */
async function assertDifferentApprover(ctx: RequestContext, requestedBy: string) {
  const cfg = await getInterlockConfig();
  if (cfg.requireDifferentApprover && ctx.userSub === requestedBy) {
    throw new AppError(
      403,
      'SELF_APPROVAL_FORBIDDEN',
      'The operator who performed this stage cannot approve it. A different user must sign off.',
    );
  }
}

type GateRow = { filterId: string; stageKey: string; cycleId: string | null };
type LiveFilterState = { currentLifecycleState: string | null; currentCycleId: string | null } | null;

/**
 * The staleness predicate, shared by the approve/reject guard and the queue()-side
 * close. Both MUST answer this question identically: a row the queue still offers
 * but the guard would 409 is exactly the stuck-forever bug.
 */
function isFilterAtGate(fd: LiveFilterState, row: GateRow): boolean {
  if (!fd) return false;
  if (fd.currentLifecycleState !== row.stageKey) return false;
  if (row.cycleId && fd.currentCycleId !== row.cycleId) return false;
  return true;
}

/**
 * Guard against acting on a STALE (orphaned) approval.
 *
 * Online, a filter cannot LEAVE a gated stage until its approval is decided, so
 * when the approver acts the filter is still parked at `row.stageKey` on the
 * same cycle. But stage interlock is an ONLINE-only gate — offline cleaning is
 * interlock-exempt (commit d8afc02). An operator who entered the gate online
 * (or whose PENDING was created by the self-heal on an online poll) can advance
 * PAST it offline; on replay the leave-gate is skipped and the filter moves on,
 * leaving this PENDING approval orphaned.
 *
 * Acting on such an orphan is unsafe: reject() would yank an already-progressed
 * filter back to WASH_IN / DRY_IN and clear dryer state mid-cycle. Refuse when
 * the filter is no longer parked at this approval's gated stage (or has rolled
 * to a different cycle). The legitimate online flow is unaffected — the filter
 * is still at the gate when its approver acts, so this passes.
 *
 * queue() closes such orphans as SUPERSEDED so they stop being offered here.
 */
async function assertFilterStillAtGate(row: GateRow) {
  const fd = await prisma.filterDetails.findUnique({
    where: { assetInstanceId: row.filterId },
    select: { currentLifecycleState: true, currentCycleId: true },
  });
  if (!isFilterAtGate(fd, row)) {
    throw new AppError(
      409,
      'APPROVAL_STALE',
      'This filter has already moved past the gated stage (it was completed offline). This approval is no longer actionable.',
    );
  }
}

/**
 * Close an orphaned PENDING approval as SUPERSEDED — closed WITHOUT a decision.
 *
 * There is no honest decision available: the filter left the gate, so approve()
 * would release an operator who already moved on and reject() would yank a
 * progressed filter backwards. Recording an APPROVED/REJECTED here would forge an
 * e-signature no human gave. SUPERSEDED says what actually happened, and the audit
 * row carries WHY so an inspector can see why a §11 request ended undecided.
 *
 * Idempotent: the status predicate in the WHERE means a concurrent/retried queue
 * read matches zero rows and writes no second audit entry.
 * Returns true if THIS call closed the row.
 */
async function supersedeOrphan(
  ctx: RequestContext,
  row: { id: string; stageKey: string; detailsSnapshot: unknown },
  currentState: string | null,
): Promise<boolean> {
  const filterName = (row.detailsSnapshot as any)?.filterName ?? null;
  const reason =
    'the filter advanced past this gated stage before the approval was decided, so it can no longer be approved or rejected';
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.cleaningStageApproval.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { status: 'SUPERSEDED', decidedAt: new Date() },
    });
    if (claimed.count === 0) return false;

    await auditLog(
      {
        userId: ctx.userId,
        userRole: ctx.userRole,
        action: 'STAGE_APPROVAL_SUPERSEDED',
        targetType: 'cleaning_stage_approval',
        targetId: row.id,
        beforeValue: { status: 'PENDING' },
        afterValue: {
          status: 'SUPERSEDED',
          stageKey: row.stageKey,
          filterName,
          currentState,
          reason,
        },
        reason,
        // Deliberately no signatureMeaning — nobody signed anything. This is the
        // system closing an undecidable request, not an approver's decision.
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        sessionId: ctx.sessionId,
      },
      tx,
    );
    return true;
  });
}

export const stageApprovalService = {
  /**
   * PENDING items the current user can act on (their role, or all for SUPER_ADMIN).
   *
   * Orphaned rows are closed as SUPERSEDED here rather than merely hidden. The
   * queue must not offer a row that approve()/reject() can only 409 on — but a
   * hidden-yet-PENDING row is a §11 approval request left open forever with no
   * record of why. Closing on detection is the honest end state, and it is the
   * only write path available: both update sites sit behind the stale guard.
   *
   * Yes, this writes on a GET. Accepted because supersedeOrphan's status
   * predicate makes it idempotent — a repeated or concurrent read closes nothing
   * twice and emits no duplicate audit row. Each close gets its own transaction so
   * one failure neither aborts the read nor the other closes.
   */
  async queue(ctx: RequestContext) {
    const where =
      ctx.userRole === 'SUPER_ADMIN'
        ? { status: 'PENDING' as const }
        : { status: 'PENDING' as const, approverRole: ctx.userRole };
    const rows = await prisma.cleaningStageApproval.findMany({
      where,
      orderBy: { requestedAt: 'desc' },
      select: SUMMARY_SELECT,
    });
    if (rows.length === 0) return rows;

    // One lookup for the whole page — not a findUnique per row.
    const live = await prisma.filterDetails.findMany({
      where: { assetInstanceId: { in: [...new Set(rows.map((r) => r.filterId))] } },
      select: { assetInstanceId: true, currentLifecycleState: true, currentCycleId: true },
    });
    const stateByFilter = new Map(live.map((f) => [f.assetInstanceId, f]));

    const actionable: typeof rows = [];
    for (const row of rows) {
      const fd = stateByFilter.get(row.filterId) ?? null;
      if (isFilterAtGate(fd, row)) {
        actionable.push(row);
        continue;
      }
      try {
        await supersedeOrphan(ctx, row, fd?.currentLifecycleState ?? null);
      } catch (e) {
        // Don't let a failed close blank the approver's queue — but don't hide it
        // either, and don't re-offer a row that can only 409.
        console.error('[stage-approvals] superseding orphan %s failed:', row.id, (e as Error).message);
      }
    }
    return actionable;
  },

  /** Broader list — ?status=APPROVED|REJECTED|PENDING for the archive. */
  async list(ctx: RequestContext, opts: { status?: string }) {
    const where: Record<string, unknown> = {};
    if (opts.status) where.status = opts.status;
    // Non-super-admins see approvals routed to their role (to act on) AND
    // approvals they themselves REQUESTED (to track the status of their own
    // requests — the tablet operator who advanced into a gated stage needs to
    // see whether QA approved/rejected it). Without the requestedBy arm the
    // operator saw an empty approvals screen because stage approvals are routed
    // to the QA/approver role, never to OPERATOR.
    if (ctx.userRole !== 'SUPER_ADMIN') {
      where.OR = [
        { approverRole: ctx.userRole },
        { requestedBy: ctx.userSub },
      ];
    }
    return prisma.cleaningStageApproval.findMany({
      where,
      orderBy: { requestedAt: 'desc' },
      take: 200,
      select: SUMMARY_SELECT,
    });
  },

  async getById(id: string) {
    const row = await prisma.cleaningStageApproval.findUnique({ where: { id } });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Stage approval not found.');
    return row;
  },

  /** APPROVE — release the operator. Records APPROVAL_GRANTED + audit signature. */
  async approve(ctx: RequestContext, id: string, remarks?: string) {
    const row = await prisma.cleaningStageApproval.findUnique({ where: { id } });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Stage approval not found.');
    if (row.status !== 'PENDING') throw new AppError(400, 'INVALID_STATUS', 'This stage approval is not pending.');
    assertRoleAllowed(ctx, row.approverRole);
    await assertDifferentApprover(ctx, row.requestedBy);
    // Refuse a stale orphan (filter already advanced past the gate offline).
    await assertFilterStillAtGate(row);

    const cleanRemarks = typeof remarks === 'string' ? remarks.trim() || null : null;

    const updated = await prisma.$transaction(async (tx) => {
      // The PENDING check above is a check-then-act — it reads, then this used
      // to issue an UNCONDITIONAL update. Two holders of the same approverRole
      // deciding one gate together both passed the check; the transaction merely
      // serialised them, so the second overwrote the first. Both wrote a
      // decision FilterEvent and an audit e-signature, and the losing decision
      // still ran its side effects — a reject that lost the race still yanked
      // currentLifecycleState back and cleared the dryer on a filter whose
      // operator the winning approve had just released.
      //
      // Predicate in the WHERE makes the transition atomic: the loser matches
      // zero rows and aborts before any side effect.
      const claimed = await tx.cleaningStageApproval.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: 'APPROVED',
          decidedBy: ctx.userSub,
          decidedByName: ctx.userId,
          decidedAt: new Date(),
          decisionRemarks: cleanRemarks,
        },
      });
      if (claimed.count === 0) {
        throw new AppError(409, 'CONCURRENT_DECISION',
          'Someone else decided this stage approval while you were deciding. Reload to see the current status.');
      }
      const u = await tx.cleaningStageApproval.findUniqueOrThrow({ where: { id } });

      // Immutable cycle-timeline entry for the signature.
      const eventData = {
        filterId: row.filterId,
        cycleId: row.cycleId,
        eventType: 'APPROVAL_GRANTED' as const,
        performedBy: ctx.userSub,
        attributes: {
          kind: 'STAGE_INTERLOCK_APPROVED',
          stageKey: row.stageKey,
          attemptSeq: row.attemptSeq,
          approvalId: row.id,
        },
        remarks: cleanRemarks,
      };
      await tx.filterEvent.create({
        data: {
          ...eventData,
          checksum: computeChecksum({
            filterId: row.filterId,
            cycleId: row.cycleId ?? '',
            eventType: 'APPROVAL_GRANTED',
            performedBy: ctx.userSub,
            stageKey: row.stageKey,
            attemptSeq: row.attemptSeq,
          }),
          ipAddress: ctx.ipAddress,
          telemetrySnapshot: {},
        },
      });

      await auditLog(
        {
          userId: ctx.userId,
          userRole: ctx.userRole,
          action: 'STAGE_APPROVAL_APPROVED',
          targetType: 'cleaning_stage_approval',
          targetId: row.id,
          afterValue: { stageKey: row.stageKey, filterName: (row.detailsSnapshot as any)?.filterName ?? null },
          signatureMeaning: `${prettyStage(row.stageKey)} approved for filter "${(row.detailsSnapshot as any)?.filterName ?? row.filterId}"`,
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          sessionId: ctx.sessionId,
        },
        tx,
      );
      return u;
    });

    await notifyOperator(row, 'STAGE_APPROVAL_APPROVED', 'Cleaning stage approved',
      `${prettyStage(row.stageKey)} for "${(row.detailsSnapshot as any)?.filterName ?? row.filterId}" was approved by ${ctx.userId}. You can continue cleaning.`, ctx);

    return updated;
  },

  /** REJECT — move the filter back and require a re-clean. Remarks mandatory. */
  async reject(ctx: RequestContext, id: string, remarks?: string) {
    const clean = typeof remarks === 'string' ? remarks.trim() : '';
    if (clean.length < 3) throw new AppError(400, 'REMARKS_REQUIRED', 'Remarks are required when rejecting (min 3 chars).');

    const row = await prisma.cleaningStageApproval.findUnique({ where: { id } });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Stage approval not found.');
    if (row.status !== 'PENDING') throw new AppError(400, 'INVALID_STATUS', 'This stage approval is not pending.');
    assertRoleAllowed(ctx, row.approverRole);
    await assertDifferentApprover(ctx, row.requestedBy);
    // Refuse a stale orphan — rejecting after the filter advanced past the gate
    // offline would yank an already-progressed filter back to WASH_IN / DRY_IN.
    await assertFilterStillAtGate(row);

    // Cycle must still be active — a rejection that re-points lifecycle state at a
    // terminated/completed cycle would corrupt it.
    if (!row.cycleId) throw new AppError(409, 'CYCLE_NOT_ACTIVE', 'This approval is not bound to a cycle.');
    const cycle = await prisma.cleaningCycle.findUnique({ where: { id: row.cycleId }, select: { status: true } });
    if (!cycle || cycle.status !== 'IN_PROGRESS') {
      throw new AppError(409, 'CYCLE_NOT_ACTIVE', 'The cleaning cycle is no longer in progress.');
    }

    // DRY_OUT reject sends the filter back to DRY_IN — clear the dryer state so the
    // operator must actually re-dry (half-time + readings gates re-fire). Per the
    // offline-anchor rule, the redo restamps dryer_started_at fresh.
    const clearsDryer = row.rejectToStateKey === 'DRY_IN';

    const updated = await prisma.$transaction(async (tx) => {
      // Same atomic claim as approve() above — without it, a reject that lost
      // the race still wrote its deviation event and dragged the filter's
      // lifecycle state backwards after the winning approve had released it.
      const claimed = await tx.cleaningStageApproval.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          decidedBy: ctx.userSub,
          decidedByName: ctx.userId,
          decidedAt: new Date(),
          decisionRemarks: clean,
        },
      });
      if (claimed.count === 0) {
        throw new AppError(409, 'CONCURRENT_DECISION',
          'Someone else decided this stage approval while you were deciding. Reload to see the current status.');
      }
      const u = await tx.cleaningStageApproval.findUniqueOrThrow({ where: { id } });

      // Immutable deviation entry: backward transition caused by QA rejection.
      const eventData = {
        filterId: row.filterId,
        cycleId: row.cycleId,
        eventType: 'STATE_TRANSITION' as const,
        fromState: row.stageKey,
        toState: row.rejectToStateKey,
        performedBy: ctx.userSub,
        attributes: {
          kind: 'STAGE_INTERLOCK_REJECTED',
          stageKey: row.stageKey,
          attemptSeq: row.attemptSeq,
          approvalId: row.id,
        },
        deviationDetails: {
          type: 'STAGE_APPROVAL_REJECTED',
          stageKey: row.stageKey,
          rejectedBy: ctx.userId,
          remarks: clean,
        },
        remarks: clean,
      };
      await tx.filterEvent.create({
        data: {
          ...eventData,
          checksum: computeChecksum({
            filterId: row.filterId,
            cycleId: row.cycleId ?? '',
            eventType: 'STATE_TRANSITION',
            fromState: row.stageKey,
            toState: row.rejectToStateKey,
            performedBy: ctx.userSub,
            attemptSeq: row.attemptSeq,
          }),
          ipAddress: ctx.ipAddress,
          telemetrySnapshot: {},
        },
      });

      // Move the filter back so the operator re-cleans.
      await tx.filterDetails.update({
        where: { assetInstanceId: row.filterId },
        data: { currentLifecycleState: row.rejectToStateKey },
      });

      if (clearsDryer) {
        await tx.cleaningCycle.update({
          where: { id: row.cycleId! },
          data: { dryerStartedAt: null, dryerDurationMinutes: null, dryerReadingsSubmitted: false },
        });
      }

      await auditLog(
        {
          userId: ctx.userId,
          userRole: ctx.userRole,
          action: 'STAGE_APPROVAL_REJECTED',
          targetType: 'cleaning_stage_approval',
          targetId: row.id,
          afterValue: { stageKey: row.stageKey, rejectToStateKey: row.rejectToStateKey, filterName: (row.detailsSnapshot as any)?.filterName ?? null, remarks: clean },
          signatureMeaning: `${prettyStage(row.stageKey)} rejected for filter "${(row.detailsSnapshot as any)?.filterName ?? row.filterId}" — restart from ${prettyStage(row.rejectToStateKey)}`,
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          sessionId: ctx.sessionId,
        },
        tx,
      );
      return u;
    });

    await notifyOperator(row, 'STAGE_APPROVAL_REJECTED', 'Cleaning stage rejected',
      `${prettyStage(row.stageKey)} for "${(row.detailsSnapshot as any)?.filterName ?? row.filterId}" was rejected by ${ctx.userId}. Restart from ${prettyStage(row.rejectToStateKey)}. Reason: ${clean}`, ctx);

    return updated;
  },

  /**
   * Batch approve/reject N cleaning-stage approvals in ONE request. Loops the
   * existing approve()/reject() per id — each keeps its own transaction, audit
   * row (the e-signature) and operator notification, so the tamper-evident trail
   * is byte-identical to N single decisions. Per-item try/catch → PARTIAL SUCCESS:
   * one failed decision neither rolls back nor blocks the others. Reauth (the
   * digital signature) is enforced ONCE at the route before this runs, exactly as
   * one operator signing the whole selection. Batch size is capped at the route.
   */
  async bulkDecide(
    ctx: RequestContext,
    ids: string[],
    action: 'approve' | 'reject',
    remarks?: string,
  ): Promise<{ results: Array<{ id: string; status: 'ok' | 'failed'; error?: { code: string; message: string } }> }> {
    const results: Array<{ id: string; status: 'ok' | 'failed'; error?: { code: string; message: string } }> = [];
    for (const id of ids) {
      try {
        if (action === 'approve') await stageApprovalService.approve(ctx, id, remarks);
        else await stageApprovalService.reject(ctx, id, remarks);
        results.push({ id, status: 'ok' });
      } catch (e: any) {
        results.push({ id, status: 'failed', error: { code: e?.code ?? 'DECISION_FAILED', message: e?.message ?? 'Failed' } });
      }
    }
    return { results };
  },
};

/** Best-effort notification to the operator who requested the approval. */
async function notifyOperator(
  row: { id: string; filterId: string; stageKey: string; requestedByName: string },
  type: 'STAGE_APPROVAL_APPROVED' | 'STAGE_APPROVAL_REJECTED',
  title: string,
  message: string,
  ctx: RequestContext,
): Promise<void> {
  try {
    await createNotification({
      type,
      title,
      message,
      forUserId: row.requestedByName, // *Name fields hold the User ID (username)
      metadata: { stageApprovalId: row.id, filterId: row.filterId, stageKey: row.stageKey },
      createdBy: ctx.userId,
    });
  } catch (e) {
    console.error('[stage-approvals] notify operator failed:', (e as Error).message);
  }
}
