/**
 * Mean Kinetic Temperature (MKT) — the single temperature that would give the
 * same thermal stress as the readings actually seen, weighted toward the hot
 * ones. ICH Q1A(R2) / USP <1150>:
 *
 *   MKT = (ΔH/R) / -ln( (1/n) Σ exp(-(ΔH/R) / T_i) )     with T in kelvin
 *
 * ΔH/R is the pharmacopoeial constant 10,000 K (ΔH = 83.144 kJ/mol over
 * R = 8.3144 J/mol·K). Not configurable: a different constant is a different
 * standard, and a report that printed "MKT" against some other number would
 * misstate the method.
 *
 * ONE implementation for both sides (operator, 2026-10-03: "if
 * isMktCalculationEnabled is true then in data report mkt value should come"):
 * the API computes the exponential mean in SQL over EVERY reading in the period
 * — the same population the report's Max / Min come from, never the printed
 * interval rows — and turns it into degrees here; the pure `mktCelsius` is the
 * reference the SQL is tested against.
 */

/** The instrument attribute that switches the figure on. Matched case-folded. */
export const MKT_ATTRIBUTE_KEY = 'isMktCalculationEnabled';

/** ΔH/R in kelvin. */
export const MKT_DELTA_H_OVER_R_K = 10_000;

export const KELVIN_OFFSET = 273.15;

/**
 * Is MKT switched ON for this instrument?
 *
 * The OPPOSITE default from the limit enable flags: absent, blank or unreadable
 * means OFF. A limit must fail toward alarming; a derived figure on a §11 report
 * must fail toward absence — printing a number nobody asked for is the worse
 * error here.
 */
export function isMktEnabled(attributes: { key: string; value: string }[]): boolean {
  const want = MKT_ATTRIBUTE_KEY.toLowerCase();
  const hit = attributes.find((a) => a.key.trim().toLowerCase() === want);
  if (!hit) return false;
  const s = String(hit.value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'y', 't', 'enabled'].includes(s);
}

/**
 * Is MKT on for this instrument, given its PROFILE's MKT setting
 * (2026-10-26, operator: "in instrument profiles … MKT attributes … enabled or
 * disabled should come")? The profile switch is an AND gate in front of the
 * instrument attribute:
 * - profile off → never;
 * - profile on, no attribute named → always;
 * - profile on, attributes named → the first one the instrument carries decides
 *   by `isMktEnabled`'s values; none carried → OFF (today's default, kept).
 *
 * `attributeKeys` are compared case-folded.
 */
export function isMktOn(
  setting: { enabled: boolean; attributeKeys: string[] },
  attributes: { key: string; value: string }[],
): boolean {
  if (!setting.enabled) return false;
  if (setting.attributeKeys.length === 0) return true;
  for (const want of setting.attributeKeys) {
    const k = want.trim().toLowerCase();
    const hit = attributes.find((a) => a.key.trim().toLowerCase() === k);
    if (!hit) continue;
    return ['1', 'true', 'yes', 'on', 'y', 't', 'enabled'].includes(String(hit.value).trim().toLowerCase());
  }
  return false;
}

/** exp(-(ΔH/R) / T) for one reading in °C, or null below absolute zero. */
function thermalTerm(celsius: number): number | null {
  const kelvin = celsius + KELVIN_OFFSET;
  if (!Number.isFinite(kelvin) || kelvin <= 0) return null;
  return Math.exp(-MKT_DELTA_H_OVER_R_K / kelvin);
}

/**
 * MKT in °C from the MEAN of the exponential terms — what the API's SQL
 * returns (`avg(exp(-10000 / (value + 273.15)))`). Null for no readings.
 */
export function mktFromExpMean(expMean: number | null | undefined): number | null {
  if (expMean === null || expMean === undefined || !Number.isFinite(expMean) || expMean <= 0) return null;
  return MKT_DELTA_H_OVER_R_K / -Math.log(expMean) - KELVIN_OFFSET;
}

/** MKT in °C over a set of readings in °C — the pure reference. */
export function mktCelsius(readings: readonly number[]): number | null {
  let sum = 0;
  let n = 0;
  for (const r of readings) {
    const term = thermalTerm(r);
    if (term === null) continue;
    sum += term;
    n += 1;
  }
  return n === 0 ? null : mktFromExpMean(sum / n);
}
