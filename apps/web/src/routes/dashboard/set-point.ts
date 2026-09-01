/**
 * Renders a room's environmental spec as a SET POINT, in the vocabulary the
 * operator's reference table uses:
 *
 *   max only        -> "NMT 25.0"     (Not More Than)
 *   min only        -> "NLT 18.0"     (Not Less Than)
 *   both            -> "18.0 - 25.0"
 *   neither / no room -> "NA"
 *
 * A room with all four bounds NULL is legitimate — a corridor or an office has no
 * specification — so "NA" is a real answer here, not an error state. The same
 * string is used for a missing reading, which matches the reference table where
 * most rows read NA.
 *
 * Pure, so it is unit-tested. That matters because the rest of this table can
 * only be checked by looking at it, and nobody can open the authenticated UI in
 * a browser from this dev environment.
 */
import { clampDecimals, RS485_FAILURE_TEXT_DEFAULT, SENSOR_RANGE_TEXT_DEFAULT } from '@digilog/shared';

export const NOT_AVAILABLE = 'NA';

export function formatSetPoint(
  min: number | null | undefined,
  max: number | null | undefined,
  decimals: number,
): string {
  const hasMin = typeof min === 'number' && Number.isFinite(min);
  const hasMax = typeof max === 'number' && Number.isFinite(max);
  // Clamped, not trusted: `decimals` now comes from an operator-typed instrument
  // attribute, and `toFixed` throws a RangeError outside 0…100 — which here would
  // take down the whole table rather than one cell.
  const dp = clampDecimals(decimals);
  const f = (n: number) => n.toFixed(dp);

  if (hasMin && hasMax) return `${f(min)} - ${f(max)}`;
  if (hasMax) return `NMT ${f(max)}`;
  if (hasMin) return `NLT ${f(min)}`;
  return NOT_AVAILABLE;
}

/**
 * Is this reading outside the room's specification?
 *
 * ONE implementation on purpose. The tabular view and the floor plan both mark
 * breaches, and they are shown on the same screen behind one toggle — two copies
 * of this rule could drift and have the table and the drawing disagree about the
 * same instrument, which on a 21 CFR Part 11 system is a contradiction in the
 * record, not a cosmetic bug.
 *
 * A NULL bound is not a breach: it means that side is not checked. A non-finite
 * reading is not a breach either — it is a bad reading, reported as NA elsewhere.
 */
export function outOfSpec(
  value: number | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (typeof min === 'number' && Number.isFinite(min) && value < min) return true;
  if (typeof max === 'number' && Number.isFinite(max) && value > max) return true;
  return false;
}

/**
 * The administered word that STANDS IN for this slot's number, or null when the
 * slot has a number to show.
 *
 * ONE implementation, for the same reason `outOfSpec` is one: the dashboard
 * table, the floor tiles and the trend page's latest-value card all have to call
 * the same fault the same thing, and the precedence between the two faults is a
 * decision, not a formatting detail.
 *
 * Range BEFORE failure: a saturated probe is a more specific finding than "not a
 * number", and the two are mutually exclusive anyway — an out-of-range value IS
 * a number.
 *
 * The fallbacks are the SHARED constants, never literals: a `'OL'` baked in here
 * would be a second opinion about a value the server administers, and the two
 * diverge the moment somebody edits the setting.
 */
export function faultWord(
  fault: { failed?: boolean; outOfRange?: boolean } | undefined,
  words: { failure: string; outOfRange: string } | undefined,
): string | null {
  if (fault?.outOfRange) return words?.outOfRange ?? SENSOR_RANGE_TEXT_DEFAULT;
  if (fault?.failed) return words?.failure ?? RS485_FAILURE_TEXT_DEFAULT;
  return null;
}
