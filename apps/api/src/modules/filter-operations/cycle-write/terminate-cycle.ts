/**
 * Filter Operations — terminateCycle() implementation.
 *
 * Extracted byte-for-byte from filter-operations.service.ts. The orchestrator
 * (FilterOperationsService.terminateCycle) is now a thin forward to this
 * function. Pure module-decomposition move; no behavioral changes.
 */
import type { RequestContext } from '../../../types/context.js';
import { prisma } from '../../../lib/prisma.js';
import { auditLog } from '../../../lib/audit.js';
import { stripHtml } from '../../../lib/sanitize.js';
import { findExistingByClientOpId, withClientOpId } from '../../../lib/idempotency.js';
import { validateOfflinePerformedAt } from '../../../lib/offline-time-window.js';
import { loadLocalContext, throwIfFailed } from '../local-context.js';
import * as executor from '@digilog/shared';
import { computeChecksum } from '../helpers.js';
import { lockAndVerifyFilterState } from './locking.js';
import type { FilterOperationsService } from '../filter-operations.service.js';

export async function terminateCycleImpl(
  service: FilterOperationsService,
  ctx: RequestContext,
  filterId: string,
  data: { justification: string; clientOpId?: string; tapeVersion?: number; offlinePerformedAt?: string },
) {
  const clientOpId: string | null = data.clientOpId ?? null;

  // Server-only: full HTML sanitization (sanitize-html via stripHtml) before
  // guards. See advance.ts:29 rationale — canonical contract used by the
  // rest of the codebase.
  const justification = typeof data.justification === 'string'
    ? stripHtml(data.justification)
    : '';

  // Phase 8.5 Commit 3: drop pure guards through the shared executor.
  const { ctx: localCtx, filterCurrentCycleId, rawCycle: cycle } = await loadLocalContext(filterId, ctx);
  throwIfFailed(executor.assertCycleActive(localCtx));

  // Cycle-scoped clientOpId dedup (audit §1.10): a terminate replay on the
  // same cycle returns current state; the same opId from a prior cycle
  // cannot collide.
  if (clientOpId && filterCurrentCycleId && await findExistingByClientOpId(filterId, clientOpId, filterCurrentCycleId)) {
    return service.getCurrentState(ctx, filterId);
  }

  // Audit 2026-05-04 fix C2 parity: validate offlinePerformedAt with
  // cycle.startedAt floor (terminate inherits the floor from the cycle
  // it's terminating).
  const offlineTime = validateOfflinePerformedAt(data.offlinePerformedAt, {
    isReplay: ctx.isOfflineReplay === true,
    cycleStartedAt: cycle?.startedAt ?? null,
  });

  throwIfFailed(executor.assertTapeVersionFresh(localCtx, data.tapeVersion));
  throwIfFailed(
    executor.assertJustificationValid(localCtx, justification, { kind: 'terminate' }),
  );

  // Phase 8.7 follow-up: snapshot the pre-lock state so the in-txn recheck can
  // detect a concurrent operator who advanced the filter or terminated/restarted
  // its cycle between loadLocalContext() and the row lock acquiring.
  const fromState = localCtx.filter.currentLifecycleState;

  await prisma.$transaction(async (tx) => {
    // Phase 8.7 follow-up: SELECT FOR UPDATE row lock — mirrors the advance()
    // pattern. Without this the audit-flagged race
    // (AUDIT-2026-05-02-concurrent-operator.md lines 83-87) lets two
    // concurrent terminate calls both succeed, or lets a terminate win against
    // an in-flight advance that already swapped the cycle.
    await lockAndVerifyFilterState(tx, filterId, fromState, filterCurrentCycleId);

    // F-06 fix (2026-05-25 DB audit): TERMINATED cycles should set
    // terminated_at, not just completed_at. Pre-fix, terminated_at stayed
    // NULL for any cycle terminated via the app, which made it impossible
    // to distinguish "completed successfully" from "terminated mid-cycle"
    // in the cleaning_cycles table without joining filter_events. Now both
    // columns are written and the column name matches the cycle status.
    const terminatedAt = new Date();
    await tx.cleaningCycle.update({
      where: { id: filterCurrentCycleId! },
      data: { status: 'TERMINATED', completedAt: terminatedAt, terminatedAt },
    });
    // currentCycleId + currentLifecycleState moved to FilterDetails (Step 6).
    await tx.filterDetails.update({
      where: { assetInstanceId: filterId },
      data: { currentCycleId: null, currentLifecycleState: null },
    });
    const eventData = {
      filterId, cycleId: filterCurrentCycleId!, eventType: 'CYCLE_TERMINATED' as const,
      performedBy: ctx.userSub, attributes: withClientOpId({ justification }, clientOpId),
      remarks: justification,
    };
    await tx.filterEvent.create({
      data: {
        ...eventData,
        checksum: computeChecksum(eventData),
        ipAddress: ctx.ipAddress,
        telemetrySnapshot: {},
        ...(offlineTime ? { performedAt: offlineTime } : {}),
      },
    });

    // Audit §1.1 (2026-05-16): audit-write inside business tx.
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CYCLE_TERMINATED',
      targetType: 'filter', targetId: filterId,
      afterValue: { cycleId: filterCurrentCycleId, justification },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    }, tx);
  });

  return service.getCurrentState(ctx, filterId);
}
