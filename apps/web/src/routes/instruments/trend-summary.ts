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
 *
 * 3. SINCE 2026-08-27 THE COUNTS THE REPORT PRINTS COME FROM THE SERVER, not
 *    from the rows this file was handed — see `withServerSummary` below. The
 *    rows the report fetches are a SAMPLE spread across the period, so a count
 *    over them is a count over the sample. `summariseSlot` still computes
 *    everything from the rows, and its extremes and its `first`/`last` pairs
 *    are what the report keeps.
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

/**
 * The endpoint's own aggregates for one key, from `summaries[key]` on the
 * `points=` (chart) response.
 *
 * Every number here was computed in SQL over EVERY reading in the range. The
 * client cannot reproduce them: it holds a sample.
 */
export interface ServerSlotSummary {
  /** Readings carrying a number — the population the counts are over, and the
   *  denominator the report prints them against. */
  numericCount: number;
  /** Present on the payload and deliberately NOT used by `withServerSummary` —
   *  see the note there on why the printed extremes stay row-derived. */
  min: number;
  max: number;
  avg: number;
  /** `null` means NO LIMIT WAS SET for this bound. Not zero. */
  belowCount: number | null;
  aboveCount: number | null;
  outOfSpecCount: number | null;
  /** The bound each count was actually taken against, from the server's own
   *  limit resolution — so the printed limit and the printed count cannot come
   *  from two different answers to "which limit applies?". */
  limitMin: number | null;
  limitMax: number | null;
}

/**
 * Replace the sampled figures with the server's true ones.
 *
 * WHY THIS EXISTS. The report fetches its rows down the `points=` path, which
 * returns a representative sample of the period, not every reading. A count of
 * out-of-limit readings taken over that sample understates an excursion the
 * sampler did not draw, and the PDF prints that number under a heading naming
 * the whole period — a §11 misstatement with no tell.
 *
 * COUNTS AND BOUNDS ONLY. `min`/`max`/`mean` are deliberately NOT taken from
 * the server, even though the payload carries them. They would come from the
 * whole range while `first`/`last` — value+timestamp PAIRS the endpoint cannot
 * supply, so they must stay row-derived — come from the sample, and the printed
 * block would then quote two populations with nothing saying so: "Minimum 17.0"
 * above a first/last pair that never goes below 22.4 is a table contradicting
 * itself. A count is self-describing against `count`; an extreme is not. (LTTB
 * is extremity-preserving by construction, so the practical gap is small; the
 * visible contradiction would not be.) If whole-range extremes are ever wanted
 * here, `first`/`last` have to be solved in the same change.
 *
 * `count` DOES become the server's `numericCount`, because it is the
 * denominator the breach counts are printed against — a numerator over the
 * range above a denominator over the sample could print more than 100%.
 *
 * With no server summary for the key (nothing in the range, or a caller that
 * did not take the chart path) the sampled figures stand — there is nothing
 * truer to put in their place, and dropping the block entirely would remove
 * the summary from the report rather than qualify it.
 */
export function withServerSummary(
  summary: SlotSummary | null,
  server: ServerSlotSummary | undefined,
): SlotSummary | null {
  if (!summary || !server) return summary;
  return {
    ...summary,
    count: server.numericCount,
    belowCount: server.belowCount,
    aboveCount: server.aboveCount,
    outOfSpecCount: server.outOfSpecCount,
    limitMin: server.limitMin,
    limitMax: server.limitMax,
  };
}
