/**
 * Sensor RANGE failures — a reading outside what the probe can physically
 * measure.
 *
 * **Range is not a limit, and confusing the two is the mistake this file exists
 * to prevent.** On this installation every instrument carries both:
 *
 *   High/Low Temperature Limit = 25 / 0     ← the SPEC. Breaching it is a
 *                                             product excursion: CRITICAL.
 *   High/Low Temperature Range = 50 / -40   ← the PROBE's span. Leaving it means
 *                                             the reading is not a measurement.
 *
 * A Pt100 asked to read beyond its span does not report the true temperature; it
 * saturates, and a real instrument displays `OL`. So a reading outside the range
 * is treated as NO READING AT ALL — the same as the `NA` an RS485 failure sends:
 *
 *   - it does not raise a limit alarm (you cannot call a product excursion from
 *     a number the sensor itself says is unreliable);
 *   - it does not CLEAR one either — absence never proves recovery, which is the
 *     standing rule in `limit-decide.ts`;
 *   - the dashboard shows the configured word instead of the number;
 *   - and a SENSOR_RANGE alarm is raised, so nothing is silently swallowed.
 *
 * Operator decision, 2026-08-31.
 */

export type RangeMetric = 'TEMPERATURE' | 'HUMIDITY';
export type RangeBound = 'temperatureHigh' | 'temperatureLow' | 'humidityHigh' | 'humidityLow';

/**
 * The attribute keys each bound is read from, most preferred first.
 *
 * These are the keys this installation's 100 instruments ALREADY carry — checked
 * against `instrument_attributes` on 2026-08-31, not guessed — so the feature
 * works without anyone re-keying an instrument. Same ordered-alias mechanism as
 * `alarm-limits`, because attribute keys are operator-typed and have drifted
 * here before.
 */
export const SENSOR_RANGE_KEYS_DEFAULT: Record<RangeBound, string> = {
  temperatureHigh: 'High Temperature Range',
  temperatureLow: 'Low Temperature Range',
  humidityHigh: 'High Humidity Range',
  humidityLow: 'Low Humidity Range',
};

/**
 * What a cell shows in place of an out-of-range reading.
 *
 * `OL` — the abbreviation a physical instrument displays for an over-range
 * input, so it reads the way the panel on the wall reads. Distinct from the
 * RS485 `Error` word on purpose: one means "the sensor sent nonsense", the other
 * "the sensor sent a number it cannot stand behind", and they call for different
 * checks.
 */
export const SENSOR_RANGE_TEXT_DEFAULT = 'OL';
export const SENSOR_RANGE_TEXT_MAX = 24;

/** The administered word, or the shipped one when blank/absent/still loading. */
export function rangeText(configured?: string | null): string {
  const t = typeof configured === 'string' ? configured.trim() : '';
  return t || SENSOR_RANGE_TEXT_DEFAULT;
}

/**
 * The GLOBAL half of the range feature: the switch and the word. Which
 * attribute holds each bound is the instrument PROFILE's since 2026-10-26
 * (`InstrumentSlotConfig.rangeKeys`, @digilog/shared/profile-measurements).
 */
export interface SensorRangeConfig {
  enabled: boolean;
  rangeText: string;
}

/** One instrument's four range bounds. Null = that bound is not declared. */
export interface SensorRangeBounds {
  temperatureHigh: number | null;
  temperatureLow: number | null;
  humidityHigh: number | null;
  humidityLow: number | null;
}

/**
 * Is this reading outside the probe's declared span?
 *
 * **Boundaries are IN range** (`>` and `<`, not `>=`), matching `checkPair` in
 * `limit-decide.ts`: a probe declaring a 50 °C maximum can report exactly 50.
 *
 * An undeclared bound is UNBOUNDED, the same rule limits use — never a silent
 * zero, which would put every negative temperature out of range.
 *
 * A non-finite value is NOT out of range: that is the RS485 source's question,
 * and answering it here too would raise two alarms for one fault.
 */
export function isOutOfRange(value: number, low: number | null, high: number | null): boolean {
  if (!Number.isFinite(value)) return false;
  // A low above its high is a misconfiguration, not a permanent fault. Same
  // reasoning as `limitsInverted`: every reading would be out of range forever,
  // which trains operators to ignore the alarm.
  if (low !== null && high !== null && low > high) return false;
  if (high !== null && value > high) return true;
  if (low !== null && value < low) return true;
  return false;
}

/** What the Alarms page's Type column calls one of these. */
export const SENSOR_RANGE_TYPE_LABEL: Record<RangeMetric, string> = {
  TEMPERATURE: 'Temperature Failure',
  HUMIDITY: 'Humidity Failure',
};

/** The frozen record of what the probe was asked to measure, and what it said. */
export interface SensorRangeSnapshot {
  kind: 'SENSOR_RANGE';
  metric: RangeMetric;
  key: string;
  /** The reading that fell outside. A real number — unlike an RS485 failure. */
  reading: number;
  /** The span in force AT RAISE TIME; editing the attribute later must not
   *  rewrite what a past fault says it exceeded. */
  rangeLow: number | null;
  rangeHigh: number | null;
  /** Which attribute key each bound came from, so "it fired against
   *  `High Temperature Range` = 50" stays answerable after a rename. */
  lowKey: string | null;
  highKey: string | null;
  /** The TEXT each bound's attribute carried beside its number at raise time
   *  (`50 (max)`), null for a bare number — printed in place of the number
   *  (2026-10-03). Optional: rows raised before it existed carry neither. */
  rangeLowText?: string | null;
  rangeHighText?: string | null;
  decimals: number;
  description: string;
  snapshotAt: string;
}

/** "temperature 60.0 is outside the sensor range -40 to 50" — one wording. */
export function describeRangeFault(
  metric: RangeMetric,
  reading: string,
  low: number | null,
  high: number | null,
): string {
  const word = metric === 'TEMPERATURE' ? 'temperature' : 'humidity';
  const span = low !== null && high !== null ? `${low} to ${high}`
    : high !== null ? `up to ${high}`
    : low !== null ? `from ${low}`
    : 'the declared range';
  return `${word} ${reading} is outside the sensor range ${span}`;
}

/**
 * The Limit column's cell: the span it left, from the FROZEN snapshot.
 *
 * A bound whose attribute carried text prints that text in place of its
 * number (`-40 – 50 (max)`), the same rule as every other set point.
 */
export function rangeLimitText(
  low: number | null,
  high: number | null,
  texts?: { low?: string | null; high?: string | null },
): string {
  const lo = low === null ? null : (texts?.low ?? String(low));
  const hi = high === null ? null : (texts?.high ?? String(high));
  if (lo !== null && hi !== null) return `${lo} – ${hi}`;
  if (hi !== null) return `> ${hi}`;
  if (lo !== null) return `< ${lo}`;
  return '—';
}
