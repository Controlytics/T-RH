/**
 * The rules behind the dashboard's aggregate trend card.
 *
 * Pure and separate from the component so each one is testable without a browser —
 * Playwright cannot authenticate against this install's certificate, so a unit test
 * is the only automated check these will ever get.
 */

export interface AggregatePoint {
  ts: string;
  min: number;
  mean: number;
  max: number;
  instrumentCount: number;
}

export interface AggregateBounds { min: number | null; max: number | null }

/**
 * Below this many instruments reporting in a bucket, the card shows the COUNT
 * instead of a band.
 *
 * Operator's call, 2026-08-28, made after the endpoint's first run against live
 * data showed 1 of 101 instruments reporting: a "spread across 33 instruments"
 * computed from one sensor is technically correct and practically a lie. Two is
 * the floor because a spread across one instrument is not a spread.
 */
export const MIN_INSTRUMENTS_FOR_BAND = 2;

/** The largest number of instruments seen in any bucket. */
export function peakReporting(points: AggregatePoint[]): number {
  return points.reduce((n, p) => Math.max(n, p.instrumentCount), 0);
}

/**
 * Whether to draw the band at all.
 *
 * Judged on the PEAK rather than the latest bucket: one quiet bucket at the end of
 * a window is normal at a 30–90 second cadence, and collapsing the whole chart
 * because of it would make the card flicker between two presentations.
 */
export function shouldDrawBand(points: AggregatePoint[]): boolean {
  return peakReporting(points) >= MIN_INSTRUMENTS_FOR_BAND;
}

/**
 * What to say when the band is suppressed. Names both numbers, because "1
 * reporting" alone does not tell the reader how much they are not seeing.
 */
export function sparseMessage(points: AggregatePoint[], selectionCount: number): string {
  const peak = peakReporting(points);
  if (peak === 0) {
    return selectionCount === 0
      ? 'No instruments in this selection.'
      : `No readings in this period from any of the ${selectionCount} instruments in this selection.`;
  }
  return `Only ${peak} of ${selectionCount} instruments reported in this period — too few for a meaningful spread.`;
}

/**
 * The one-line disclosure that rides above the chart.
 *
 * Every value on this chart is COMPUTED. On a 21 CFR Part 11 system a derived
 * number that looks like a recorded one is a misrepresentation, not a
 * presentational shortcut — the same reason the per-instrument trend page labels
 * an averaged chart and refuses to let its sampler invent a point.
 */
export function derivedNote(selectionCount: number): string {
  return `Minimum, mean and maximum across ${selectionCount} instrument${selectionCount === 1 ? '' : 's'} `
    + 'per interval. These are computed values, not stored readings.';
}

/**
 * What to say about limit lines.
 *
 * `null` means say nothing — either the lines are drawn, or nothing in the
 * selection is bounded and there is no claim to make. A selection where NOTHING
 * has limits is unbounded, not mixed, and announcing "different limits" there
 * would be untrue.
 */
export function limitNote(bounds: AggregateBounds | null, mixed: boolean): string | null {
  if (bounds !== null) return null;
  if (!mixed) return null;
  return 'Instruments in this selection have different limits, so no limit line is drawn.';
}
