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
 * 3. SINCE 2026-08-27 THE FIGURES THE REPORT PRINTS COME FROM THE SERVER, not
 *    from the rows this file was handed — see `withServerSummary` below. The
 *    rows the report fetches are a SAMPLE spread across the period, so every
 *    figure over them is a figure over the sample. `summariseSlot` still
 *    computes everything from the rows; the report keeps only its `first`/`last`
 *    PAIRS, which are value+timestamp claims about two specific instants that
 *    the endpoint cannot supply and the sampler preserves verbatim.
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
  /** The attribute's own TEXT for each bound (`60 (For Reference)`), printed
   *  in the number's place wherever the bound is quoted (operator, 2026-10-03).
   *  Null = the number. Comes from the SERVER summary beside the number it
   *  captions, so the printed bound and its breach count are one answer. */
  limitMinText?: string | null;
  limitMaxText?: string | null;
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
  /** The whole range's extremes and mean — what the report prints. See
   *  `withServerSummary`. `avg` maps onto `SlotSummary.mean`. */
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
  /** The text each bound prints in place of its number; null = the number.
   *  Optional: a server from before 2026-10-03 sends neither. */
  limitMinText?: string | null;
  limitMaxText?: string | null;
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
 * `min`/`max`/`mean` COME FROM THE SERVER TOO, since 2026-08-27. They did not
 * at first: the stated reason was that whole-range extremes beside sample-derived
 * `first`/`last` would quote two populations — "Minimum 17.0" above a first/last
 * pair that never goes below 22.4. THAT REASONING WAS OVERTURNED, because
 * `first`/`last` are printed as "First reading" / "Last reading" WITH their own
 * timestamps: they are claims about two specific instants, not about the range,
 * and a range minimum below both of them is ordinary and expected. What the old
 * arrangement bought was the absence of a non-contradiction; what it cost was a
 * real one — a sampled maximum of 24.8 °C printed directly above "3 readings
 * above 25.0", in the artifact that leaves the building. LTTB may drop the one
 * reading that breached, and the breach counts beside it never do.
 *
 * `count` becomes the server's `numericCount`, the denominator the breach counts
 * are printed against — a numerator over the range above a denominator over the
 * sample could print more than 100%. It is also the population `min`/`max`/`mean`
 * and the breach counts are ALL taken over server-side (each is a numeric-guarded
 * aggregate or a `count(*) FILTER` over the same numeric cast), so the printed
 * block now quotes ONE population throughout, bar the two labelled instants.
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
    min: server.min,
    max: server.max,
    mean: server.avg,
    belowCount: server.belowCount,
    aboveCount: server.aboveCount,
    outOfSpecCount: server.outOfSpecCount,
    limitMin: server.limitMin,
    limitMax: server.limitMax,
    limitMinText: server.limitMinText ?? null,
    limitMaxText: server.limitMaxText ?? null,
  };
}
