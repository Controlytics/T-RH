/**
 * Filter Operations — bypass() implementation.
 *
 * Extracted byte-for-byte from filter-operations.service.ts. The orchestrator
 * (FilterOperationsService.bypass) is now a thin forward to this function.
 * Pure module-decomposition move; no behavioral changes.
 */
import type { RequestContext } from '../../../types/context.js';
import { prisma } from '../../../lib/prisma.js';
import { auditLog } from '../../../lib/audit.js';
import { stripHtml } from '../../../lib/sanitize.js';
import { AppError } from '../../../lib/errors.js';
import { findExistingByClientOpId, withClientOpId } from '../../../lib/idempotency.js';
import { validateOfflinePerformedAt } from '../../../lib/offline-time-window.js';
import { loadLocalContext, throwIfFailed } from '../local-context.js';
import * as executor from '@digilog/shared';
import { computeChecksum } from '../helpers.js';
import { lockAndVerifyFilterState } from './locking.js';
import { assertStageApprovedToLeave } from '../stage-interlock.js';
import type { FilterOperationsService } from '../filter-operations.service.js';

/** @param data - Validated by Fastify JSON schema before reaching this method */
export async function bypassImpl(
  service: FilterOperationsService,
  ctx: RequestContext,
  filterId: string,
  data: any,
) {
  const { targetState, parameters } = data;
  // Server-only: full HTML sanitization (sanitize-html via stripHtml) before
  // guards. Hand-rolled `<` / `>` escapes missed entity-encoded payloads,
  // javascript: URIs, and event handlers — replaced with the canonical
  // helper that the rest of the codebase uses.
  const justification = typeof data.justification === "string"
    ? stripHtml(data.justification)
    : data.justification;
  const clientOpId: string | null = data.clientOpId ?? null;

  // Phase 8.5 Commit 3: drop pure guards through the shared executor.
  const { ctx: localCtx, cp, filterCurrentCycleId, rawCycle: cycle } = await loadLocalContext(filterId, ctx);

  // Cycle-scoped clientOpId dedup (audit §1.10): scope by current cycle so a
  // clientOpId reused from a prior (completed/terminated) cycle cannot
  // silently no-op a fresh bypass.
  if (clientOpId && filterCurrentCycleId && await findExistingByClientOpId(filterId, clientOpId, filterCurrentCycleId)) {
    return service.getCurrentState(ctx, filterId);
  }
  throwIfFailed(executor.assertCycleActive(localCtx));

  // Audit 2026-05-04 fix C2 parity (start-cycle/advance/submit-checklist
  // already wired): validate offlinePerformedAt against cycle.startedAt
  // floor + replay-only + future-skew + max-staleness. See
  // apps/api/src/lib/offline-time-window.ts.
  const offlineTime = validateOfflinePerformedAt(data.offlinePerformedAt, {
    isReplay: ctx.isOfflineReplay === true,
    cycleStartedAt: cycle?.startedAt ?? null,
  });

  throwIfFailed(executor.assertTapeVersionFresh(localCtx, data.tapeVersion));
  // 2026-06-09: bypass runs on an IN-PROGRESS cycle whose profile is pinned at
  // start. Do not require the pinned profile to still be ACTIVE — disabling a
  // profile must not strand cycles already running on it (it still has the
  // flowMode + states bypass needs). cp is only null if the row is missing.
  if (!cp) {
    throw new AppError(400, 'NO_PROFILE', 'This cycle has no cleaning profile (the pinned profile record is missing).');
  }
  throwIfFailed(executor.assertBypassAllowed(localCtx, cp.flowMode));
  const validStates = cp.stages.filter(s => s.nodeType === 'STAGE' && s.stateKey).map(s => s.stateKey);
  throwIfFailed(executor.assertBypassTargetStateValid(localCtx, targetState, validStates));
  throwIfFailed(executor.assertJustificationValid(localCtx, justification, { kind: 'bypass' }));

  const fromState = localCtx.filter.currentLifecycleState;

  // Stage interlock — leave-gate. A bypass must not be an escape hatch around a
  // pending QA approval: leaving an interlock stage (WASH_OUT / DRY_OUT) still
  // requires the latest approval to be APPROVED. No-op when interlock disabled or
  // fromState is not a gated stage.
  // KNOWN GAP (Phase 2): a bypass that jumps INTO a later stage, skipping an
  // interlock stage entirely, is not yet blocked — tracked in
  // tasks/STAGE-INTERLOCK-PLAN.md. Most profiles are STRICT (bypass disabled).
  // OFFLINE EXEMPTION (2026-06-15, per user): the interlock is online-only, so an
  // offline-replayed bypass is not gated (mirrors advance.ts).
  if (filterCurrentCycleId && !ctx.isOfflineReplay) {
    await assertStageApprovedToLeave({
      cycleId: filterCurrentCycleId,
      fromState,
      targetState,
    });
  }

  const eventData = {
    filterId, cycleId: filterCurrentCycleId ?? undefined,
    eventType: 'BYPASS_DEVIATION' as const,
    fromState, toState: targetState,
    performedBy: ctx.userSub,
    // 2026-07-10 (per user): mark an OFFLINE bypass into a gated stage so the
    // interlock self-heal (current-state.ts) exempts it — same carve-out as the
    // advance path. Reserved key so it can't collide with an admin param key.
    attributes: withClientOpId({ ...(parameters ?? {}), ...(offlineTime ? { __offlineEntry: true } : {}) }, clientOpId),
    deviationDetails: { type: 'BYPASS', fromState, toState: targetState, justification },
    remarks: justification,
  };
  const checksum = computeChecksum(eventData);

  await prisma.$transaction(async (tx) => {
    // Phase 5b.4: SELECT FOR UPDATE row lock — prevents concurrent bypass
    // and concurrent advance from interleaving on the same filter.
    // Phase 8.7 follow-up: also rechecks current_cycle_id (was missing — see
    // AUDIT-2026-05-02-concurrent-operator.md). A cycle-id swap behind a
    // bypass write would otherwise silently record BYPASS_DEVIATION against
    // the pre-lock cycle.
    await lockAndVerifyFilterState(tx, filterId, fromState, filterCurrentCycleId);

    await tx.filterEvent.create({
      data: {
        ...eventData,
        checksum,
        ipAddress: ctx.ipAddress,
        telemetrySnapshot: {},
        ...(offlineTime ? { performedAt: offlineTime } : {}),
      },
    });

    // currentLifecycleState moved to FilterDetails (Step 6).
    await tx.filterDetails.update({
      where: { assetInstanceId: filterId },
      data: { currentLifecycleState: targetState },
    });

    // Audit §1.1 (2026-05-16): audit-write inside business tx.
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'BYPASS_DEVIATION',
      targetType: 'filter', targetId: filterId,
      beforeValue: { state: fromState },
      afterValue: { state: targetState, justification },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    }, tx);
  });

  return service.getCurrentState(ctx, filterId);
}
