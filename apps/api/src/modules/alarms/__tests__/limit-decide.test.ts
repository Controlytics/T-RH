import { describe, it, expect } from 'vitest';
import {
  checkLimits,
  limitsInverted,
  describeLimit,
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

describe('describeLimit', () => {
  it('reads as the condition that fired', () => {
    expect(describeLimit({ metric: 'TEMPERATURE', limitKind: 'HIGH', limit: 25 }))
      .toBe('temperature above 25');
    expect(describeLimit({ metric: 'HUMIDITY', limitKind: 'LOW', limit: 40 }))
      .toBe('humidity below 40');
  });
});
