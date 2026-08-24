import type { ChartSeries } from '@/routes/dashboard/time-series-chart';

/** One telemetry reading, LONG format — one row per key per timestamp. */
export interface TelemetryLongRow {
  key: string;
  value: number;
  ts: string;
}

/**
 * Pure transforms over the trend endpoint's LONG-format response.
 *
 * Both are pure and React-free on purpose — a pivot that silently invents a
 * reading that was never received is exactly the kind of bug that only shows
 * up by staring at rendered output, so the pivot logic is isolated here where
 * it can be asserted against instead.
 */

/**
 * One series' points for one key, oldest first, at that key's own precision.
 *
 * `bucketMs` is an OPTIONAL client-side aggregation bucket. No server-side
 * aggregation endpoint exists for this route (the telemetry route added in
 * Task 4 only grew an `offset`, not an interval/bucket parameter), so the
 * trend page's "Chart interval" control is honoured here, on the chart series
 * only, by averaging same-bucket points — never on `toTableRows`, which stays
 * raw. Omitting it (existing callers) is a no-op.
 */
export function toChartSeries(
  rows: TelemetryLongRow[],
  key: string,
  decimals: number,
  label: string,
  bucketMs?: number | null,
): ChartSeries {
  const points = rows
    .filter((r) => r.key === key)
    .map((r) => ({ ts: r.ts, value: r.value }))
    .sort((a, b) => a.ts.localeCompare(b.ts));

  return { id: key, label, decimals, points: bucketMs ? bucketize(points, bucketMs) : points };
}

/** Average same-bucket points into one, keyed by the bucket's start instant. */
function bucketize(points: { ts: string; value: number }[], bucketMs: number): { ts: string; value: number }[] {
  const buckets = new Map<number, { sum: number; count: number }>();
  for (const p of points) {
    const start = Math.floor(new Date(p.ts).getTime() / bucketMs) * bucketMs;
    const b = buckets.get(start);
    if (b) { b.sum += p.value; b.count += 1; } else buckets.set(start, { sum: p.value, count: 1 });
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, b]) => ({ ts: new Date(start).toISOString(), value: b.sum / b.count }));
}

export interface TableRow {
  ts: string;
  values: Record<string, number | null>;
}

/**
 * One row per timestamp, one column per requested key, newest first.
 *
 * A key with no reading at a given timestamp is `null`, never the previous
 * value — a §11 history must show only what was actually received. This is
 * the behaviour under test: do not "improve" it by filling gaps.
 */
export function toTableRows(rows: TelemetryLongRow[], keys: string[]): TableRow[] {
  const byTs = new Map<string, Record<string, number | null>>();
  for (const r of rows) {
    if (!keys.includes(r.key)) continue;
    let values = byTs.get(r.ts);
    if (!values) {
      values = Object.fromEntries(keys.map((k) => [k, null]));
      byTs.set(r.ts, values);
    }
    values[r.key] = r.value;
  }
  return [...byTs.entries()]
    .map(([ts, values]) => ({ ts, values }))
    .sort((a, b) => b.ts.localeCompare(a.ts));
}
