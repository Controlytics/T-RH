/**
 * Sensor-range decisions: is this reading outside what the probe can measure?
 *
 * PURE, like the three decide modules beside it. The worker does only I/O.
 *
 * **The clear signal is an IN-RANGE NUMBER, and silence holds the alarm open** —
 * the `limit-decide.ts` rule, the same as `rs485-decide.ts`, and the inverse of
 * `inactivity-decide.ts`. A probe that stops reporting has not been repaired.
 *
 * The `outOfRange` input is computed by the caller from `isOutOfRange()` against
 * the instrument's declared bounds; this module only sequences the decision, so
 * the comparison lives in exactly one place (`@digilog/shared/sensor-range`) and
 * the dashboard, the alarm and the limit suppression cannot disagree about which
 * readings are usable.
 */

export type RangeAction = 'raise' | 'clear' | 'none';

export interface RangeSample {
  /** True when a reading ARRIVED and fell outside the declared bounds. */
  outOfRange: boolean;
  /** Did a usable reading arrive at all? False for silence AND for a
   *  non-numeric value, which is the RS485 source's fault, not this one's. */
  hasReading: boolean;
  isActive: boolean;
  hasOpenAlarm: boolean;
}

export function decideRange(s: RangeSample): RangeAction {
  // Clearing first, and NOT gated on isActive: retiring an instrument must not
  // strand an open regulated record.
  if (s.hasOpenAlarm) {
    // No usable reading — silence, or an RS485 failure that has taken over. Hold.
    // Clearing on the arrival of `NA` would declare a saturated probe healthy
    // the moment it broke in a second way.
    if (!s.hasReading) return 'none';
    return s.outOfRange ? 'none' : 'clear';
  }

  if (!s.hasReading) return 'none';
  if (!s.outOfRange) return 'none';
  // Silent on purpose. An alarm nobody can clear is worse than no alarm.
  if (!s.isActive) return 'none';
  return 'raise';
}
