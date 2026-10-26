import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROFILE_MEASUREMENTS,
  profileMeasurementsSchema,
  slotConfigFromMeasurements,
  coerceProfileMeasurements,
  measurementsEquivalent,
  type ProfileMeasurement,
} from './profile-measurements.js';

const clone = (ms: ProfileMeasurement[]): ProfileMeasurement[] => structuredClone(ms);
const issues = (value: unknown) => {
  const r = profileMeasurementsSchema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('DEFAULT_PROFILE_MEASUREMENTS', () => {
  it('is valid, and is temperature then humidity', () => {
    expect(issues(DEFAULT_PROFILE_MEASUREMENTS)).toEqual([]);
    expect(DEFAULT_PROFILE_MEASUREMENTS.map((m) => m.code)).toEqual(['TEMPERATURE', 'HUMIDITY']);
  });

  it('reads humidity from `h` — the key this plant\'s devices send', () => {
    expect(DEFAULT_PROFILE_MEASUREMENTS[1].deviceKeys).toContain('h');
  });

  it('keeps today\'s MKT behaviour: temperature asks the instrument attribute, humidity never', () => {
    expect(DEFAULT_PROFILE_MEASUREMENTS[0].mkt).toEqual({ enabled: true, attributeKeys: ['isMktCalculationEnabled'] });
    expect(DEFAULT_PROFILE_MEASUREMENTS[1].mkt).toEqual({ enabled: false, attributeKeys: [] });
  });
});

describe('profileMeasurementsSchema', () => {
  it('refuses the same measurement twice', () => {
    const ms = clone(DEFAULT_PROFILE_MEASUREMENTS);
    ms[1].code = 'TEMPERATURE';
    expect(issues(ms).join(' ')).toMatch(/more than once/i);
  });

  it('refuses OFFLINE, which is not a measurement', () => {
    const ms = clone(DEFAULT_PROFILE_MEASUREMENTS);
    ms[1].code = 'OFFLINE';
    expect(issues(ms).join(' ')).toMatch(/OFFLINE/);
  });

  it('refuses one device key for two measurements, ignoring case', () => {
    const ms = clone(DEFAULT_PROFILE_MEASUREMENTS);
    ms[0].deviceKeys = ['T'];
    ms[1].deviceKeys = ['t'];
    expect(issues(ms).join(' ')).toMatch(/device key/i);
  });

  it('refuses one attribute playing two roles', () => {
    const ms = clone(DEFAULT_PROFILE_MEASUREMENTS);
    ms[0].high.limitKeys = ['t_hl'];
    ms[1].offsetKeys = ['T_HL'];
    expect(issues(ms).join(' ')).toMatch(/t_hl/i);
  });
});

describe('slotConfigFromMeasurements', () => {
  it('a profile without humidity measures no humidity, and enforces no humidity bound', () => {
    const cfg = slotConfigFromMeasurements([DEFAULT_PROFILE_MEASUREMENTS[0]]);
    expect(cfg.measured.humidity).toBe(false);
    expect(cfg.aliases.humidity).toEqual([]);
    expect(cfg.boundSwitch.humidityHigh).toBe(false);
    expect(cfg.boundSwitch.humidityLow).toBe(false);
    expect(cfg.measured.temperature).toBe(true);
  });

  it('lower-cases the lists, in order', () => {
    const cfg = slotConfigFromMeasurements(DEFAULT_PROFILE_MEASUREMENTS);
    expect(cfg.aliases.temperature).toEqual(['temperature', 'temp', 't']);
  });

  it('values a measurement\'s limit and range keys at its precision, never its offset key', () => {
    const cfg = slotConfigFromMeasurements(DEFAULT_PROFILE_MEASUREMENTS);
    expect(cfg.decimals.valuedKeys.temperature).toContain('high temperature limit');
    expect(cfg.decimals.valuedKeys.temperature).toContain('high temperature range');
    expect(cfg.decimals.valuedKeys.temperature).not.toContain('temp off set');
  });

  it('carries the profile switch for each bound', () => {
    const ms = clone(DEFAULT_PROFILE_MEASUREMENTS);
    ms[0].high.enabled = false;
    const cfg = slotConfigFromMeasurements(ms);
    expect(cfg.boundSwitch.temperatureHigh).toBe(false);
    expect(cfg.boundSwitch.temperatureLow).toBe(true);
  });
});

describe('coerceProfileMeasurements', () => {
  it('reads NULL (never customised) as the defaults', () => {
    expect(coerceProfileMeasurements(null)).toEqual(DEFAULT_PROFILE_MEASUREMENTS);
  });

  it('keeps an empty list — a profile that measures nothing', () => {
    expect(coerceProfileMeasurements([])).toEqual([]);
  });

  it('reads junk as the defaults rather than as nothing measured', () => {
    expect(coerceProfileMeasurements('junk')).toEqual(DEFAULT_PROFILE_MEASUREMENTS);
  });
});

describe('measurementsEquivalent', () => {
  it('a copy is equivalent', () => {
    expect(measurementsEquivalent(DEFAULT_PROFILE_MEASUREMENTS, clone(DEFAULT_PROFILE_MEASUREMENTS))).toBe(true);
  });

  it('a switched-off bound is not', () => {
    const ms = clone(DEFAULT_PROFILE_MEASUREMENTS);
    ms[0].high.enabled = false;
    expect(measurementsEquivalent(DEFAULT_PROFILE_MEASUREMENTS, ms)).toBe(false);
  });

  it('a key differing only in case is', () => {
    const ms = clone(DEFAULT_PROFILE_MEASUREMENTS);
    ms[0].deviceKeys = ms[0].deviceKeys.map((k) => k.toUpperCase());
    expect(measurementsEquivalent(DEFAULT_PROFILE_MEASUREMENTS, ms)).toBe(true);
  });
});
