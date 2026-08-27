import { describe, it, expect } from 'vitest';
import { summariseSlot, withServerSummary, type ServerSlotSummary } from '../trend-summary';
import { toChartSeries } from '../trend-series';

/**
 * The period summary is the block a §11 reader treats as authoritative, so the
 * two decisions encoded in it are asserted here directly rather than inferred
 * from a rendered PDF.
 */

const t = (ts: string, value: number) => ({ key: 't', value, ts });

describe('summariseSlot', () => {
  const rows = [
    t('2026-08-24T00:30:00.000Z', 26.9),   // deliberately out of order
    t('2026-08-24T00:10:00.000Z', 22.4),
    t('2026-08-24T00:20:00.000Z', 22.5),
    { key: 'h', value: 45.1, ts: '2026-08-24T00:10:00.000Z' },
  ];

  it('covers only its own key', () => {
    expect(summariseSlot(rows, 't', 'Temperature', '°C', 1, 18, 25)!.count).toBe(3);
  });

  it('orders by timestamp for first/last, not by arrival', () => {
    const s = summariseSlot(rows, 't', 'Temperature', '°C', 1, 18, 25)!;
    expect(s.first).toEqual({ value: 22.4, ts: '2026-08-24T00:10:00.000Z' });
    expect(s.last).toEqual({ value: 26.9, ts: '2026-08-24T00:30:00.000Z' });
  });

  it('computes min, max and mean over every reading', () => {
    const s = summariseSlot(rows, 't', 'Temperature', '°C', 1, 18, 25)!;
    expect(s.min).toBe(22.4);
    expect(s.max).toBe(26.9);
    expect(s.mean).toBeCloseTo((22.4 + 22.5 + 26.9) / 3, 10);
  });

  it('counts readings below and above the resolved limits separately', () => {
    const s = summariseSlot([...rows, t('2026-08-24T00:40:00.000Z', 12)], 't', 'Temperature', '°C', 1, 18, 25)!;
    expect(s.belowCount).toBe(1);
    expect(s.aboveCount).toBe(1);
    expect(s.outOfSpecCount).toBe(2);
  });

  it('reports NULL — not zero — when there are no limits to judge against', () => {
    // Zero would read as "nothing was out of spec". The truth is "nothing was
    // checked", and a §11 summary must not conflate the two.
    const s = summariseSlot(rows, 't', 'Temperature', '°C', 1, null, null)!;
    expect(s.outOfSpecCount).toBeNull();
    expect(s.belowCount).toBeNull();
    expect(s.aboveCount).toBeNull();
  });

  it('judges against a one-sided limit when only one is set', () => {
    const s = summariseSlot(rows, 't', 'Temperature', '°C', 1, null, 25)!;
    expect(s.belowCount).toBe(0);
    expect(s.aboveCount).toBe(1);
    expect(s.outOfSpecCount).toBe(1);
  });

  it('treats a reading exactly ON a limit as in spec', () => {
    const s = summariseSlot([t('2026-08-24T00:10:00.000Z', 25)], 't', 'Temperature', '°C', 1, 18, 25)!;
    expect(s.outOfSpecCount).toBe(0);
  });

  it('returns null for a slot with no readings, rather than a row of dashes', () => {
    expect(summariseSlot(rows, 'nope', 'Nope', '', 1, 18, 25)).toBeNull();
  });

  /**
   * THE ONE THAT MATTERS MOST.
   *
   * A single reading breaching a limit for one sample is averaged back inside
   * the band by a wide enough bucket and disappears from the plotted series
   * entirely. If the summary were computed from what the chart plots, the
   * excursion would vanish from the block a §11 reader trusts. It is computed
   * from the stored readings for exactly this reason.
   */
  it('sees an excursion that averaging smooths away', () => {
    const spiky = [
      t('2026-08-24T00:00:00.000Z', 22.0),
      t('2026-08-24T00:01:00.000Z', 22.0),
      t('2026-08-24T00:02:00.000Z', 31.0),   // the breach
      t('2026-08-24T00:03:00.000Z', 22.0),
      t('2026-08-24T00:04:00.000Z', 22.0),
    ];

    // What a 5-minute bucket would plot: one point, comfortably in spec.
    const plotted = toChartSeries(spiky, 't', 1, 'Temperature', 5 * 60_000).points;
    expect(plotted).toHaveLength(1);
    expect(plotted[0].value).toBeLessThan(25);

    // What the summary reports, from the stored readings.
    const s = summariseSlot(spiky, 't', 'Temperature', '°C', 1, 18, 25)!;
    expect(s.max).toBe(31);
    expect(s.aboveCount).toBe(1);
    expect(s.count).toBe(5);

    // And the summary computed FROM the plotted points — the bug this guards —
    // would have reported no excursion at all.
    const fromPlotted = summariseSlot(
      plotted.map((pt) => ({ key: 't', value: pt.value, ts: pt.ts })),
      't', 'Temperature', '°C', 1, 18, 25,
    )!;
    expect(fromPlotted.aboveCount).toBe(0);
  });
});

