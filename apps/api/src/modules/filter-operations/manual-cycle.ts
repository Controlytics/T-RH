/**
 * Manual cleaning-cycle lifecycle helpers for web "Edit Filter Status" (P3,
 * 2026-06-03). Both run INSIDE the caller's transaction.
 *
 *  - breakActiveCycleTx: closes an in-progress cycle as TERMINATED — the
 *    "broken" status (D1: reuse TERMINATED + a reason marker, no enum migration)
 *    — and writes a CYCLE_TERMINATED event. Used when a manual move goes
 *    BACKWARD: the in-flight cycle is interrupted.
 *  - resolveManualCycleReason: validates the operator-chosen cleaning reason
 *    against the filter's profile (D2: prompt operator). Throws AppError 400.
 *  - startManualCycleTx: creates a fresh cleaning_cycles row (manual origin) at
 *    the operator's stage with that reason + a CYCLE_STARTED event. Returns the
 *    new cycle id.
 *
 * Manual cycles are intentionally lighter than tablet cycles: no checklist /
 * equipment version pins and no instrument readings — they record the stage
 * progression an operator performed by hand. The cycle_code carries a `-M`
 * suffix so manual-origin cycles are distinguishable.
 */
import { AppError } from '../../lib/errors.js';
import { computeChecksum } from './helpers.js';
import { getCleaningReasons } from './filter-resolver.js';

export interface ManualCycleReasonInput {
  cleaningReasonKey?: string | null;
  cleaningJustification?: string | null;
}
export interface ResolvedManualReason {
  key: string;
  name: string;
  justification: string | null;
}

/** Validate the operator's reason against the filter's profile reasons. */
export async function resolveManualCycleReason(
  profileId: string,
  input: ManualCycleReasonInput,
): Promise<ResolvedManualReason> {
  const reasons = await getCleaningReasons(profileId);
  if (!input.cleaningReasonKey) {
    throw new AppError(400, 'REASON_REQUIRED', 'A cleaning reason is required to start a cleaning cycle.');
  }
  const reason = (reasons as any[]).find((r) => r.key === input.cleaningReasonKey);
  if (!reason) {
    throw new AppError(400, 'INVALID_REASON', `Invalid cleaning reason: ${input.cleaningReasonKey}`);
  }
  const justification = typeof input.cleaningJustification === 'string' ? input.cleaningJustification.trim() : '';
  if (reason.requiresJustification && justification.length < 10) {
    throw new AppError(400, 'JUSTIFICATION_REQUIRED', 'Justification required (min 10 characters) for this cleaning reason.');
  }
  return { key: reason.key, name: reason.name, justification: justification || null };
}

/** Close an in-progress cycle as TERMINATED ("broken") with a reason marker. */
export async function breakActiveCycleTx(tx: any, opts: {
  filterId: string; cycleId: string; sequenceNumber: number;
  performedBy: string; ipAddress?: string; at: Date; reason: string;
}): Promise<void> {
  const { filterId, cycleId, sequenceNumber, performedBy, ipAddress, at, reason } = opts;
  await tx.cleaningCycle.update({
    where: { id: cycleId },
    data: { status: 'TERMINATED', completedAt: at, terminatedAt: at },
  });
  const eventData = {
    filterId, cycleId, eventType: 'CYCLE_TERMINATED' as const,
    performedBy,
    attributes: { sequenceNumber, manual: true, broken: true, reason },
    remarks: reason,
  };
  await tx.filterEvent.create({
    data: { ...eventData, performedAt: at, checksum: computeChecksum(eventData), ipAddress, telemetrySnapshot: {} },
  });
}

/** Create a fresh manual-origin cycle. Returns the new cycle id. */
export async function startManualCycleTx(tx: any, opts: {
  filterId: string; filterName: string | null; profileId: string;
  reason: ResolvedManualReason; performedBy: string; ipAddress?: string; at: Date;
}): Promise<string> {
  const { filterId, filterName, profileId, reason, performedBy, ipAddress, at } = opts;
  // cleaning_cycles.profile_id FKs to filter_cleaning_profiles.id — resolve the
  // FilterProfile → CleaningProfile id (mirrors start-cycle.ts).
  const fp = await tx.filterProfile.findUnique({ where: { id: profileId } });
  const cleaningProfileId = fp ? fp.cleaningProfileId : profileId;
  const cp = await tx.filterCleaningProfile.findUnique({ where: { id: cleaningProfileId } });

  const prevCount = await tx.cleaningCycle.count({ where: { filterId } });
  const seq = prevCount + 1;
  const dateStr = at.toISOString().slice(0, 10).replace(/-/g, '');
  const nameForCode = (filterName ?? filterId.slice(0, 8)).replace(/\s+/g, '');
  const cycleCode = `CC-${nameForCode}-${String(seq).padStart(3, '0')}-${dateStr}-M`;

  const newCycle = await tx.cleaningCycle.create({
    data: {
      cycleCode, filterId,
      profileId: cleaningProfileId, profileVersion: cp?.version ?? 1,
      checklistVersionPins: {}, sequenceNumber: seq,
      cleaningReasonKey: reason.key, cleaningReasonLabel: reason.name,
      cleaningJustification: reason.justification,
      cleaningAreaId: null, equipmentGroupId: null, equipmentGroupVersionPin: null,
      startedAt: at,
    },
  });

  const startEvent = {
    filterId, cycleId: newCycle.id, eventType: 'CYCLE_STARTED' as const,
    performedBy,
    attributes: { cleaningReasonKey: reason.key, cleaningReasonLabel: reason.name, manual: true },
    remarks: reason.justification,
  };
  await tx.filterEvent.create({
    data: { ...startEvent, performedAt: at, checksum: computeChecksum(startEvent), ipAddress, telemetrySnapshot: {} },
  });

  return newCycle.id;
}
