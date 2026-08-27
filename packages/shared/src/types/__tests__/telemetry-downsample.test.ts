import { describe, it, expect } from 'vitest';
import { lttb } from '../telemetry-downsample.js';
import { PERIOD_PRESETS } from '../telemetry-period.js';

const at = (i: number, value: number) => ({ ts: new Date(1_700_000_000_000 + i * 60_000).toISOString(), value });
const ramp = (n: number) => Array.from({ length: n }, (_, i) => at(i, i));

describe('lttb', () => {
  it('returns the input untouched when it is already small enough', () => {
    const pts = ramp(50);
    expect(lttb(pts, 100)).toBe(pts);
    expect(lttb(pts, 50)).toBe(pts);
  });

  it('returns exactly the requested number of points', () => {
    expect(lttb(ramp(10_000), 500)).toHaveLength(500);
  });

  /**
   * The range's own endpoints must be REAL readings, or the chart's x-extent
   * disagrees with the range the operator selected.
   */
  it('always keeps the first and last reading', () => {
    const pts = ramp(10_000);
    const out = lttb(pts, 250);
    expect(out[0]).toBe(pts[0]);
    expect(out[out.length - 1]).toBe(pts[pts.length - 1]);
  });

  /**
   * THE LOAD-BEARING ASSERTION. `toBe`, not `toEqual`: every returned element must
   * be the SAME OBJECT as an input element. A future refactor that "helpfully"
   * builds new points — averaging, rounding, re-timestamping — fails here. That is
   * the whole difference between this and the bucket-averaging the spec rejects.
   */
  it('never invents a point — every result is reference-equal to an input', () => {
    const pts = ramp(5_000);
    const inputs = new Set<unknown>(pts);
    for (const p of lttb(pts, 300)) expect(inputs.has(p)).toBe(true);
  });

  it('preserves chronological order', () => {
    const out = lttb(ramp(5_000), 400);
    for (let i = 1; i < out.length; i++) {
      expect(new Date(out[i].ts).getTime()).toBeGreaterThan(new Date(out[i - 1].ts).getTime());
    }
  });

  /**
   * The reason to use LTTB rather than "every Nth reading". A brief excursion is
   * the thing a Part 11 record exists to show; naive decimation drops it.
   */
  it('keeps a lone spike that naive every-Nth sampling would drop', () => {
    const pts = ramp(5_000);
    pts[2_501] = at(2_501, 999); // one sharp excursion, deliberately off a round index
    const out = lttb(pts, 200);
    expect(out.some((p) => p.value === 999)).toBe(true);
  });

  it('degenerates safely below three points', () => {
    const pts = ramp(1_000);
    expect(lttb(pts, 2)).toEqual([pts[0], pts[999]]);
    expect(lttb(pts, 1)).toEqual([pts[0], pts[999]]);
    expect(lttb([], 100)).toEqual([]);
  });

  it('accepts Date timestamps as well as ISO strings', () => {
    const pts = Array.from({ length: 500 }, (_, i) => ({ ts: new Date(1_700_000_000_000 + i * 1_000), value: i }));
    expect(lttb(pts, 100)).toHaveLength(100);
  });

  /**
   * Regression: an off-by-one in the bucket range formulas shifted every
   * selection window forward by one full bucket, so bucket 0's own candidates
   * — the head of the series — were never scanned by any iteration at any
   * target. A spike in that unscanned head vanished from every chart.
   */
  it.each([5, 1, 10, 25])('keeps a spike inside the first bucket (index %i)', (spikeIndex) => {
    const pts = ramp(5_000);
    pts[spikeIndex] = at(spikeIndex, 999999);
    const out = lttb(pts, 200);
    expect(out.some((p) => p.value === 999999)).toBe(true);
  });

  /**
   * At target === 3 there is exactly one selectable bucket (`target - 2 === 1`),
   * so it must find the real extremum in that bucket rather than defaulting to
   * `points[points.length - 2]` — the failure mode of the same off-by-one.
   */
  it('with target 3, selects the real extremum near the head, not always the point before last', () => {
    const pts = ramp(10);
    pts[1] = at(1, 999999);
    const out = lttb(pts, 3);
    expect(out).toHaveLength(3);
    expect(out.some((p) => p.value === 999999)).toBe(true);
  });
});

describe('period presets', () => {
  it('offers 12 hours', () => {
    const p = PERIOD_PRESETS.find((x) => x.value === '12h');
    expect(p).toBeTruthy();
    expect(p!.ms).toBe(12 * 3_600_000);
  });

  it('keeps the presets in ascending order so the control reads left to right', () => {
    const ms = PERIOD_PRESETS.map((p) => p.ms);
    expect([...ms].sort((a, b) => a - b)).toEqual(ms);
  });
});
