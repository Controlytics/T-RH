/**
 * Offline-gate validation — single source of truth for the desktop +
 * tablet filter-operations pages.
 *
 * Mobile previously owned this as `validateOfflineGate` (an inner closure in
 * `mobile-operations.tsx`); desktop had the same logic INLINED in
 * `handleSubmitBatch`. Phase 8.7 Wave-5 split lifts the function out so the
 * two implementations cannot drift again.
 *
 * ── What it gates ─────────────────────────────────────────────────────────
 *
 *   1. Stale cache: offline + no graph + no linear pipeline + empty tape
 *      → "offline data not cached" (refuse).
 *   2. Cross-block scan: home-block ≠ selected-block AND no APPROVED block
 *      change → block-change required (refuse + signal that the caller
 *      should pop the structured modal).
 *   3. Cycle-start at illegal first stage: walks the cached pipeline graph
 *      from its START node via the shared executor's `findReachable` helper
 *      and confirms `activeStageKey` is one of the legal entry points.
 *   4. In-cycle wrong stage: `activeStageKey` must appear as an
 *      `ADVANCE_TO_STAGE` (or `SET_DRYER_DURATION`) target on the resolved
 *      action tape.
 *   5. Stale in-cycle cache: offline + cycle-in-progress + no advance
 *      actions on tape AND no checklist gate → "in-cycle but no next stage".
 *   6. DRY_IN already recorded: dryerReadingsSubmitted=true on the cycle
 *      → "scan on Dry Out".
 *
 * Reachability decisions read the action tape (server `actions[]` when
 * TAPE_PARALLEL is on, else `executor.computeNextActions(ctx)` resolved by
 * `getCurrentActions()`). The legacy `nextAllowed` string list is preserved
 * on the input shape as an emptiness indicator for the "stale cache"
 * detector, but stage-membership decisions go through `actionsForStage()`.
 */

import { findReachable as sharedFindReachable, type Action } from '@digilog/shared';
import { actionsForStage } from '@/lib/action-tape';

export interface GateInput {
  activeStageKey: string;
  activeStageLabel: string;
  online: boolean;
  currentLifecycle: string | null;
  actions: Action[];
  hasGraph: boolean;
  hasLinearPipeline: boolean;
  pipelineGraph: any;
  cycleInProgress: boolean;
  hasPendingChecklist: boolean;
  dryerReadingsSubmitted?: boolean;
  dryerStartedAt?: string | Date | null;
  dryerDurationMinutes?: number | null;
  homeBlockId?: string | null;
  blockChangeStatus?: string | null;
  selectedBlockId?: string | null;
  /** Filter is under an AHU with an overdue replacement — block a cycle START. */
  replacementBlocked?: boolean;
}

export type GateResult =
  | { ok: true }
  | { ok: false; reason: string; blockChangeRequired?: boolean };

/**
 * Walk the cached pipeline graph from its START node and return the legal
 * first stages. Used for cycle-start gating; both desktop + mobile previously
 * inlined this same walk. Empty array when the graph or START node is missing.
 */
export function firstStagesFromGraph(
  graph: { stages?: any[]; connections?: any[] } | null | undefined,
): string[] {
  if (!graph?.stages || !graph?.connections) return [];
  const startNode = graph.stages.find((s: any) => s.nodeType === 'START');
  if (!startNode) return [];
  return sharedFindReachable(startNode.id, graph.stages, graph.connections).reachableStages;
}

