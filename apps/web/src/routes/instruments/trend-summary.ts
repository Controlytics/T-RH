/**
 * Period statistics for one administered slot.
 *
 * TWO THINGS HERE ARE COMPLIANCE DECISIONS, NOT PRESENTATION CHOICES.
 *
 * 1. THESE ARE COMPUTED FROM THE STORED READINGS, NEVER FROM THE AVERAGED
 *    POINTS THE CHART PLOTS. The minimum of a set of means is not the minimum
 *    of the record: a single reading that breached a limit for one sample can
 *    be averaged back inside the band and disappear entirely. A summary that
 *    inherited that smoothing would under-report an excursion in the one block
 *    of the report a §11 reader trusts to be authoritative.
 *
 * 2. OUT-OF-SPEC IS COUNTED IN READINGS, NOT IN ELAPSED TIME. Turning samples
 *    into a duration requires assuming what happened BETWEEN them, and the gap
 *    left by an instrument that went offline is exactly where that assumption
 *    is worst — it would silently attribute a value to a stretch with no record
 *    at all. The count is what was actually observed, and the report says that
 *    is what it is counting.
 *
 * Limits arrive already resolved from the telemetry-overview payload
 * (instrument's own, else its room's). Nothing here re-derives them.
 */

export interface Reading {
  key: string;
  value: number;
  ts: string;
}

export interface SlotSummary {
  /** 'Temperature' / 'Humidity'. */
  label: string;
  unit: string;
  /** The instrument's own display precision, resolved server-side. */
  decimals: number;
  /** Readings this summary was computed over. */
  count: number;
  min: number;
  max: number;
  mean: number;
  first: { value: number; ts: string };
  last: { value: number; ts: string };
  /** As resolved on the payload. Null when neither instrument nor room says. */
  limitMin: number | null;
  limitMax: number | null;
  /** Null when there are no limits to judge against — NOT zero, which would
   *  read as "nothing was out of spec" when the truth is "nothing was checked". */
  belowCount: number | null;
  aboveCount: number | null;
  outOfSpecCount: number | null;
}

/**
 * Summarise one slot's readings over a period.
 *
 * Returns `null` for a slot with no readings: a summary of nothing would print
 * a row of dashes that reads as a measurement, and the report says "no
 * readings" instead.
 */
export function summariseSlot(
  rows: Reading[],
  key: string,
  label: string,
  unit: string,
  decimals: number,
  limitMin: number | null | undefined,
  limitMax: number | null | undefined,
): SlotSummary | null {
  const points = rows
    .filter((r) => r.key === key)
    .map((r) => ({ value: r.value, ts: r.ts }))
    .sort((a, b) => a.ts.localeCompare(b.ts));

  if (points.length === 0) return null;

  let min = points[0].value;
  let max = points[0].value;
  let sum = 0;
  let below = 0;
  let above = 0;
  for (const p of points) {
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
    sum += p.value;
    if (limitMin != null && p.value < limitMin) below += 1;
    if (limitMax != null && p.value > limitMax) above += 1;
  }

  const hasLimits = limitMin != null || limitMax != null;

  return {
    label,
    unit,
    decimals,
    count: points.length,
    min,
    max,
    mean: sum / points.length,
    first: points[0],
    last: points[points.length - 1],
    limitMin: limitMin ?? null,
    limitMax: limitMax ?? null,
    belowCount: hasLimits ? below : null,
    aboveCount: hasLimits ? above : null,
    outOfSpecCount: hasLimits ? below + above : null,
  };
}
