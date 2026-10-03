import { describe, it, expect } from 'vitest';
import {
  checkLimits,
  limitsInverted,
  describeLimit,
  finiteOrNull,
  limitSnapshot,
  type InstrumentLimits,
} from '../limit-decide.js';

const none: InstrumentLimits = {
  temperatureHigh: null, temperatureLow: null, humidityHigh: null, humidityLow: null,
};
const temp: InstrumentLimits = { ...none, temperatureHigh: 25, temperatureLow: 18 };

describe('checkLimits', () => {
  it('raises HIGH above the high limit', () => {
    const out = checkLimits(temp, { temperature: 26.4, humidity: null });
    expect(out).toEqual([
      { metric: 'TEMPERATURE', limitKind: 'HIGH', limit: 25, breaching: true },
      { metric: 'TEMPERATURE', limitKind: 'LOW', limit: 18, breaching: false },
    ]);
  });

  it('raises LOW below the low limit', () => {
    const out = checkLimits(temp, { temperature: 17.2, humidity: null });
    expect(out.find((c) => c.limitKind === 'LOW')?.breaching).toBe(true);
    expect(out.find((c) => c.limitKind === 'HIGH')?.breaching).toBe(false);
  });

  it('treats a reading EXACTLY at either limit as in spec', () => {
    // Boundaries are in spec everywhere else in this system (decide.ts
    // OUTSIDE_RANGE, telemetry-slots breaches). This must not be the exception.
    expect(checkLimits(temp, { temperature: 25, humidity: null }).every((c) => !c.breaching)).toBe(true);
    expect(checkLimits(temp, { temperature: 18, humidity: null }).every((c) => !c.breaching)).toBe(true);
  });

  it('never checks a bound that has no limit', () => {
    const highOnly: InstrumentLimits = { ...none, temperatureHigh: 25 };
    const out = checkLimits(highOnly, { temperature: -40, humidity: null });
    expect(out).toEqual([{ metric: 'TEMPERATURE', limitKind: 'HIGH', limit: 25, breaching: false }]);
  });

  it('returns nothing when the instrument has no limits at all', () => {
    expect(checkLimits(none, { temperature: 99, humidity: 99 })).toEqual([]);
  });

  it('treats a missing reading as NOT breaching — that is the OFFLINE concern', () => {
    expect(checkLimits(temp, { temperature: null, humidity: null }).every((c) => !c.breaching)).toBe(true);
  });

  it('treats a non-finite reading (NaN, Infinity) as NOT breaching, same as null', () => {
    expect(checkLimits(temp, { temperature: NaN, humidity: null }).every((c) => !c.breaching)).toBe(true);
    expect(checkLimits(temp, { temperature: Infinity, humidity: null }).every((c) => !c.breaching)).toBe(true);
  });

  it('checks temperature and humidity independently', () => {
    const both: InstrumentLimits = { temperatureHigh: 25, temperatureLow: 18, humidityHigh: 60, humidityLow: 40 };
    const out = checkLimits(both, { temperature: 26, humidity: 30 });
    expect(out.filter((c) => c.breaching)).toEqual([
      { metric: 'TEMPERATURE', limitKind: 'HIGH', limit: 25, breaching: true },
      { metric: 'HUMIDITY', limitKind: 'LOW', limit: 40, breaching: true },
    ]);
  });

  it('skips BOTH bounds of an inverted pair rather than alarming forever', () => {
    const inverted: InstrumentLimits = { ...none, temperatureHigh: 20, temperatureLow: 30 };
    expect(checkLimits(inverted, { temperature: 25, humidity: null })).toEqual([]);
  });
});

describe('limitsInverted', () => {
  it('is true only when both are set and low is above high', () => {
    expect(limitsInverted(20, 30)).toBe(true);
    expect(limitsInverted(30, 20)).toBe(false);
    expect(limitsInverted(25, 25)).toBe(false);
    expect(limitsInverted(null, 30)).toBe(false);
    expect(limitsInverted(20, null)).toBe(false);
  });
});

