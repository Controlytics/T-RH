import { describe, it, expect } from 'vitest';
import { summariseSlot } from '../trend-summary';
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
