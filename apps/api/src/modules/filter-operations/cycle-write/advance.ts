/**
 * Filter Operations — advance() implementation.
 *
 * Extracted byte-for-byte from filter-operations.service.ts. Largest of the
 * write methods: pure-guard chain → equipment-group / instrument-readings
 * resolution (against pinned snapshot or live group) → in-tx row lock →
 * mutation + auto-complete on END.
 *
 * 2026-07-16 — split into `prepareAdvance` (validate + read, NO writes) and
 * `executeAdvanceTx` (all mutations, caller-supplied tx) so the atomic
 * advance+checklist op (`advance-with-checklist.ts`) can compose this with
 * `submit-checklist.ts` inside ONE transaction. `advanceImpl` is unchanged
 * behaviour: prepare + own tx + post-commit notify.
 *
 * The equipment-group lazy-bind used to write to `cleaning_cycles` BEFORE the
 * transaction opened (old :240-243). That made "prepare performs no writes"
 * false and would have leaked out of the composed op's atomicity — a rolled-back
 * advance+checklist would still have left the group binding behind. The READ that
 * resolves the group stays in prepare; the WRITE moved into `executeAdvanceTx`.
 */
import type { Prisma } from '@prisma/client';
import type { RequestContext } from '../../../types/context.js';
import { prisma } from '../../../lib/prisma.js';
import { auditLog } from '../../../lib/audit.js';
import { stripHtml } from '../../../lib/sanitize.js';
import { AppError } from '../../../lib/errors.js';
import { findExistingByClientOpId, withClientOpId } from '../../../lib/idempotency.js';
import { validateOfflinePerformedAt } from '../../../lib/offline-time-window.js';
import { loadLocalContext, throwIfFailed } from '../local-context.js';
import * as executor from '@digilog/shared';
import { computeChecksum, collectChecklistsAfterStage, prettyStageLabel, toLocalDateString } from '../helpers.js';
import { lockAndVerifyFilterState } from './locking.js';
import { validateAdvanceBlock } from '../filter-resolver.js';
import {
  getInterlockConfig,
  isInterlockStage,
  getApproverRoleForStage,
  assertStageApprovedToLeave,
  collectFilterApprovalDetails,
  requestStageApprovalTx,
  notifyStageApprovalRequested,
  type FilterApprovalDetails,
} from '../stage-interlock.js';
import type { FilterOperationsService } from '../filter-operations.service.js';

type TxClient = Prisma.TransactionClient;

/** Everything `executeAdvanceTx` needs. Built by `prepareAdvance` with no writes. */
export interface AdvancePlan {
  filterId: string;
  ctx: RequestContext;
  cycleId: string;
  sequenceNumber: number;
  /** Live stage at prepare time — the lock verifies against this. */
  currentState: string | null;
  targetState: string;
  fromState: string | null;
  eventData: Record<string, any>;
  checksum: string;
  offlineTime: Date | null;
  clientOpId: string | null;
  /** Explicit caller-supplied group to bind when the cycle has none yet. */
  bindEquipmentGroupId: string | null;
  /** Lazy-bind resolved from the block's single active group (was a pre-tx write). */
  lazyBind: { groupId: string; versionPin: number } | null;
  dryerAction: string | null;
  dryerDurationMinutes: number | null;
  dryerStartedAt: Date | null;
  enteringInterlock: boolean;
  interlockSnapshot: FilterApprovalDetails | null;
  interlockApproverRole: string | null;
  /** advance's OWN completion. False when a checklist defers it (composed or not). */
  completesCycle: boolean;
}

export type AdvancePrep =
  | { kind: 'dedup' }
  | { kind: 'plan'; plan: AdvancePlan };

export interface PrepareAdvanceOpts {
  /**
   * A checklist for `targetState` is being submitted in the SAME transaction.
   *
   * Only affects the INTERLOCK decisions: `hasPendingChecklistAfterTarget`
   * normally keeps `willComplete` false, which both suppresses the
   * INTERLOCK_TERMINAL_STAGE 422 and raises a PENDING approval. When the
   * checklist lands in this tx the cycle genuinely DOES complete here, so the
   * interlock must judge against that. Closes the terminal-interlock hole for
   * the composed path (the bare two-request path still has it — tracked
   * separately, see ATOMIC-ADVANCE-CHECKLIST-PLAN.md).
   *
   * Does NOT affect `completesCycle`: the checklist half still owns completion,
   * exactly as in the two-request flow.
   */
  composedWithChecklist?: boolean;
  /** Composed path dedups once, here, on the shared clientOpId. */
  skipDedup?: boolean;
}

