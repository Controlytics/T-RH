/**
 * Filter Operations — startCycle() implementation.
 *
 * Extracted byte-for-byte from filter-operations.service.ts. Creates a new
 * CleaningCycle, snapshots checklist-profile versions for cycle-pinning
 * (Phase A.1), pins the equipment-group version (P1, 2026-05-02), records
 * CYCLE_STARTED, and updates FilterDetails.currentCycleId. No race lock —
 * uses an in-tx recheck against the previously-active cycle to prevent
 * concurrent double-start.
 */
import type { RequestContext } from '../../../types/context.js';
import { prisma } from '../../../lib/prisma.js';
import { auditLog } from '../../../lib/audit.js';
import { stripHtml } from '../../../lib/sanitize.js';
import { AppError } from '../../../lib/errors.js';
import { findExistingStartByClientOpId } from '../../../lib/idempotency.js';
import { validateOfflinePerformedAt } from '../../../lib/offline-time-window.js';
import { computeChecksum } from '../helpers.js';
import {
  getFilter,
  resolveFilterProfile,
  validateBlockChange,
  getCleaningReasons,
} from '../filter-resolver.js';
import type { FilterOperationsService } from '../filter-operations.service.js';
// Dynamically imported below (not statically) — replacement-schedule/service.ts
// statically imports FilterOperationsService and instantiates it at module top
// level, so a static import here creates an init-time circular-import cycle
// (start-cycle.ts is itself loaded via filter-operations.service.ts). Mirrors
// the existing `blockChangeService` dynamic import a few lines down.

/**
 * #eqpin (2026-07-04): decide the equipment-group binding + version pin to freeze
 * at cycle START. Pinning the version at start (rather than lazy-binding it at the
 * first instrument-readings submission, as advance() did) stops an admin edit to
 * instrument operating-ranges *mid-cycle* from changing the out-of-range
 * determination for an in-flight cycle — the pin exists precisely so mid-cycle
 * edits don't reach a running cycle (CLAUDE.md P1).
 *
 *   - explicit group supplied  → pin its version (caller has validated it's active).
 *   - no group, block has exactly ONE active group → bind + pin it at start (the
 *     common auto-resolve case that previously drifted).
 *   - no group, block has 0 or >1 active groups → leave unbound; advance() resolves
 *     later exactly as before (no-group → no readings; >1 → ambiguity error).
 *
 * Pure + exported so the pin-capture decision is unit-testable without a DB.
 */
export function resolveStartEquipmentGroupPin(
  explicitGroup: { id: string; version: number } | null,
  blockGroups: Array<{ id: string; version: number }>,
): { equipmentGroupId: string | null; equipmentGroupVersionPin: number | null } {
  if (explicitGroup) {
    return { equipmentGroupId: explicitGroup.id, equipmentGroupVersionPin: explicitGroup.version };
  }
  if (blockGroups.length === 1) {
    return { equipmentGroupId: blockGroups[0].id, equipmentGroupVersionPin: blockGroups[0].version };
  }
  return { equipmentGroupId: null, equipmentGroupVersionPin: null };
}

