/**
 * Should this instrument have an open inactivity alarm?
 *
 * Pure, so the rule that matters can be tested without a database or a clock.
 *
 * **The rule that matters: the CLEAR signal is PRESENCE, and that is the exact
 * opposite of the instrument-limit pass.** There, a missing reading HOLDS an
 * alarm open — you cannot prove recovery from absence, so a null must never
 * clear (see the long comment in `limit-decide.ts`). Here absence IS the alarm,
 * so presence is the proof of recovery. A pass written by copying the limit
 * pass's shape inherits its `continue`-on-null and strands every inactivity
 * alarm ACTIVE for good, which is why the two are separate modules with the
 * asymmetry written down in both.
 *
 * `reporting` is NOT recomputed here. It comes from `isInstrumentReporting()`
 * via `buildTelemetryOverview()` — the ONE definition of reporting in this
 * system — so the alarm and the dashboard can never disagree about whether an
 * instrument is offline.
 */

export type InactivityAction = 'raise' | 'clear' | 'none';

export interface InactivitySample {
  /** From `isInstrumentReporting()`, never re-derived. */
  reporting: boolean;
  lastSeenAt: Date | null;
  /** A decommissioned instrument is silent on purpose. */
  isActive: boolean;
  hasOpenAlarm: boolean;
}

/**
 * How long the instrument has been silent, in whole minutes.
 *
 * Clamped at zero: a device whose clock runs ahead reports a future timestamp,
 * and `isInstrumentReporting` already treats that as fresh rather than as
 * infinitely stale. A negative duration here would let such a device raise an
 * alarm quoting a nonsense span.
 */
export function quietMinutes(lastSeenAt: Date | null, now: Date): number | null {
  if (!lastSeenAt) return null;
  const ms = now.getTime() - lastSeenAt.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor(ms / 60_000));
}

export function decideInactivity(
  s: InactivitySample,
  graceMinutes: number,
  now: Date,
): InactivityAction {
  // Clearing is checked FIRST and is not gated on `isActive`. Retiring an
  // instrument must not strand an alarm that was already open — the isActive
  // guard below suppresses raising, which is a different question.
  if (s.hasOpenAlarm) return s.reporting ? 'clear' : 'none';

  if (s.reporting) return 'none';
  // Silent on purpose. Nothing is wrong, and an alarm nobody can clear is worse
  // than no alarm.
  if (!s.isActive) return 'none';

  // An instrument that has NEVER reported has not gone inactive; it was never
  // active. Raising here would alarm every instrument the moment it is created
  // and before it is wired up, and no telemetry is coming to clear it.
  const quiet = quietMinutes(s.lastSeenAt, now);
  if (quiet === null) return 'none';

  // `>=`, so the boundary counts as reached. The grace delays RAISING only.
  return quiet >= graceMinutes ? 'raise' : 'none';
}
