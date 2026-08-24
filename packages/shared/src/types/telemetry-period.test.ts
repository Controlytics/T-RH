import { describe, it, expect } from 'vitest';
import {
  PERIOD_PRESETS, INTERVALS, MAX_SERIES_POINTS,
  intervalSpec, isIntervalKey, isPeriodPreset,
  resolvePeriod, chooseInterval, describeRange,
} from './telemetry-period.js';

const NOW = new Date('2026-08-24T12:00:00.000Z');

describe('resolvePeriod', () => {
  it('measures a preset backwards from the instant it is given', () => {
    const r = resolvePeriod('1h', NOW);
    expect(r.to).toEqual(NOW);
    expect(r.from.toISOString()).toBe('2026-08-24T11:00:00.000Z');
  });

  it('uses the supplied custom range verbatim', () => {
    const custom = { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-08-02T00:00:00Z') };
    expect(resolvePeriod('custom', NOW, custom)).toEqual(custom);
  });

  it('falls back to 24h when custom is selected with no range yet', () => {
    // The picker can be switched to Custom before either date is filled in. A
    // NaN range here would reach the SQL as an invalid timestamp.
    const r = resolvePeriod('custom', NOW, null);
    expect(r.to.getTime() - r.from.getTime()).toBe(24 * 3_600_000);
  });

  it('never returns an invalid date for any preset', () => {
    for (const p of PERIOD_PRESETS) {
      const r = resolvePeriod(p.value, NOW);
      expect(Number.isNaN(r.from.getTime())).toBe(false);
      expect(r.from.getTime()).toBeLessThan(r.to.getTime());
    }
  });
});

describe('chooseInterval', () => {
  it('honours a request that fits', () => {
    const range = resolvePeriod('24h', NOW);          // 288 points at 5m
    const c = chooseInterval('5m', range);
    expect(c.interval).toBe('5m');
    expect(c.seconds).toBe(300);
    expect(c.downgradedFrom).toBeNull();
  });

  it('widens the bucket rather than serving an undrawable series', () => {
    const range = resolvePeriod('30d', NOW);          // 518k raw points at 5s
    const c = chooseInterval('raw', range);
    expect(c.downgradedFrom).toBe('raw');
    expect(c.seconds).not.toBeNull();
    expect((range.to.getTime() - range.from.getTime()) / 1000 / c.seconds!)
      .toBeLessThanOrEqual(MAX_SERIES_POINTS);
  });

  it('reports the downgrade so the UI cannot mislabel the resolution', () => {
    // A chart captioned "raw" that is actually hourly averages is a record that
    // misdescribes itself. The caller must be able to say what it really drew.
    const c = chooseInterval('1m', resolvePeriod('30d', NOW));
    expect(c.downgradedFrom).toBe('1m');
    expect(c.interval).not.toBe('1m');
  });

  it('keeps raw for a short window', () => {
    expect(chooseInterval('raw', resolvePeriod('15m', NOW)).downgradedFrom).toBeNull();
  });

  it('only ever widens, never narrows', () => {
    const order = INTERVALS.map((i) => i.value);
    for (const range of [resolvePeriod('7d', NOW), resolvePeriod('30d', NOW)]) {
      for (const asked of order) {
        const c = chooseInterval(asked, range);
        expect(order.indexOf(c.interval)).toBeGreaterThanOrEqual(order.indexOf(asked));
      }
    }
  });
});

describe('guards', () => {
  it('rejects unknown wire values', () => {
    expect(isIntervalKey('5m')).toBe(true);
    expect(isIntervalKey('7s')).toBe(false);
    expect(isIntervalKey(undefined)).toBe(false);
    expect(isPeriodPreset('custom')).toBe(true);
    expect(isPeriodPreset('99y')).toBe(false);
  });

  it('intervalSpec never returns undefined for a bad key', () => {
    expect(intervalSpec('nonsense' as never).seconds).toBe(300);
  });
});

describe('describeRange', () => {
  it('is stable and readable for an audit reason', () => {
    expect(describeRange({ from: new Date('2026-08-23T09:00:00Z'), to: new Date('2026-08-24T17:30:00Z') }))
      .toBe('2026-08-23 09:00 UTC → 2026-08-24 17:30 UTC');
  });
});
