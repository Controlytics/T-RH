import { describe, it, expect } from 'vitest';
import { niceScale, seriesColor, SERIES_COLORS } from '../time-series-chart';

describe('niceScale', () => {
  it('covers the requested range', () => {
    const s = niceScale(18.3, 24.7);
    expect(s.min).toBeLessThanOrEqual(18.3);
    expect(s.max).toBeGreaterThanOrEqual(24.7);
  });

  it('never returns a zero or negative step', () => {
    expect(niceScale(20, 20).step).toBeGreaterThan(0);
    expect(niceScale(0, 0).step).toBeGreaterThan(0);
  });

  it('gives a flat series visible range rather than a degenerate axis', () => {
    // A zero-height axis divides by zero and draws every point on one pixel
    // row, which looks identical to a broken chart.
    const s = niceScale(22, 22);
    expect(s.max).toBeGreaterThan(s.min);
  });

  it('handles a negative range', () => {
    const s = niceScale(-20, -5);
    expect(s.min).toBeLessThanOrEqual(-20);
    expect(s.max).toBeGreaterThanOrEqual(-5);
  });

  it('produces ascending ticks inside the range', () => {
    const s = niceScale(0, 100);
    expect(s.ticks).toEqual([...s.ticks].sort((a, b) => a - b));
    expect(s.ticks[0]).toBeGreaterThanOrEqual(s.min);
    expect(s.ticks[s.ticks.length - 1]).toBeLessThanOrEqual(s.max);
  });

  it('survives non-finite input instead of emitting NaN geometry', () => {
    const s = niceScale(NaN, Infinity);
    expect(Number.isFinite(s.min)).toBe(true);
    expect(Number.isFinite(s.max)).toBe(true);
    expect(s.ticks.every(Number.isFinite)).toBe(true);
  });

  it('rounds ticks to human values', () => {
    const s = niceScale(0, 10);
    for (const t of s.ticks) expect(Number.isInteger(t * 100)).toBe(true);
  });
});

describe('seriesColor', () => {
  it('assigns hues in fixed order, never cycled into a generated colour', () => {
    expect(seriesColor(0)).toBe(SERIES_COLORS[0]);
    expect(seriesColor(1)).toBe(SERIES_COLORS[1]);
    expect(seriesColor(2)).toBe(SERIES_COLORS[2]);
  });

  it('is stable for a given index — colour follows the entity, not its rank', () => {
    expect(seriesColor(1)).toBe(seriesColor(1));
  });

  it('clamps past the end of the palette rather than inventing a hue', () => {
    const beyond = seriesColor(SERIES_COLORS.length + 5);
    expect(SERIES_COLORS).toContain(beyond);
  });
});
