import { describe, it, expect } from 'vitest';
import { toChartSeries, toTableRows } from '../trend-series';

const rows = [
  { key: 'temp', value: 21.5, ts: '2026-08-24T10:00:00.000Z' },
  { key: 'rh',   value: 45,   ts: '2026-08-24T10:00:00.000Z' },
  { key: 'temp', value: 21.7, ts: '2026-08-24T10:00:10.000Z' },
];

describe('toChartSeries', () => {
  it('keeps only the requested key', () => {
    expect(toChartSeries(rows, 'temp', 1, 'Temperature').points).toHaveLength(2);
  });
  it('orders points oldest first, whatever order they arrived in', () => {
    const s = toChartSeries([...rows].reverse(), 'temp', 1, 'Temperature');
    expect(s.points[0].ts < s.points[1].ts).toBe(true);
  });
  it('carries the per-instrument decimals onto the series', () => {
    expect(toChartSeries(rows, 'temp', 2, 'Temperature').decimals).toBe(2);
  });
  it('returns an empty series rather than throwing when the key never appears', () => {
    expect(toChartSeries(rows, 'co2', 1, 'CO2').points).toEqual([]);
  });

  // Additional coverage beyond the plan's given tests: the optional bucketMs
  // parameter. No server-side aggregation endpoint exists yet (Task 4 only
  // added `offset`, not an interval/bucket param), so the "Chart interval"
  // control this trend page offers is honoured client-side, on the chart
  // series only — never on the raw table (toTableRows below stays unbucketed).
  describe('bucketMs (client-side chart aggregation, no server endpoint exists for this)', () => {
    it('is a no-op when omitted — existing callers are unaffected', () => {
      expect(toChartSeries(rows, 'temp', 1, 'Temperature').points).toEqual([
        { ts: '2026-08-24T10:00:00.000Z', value: 21.5 },
        { ts: '2026-08-24T10:00:10.000Z', value: 21.7 },
      ]);
    });
    it('averages points that fall in the same bucket', () => {
      const s = toChartSeries(rows, 'temp', 1, 'Temperature', 60_000);
      expect(s.points).toHaveLength(1);
      expect(s.points[0].value).toBeCloseTo(21.6);
    });
    it('leaves points in different buckets separate', () => {
      const wide = [
        { key: 'temp', value: 20, ts: '2026-08-24T10:00:00.000Z' },
        { key: 'temp', value: 22, ts: '2026-08-24T10:10:00.000Z' },
      ];
      const s = toChartSeries(wide, 'temp', 1, 'Temperature', 60_000);
      expect(s.points).toHaveLength(2);
    });
  });
});

describe('toTableRows', () => {
  it('pivots one row per timestamp with a column per key', () => {
    const out = toTableRows(rows, ['temp', 'rh']);
    expect(out).toHaveLength(2);
    // Asserted by timestamp, not position: the plan's original draft of this
    // test asserted `out[0]` directly, which silently assumed oldest-first
    // output — contradicting the "orders newest first" test below it (and the
    // prose spec, "newest first, as a history list reads"). Both cannot pass
    // against the same two-distinct-timestamp fixture; newest-first is the
    // one actually specified, so this assertion is pinned to the timestamp
    // instead of a position that only held under the other ordering.
    const first = out.find((r) => r.ts === '2026-08-24T10:00:00.000Z')!;
    expect(first.values).toEqual({ temp: 21.5, rh: 45 });
  });
  it('leaves a key null at a timestamp that did not carry it — never carries the previous value forward', () => {
    const out = toTableRows(rows, ['temp', 'rh']);
    const second = out.find((r) => r.ts.endsWith('10.000Z'))!;
    expect(second.values.rh).toBeNull();
  });
  it('orders newest first, as a history list reads', () => {
    const out = toTableRows(rows, ['temp']);
    expect(out[0].ts > out[1].ts).toBe(true);
  });
});
