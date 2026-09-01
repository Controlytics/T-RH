import { describe, it, expect } from 'vitest';
import { toChartSeries, toTableRows, rawCountForKey , toTableRowsWithErrors } from '../trend-series';

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

describe('rawCountForKey', () => {
  it('counts every row for the key, not the number of points a chart would draw', () => {
    expect(rawCountForKey(rows, 'temp')).toBe(2);
  });
  it('returns 0 for a key that never appears', () => {
    expect(rawCountForKey(rows, 'co2')).toBe(0);
  });

  /**
   * The bug this guards: `SampledNote`'s `shown` count used to be
   * `toChartSeries(...).points.length`, which is the BUCKET count once an
   * interval is selected — not the number of raw readings the chart
   * represents. A 1-hour period with 3,600 raw readings bucketed to 5
   * minutes plots 12 points, so the note read "Showing 12 of 3,600
   * readings" directly under `ChartIntervalNote`'s "the table below shows
   * every reading" — two contradictory claims in the same card, on a §11
   * page, for a chart where nothing was actually dropped. `rawCountForKey`
   * must stay the RAW count regardless of bucketing.
   */
  it('stays the raw reading count even when the same rows would bucket down to far fewer chart points', () => {
    const threeReadingsOneBucket = [
      { key: 'temp', value: 21.5, ts: '2026-08-24T10:00:00.000Z' },
      { key: 'temp', value: 21.6, ts: '2026-08-24T10:01:00.000Z' },
      { key: 'temp', value: 21.7, ts: '2026-08-24T10:02:00.000Z' },
    ];
    const bucketed = toChartSeries(threeReadingsOneBucket, 'temp', 1, 'Temperature', 5 * 60_000);
    expect(bucketed.points).toHaveLength(1); // what the chart DRAWS
    expect(rawCountForKey(threeReadingsOneBucket, 'temp')).toBe(3); // what it REPRESENTS
  });

  // The caller passes rows with `value: unknown` (the response's raw shape,
  // before this page's numeric-only filter) precisely so a non-numeric
  // reading on this key is counted the same way the server's
  // `summaries[key].count` counts it (`count(*)`, no numeric guard) — a
  // type that required `value: number` would force filtering first, which
  // is exactly the mismatch that made the boundary case work "by accident".
  it('counts a row regardless of its value type — matches the server COUNT(*), not a numeric-only count', () => {
    const withNonNumeric = [
      { key: 'temperature', value: 21.5, ts: '2026-08-24T10:00:00.000Z' },
      { key: 'temperature', value: 'ERR', ts: '2026-08-24T10:01:00.000Z' },
    ];
    expect(rawCountForKey(withNonNumeric, 'temperature')).toBe(2);
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

describe('toTableRowsWithErrors — the raw table must not hide broken readings', () => {
  it('keeps a non-numeric reading as an error instead of dropping the row', () => {
    // The defect this exists for: the table says it lists every reading in the
    // range, and it was built from `numericRows`, which DROPS anything that is
    // not a number — silently omitting exactly the readings an engineer opens
    // this table to find.
    const rows = toTableRowsWithErrors([
      { key: 'temperature', value: 'NA', ts: '2026-08-31T10:00:00Z' },
      { key: 'humidity', value: 45.2, ts: '2026-08-31T10:00:00Z' },
    ], ['temperature', 'humidity']);

    expect(rows).toHaveLength(1);
    expect(rows[0].errors?.temperature).toBe(true);
    expect(rows[0].values.temperature).toBeNull();
    expect(rows[0].values.humidity).toBe(45.2);
    expect(rows[0].errors?.humidity).toBeUndefined();
  });

  it('distinguishes a broken reading from no reading at all', () => {
    // Both leave `values[key]` null. Only one is a fault, and the table has to
    // say which — that distinction is the whole point of the word.
    const rows = toTableRowsWithErrors(
      [{ key: 'temperature', value: 'NA', ts: '2026-08-31T10:00:00Z' }],
      ['temperature', 'humidity'],
    );
    expect(rows[0].errors?.temperature).toBe(true);
    expect(rows[0].errors?.humidity).toBeUndefined();
    expect(rows[0].values.humidity).toBeNull();
  });

  it('reads a QUOTED number as a value, not an error', () => {
    // The one definition (`coerceReading`) the dashboard and the alarms share.
    const rows = toTableRowsWithErrors(
      [{ key: 'temperature', value: '23.5', ts: '2026-08-31T10:00:00Z' }],
      ['temperature'],
    );
    expect(rows[0].values.temperature).toBe(23.5);
    expect(rows[0].errors?.temperature).toBeUndefined();
  });

  it('still flags an empty string as an error, never as 0', () => {
    const rows = toTableRowsWithErrors(
      [{ key: 'temperature', value: '', ts: '2026-08-31T10:00:00Z' }],
      ['temperature'],
    );
    expect(rows[0].errors?.temperature).toBe(true);
    expect(rows[0].values.temperature).toBeNull();
  });

  it('keeps 0 as a real reading, not an error', () => {
    const rows = toTableRowsWithErrors(
      [{ key: 'temperature', value: 0, ts: '2026-08-31T10:00:00Z' }],
      ['temperature'],
    );
    expect(rows[0].values.temperature).toBe(0);
    expect(rows[0].errors?.temperature).toBeUndefined();
  });

  it('still sorts newest first, like the numeric builder', () => {
    const rows = toTableRowsWithErrors([
      { key: 'temperature', value: 'NA', ts: '2026-08-31T10:00:00Z' },
      { key: 'temperature', value: 21, ts: '2026-08-31T11:00:00Z' },
    ], ['temperature']);
    expect(rows.map((r) => r.ts)).toEqual(['2026-08-31T11:00:00Z', '2026-08-31T10:00:00Z']);
  });
});
