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
export const NOT_AVAILABLE = 'NA';

export function formatSetPoint(
  min: number | null | undefined,
  max: number | null | undefined,
  decimals: number,
): string {
  const hasMin = typeof min === 'number' && Number.isFinite(min);
  const hasMax = typeof max === 'number' && Number.isFinite(max);
  const f = (n: number) => n.toFixed(decimals);

  if (hasMin && hasMax) return `${f(min)} - ${f(max)}`;
  if (hasMax) return `NMT ${f(max)}`;
  if (hasMin) return `NLT ${f(min)}`;
  return NOT_AVAILABLE;
}
