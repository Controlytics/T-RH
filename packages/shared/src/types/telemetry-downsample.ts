/**
 * Downsampling for telemetry charts — by SELECTION, never by computation.
 *
 * Design: docs/superpowers/specs/2026-08-27-instrument-trend-page-design.md
 *
 * At this installation's cadence (a reading every 30-90s) a 30-day range holds
 * 28,000-86,000 readings per key. A 1600px chart has 1600 columns, so those points
 * are already sub-pixel; sending them all costs tens of MB and stalls the tab
 * without showing anything more.
 *
 * The answer is NOT to average. An averaged point is a value that was never read,
 * and a brief excursion — the thing a 21 CFR Part 11 record exists to show —
 * vanishes into its bucket's mean. Largest-Triangle-Three-Buckets instead PICKS
 * which stored readings to draw, so every plotted point is real, keeps its own
 * timestamp, and peaks survive.
 */

export interface DownsamplePoint {
  ts: string | Date;
  value: number;
}

const millis = (ts: string | Date): number => (ts instanceof Date ? ts.getTime() : new Date(ts).getTime());

/**
 * Largest-Triangle-Three-Buckets.
 *
 * Divides the series into `target - 2` buckets between the fixed first and last
 * points and picks, from each, the reading forming the largest triangle with the
 * previously selected point and the next bucket's average position. That area
 * metric is what preserves shape and spikes.
 *
 * Returns the ORIGINAL array (same reference) when no sampling is needed, so a
 * caller can cheaply tell that nothing was dropped.
 */
export function lttb<T extends DownsamplePoint>(points: T[], target: number): T[] {
  if (points.length === 0) return points;
  if (target >= points.length) return points;

  const first = points[0];
  const last = points[points.length - 1];
  if (target <= 2) return [first, last];

  const out: T[] = [first];
  // Buckets span the points BETWEEN the fixed endpoints.
  const bucketSize = (points.length - 2) / (target - 2);
  let selected = 0;

  for (let i = 0; i < target - 2; i++) {
    // Selection range for bucket `i`: the points between the fixed first point
    // and the next bucket boundary. `i`/`(i + 1)` — NOT `(i + 1)`/`(i + 2)` —
    // or bucket 0's own candidates are never scanned by any iteration.
    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, points.length - 1);

    // The NEXT bucket's average position, which the triangle is measured against.
    const nextStart = rangeEnd;
    const nextEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, points.length);
    const nextCount = Math.max(1, nextEnd - nextStart);
    let avgX = 0;
    let avgY = 0;
    for (let j = nextStart; j < nextEnd; j++) {
      avgX += millis(points[j].ts);
      avgY += points[j].value;
    }
    avgX /= nextCount;
    avgY /= nextCount;

    const aX = millis(points[selected].ts);
    const aY = points[selected].value;

    let bestArea = -1;
    let bestIndex = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs(
        (aX - avgX) * (points[j].value - aY) - (aX - millis(points[j].ts)) * (avgY - aY),
      );
      if (area > bestArea) {
        bestArea = area;
        bestIndex = j;
      }
    }

    out.push(points[bestIndex]);
    selected = bestIndex;
  }

  out.push(last);
  return out;
}