/** @param data - Validated by Fastify JSON schema before reaching this method */
export async function prepareAdvance(
  service: FilterOperationsService,
  ctx: RequestContext,
  filterId: string,
  data: any,
  opts: PrepareAdvanceOpts = {},
): Promise<AdvancePrep> {
  const { targetState, parameters, equipmentId, cleaningAreaId, instrumentReadings, equipmentGroupId, dryerAction, dryerDurationMinutes } = data;
  // Use the canonical `stripHtml` (sanitize-html under the hood) instead of
  // hand-rolled `<` / `>` escapes. The hand-rolled version missed entity-
  // encoded payloads, `javascript:` URIs, and event handlers. Other modules
  // (admin-requests, auth, assets) already use this helper — bringing
  // cycle-write into the same input-sanitization contract.
  const remarks = typeof data.remarks === "string" ? stripHtml(data.remarks) : data.remarks;
  const clientOpId: string | null = data.clientOpId ?? null;

  // Phase 8.5 Commit 3: drop pure guards through the shared executor.
  const { ctx: localCtx, cp, rawCycle: cycle, filterCurrentCycleId } = await loadLocalContext(filterId, ctx);

  // Cycle-scoped clientOpId dedup (audit §1.10): a replay with the same opId
  // for the same cycle is a no-op success; the same opId across different
  // cycles cannot collide. Run AFTER loadLocalContext so we have the
  // current cycle id; same pattern as submit-checklist.ts.
  if (!opts.skipDedup && clientOpId && filterCurrentCycleId
    && await findExistingByClientOpId(filterId, clientOpId, filterCurrentCycleId)) {
    return { kind: 'dedup' };
  }
  throwIfFailed(executor.assertCycleActive(localCtx));

  // Server-only: cycle must be IN_PROGRESS (live state).
  if (!cycle || cycle.status !== 'IN_PROGRESS') {
    throw new AppError(400, 'NO_ACTIVE_CYCLE', 'No active cleaning cycle found');
  }

  // Block guard (2026-06-06): the cycle's block is frozen at start. Reject a
  // stage submitted for a DIFFERENT block (config-gated). Pure pre-write gate
  // — throws before any cycle mutation; does not touch stage/cycle mechanics.
  await validateAdvanceBlock({ filterId, cleaningAreaId: cycle.cleaningAreaId }, cleaningAreaId);

  // Validate offlinePerformedAt against cycle.startedAt floor + replay-only +
  // future-skew + max-staleness. Audit 2026-05-04 fix C2 — see
  // apps/api/src/lib/offline-time-window.ts.
  const offlineTime = validateOfflinePerformedAt(data.offlinePerformedAt, {
    isReplay: ctx.isOfflineReplay === true,
    cycleStartedAt: cycle.startedAt,
  });

  throwIfFailed(executor.assertTapeVersionFresh(localCtx, data.tapeVersion));
  throwIfFailed(executor.assertProfileAssigned(localCtx, cp?.id));

  // 2026-06-09: an IN-PROGRESS cycle pins its cleaning profile at start
  // (cleaning_cycles.profileId is frozen). Do NOT require that profile to still
  // be ACTIVE here — disabling a profile must never strand cycles already running
  // on it. Operators were blocked from finishing a cycle with "Cleaning profile
  // is disabled" after an admin deactivated the profile mid-cycle. NEW cycle
  // starts still require an ACTIVE profile (start-cycle.ts). cp is only null if
  // the pinned profile ROW is missing (deleted), which is a genuine error.
  if (!cp) {
    throw new AppError(400, 'NO_PROFILE', 'This cycle has no cleaning profile (the pinned profile record is missing).');
  }

  const currentState = localCtx.filter.currentLifecycleState;

  // Pending checklist gate (frozen at cycle start per A5).
  throwIfFailed(executor.assertChecklistGatePassed(localCtx, localCtx.profile, currentState));

  // Stage interlock — leave-gate (QA approval after WASH_OUT / DRY_OUT).
  // Cannot leave an interlock stage until the latest approval for (cycle, stage)
  // is APPROVED. Config fetched once and reused for the entry step below. No-op
  // when interlock is disabled or fromState is not a gated stage.
  //
  // OFFLINE EXEMPTION (2026-06-15, per user): the interlock is an ONLINE-only QA
  // checkpoint. An operator working offline can't reach an approver, so offline
  // work must NOT be gated — otherwise queued advances poison the sync. On replay
  // (ctx.isOfflineReplay) we skip the leave-gate; the state transition + its
  // offlinePerformedAt audit row are still recorded.
  const interlockConfig = await getInterlockConfig();
  if (!ctx.isOfflineReplay) {
    await assertStageApprovedToLeave({
      cycleId: cycle.id,
      fromState: currentState,
      targetState,
      config: interlockConfig,
    });
  }

  // Compute reachable stages + END detection from pipeline graph.
  const fromNodeForReachability = currentState
    ? localCtx.profile.nodes.find(s => s.stateKey === currentState)
      ?? localCtx.profile.nodes.find(s => s.nodeType === 'START')
    : localCtx.profile.nodes.find(s => s.nodeType === 'START');
  const { reachableStages, hasEndNext } = fromNodeForReachability
    ? executor.findReachable(fromNodeForReachability.id, localCtx.profile.nodes, localCtx.profile.edges)
    : { reachableStages: [] as string[], hasEndNext: false };

  throwIfFailed(executor.assertNotCycleComplete(localCtx, reachableStages, hasEndNext));
  // Dryer-in-place exception: SET_DURATION / SUBMIT_READINGS at DRY_IN -> DRY_IN.
  const isDryerInPlace = !!dryerAction && targetState === 'DRY_IN' && currentState === 'DRY_IN';
  throwIfFailed(
    executor.assertTargetStateReachable(
      localCtx,
      targetState,
      reachableStages,
      cp.flowMode,
      isDryerInPlace,
      currentState,
    ),
  );
  throwIfFailed(executor.assertTargetStateExists(localCtx, targetState, localCtx.profile));

  // Resolve targetStage (post-existence check) for the in-tx END walk.
  const targetStage = cp.stages.find(s => s.stateKey === targetState)!;

  // PARAM_CAPTURE block validation (pure).
  const paramDefs = executor.extractParameterDefs(localCtx.profile.nodes);
  throwIfFailed(executor.assertParametersRequired(localCtx, parameters, paramDefs));
  throwIfFailed(executor.assertParametersInRange(localCtx, parameters, paramDefs));

  const fromState = currentState;

  // Equipment-group existence check when provided + not yet bound (server I/O).
  if (equipmentGroupId && !cycle.equipmentGroupId) {
    const eqGroup = await prisma.equipmentGroup.findFirst({
      where: { id: equipmentGroupId, isActive: true },
      select: { id: true, isActive: true },
    });
    throwIfFailed(executor.assertEquipmentGroupValid(localCtx, equipmentGroupId, eqGroup));
  }

  // Dryer guards (pure).
  throwIfFailed(executor.assertDryerActionValid(localCtx, dryerAction, targetState));
  if (dryerAction === 'SET_DURATION') {
    throwIfFailed(executor.assertDryerDurationValid(localCtx, dryerDurationMinutes));
  }
  throwIfFailed(executor.assertInDryInForReadings(localCtx, currentState, dryerAction));
  throwIfFailed(executor.assertDryerStarted(localCtx, localCtx.cycle, dryerAction));
  throwIfFailed(
    executor.assertDryerHalfTimeElapsed(localCtx, localCtx.cycle, dryerAction, offlineTime ?? null),
  );
  throwIfFailed(
    executor.assertDryerHalfTimeBeforeLeavingDryIn(
      localCtx,
      localCtx.cycle,
      currentState,
      targetState,
      offlineTime ?? null,
    ),
  );
  // 2026-05-25: require the SUBMIT_READINGS submission before leaving DRY_IN.
  // The half-time guard alone was letting cycles auto-advance once the timer
  // elapsed even though no actual temperature reading was recorded — a 21
  // CFR Part 11 gap reported by an operator the same day.
  throwIfFailed(
    executor.assertDryerReadingsSubmittedBeforeLeavingDryIn(
      localCtx.cycle,
      currentState,
      targetState,
    ),
  );

  // 2026-06-09 (per user): Wash In cannot be completed without the equipment-group
  // instrument readings WHEN the cleaning block has an active equipment group.
  // (Blocks with no equipment group have nothing to record → allowed without.)
  if (targetState === 'WASH_IN') {
    const hasReadings = !!instrumentReadings && typeof instrumentReadings === 'object'
      && Object.keys(instrumentReadings).length > 0;
    if (!hasReadings) {
      const hasGroup = (equipmentGroupId || cycle.equipmentGroupId)
        ? true
        : cycle.cleaningAreaId
          ? (await prisma.equipmentGroup.count({ where: { blockId: cycle.cleaningAreaId, isActive: true } })) > 0
          : false;
      if (hasGroup) {
        throw new AppError(400, 'WASH_IN_READINGS_REQUIRED',
          'Wash In requires the equipment-group instrument readings to be submitted before it can be completed.');
      }
    }
  }

  // Validate instrument readings if provided.
  let validatedReadings: any = null;
  let lazyBind: { groupId: string; versionPin: number } | null = null;
  if (instrumentReadings && typeof instrumentReadings === 'object' && Object.keys(instrumentReadings).length > 0) {
    let cycleGroupId = equipmentGroupId ?? cycle.equipmentGroupId;
    // Three pin sources (priority): cycle pin → lazy-bind live group version → null (legacy).
    // #eqpin (2026-07-04): the pin was frozen against cycle.equipmentGroupId. Only
    // honour it when we're validating THAT group. If the caller supplies a different
    // equipmentGroupId (an advance-time override), the pin doesn't apply to it — drop
    // to null so we lazy-bind / use live for the overriding group instead of matching
    // the wrong group against a stale version number. Defensive: normal advances pass
    // no override, so cycleGroupId === cycle.equipmentGroupId and the pin is kept.
    let cycleVersionPin: number | null =
      cycleGroupId && cycleGroupId === cycle.equipmentGroupId
        ? (cycle.equipmentGroupVersionPin ?? null)
        : null;

    // Auto-resolve: if no group on cycle but block is known, pick the block's active group.
    // Hybrid guard #30 — pure portion (count <= 1) wraps the live DB read.
    if (!cycleGroupId && cycle.cleaningAreaId) {
      const blockGroups = await prisma.equipmentGroup.findMany({
        where: { blockId: cycle.cleaningAreaId, isActive: true },
        select: { id: true, version: true },
      });
      throwIfFailed(executor.assertSingleEquipmentGroupPerBlock(localCtx, blockGroups.length));
      if (blockGroups.length === 1) {
        cycleGroupId = blockGroups[0].id;
        cycleVersionPin = blockGroups[0].version; // P1: pin at lazy-bind moment
        // 2026-07-16: this used to `prisma.cleaningCycle.update(...)` right here,
        // OUTSIDE the transaction. Deferred to executeAdvanceTx so prepare stays
        // write-free and the binding rolls back with the rest of a composed op.
        lazyBind = { groupId: cycleGroupId, versionPin: cycleVersionPin };
      }
    }
    throwIfFailed(executor.assertEquipmentGroupSelected(localCtx, cycleGroupId));

    // P1 (2026-05-02): validate against frozen snapshot when pinned, live row otherwise.
    let stageInstruments: any[];
    if (cycleVersionPin !== null) {
      const versionRow = await prisma.equipmentGroupVersion.findUnique({
        where: { groupId_versionNumber: { groupId: cycleGroupId!, versionNumber: cycleVersionPin } },
      });
      if (versionRow) {
        const snap = versionRow.snapshot as { instruments: any[] };
        const readingsStageKey = dryerAction === 'SUBMIT_READINGS' ? 'DRY_IN' : targetState;
        stageInstruments = (snap.instruments ?? [])
          .filter((i: any) => i.stageKey === readingsStageKey)
          .sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      } else {
        // Pin set but no version row — pin is for current live row (lazy first-version).
        const eqGroup = await prisma.equipmentGroup.findUnique({
          where: { id: cycleGroupId! },
          include: { instruments: { orderBy: { sortOrder: 'asc' } } },
        });
        if (!eqGroup) throw new AppError(400, 'INVALID_EQUIPMENT_GROUP', 'Equipment group not found');
        // Hybrid guard #32 — pure portion compares pin/live version.
        throwIfFailed(
          executor.assertEquipmentGroupVersionExists(localCtx, cycleVersionPin, eqGroup.version, false),
        );
        const readingsStageKey = dryerAction === 'SUBMIT_READINGS' ? 'DRY_IN' : targetState;
        stageInstruments = eqGroup.instruments.filter(i => i.stageKey === readingsStageKey);
      }
    } else {
      // Legacy fallback (pre-P1 cycle).
      const eqGroup = await prisma.equipmentGroup.findUnique({
        where: { id: cycleGroupId! },
        include: { instruments: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!eqGroup) throw new AppError(400, 'INVALID_EQUIPMENT_GROUP', 'Equipment group not found');
      const readingsStageKey = dryerAction === 'SUBMIT_READINGS' ? 'DRY_IN' : targetState;
      stageInstruments = eqGroup.instruments.filter(i => i.stageKey === readingsStageKey);
    }

    validatedReadings = [];
    for (const inst of stageInstruments) {
      const reading = instrumentReadings[inst.id];
      // Required + numeric are still hard guards (#27/#28).
      throwIfFailed(executor.assertInstrumentReadingRequired(localCtx, reading, inst));
      throwIfFailed(executor.assertInstrumentReadingValid(localCtx, reading, inst));
      const val = Number(reading);
      // Out-of-range (#29) is NO LONGER a hard reject (2026-06-13, user decision):
      // the operator confirms an out-of-range reading on the client, and we record
      // it as a deviation here (outOfRange flag + the operating range) for the 21
      // CFR audit trail, instead of blocking the submit. Capture, don't throw.
      const rangeCheck = executor.assertInstrumentReadingInRange(localCtx, val, inst);
      validatedReadings.push({
        instrumentId: inst.id,
        instrumentCode: inst.instrumentId,
        description: inst.description,
        value: val,
        uom: inst.uom,
        leastCount: inst.leastCount,
        ...(rangeCheck.ok ? {} : { outOfRange: true, operatingMin: inst.operatingMin, operatingMax: inst.operatingMax }),
      });
    }
  }

  // Fold the dryer-action info into the main event's attributes so that
  // SET_DURATION emits ONE filter_event row, not two. The previous code
  // wrote a separate "DRYER_STARTED" STATE_TRANSITION inside the same tx
  // (lines below, now removed), both stamped with the same clientOpId.
  // That broke server-side idempotency-by-clientOpId — a single op produced
  // two audit rows with identical clientOpId 14ms apart — and bloated the
  // immutable trail with redundant transitions (see test 2026-05-18
  // cycle CC-fffffff-00-003 at 16:42:54).
  //
  // Offline-cycle correctness (2026-05-18): when SET_DURATION is replayed
  // from an offline queue, stamp dryer_started_at with the offline
  // timestamp, not server NOW. Otherwise the FOLLOWING op in the queue
  // (advance DRY_IN → STORAGE_IN, also stamped with an offline
  // performedAt) will fail assertDryerHalfTimeBeforeLeavingDryIn because
  // (offlinePerformedAt - serverNow) is negative or tiny. With offline
  // anchor, the subsequent op compares two offline timestamps and the
  // half-time guard passes for cycles the operator actually waited out.
  const dryerStartedAt = dryerAction === 'SET_DURATION' ? (offlineTime ?? new Date()) : null;
  const eventAttributes = withClientOpId({
    ...(parameters ?? {}),
    ...(validatedReadings ? { instrumentReadings: validatedReadings } : {}),
    ...(dryerAction === 'SET_DURATION' ? { action: 'DRYER_STARTED', dryerDurationMinutes, dryerStartedAt: dryerStartedAt!.toISOString() } : {}),
    ...(dryerAction === 'SUBMIT_READINGS' ? { action: 'DRYER_READINGS_SUBMITTED' } : {}),
    // 2026-07-10 (per user): durably mark a stage-entry performed OFFLINE. The
    // stage interlock never gates offline work, so the self-heal in
    // current-state.ts reads this to avoid manufacturing a PENDING approval when
    // an online poll catches a filter that reached a gated stage offline.
    // Reserved key (double-underscore) so it can never collide with a free-form
    // admin-configured PARAM_CAPTURE parameter key.
    ...(offlineTime ? { __offlineEntry: true } : {}),
  }, clientOpId);

  // Dryer-readings submission is recorded as a STATE_TRANSITION row but
  // the filter never actually leaves DRY_IN (isDryerInPlace). Storing
  // fromState=toState=DRY_IN reads as "DRY_IN → DRY_IN" in the audit UI,
  // which misleads inspectors into thinking a transition happened. Set
  // fromState=null when no transition actually occurs; the `action`
  // attribute already labels the event correctly.
  const persistedFromState = isDryerInPlace ? null : fromState;
  const eventData = {
    filterId, cycleId: cycle.id, eventType: 'STATE_TRANSITION' as const,
    fromState: persistedFromState, toState: targetState,
    performedBy: ctx.userSub,
    cleaningAreaId: cleaningAreaId ?? null,
    equipmentId: equipmentId ?? null,
    attributes: eventAttributes,
    remarks: dryerAction === 'SET_DURATION'
      ? (remarks ?? `Dryer started for ${dryerDurationMinutes} minute(s)`)
      : (remarks ?? null),
  };
  const checksum = computeChecksum(eventData);

  // Check if target stage leads to END (walking through any CHECKLIST nodes).
  // Cross-cutting cleanup: was an inline recursive `checkEnd` walker; replaced
  // with the canonical `executor.findReachable` (packages/shared/src/
  // pipeline-executor/transitions.ts:279) — same semantics, single source of
  // truth shared with submit-checklist.ts and current-state.ts.
  const reachFromTarget = executor.findReachable(targetStage.id, localCtx.profile.nodes, localCtx.profile.edges);
  const leadsToEnd = reachFromTarget.hasEndNext;
  const hasMoreStages = reachFromTarget.reachableStages.length > 0;

  // Defer auto-complete when an active CHECKLIST node sits between the
  // target stage and END. Without this, pipelines like WASH_IN→CHECKLIST→END
  // would complete the cycle the instant the operator advances to WASH_IN,
  // never letting them answer the post-stage checklist. submitChecklist
  // performs the completion in that case instead.
  let hasPendingChecklistAfterTarget = false;
  if (leadsToEnd && !hasMoreStages) {
    const postNodes = collectChecklistsAfterStage(targetStage, cp.stages, cp.connections)
      .filter(n => (n.configuration as any)?.checklistProfileId);
    const postProfileIds = [...new Set(postNodes.map(n => (n.configuration as any).checklistProfileId).filter(Boolean))] as string[];
    if (postProfileIds.length > 0) {
      const active = await prisma.checklistProfile.findMany({
        where: { id: { in: postProfileIds }, isActive: true },
        select: { id: true },
      });
      hasPendingChecklistAfterTarget = active.length > 0;
    }
  }

  // advance's OWN completion — unchanged. When a checklist follows the target
  // stage the checklist half completes the cycle, composed or not.
  const completesCycle = leadsToEnd && !hasMoreStages && !hasPendingChecklistAfterTarget;

  // Stage interlock — entry step. When this advance ENTERS an interlock stage
  // (WASH_OUT / DRY_OUT) and the cycle is NOT auto-completing here, a PENDING
  // approval is created inside the tx (atomic with the state change) so there is
  // no window where the filter sits at the gated stage with no gate. The details
  // snapshot (DB reads) is gathered BEFORE the tx; the notification fires AFTER
  // commit (best-effort).
  //
  // 2026-07-16: interlock judges against whether the CYCLE completes here, which
  // in the composed path includes the checklist landing in the same tx. In the
  // bare path `composedWithChecklist` is false and this is identical to
  // `completesCycle` — i.e. unchanged behaviour for every existing caller.
  const cycleWillComplete = leadsToEnd && !hasMoreStages
    && (!hasPendingChecklistAfterTarget || opts.composedWithChecklist === true);

  // #5 fix (audit 2026-07-04): a terminal interlock stage — WASH_OUT / DRY_OUT that
  // leads straight to END — would auto-complete with NO QA sign-off. `willComplete`
  // zeroes `enteringInterlock` below, so no PENDING CleaningStageApproval is ever
  // created and the interlock gate ("no filter leaves WASH_OUT/DRY_OUT without QA
  // approval") is silently defeated. Fail SAFE: reject the completing advance rather
  // than complete without the required approval (21 CFR §11). An admin must add a
  // stage after the interlock point or disable the interlock. Offline replay is
  // exempt (offline work is never gated — same carve-out as `enteringInterlock`).
  if (interlockConfig.enabled && isInterlockStage(targetState) && cycleWillComplete && !ctx.isOfflineReplay) {
    throw new AppError(
      422,
      'INTERLOCK_TERMINAL_STAGE',
      `This cleaning cycle would complete directly out of ${prettyStageLabel(targetState)}, but the QA stage interlock is enabled for that stage — a filter cannot complete a cycle without the required QA approval. An administrator must add a stage after ${prettyStageLabel(targetState)} or disable the stage interlock.`,
    );
  }

  // Offline exemption (see leave-gate note above): don't raise the gate for an
  // offline-replayed entry into WASH_OUT / DRY_OUT — offline work isn't gated, so
  // creating a PENDING approval would leave a stuck request no operator can clear.
  const enteringInterlock =
    interlockConfig.enabled && isInterlockStage(targetState) && !cycleWillComplete && !ctx.isOfflineReplay;
  let interlockSnapshot: FilterApprovalDetails | null = null;
  const interlockApproverRole: string | null = enteringInterlock
    ? getApproverRoleForStage(targetState, interlockConfig)
    : null;
  if (enteringInterlock) {
    interlockSnapshot = await collectFilterApprovalDetails(filterId);
  }

  return {
    kind: 'plan',
    plan: {
      filterId,
      ctx,
      cycleId: cycle.id,
      sequenceNumber: cycle.sequenceNumber,
      currentState,
      targetState,
      fromState,
      eventData,
      checksum,
      offlineTime: offlineTime ?? null,
      clientOpId,
      bindEquipmentGroupId: (equipmentGroupId && !cycle.equipmentGroupId) ? equipmentGroupId : null,
      lazyBind,
      dryerAction: dryerAction ?? null,
      dryerDurationMinutes: dryerDurationMinutes ?? null,
      dryerStartedAt,
      enteringInterlock,
      interlockSnapshot,
      interlockApproverRole,
      completesCycle,
    },
  };
}

/**
 * Apply a prepared advance inside the caller's transaction. Returns the created
 * PENDING stage approval (if any) so the caller can notify AFTER commit.
 */
export async function executeAdvanceTx(tx: TxClient, plan: AdvancePlan): Promise<{ id: string } | null> {
  const {
    filterId, ctx, cycleId, currentState, targetState, fromState,
    eventData, checksum, offlineTime, dryerAction, dryerDurationMinutes, dryerStartedAt,
  } = plan;

  // SELECT ... FOR UPDATE on the FilterDetails row blocks any concurrent
  // advance/bypass on this filter until this transaction commits. Closes
  // the read-then-write race where two operators on two devices could both
  // pass the state check and both write STAGE_TRANSITIONED.
  await lockAndVerifyFilterState(tx, filterId, currentState, cycleId);

  // Update equipment group if provided and not yet set
  if (plan.bindEquipmentGroupId) {
    await tx.cleaningCycle.update({
      where: { id: cycleId },
      data: { equipmentGroupId: plan.bindEquipmentGroupId },
    });
  }

  // Lazy-bound group + version pin resolved in prepare (was a pre-tx write).
  if (plan.lazyBind) {
    await tx.cleaningCycle.update({
      where: { id: cycleId },
      data: {
        equipmentGroupId: plan.lazyBind.groupId,
        equipmentGroupVersionPin: plan.lazyBind.versionPin,
      },
    });
  }

  // Dryer SET_DURATION: persist duration + start time on the cycle row.
  // The DRYER_STARTED audit info is now folded into the main advance event
  // (see eventAttributes above) — emitting a separate row here would
  // duplicate the audit-trail with two state transitions per advance and
  // break clientOpId-based idempotency.
  if (dryerAction === 'SET_DURATION') {
    await tx.cleaningCycle.update({
      where: { id: cycleId },
      data: { dryerDurationMinutes: dryerDurationMinutes!, dryerStartedAt: dryerStartedAt! },
    });
  }

  await tx.filterEvent.create({
    data: {
      ...(eventData as any),
      checksum,
      ipAddress: ctx.ipAddress,
      telemetrySnapshot: {},
      ...(offlineTime && { performedAt: offlineTime }),
    },
  });

  // Mark dryer readings as submitted (DRY_IN stays, user advances to DRY_OUT later)
  if (dryerAction === 'SUBMIT_READINGS') {
    await tx.cleaningCycle.update({
      where: { id: cycleId },
      data: { dryerReadingsSubmitted: true },
    });
  }

  // currentLifecycleState moved to FilterDetails (Step 6).
  await tx.filterDetails.update({
    where: { assetInstanceId: filterId },
    data: { currentLifecycleState: targetState },
  });

  // Stage interlock — raise the gate on entry (atomic with the state change).
  let approvalRow: { id: string } | null = null;
  if (plan.enteringInterlock && plan.interlockSnapshot && plan.interlockApproverRole) {
    approvalRow = await requestStageApprovalTx(tx, {
      cycleId,
      filterId,
      stageKey: targetState,
      approverRole: plan.interlockApproverRole,
      detailsSnapshot: plan.interlockSnapshot,
      ctx,
    });
  }

  if (plan.completesCycle) {
    const completedAt = offlineTime ?? new Date();
    await tx.cleaningCycle.update({
      where: { id: cycleId },
      data: { status: 'COMPLETED', completedAt },
    });
    // 2026-06-02: completion now leaves the filter in the terminal
    // CLEANING_CYCLE_COMPLETED state (was null/Idle). currentCycleId is still
    // cleared, so getCurrentState/start-cycle treat the filter as available
    // (both key off currentCycleId, not the lifecycle label).
    await tx.filterDetails.update({
      where: { assetInstanceId: filterId },
      data: { currentCycleId: null, currentLifecycleState: 'CLEANING_CYCLE_COMPLETED' },
    });
    // Stamp the typed filter's lastCleaningDate to the completion day so the
    // "Last Cleaned" column reflects the just-finished cycle. Uses offlineTime
    // (not server-now) for offline replay, per the dryer-anchor rule. jsonb_set
    // merges — other field-option attributes are preserved. The filters→
    // asset_instances mirror trigger keeps the legacy row in sync.
    // LOCAL calendar day (not toISOString/UTC) so a completion near local
    // midnight isn't stamped a day early — see toLocalDateString.
    const cleanDate = toLocalDateString(completedAt);
    await tx.$executeRaw`UPDATE filters SET attributes = jsonb_set(COALESCE(attributes, '{}'::jsonb), '{lastCleaningDate}', to_jsonb(${cleanDate}::text), true) WHERE id = ${filterId}::uuid`;

    const completeEvent = {
      filterId, cycleId, eventType: 'CYCLE_COMPLETED' as const,
      performedBy: ctx.userSub, attributes: withClientOpId({ sequenceNumber: plan.sequenceNumber }, plan.clientOpId),
    };
    await tx.filterEvent.create({
      data: {
        ...completeEvent,
        checksum: computeChecksum(completeEvent),
        ipAddress: ctx.ipAddress,
        telemetrySnapshot: {},
      },
    });
  }

  // Audit §1.1 (2026-05-16): audit-write inside business tx.
  await auditLog({
    userId: ctx.userId, userRole: ctx.userRole, action: 'STATE_TRANSITION',
    targetType: 'filter', targetId: filterId,
    beforeValue: { state: fromState },
    afterValue: { state: targetState },
    ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
  }, tx);

  return approvalRow;
}

/**
 * Post-commit, best-effort approver notification. Extracted so the composed op
 * fires the identical notification after ITS transaction commits.
 */
export async function notifyAdvanceInterlock(
  plan: AdvancePlan,
  createdApproval: { id: string } | null,
): Promise<void> {
  if (createdApproval && plan.interlockApproverRole) {
    await notifyStageApprovalRequested(
      { id: createdApproval.id, filterId: plan.filterId, stageKey: plan.targetState, approverRole: plan.interlockApproverRole },
      plan.interlockSnapshot?.filterName ?? null,
      plan.ctx,
    );
  }
}

/** @param data - Validated by Fastify JSON schema before reaching this method */
export async function advanceImpl(
  service: FilterOperationsService,
  ctx: RequestContext,
  filterId: string,
  data: any,
) {
  const prep = await prepareAdvance(service, ctx, filterId, data);
  if (prep.kind === 'dedup') return service.getCurrentState(ctx, filterId);

  // Captured from the transaction's return value (TS can't narrow a variable
  // mutated inside the async tx closure, so the approval is returned out).
  const createdApproval = await prisma.$transaction(async (tx) => executeAdvanceTx(tx, prep.plan));

  // Best-effort: notify the approver role that a stage is awaiting approval.
  // After commit so a notification failure never rolls back the cycle write.
  await notifyAdvanceInterlock(prep.plan, createdApproval);

  return service.getCurrentState(ctx, filterId);
}
