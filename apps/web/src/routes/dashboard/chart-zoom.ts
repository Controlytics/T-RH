/**
 * Pure geometry for drag-to-zoom. Separated from the chart component because this
 * is the part that can be wrong in a way no build catches, and Playwright cannot
 * authenticate in this repo — a unit test is the only automated check the zoom
 * behaviour will ever get.
 *
 * ZOOM REFETCHES, IT DOES NOT MAGNIFY. These two functions turn a drag into a
 * TIME RANGE, which the page then requests from the server. Nothing here scales
 * the points already in memory: magnifying a downsampled window would draw
 * bigger dots and claim a resolution the client never received, which on a
 * §11 record is a picture asserting detail that does not exist.
 */

/** Clamped, so a drag that leaves the plot area selects the edge rather than extrapolating. */
export function pixelToTime(px: number, plotLeft: number, plotW: number, t0: number, t1: number): number {
  const ratio = Math.min(1, Math.max(0, (px - plotLeft) / plotW));
  return Math.round(t0 + ratio * (t1 - t0));
}

/**
 * Orders a drag and refuses one too narrow to be intentional.
 *
 * A click is a zero-width drag; without the floor it would set an empty range, the
 * refetch would return nothing, and the chart would blank on a stray click.
 */
export function normalizeSelection(a: number, b: number, minSpanMs: number): { from: number; to: number } | null {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  if (to - from < minSpanMs) return null;
  return { from, to };
}