/** @param data - Validated by Fastify JSON schema before reaching this method */
export async function startCycleImpl(
  service: FilterOperationsService,
  ctx: RequestContext,
  filterId: string,
  data: any,
) {
  const { cleaningReasonKey, cleaningAreaId, equipmentGroupId } = data;
  // offlinePerformedAt: tablet wall-clock timestamp when the operator
  // physically performed the action offline. The tablet IS the source of
  // truth — that's the point of offline operation. But the server validates
  // the value (future-skew, max-staleness, replay-only) so a forged client
  // can't back-date forged audit records (audit 2026-05-04 fix — C2).
  // start-cycle has no prior cycle so cycleStartedAt is omitted.
  const offlineTime = validateOfflinePerformedAt(data.offlinePerformedAt, {
    isReplay: ctx.isOfflineReplay === true,
  });
  // Idempotent replay: if this clientOpId was already used to start a cycle,
  // return current state instead of creating a duplicate cycle. Scoped to
  // CYCLE_STARTED events only (audit §1.10) so replays from non-start ops
  // sharing the same UUID don't accidentally short-circuit a legitimate start.
  const clientOpId: string | null = data.clientOpId ?? null;
  if (clientOpId && await findExistingStartByClientOpId(filterId, clientOpId)) {
    return service.getCurrentState(ctx, filterId);
  }
  // Use canonical `stripHtml` instead of hand-rolled `<` / `>` escape — see
  // advance.ts:29 rationale. Same input-sanitization contract as the rest
  // of the codebase.
  const cleaningJustification = typeof data.cleaningJustification === "string" ? stripHtml(data.cleaningJustification) : data.cleaningJustification;

  const filter = await getFilter(filterId, ctx);
  const resolvedProfileIdForCycle = await resolveFilterProfile(filter);
  if (!resolvedProfileIdForCycle) throw new AppError(400, 'NO_PROFILE', 'Filter has no assigned profile');

  if (filter.currentCycleId) {
    const activeCycle = await prisma.cleaningCycle.findFirst({
      where: { id: filter.currentCycleId, status: 'IN_PROGRESS' },
    });
    if (activeCycle) throw new AppError(409, 'CYCLE_ACTIVE', 'Filter already has an active cleaning cycle');
  }

  // AHU overdue-replacement gate (2026-07-16). A filter under an AHU with an
  // overdue (MISSED) replacement entry cannot START a new cleaning cycle until it
  // is replaced — it is due to be physically swapped out. Offline replay is EXEMPT
  // (mirrors validateBlockChange): the offline client already gated this at scan
  // time, and re-checking on replay could strand a legitimately-queued start. The
  // online start is authoritative here.
  if (!ctx.isOfflineReplay) {
    const { isFilterBlockedForCleaning } = await import('../../replacement-schedule/service.js');
    if (await isFilterBlockedForCleaning(filterId)) {
      throw new AppError(409, 'AHU_REPLACEMENT_OVERDUE',
        'This filter’s AHU has an overdue replacement. Replace the filter before starting a cleaning cycle.');
    }
  }

  // Validate cross-block (must be before cycle creation). Mode-aware (CONFIRM vs
  // APPROVAL) and online-only — validateBlockChange auto-passes offline replays so a
  // queued offline start syncs rather than stranding the rest of the cycle's ops.
  const blockClearance = await validateBlockChange(filterId, cleaningAreaId, ctx, data.acknowledgeBlockChange === true);

  const reasons = await getCleaningReasons(resolvedProfileIdForCycle);
  if (!cleaningReasonKey) {
    throw new AppError(400, 'REASON_REQUIRED', 'Cleaning reason is required');
  }
  const reason = reasons.find((r: any) => r.key === cleaningReasonKey);
  if (!reason) throw new AppError(400, 'INVALID_REASON', `Invalid cleaning reason: ${cleaningReasonKey}`);
  if (reason.requiresJustification && (!cleaningJustification || cleaningJustification.length < 10)) {
    throw new AppError(400, 'JUSTIFICATION_REQUIRED', 'Justification required (min 10 characters) for this cleaning reason');
  }

  const prevCycleCount = await prisma.cleaningCycle.count({ where: { filterId } });
  const seq = prevCycleCount + 1;
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // 2026-05-21: don't slice the filter name. Pre-fix truncated to 10 chars,
  // which collided across filters whose names share a 10-char prefix
  // (e.g. `L1/AHu-01/00` and `L1/AHu-01/02` both truncated to `L1/AHu-01/`),
  // failing start-cycle with "Unique constraint failed on (cycle_code)".
  // cycle_code column is varchar(100); pass the full name and let the
  // column cap us if anyone names a filter longer than ~85 chars.
  const filterNameForCode = (filter.name ?? filterId.slice(0, 8)).replace(/\s+/g, '');
  const cycleCode = `CC-${filterNameForCode}-${String(seq).padStart(3, '0')}-${dateStr}`;

  // Resolve to cleaning profile — could be a FilterProfile ID or a CleaningProfile ID directly
  const fp = await prisma.filterProfile.findUnique({ where: { id: resolvedProfileIdForCycle } });
  const cleaningProfileIdForCycle = fp ? fp.cleaningProfileId : resolvedProfileIdForCycle;
  const cp = await prisma.filterCleaningProfile.findUnique({ where: { id: cleaningProfileIdForCycle } });
  if (cp && cp.status !== 'ACTIVE') {
    throw new AppError(400, 'PROFILE_DISABLED', `Cleaning profile "${cp.name}" is disabled. Contact admin to activate it.`);
  }

  // Phase A.1: snapshot the version of every ChecklistProfile referenced by
  // this pipeline at cycle start. From now on, this cycle resolves checklist
  // questions through these pinned versions — admin edits to a profile mid-cycle
  // will NOT change the questions or required-flags the operator sees.
  // Goes through the service.getProfilePipeline indirection so tests that
  // monkey-patch the spy still intercept.
  const pipelineForPins = await (service as any).getProfilePipeline(resolvedProfileIdForCycle, false);
  const checklistProfileIdsInPipeline: string[] = pipelineForPins
    ? [...new Set(
        pipelineForPins.stages
          .filter((s: any) => s.nodeType === 'CHECKLIST')
          .map((s: any) => s.configuration?.checklistProfileId)
          .filter(Boolean) as string[],
      )]
    : [];
  const checklistVersionPins: Record<string, number> = {};
  if (checklistProfileIdsInPipeline.length > 0) {
    const profilesForPins = await prisma.checklistProfile.findMany({
      where: { id: { in: checklistProfileIdsInPipeline } },
      select: { id: true, version: true },
    });
    for (const p of profilesForPins) {
      checklistVersionPins[p.id] = p.version;
    }
  }

  // Use transaction to prevent race conditions on double-start.
  //
  // Audit 2026-05-04 fix (api-core review C2): the previous in-tx `findUnique`
  // recheck did NOT acquire a row lock — two concurrent start-cycle requests
  // for the same filter could both clear the recheck and both insert. Switch
  // to `SELECT ... FOR UPDATE` so the second caller serializes behind the
  // first's commit and observes the new currentCycleId before its own check.
  // Mirrors the lock pattern used by advance/bypass/terminate via
  // lockAndVerifyFilterState() in ./locking.ts.
  const cycle = await prisma["$transaction"](async (tx) => {
    const lockedRows = await tx.$queryRaw<Array<{ current_cycle_id: string | null }>>`
      SELECT current_cycle_id
      FROM filter_details
      WHERE asset_instance_id = ${filterId}::uuid
      FOR UPDATE
    `;
    const lockedCurrentCycleId = lockedRows[0]?.current_cycle_id ?? null;
    if (lockedCurrentCycleId) {
      const active = await tx.cleaningCycle.findFirst({ where: { id: lockedCurrentCycleId, status: 'IN_PROGRESS' } });
      if (active) throw new AppError(409, 'CYCLE_ACTIVE', 'Filter already has an active cleaning cycle');
    }

    // Spend the block-change approval under the same lock as the cycle insert.
    // An approval is single-use: before this, hasApproval() only ever READ the
    // row and nothing ever set it EXPIRED, so one approval was a permanent,
    // unlimited licence to clean that filter in that block (and the operator-set
    // `autoExpireHours` did nothing). The tx-aware consume helper was written for
    // exactly this in 2026-05-05 and was never wired up.
    //
    // A 0-row consume means another start took the same approval between
    // validateBlockChange's read and this lock — that caller won the race, so
    // this one is simply not approved.
    if (blockClearance.consumeApproval) {
      const { blockChangeService } = await import('../../block-change-requests/block-change.service.js');
      const consumed = await blockChangeService.consumeApprovalTx(
        tx, blockClearance.consumeApproval.filterId, blockClearance.consumeApproval.toBlockId,
      );
      if (consumed === 0) {
        throw new AppError(409, 'BLOCK_CHANGE_REQUIRED',
          'The block-change approval for this filter has already been used. Request approval again to clean it in this block.');
      }
    }

    // Validate equipment group if provided. P1 (2026-05-02): also capture the
    // group's current version so the cycle pins it at start. Reading validation
    // later reads operating-range from the pinned EquipmentGroupVersion
    // snapshot, NOT the live group, so admin edits to ranges mid-cycle don't
    // reach the in-flight cycle. #eqpin (2026-07-04): also pin the common case
    // where no group was passed but the block has exactly one active group —
    // previously that stayed null and lazy-bound to the LIVE version at the
    // first readings advance, drifting if the group was edited in between.
    let explicitGroup: { id: string; version: number } | null = null;
    if (equipmentGroupId) {
      explicitGroup = await tx.equipmentGroup.findFirst({
        where: { id: equipmentGroupId, isActive: true },
        select: { id: true, version: true },
      });
      if (!explicitGroup) throw new AppError(400, 'INVALID_EQUIPMENT_GROUP', 'Equipment group not found or inactive');
    }
    // Only resolve the block's active groups when we need to (no explicit group +
    // a known block). Matches advance()'s auto-resolve: bind only when EXACTLY one.
    const blockGroups = (!equipmentGroupId && cleaningAreaId)
      ? await tx.equipmentGroup.findMany({
          where: { blockId: cleaningAreaId, isActive: true },
          select: { id: true, version: true },
        })
      : [];
    const { equipmentGroupId: boundEquipmentGroupId, equipmentGroupVersionPin } =
      resolveStartEquipmentGroupPin(explicitGroup, blockGroups);

    const newCycle = await tx.cleaningCycle.create({
      data: {
        cycleCode, filterId,
        // Pre-existing latent bug caught during P1 verification (2026-05-02):
        // cleaning_cycles.profile_id FKs to filter_cleaning_profiles.id, NOT
        // filter_profiles.id. resolveFilterProfile() can return either depending
        // on whether the filter has a FilterDetails.filter_profile_id binding
        // (returns FilterProfile id) or only a config-based rule (which
        // *might* return a CleaningProfile id directly). Storing the
        // FilterProfile id here triggers the FK violation. cleaningProfileIdForCycle
        // (computed at line 820) already resolves to the CleaningProfile id in both
        // cases — use that. Latent until now because no FilterDetails-bound cycle
        // had ever been started in this DB.
        profileId: cleaningProfileIdForCycle,
        profileVersion: cp?.version ?? 1,
        checklistVersionPins: checklistVersionPins as any,
        sequenceNumber: seq, cleaningReasonKey,
        cleaningReasonLabel: reason.name,
        cleaningJustification: cleaningJustification ?? null,
        cleaningAreaId: cleaningAreaId ?? null,
        equipmentGroupId: boundEquipmentGroupId, // #eqpin: block's sole group auto-bound at start
        equipmentGroupVersionPin, // P1: version frozen at start (null only when no group resolvable)
        ...(offlineTime && { startedAt: offlineTime }),
      },
    });

    await tx.filterEvent.create({
      data: {
        filterId, cycleId: newCycle.id, eventType: 'CYCLE_STARTED',
        performedBy: ctx.userSub, cleaningAreaId: cleaningAreaId ?? null,
        attributes: { cleaningReasonKey, cleaningReasonLabel: reason.name, ...(clientOpId ? { clientOpId } : {}) },
        remarks: cleaningJustification ?? null,
        checksum: computeChecksum({ filterId, cycleId: newCycle.id, eventType: 'CYCLE_STARTED', performedBy: ctx.userSub }),
        ipAddress: ctx.ipAddress, telemetrySnapshot: {},
        ...(offlineTime && { performedAt: offlineTime }),
      },
    });

    // currentCycleId moved to FilterDetails (Step 6).
    // Reset currentLifecycleState too: a prior cycle may have left it in the
    // terminal CLEANING_CYCLE_COMPLETED state (2026-06-02), which would
    // otherwise display until the first advance sets the real first stage.
    await tx.filterDetails.upsert({
      where: { assetInstanceId: filterId },
      update: { currentCycleId: newCycle.id, currentLifecycleState: null },
      create: { assetInstanceId: filterId, currentCycleId: newCycle.id },
    });

    // Audit §1.1 (2026-05-16): audit-write must share the business tx so
    // a partial failure either rolls back the cycle creation OR is
    // re-attempted as a unit. Standalone (post-commit) writes left state
    // changed with no audit record on transient failures — § 11.10(e)
    // violation.
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'CYCLE_STARTED',
      targetType: 'cleaning_cycle', targetId: newCycle.id,
      // 2026-05-20 fix: include filterName + cleaningReasonLabel so the
      // audit template "Cleaning cycle started for filter \"{targetName}\"
      // with reason \"{reason}\" by {actor}" renders with real values.
      // Pre-fix afterValue had only {cycleCode, cleaningReasonKey, filterId}
      // — both {targetName} and {reason} placeholders fell through to empty
      // / literal text on the audit-trail page.
      afterValue: {
        cycleCode,
        cleaningReasonKey,
        cleaningReasonLabel: reason.name,
        filterId,
        filterName: filter.name,
      },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    }, tx);

    return newCycle;
  });

  return cycle;
}
