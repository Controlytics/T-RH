// Shared, pure helpers for rendering cleaning-cycle records cycle-wise.
// Single source of truth used by BOTH the Filter Cleaning Record list
// (routes/cleaning-cycles/history.tsx) and the Filter Lifecycle Report
// (routes/cleaning-cycles/filter-lifecycle.tsx) so the column meanings can
// never drift between the two pages.
import type { FilterEvent } from '../types/filter';
import { formatByLeastCount } from './format-by-least-count';

/**
 * Column order/keys for the cleaning-cycle record tables (2026-06-08):
 *  - `duration` = the dryer duration the operator selected at DRY_IN
 *    (cycle.dryerDurationMinutes), NOT the full cycle duration.
 *  - `dryIn` time = when the operator submitted the dryer-duration record
 *    (cycle.dryerStartedAt), not the temperature-submission time.
 * 'Dry By' and the old cycle-duration column were dropped per operator request.
 */
export const CC_COL_KEYS = [
  'sNo', 'filter', 'size', 'airPressure', 'roWater',
  'washIn', 'washOut', 'washBy', 'duration', 'dryIn', 'dryerTemp', 'dryOut', 'status',
] as const;

/**
 * Resolve the canonical STATE_TRANSITION event for a stage.
 * DRY_IN is special: two transitions land on DRY_IN (SET_DURATION with no
 * readings, then SUBMIT_READINGS with the temperature). For DRY_IN we want the
 * readings-bearing event (for the temperature); a manual Edit-Filter-Status
 * change carries no readings, so fall back to it; otherwise the column is blank
 * (cycle mid-dryer, no temperature yet). Every other stage emits a single
 * readings-bearing transition, so the fallback to stageEvents[0] is correct.
 */
export function getStageInfo(events: FilterEvent[], stage: string) {
  const stageEvents = (events ?? []).filter((e) => e.eventType === 'STATE_TRANSITION' && e.toState === stage);
  const requireReadings = stage === 'DRY_IN';
  const evWithReadings = stageEvents.find((e) => (e.attributes as any)?.instrumentReadings?.length > 0);
  const manualStageEvent = stageEvents.find((e) => (e.attributes as any)?.manual);
  const ev = evWithReadings ?? manualStageEvent ?? (requireReadings ? null : stageEvents[0]);
  if (!ev) return null;
  return {
    time: ev.performedAt,
    performedBy: ev.performedByName ?? ev.performedBy?.substring(0, 8) ?? '-',
    readings: (ev.attributes as any)?.instrumentReadings ?? [],
    manual: !!(ev.attributes as any)?.manual, // stage was set by a manual update
  };
}

/** Find an instrument reading by description substring and format it with its UOM. */
export function getReading(readings: any[], desc: string) {
  const r = (readings ?? []).find((r: any) => r.description?.toLowerCase().includes(desc.toLowerCase()));
  if (!r) return '-';
  const formatted = r.leastCount !== undefined && r.leastCount !== null
    ? formatByLeastCount(r.value, r.leastCount)
    : String(r.value);
  return `${formatted} ${r.uom ?? ''}`.trim();
}

/** Format a minute count as a human duration ("45m", "1h 30m", "2h"). */
export function fmtMinutes(mins: number | null | undefined) {
  if (mins == null) return null;
  const m = Math.round(mins);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/**
 * Dryer duration the operator SELECTED at DRY_IN + the time they submitted it.
 * Authoritative source is the cycle row (advance.ts persists
 * dryerDurationMinutes / dryerStartedAt on SET_DURATION). Falls back to the
 * DRYER_STARTED DRY_IN event for legacy cycles written before those columns.
 */
export function getDryerStart(cycle: any, events: FilterEvent[]) {
  let minutes: number | null = cycle?.dryerDurationMinutes ?? null;
  let time: string | null = cycle?.dryerStartedAt ?? null;
  if (minutes == null || time == null) {
    const ev = (events ?? []).find((e) =>
      e.eventType === 'STATE_TRANSITION' && e.toState === 'DRY_IN' &&
      ((e.attributes as any)?.action === 'DRYER_STARTED' || (e.attributes as any)?.dryerDurationMinutes != null));
    minutes = minutes ?? ((ev?.attributes as any)?.dryerDurationMinutes ?? null);
    time = time ?? ((ev?.attributes as any)?.dryerStartedAt ?? ev?.performedAt ?? null);
  }
  return { minutes, time };
}

/**
 * Display status for a cycle. A cycle terminated because its filter was retired
 * or replaced mid-cleaning carries terminationReason RETIRED / REPLACED — surface
 * that instead of a generic TERMINATED so the reports show why the cycle ended.
 */
export function effectiveCycleStatus(cycle: any): string {
  if (cycle?.status === 'TERMINATED') {
    if (cycle.terminationReason === 'RETIRED') return 'RETIRED';
    if (cycle.terminationReason === 'REPLACED') return 'REPLACED';
  }
  return cycle?.status;
}

/** Cleaning stages in pipeline order — the stage-progress bar's fixed axis. */
export const STAGE_ORDER = ['WASH_IN', 'WASH_OUT', 'DRY_IN', 'DRY_OUT', 'STORAGE_IN', 'STORAGE_OUT'] as const;

/**
 * Stage-progress state for the cycle detail view's progress bar.
 *
 * `reached` is a SET of the stages the cycle transitioned into — deliberately not
 * the raw event list. A stage can legitimately be entered by MORE than one
 * STATE_TRANSITION: DRY_IN emits two (SET_DURATION, then SUBMIT_READINGS — the
 * persisted-countdown flow), so the event list carries duplicates by design and
 * its LENGTH is not a stage index.
 *
 * `current` is derived structurally rather than by counting transitions: it is the
 * first in-profile stage that comes after the furthest stage reached and has not
 * itself been reached. Counting instead (`i === events.length`) overshoots by one
 * per duplicate and pulses a stage the operator hasn't got to yet.
 *
 * Only an IN_PROGRESS cycle has a current stage — a completed / terminated /
 * retired / replaced one has no next action, so `current` is null.
 */
export function stageProgress(
  events: any[],
  profileStages: string[],
  effStatus: string,
): { reached: Set<string>; current: string | null } {
  const reached = new Set<string>(
    (events ?? [])
      .filter((e: any) => e.eventType === 'STATE_TRANSITION' && e.toState)
      .map((e: any) => e.toState as string),
  );
  // Furthest point on the axis the cycle has actually got to (-1 = not started).
  const maxReachedIdx = STAGE_ORDER.reduce((acc, s, i) => (reached.has(s) ? i : acc), -1);
  // Before the first transition nothing pulses (unchanged behaviour): with no
  // transition there is no evidence of which stage the operator is on.
  if (effStatus !== 'IN_PROGRESS' || maxReachedIdx < 0) return { reached, current: null };
  const current = STAGE_ORDER.find(
    (s, i) =>
      i > maxReachedIdx &&
      !reached.has(s) &&
      // Stages outside this cycle's profile render "NA" and are never current.
      (profileStages.length === 0 || profileStages.includes(s)),
  );
  return { reached, current: current ?? null };
}