/**
 * `withServerSummary` — the sampled figures replaced by the server's.
 *
 * The report fetches its rows down the `points=` path, which returns a sample
 * of the period rather than every reading. Counting excursions over that
 * sample understates the record, and the PDF prints the number under a heading
 * naming the whole period. These tests fix the two claims that must not slip:
 * the counts describe the RANGE, and an absent bound stays null all the way to
 * the renderer instead of becoming a zero.
 */
describe('withServerSummary', () => {
  const sampled = [
    t('2026-08-24T00:10:00.000Z', 22.4),
    t('2026-08-24T00:20:00.000Z', 22.5),
  ];
  const base = () => summariseSlot(sampled, 't', 'Temperature', '°C', 1, 18, 25)!;

  const server: ServerSlotSummary = {
    numericCount: 2500, min: 17, max: 99.9, avg: 20.2,
    belowCount: 2, aboveCount: 7, outOfSpecCount: 9,
    limitMin: 18, limitMax: 25,
  };

  it('takes the counts from the range, not from the sample', () => {
    const before = base();
    // The sample holds two in-limit readings; the range holds nine breaches the
    // sampler never returned. Counted over the sample this is a clean period.
    expect(before.outOfSpecCount).toBe(0);

    const after = withServerSummary(before, server)!;
    expect(after.count).toBe(2500);
    expect(after.belowCount).toBe(2);
    expect(after.aboveCount).toBe(7);
    expect(after.outOfSpecCount).toBe(9);
  });

  it('takes the EXTREMES from the range too, so the block cannot contradict itself', () => {
    // OVERTURNS the original decision to leave min/max/mean row-derived. A
    // sample-derived maximum can sit BELOW a limit the same block reports
    // breaches of: here the sample tops out at 22.5 while the range holds 7
    // readings above the 25 high limit. "Maximum 22.5 °C" printed above "7
    // readings above 25.0" is arithmetically impossible, in the artifact that
    // leaves the building.
    //
    // The reasoning it replaces was that whole-range extremes beside
    // sample-derived `first`/`last` quote two populations. They do not
    // conflict: `first`/`last` are printed as "First reading"/"Last reading"
    // WITH their own timestamps — claims about two instants, not about the
    // range — so a range minimum below both is expected.
    const after = withServerSummary(base(), server)!;
    expect(after.min).toBe(17);
    expect(after.max).toBe(99.9);
    expect(after.mean).toBe(20.2);
    // The contradiction the swap exists to prevent: the printed maximum can
    // never sit below a high limit the printed count reports breaches of.
    expect(after.aboveCount).toBe(7);
    expect(after.max).toBeGreaterThan(after.limitMax!);
  });

  it('keeps first/last as the sampled value+timestamp pairs', () => {
    // The ONE thing that stays row-derived. The endpoint returns only
    // timestamps for these two, and the sampler keeps the range's endpoints
    // verbatim, so the pairs computed here are the true first and last stored
    // readings of the period.
    const after = withServerSummary(base(), server)!;
    expect(after.first).toEqual({ value: 22.4, ts: '2026-08-24T00:10:00.000Z' });
    expect(after.last).toEqual({ value: 22.5, ts: '2026-08-24T00:20:00.000Z' });
    expect(after.label).toBe('Temperature');
    expect(after.decimals).toBe(1);
  });

  it('carries an absent bound through as null, never as zero', () => {
    // Zero would claim the readings were checked against a low limit and
    // passed. Nothing was checked — a claim of compliance the data cannot
    // support is the one thing this field exists to prevent.
    const after = withServerSummary(base(), {
      ...server, belowCount: null, limitMin: null, outOfSpecCount: 7,
    })!;
    expect(after.belowCount).toBeNull();
    expect(after.limitMin).toBeNull();
    expect(after.aboveCount).toBe(7);
    expect(after.outOfSpecCount).toBe(7);
  });

  it('prints the bound the server counted against, not the screen\'s', () => {
    // The two resolutions can differ (a room band vs an instrument's own). One
    // table quoting a count from one and a limit from the other would be
    // internally inconsistent on a signed record.
    const after = withServerSummary(base(), { ...server, limitMax: 24 })!;
    expect(after.limitMax).toBe(24);
  });

  it('leaves the sampled figures alone when the server sent none for this key', () => {
    // Nothing truer to put in their place; dropping the block would remove the
    // summary from the report rather than qualify it.
    const after = withServerSummary(base(), undefined)!;
    expect(after.count).toBe(2);
    expect(after.max).toBe(22.5);
  });

  it('is null-safe on a slot with no readings', () => {
    expect(withServerSummary(null, server)).toBeNull();
  });
});
