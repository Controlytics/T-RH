/**
 * Dryer guards (Phase 8.5).
 *
 * Pure portions of advance()'s dryer-specific blocks in
 * `apps/api/src/modules/filter-operations/filter-operations.service.ts`
 * (lines 1294-1326). SET_DURATION + SUBMIT_READINGS validation, half-time
 * gates.
 *
 * Note on offline replay: when the operator submitted the action offline,
 * `offlinePerformedAt` is the regulatory timestamp and the server skips the
 * half-time gate (time was already validated client-side). We mirror that by
 * accepting an optional `offlineTime` argument; pass `undefined` for online
 * paths to enforce the gate.
 */
import type { CycleSlice, GuardResult, LocalContext } from './types.js';

/** Guard #21: SET_DURATION only valid for DRY_IN target. */
export function assertDryerActionValid(
  _ctx: LocalContext,
  dryerAction: string | null | undefined,
  targetState: string | null | undefined,
): GuardResult {
  if (dryerAction !== 'SET_DURATION') return { ok: true };
  if (targetState === 'DRY_IN') return { ok: true };
  return {
    ok: false,
    code: 'INVALID_DRYER_ACTION',
    message: 'SET_DURATION only valid for DRY_IN',
  };
}

/** Guard #22: SET_DURATION must have positive `dryerDurationMinutes`. */
export function assertDryerDurationValid(
  _ctx: LocalContext,
  dryerDurationMinutes: number | null | undefined,
): GuardResult {
  if (!dryerDurationMinutes || dryerDurationMinutes < 1) {
    return {
      ok: false,
      code: 'INVALID_DURATION',
      message: 'dryerDurationMinutes required',
    };
  }
  return { ok: true };
}

/** Guard #23: SUBMIT_READINGS only valid when filter is currently in DRY_IN. */
export function assertInDryInForReadings(
  _ctx: LocalContext,
  currentLifecycleState: string | null | undefined,
  dryerAction: string | null | undefined,
): GuardResult {
  if (dryerAction !== 'SUBMIT_READINGS') return { ok: true };
  if (currentLifecycleState === 'DRY_IN') return { ok: true };
  return {
    ok: false,
    code: 'NOT_IN_DRY_IN',
    message: 'Filter is not in DRY_IN',
  };
}

/** Guard #24: SUBMIT_READINGS requires the dryer to have started. */
export function assertDryerStarted(
  _ctx: LocalContext,
  cycle: CycleSlice,
  dryerAction: string | null | undefined,
): GuardResult {
  if (dryerAction !== 'SUBMIT_READINGS') return { ok: true };
  if (!cycle.dryerStartedAt || !cycle.dryerDurationMinutes) {
    return {
      ok: false,
      code: 'DRYER_NOT_STARTED',
      message: 'Dryer duration not set',
    };
  }
  return { ok: true };
}

/**
 * Guard #25: SUBMIT_READINGS — half-time elapsed gate (skip when offline replay).
 *
 * Mirrors advance() lines 1306-1313. `offlineTime !== undefined` skips the gate
 * because the operator's actual click time was already validated when they
 * performed the action offline (server is replaying their queued submission).
 */
export function assertDryerHalfTimeElapsed(
  ctx: LocalContext,
  cycle: CycleSlice,
  dryerAction: string | null | undefined,
  offlineTime?: Date | string | null,
): GuardResult {
  if (dryerAction !== 'SUBMIT_READINGS') return { ok: true };
  if (offlineTime) return { ok: true };
  if (!cycle.dryerStartedAt || !cycle.dryerDurationMinutes) return { ok: true };

  const halfMs = (cycle.dryerDurationMinutes * 60_000) / 2;
  const startedMs =
    cycle.dryerStartedAt instanceof Date
      ? cycle.dryerStartedAt.getTime()
      : new Date(cycle.dryerStartedAt as string).getTime();
  const elapsedMs = ctx.now - startedMs;
  if (elapsedMs >= halfMs) return { ok: true };
  const remainingMin = Math.ceil((halfMs - elapsedMs) / 60_000);
  return {
    ok: false,
    code: 'DRYER_NOT_READY',
    message: `Dryer still running. Wait ${remainingMin} more minute(s).`,
    details: { remainingMin },
  };
}

/**
 * Guard #27 (added 2026-05-25): leaving DRY_IN requires that the operator
 * actually submitted the dryer-temperature readings (SUBMIT_READINGS) —
 * NOT just SET_DURATION + half-time elapsed. Pre-fix the chain only
 * checked half-time, so a filter could advance to DRY_OUT after the
 * dryer countdown ended even though no temperature reading was ever
 * recorded. The DB then held `dryer_readings_submitted = false` for a
 * completed cycle — a 21 CFR Part 11 attestation gap.
 *
 * Applies whenever the cycle has actually entered the dryer phase
 * (`dryerStartedAt` set). If the pipeline doesn't use the dryer at all
 * (no SET_DURATION ever submitted), this guard is a no-op so non-dryer
 * pipelines aren't blocked.
 *
 * Unlike `assertDryerHalfTimeBeforeLeavingDryIn`, this guard does NOT
 * skip for offline replay — a queued advance that skipped the readings
 * submission represents real data the operator never produced, and the
 * audit trail should refuse to back-fill it.
 */
export function assertDryerReadingsSubmittedBeforeLeavingDryIn(
  cycle: CycleSlice,
  currentLifecycleState: string | null | undefined,
  targetState: string | null | undefined,
): GuardResult {
  if (currentLifecycleState !== 'DRY_IN') return { ok: true };
  if (targetState === 'DRY_IN') return { ok: true };
  // Pipeline doesn't use the dryer at all → no readings to require.
  if (!cycle.dryerStartedAt) return { ok: true };
  if (cycle.dryerReadingsSubmitted) return { ok: true };
  return {
    ok: false,
    code: 'DRYER_READINGS_REQUIRED',
    message: 'Submit dryer temperature readings before leaving DRY_IN.',
  };
}

/**
 * Guard #26: leaving DRY_IN requires the dryer to have run at least half its
 * duration. Skipped for offline replay.
 *
 * Mirrors advance() lines 1317-1326.
 */
export function assertDryerHalfTimeBeforeLeavingDryIn(
  ctx: LocalContext,
  cycle: CycleSlice,
  currentLifecycleState: string | null | undefined,
  targetState: string | null | undefined,
  offlineTime?: Date | string | null,
): GuardResult {
  if (currentLifecycleState !== 'DRY_IN') return { ok: true };
  if (targetState === 'DRY_IN') return { ok: true };
  if (offlineTime) return { ok: true };
  if (!cycle.dryerStartedAt || !cycle.dryerDurationMinutes) return { ok: true };

  const halfMs = (cycle.dryerDurationMinutes * 60_000) / 2;
  const startedMs =
    cycle.dryerStartedAt instanceof Date
      ? cycle.dryerStartedAt.getTime()
      : new Date(cycle.dryerStartedAt as string).getTime();
  const elapsedMs = ctx.now - startedMs;
  if (elapsedMs >= halfMs) return { ok: true };
  const remainingMin = Math.ceil((halfMs - elapsedMs) / 60_000);
  return {
    ok: false,
    code: 'DRYER_NOT_READY',
    message: `Dryer still running. Wait ${remainingMin} more minute(s) before leaving DRY_IN.`,
    details: { remainingMin },
  };
}