describe('finiteOrNull', () => {
  // The guard the raise path (checkPair, via checkLimits above) and the worker's
  // clear-path branch BOTH go through — see its doc comment for why they must
  // agree. Testing it directly here (rather than only through checkLimits) is
  // what lets the worker's clear-branch guard be exercised without needing a
  // NaN to survive Postgres jsonb storage, which it cannot.
  it('passes through a real finite number', () => {
    expect(finiteOrNull(26.4)).toBe(26.4);
    expect(finiteOrNull(0)).toBe(0);
    expect(finiteOrNull(-12)).toBe(-12);
  });

  it('rejects NaN and Infinity', () => {
    expect(finiteOrNull(NaN)).toBeNull();
    expect(finiteOrNull(Infinity)).toBeNull();
    expect(finiteOrNull(-Infinity)).toBeNull();
  });

  it('rejects null, undefined, and non-numbers', () => {
    expect(finiteOrNull(null)).toBeNull();
    expect(finiteOrNull(undefined)).toBeNull();
    expect(finiteOrNull('26.4')).toBeNull();
  });
});

describe('describeLimit', () => {
  it('reads as the condition that fired', () => {
    expect(describeLimit({ metric: 'TEMPERATURE', limitKind: 'HIGH', limit: 25 }))
      .toBe('temperature above 25');
    expect(describeLimit({ metric: 'HUMIDITY', limitKind: 'LOW', limit: 40 }))
      .toBe('humidity below 40');
  });
});

describe('limitSnapshot — both bounds are frozen', () => {
  /**
   * Added 2026-09-01 for the Alarm Report, whose HIGH SET POINT VALUE and LOW SET
   * POINT VALUE columns are the instrument's High/Low Temperature (or Humidity)
   * Limit.
   *
   * Only the BREACHED bound was frozen before, so the report could not name the
   * counterpart — and reading it live would print TODAY's limit against a June
   * excursion, which is the thing freezing exists to prevent.
   */
  const base = {
    metric: 'TEMPERATURE',
    limitKind: 'HIGH',
    limit: 27,
    attributeKey: 'High Temperature Limit',
    snapshotAt: '2026-09-01T10:00:00.000Z',
  };

  // Operator, 2026-10-03: a limit attribute may carry text beside its number
  // (`27 (For Reference)`). The text is frozen WITH the number, and never for a
  // bound that is not in force — a caption for a withheld bound would print it.
  it('freezes each bound\'s TEXT beside its number, and only for a bound in force', () => {
    const snap = limitSnapshot({
      ...base, thresholdHigh: 27, thresholdLow: null,
      thresholdHighText: '27 (For Reference)', thresholdLowText: '18 (stale)',
    });
    expect(snap.thresholdHighText).toBe('27 (For Reference)');
    expect(snap.thresholdLowText).toBeNull();
    // A bare number freezes a null text, and an older caller omits both.
    expect(limitSnapshot({ ...base, thresholdHigh: 27 }).thresholdHighText).toBeNull();
  });

  it('freezes the pair, not just the one that fired', () => {
    const snap = limitSnapshot({ ...base, thresholdHigh: 27, thresholdLow: 18 });
    expect(snap.thresholdHigh).toBe(27);
    expect(snap.thresholdLow).toBe(18);
    // The breached bound is still there and still authoritative for the Limit
    // column on screen, which did not change.
    expect(snap.limit).toBe(27);
    expect(snap.limitKind).toBe('HIGH');
  });

  it('stores a switched-off bound as NULL, not as its number', () => {
    // A disabled bound could not have raised this alarm. Printing it would state
    // a limit that was not in force — the same rule that makes
    // `telemetry-overview` WITHHOLD such a bound rather than merely not enforce
    // it. The worker passes null; this asserts nothing fills it back in.
    const snap = limitSnapshot({ ...base, thresholdHigh: 27, thresholdLow: null });
    expect(snap.thresholdLow).toBeNull();
  });

  it('is null on both when the caller freezes neither', () => {
    // Rows raised before this existed. The report then shows the breached bound
    // in its own column and N/A in the other, rather than inventing a pair.
    const snap = limitSnapshot(base);
    expect(snap.thresholdHigh).toBeNull();
    expect(snap.thresholdLow).toBeNull();
  });
});