export function validateOfflineGate(g: GateInput): GateResult {
  // Reachable advance/bypass targets, derived from the resolved tape. When
  // the tape is empty AND we have no pipeline data, we're working from a
  // stale offline cache and refuse below.
  const advanceTargets = g.actions
    .filter((a) => a.type === 'ADVANCE_TO_STAGE' || a.type === 'SET_DRYER_DURATION')
    .map((a) => (a as { params: { targetState: string } }).params.targetState);
  const hasValidation = g.hasGraph || g.hasLinearPipeline || advanceTargets.length > 0;
  if (!g.online && !hasValidation) {
    return { ok: false, reason: 'offline data not cached — sync first' };
  }
  // AHU overdue-replacement gate (2026-07-16). START-only: an in-flight cycle is
  // never frozen (running cycles finish). The server is authoritative online;
  // this is the offline enforcement + an instant online message.
  if (!g.cycleInProgress && g.replacementBlocked) {
    return { ok: false, reason: 'AHU replacement overdue — replace this filter before cleaning' };
  }
  // 2026-06-09: OFFLINE never blocks cross-block. Per config, the confirm/approval
  // gate applies ONLINE only; offline the operation proceeds and the caller shows an
  // informational "belongs to another block" notice. (The old offline
  // block-change-required gate was removed here.)
  // First-stage validation for brand-new cycles. The action tape only
  // emits ADVANCE_TO_STAGE entries for in-progress cycles — for the
  // pre-cycle case we walk the cached pipeline graph from its START node
  // via the shared executor's `findReachable` helper (same walker the
  // server tape generator uses internally).
  if (!g.cycleInProgress && g.hasGraph) {
    const firstStages = firstStagesFromGraph(g.pipelineGraph);
    if (firstStages.length > 0 && !firstStages.includes(g.activeStageKey)) {
      return {
        ok: false,
        reason: `cannot start cycle at ${g.activeStageLabel} — start at ${firstStages
          .map((s: string) => s.replace(/_/g, ' '))
          .join(', ')}`,
      };
    }
  }
  // In-cycle: activeStage must appear as an ADVANCE_TO_STAGE target on the
  // current tape (also covers SET_DRYER_DURATION, since DRY_IN is a valid
  // advance target with the dryer-duration sub-action).
  if (g.cycleInProgress && advanceTargets.length > 0) {
    const advanceMatch = actionsForStage(g.activeStageKey, g.actions).some(
      (a) => a.type === 'ADVANCE_TO_STAGE' || a.type === 'SET_DRYER_DURATION',
    );
    if (!advanceMatch) {
      return {
        ok: false,
        reason: `is at ${(g.currentLifecycle ?? 'START').replace(/_/g, ' ')} — next allowed ${advanceTargets
          .map((s) => s.replace(/_/g, ' '))
          .join(', ')}`,
      };
    }
  }
  // Offline: cycle-in-progress + no advance actions is stale cache (unless checklist blocks)
  if (
    !g.online &&
    g.cycleInProgress &&
    advanceTargets.length === 0 &&
    !g.hasPendingChecklist
  ) {
    return { ok: false, reason: 'in-cycle but no next stage cached — re-sync' };
  }
  // DRY_IN guard
  if (g.activeStageKey === 'DRY_IN' && g.dryerReadingsSubmitted) {
    return { ok: false, reason: 'dry-in already recorded — scan on Dry Out' };
  }
  // Leaving-DRY_IN guard (2026-05-18): when the filter is at DRY_IN and the
  // operator scans a non-DRY_IN stage, mirror the server's
  // assertDryerHalfTimeBeforeLeavingDryIn + dryer-readings rules locally.
  // Otherwise the offline queue accepts the advance, syncs Wash In/Out + Dry
  // In, then the server rejects Storage In / Storage Out replay because
  // dryer half-time hasn't elapsed (dryer_started_at gets stamped at sync
  // moment). Operator sees "duration was still there" and the cycle stays
  // stuck mid-pipeline.
  if (g.currentLifecycle === 'DRY_IN' && g.activeStageKey !== 'DRY_IN') {
    if (!g.dryerStartedAt || !g.dryerDurationMinutes) {
      return { ok: false, reason: 'set the dryer duration before leaving Dry In' };
    }
    if (!g.dryerReadingsSubmitted) {
      const startedMs = new Date(g.dryerStartedAt).getTime();
      const halfMs = (g.dryerDurationMinutes * 60_000) / 2;
      const elapsedMs = Date.now() - startedMs;
      if (elapsedMs < halfMs) {
        const remainingMin = Math.max(1, Math.ceil((halfMs - elapsedMs) / 60_000));
        return { ok: false, reason: `dryer still running — wait ${remainingMin} more minute(s) before leaving Dry In` };
      }
      return { ok: false, reason: 'submit dryer temperature before leaving Dry In' };
    }
  }
  return { ok: true };
}
