import { describe, it, expect } from 'vitest';
import { decimalsFor, annotateAttribute, DECIMALS_CONFIG_DEFAULT } from '../decimals.js';

/**
 * The API side of per-instrument display precision. The parsing rules themselves
 * are covered in `packages/shared/src/types/telemetry-decimals.test.ts`; what is
 * checked here is that the SHIPPED default key mapping resolves the attribute
 * names the operator actually types on an instrument.
 */
describe('decimalsFor', () => {
  it('reads both slots from the instrument attributes', () => {
    expect(decimalsFor(DECIMALS_CONFIG_DEFAULT, [
      { key: 'temp_decimals', value: '2' },
      { key: 'humid_decimals', value: '0' },
    ])).toEqual({ temperature: 2, humidity: 0 });
  });

  it('honours a declared 0 rather than treating it as unset', () => {
    // The reason this feature exists: an instrument reporting whole degrees must
    // be able to say so, and 0 must not be mistaken for "not configured".
    expect(decimalsFor(DECIMALS_CONFIG_DEFAULT, [{ key: 'temp_decimals', value: '0' }]).temperature)
      .toBe(0);
  });

  it('falls back per slot, so declaring one does not silently set the other', () => {
    const d = decimalsFor(DECIMALS_CONFIG_DEFAULT, [{ key: 'temp_decimals', value: '3' }]);
    expect(d.temperature).toBe(3);
    expect(d.humidity).toBe(DECIMALS_CONFIG_DEFAULT.fallback.humidity);
  });

  it('ignores the instrument attributes that already live in this database', () => {
    // The real Default profile carries these. None of them is a precision.
    expect(decimalsFor(DECIMALS_CONFIG_DEFAULT, [
      { key: 'High Temperature Limit', value: '25' },
      { key: 'Low Temperature', value: '18' },
      { key: 'Slave ID', value: '3' },
      { key: 'assetTag', value: 'AT-99412' },
    ])).toEqual(DECIMALS_CONFIG_DEFAULT.fallback);
  });

  it('falls back on an unparseable value instead of inventing a precision', () => {
    expect(decimalsFor(DECIMALS_CONFIG_DEFAULT, [{ key: 'temp_decimals', value: '1.5' }]).temperature)
      .toBe(DECIMALS_CONFIG_DEFAULT.fallback.temperature);
    expect(decimalsFor(DECIMALS_CONFIG_DEFAULT, [{ key: 'temp_decimals', value: '' }]).temperature)
      .toBe(DECIMALS_CONFIG_DEFAULT.fallback.temperature);
  });

  it('never returns a count that would make toFixed throw', () => {
    const d = decimalsFor(DECIMALS_CONFIG_DEFAULT, [
      { key: 'temp_decimals', value: '9999' },
      { key: 'humid_decimals', value: '0' },
    ]);
    expect(() => (25).toFixed(d.temperature)).not.toThrow();
    expect(() => (25).toFixed(d.humidity)).not.toThrow();
  });
});

describe('annotateAttribute', () => {
  const dp = { temperature: 0, humidity: 2 } as const;

  it('formats a limit at the temperature precision', () => {
    expect(annotateAttribute(DECIMALS_CONFIG_DEFAULT, dp, { key: 'High Temperature Limit', value: '25' }))
      .toEqual({ slot: 'temperature', decimals: 0, display: '25' });
  });

  it('formats a RANGE too — a range is a reading like any other', () => {
    expect(annotateAttribute(DECIMALS_CONFIG_DEFAULT, dp, { key: 'High Humidity Range', value: '100' }))
      .toEqual({ slot: 'humidity', decimals: 2, display: '100.00' });
  });

  it('resolves the alias spelling this database holds', () => {
    expect(annotateAttribute(DECIMALS_CONFIG_DEFAULT, dp, { key: 'High Temperature', value: '23' }).display)
      .toBe('23');
  });

  it('matches the key case-insensitively and ignores surrounding space', () => {
    expect(annotateAttribute(DECIMALS_CONFIG_DEFAULT, dp, { key: ' low humidity limit ', value: '40' }).slot)
      .toBe('humidity');
  });

  it('leaves an attribute that is not a reading alone', () => {
    expect(annotateAttribute(DECIMALS_CONFIG_DEFAULT, dp, { key: 'Slave ID', value: '3' }))
      .toEqual({ slot: null, decimals: null, display: null });
    expect(annotateAttribute(DECIMALS_CONFIG_DEFAULT, dp, { key: 'temp_decimals', value: '0' }).slot)
      .toBeNull();
  });

  it('keeps the raw value when a classified key holds something unparseable', () => {
    // Blanking it would hide a recorded §11 value for failing a number format.
    const out = annotateAttribute(DECIMALS_CONFIG_DEFAULT, dp, { key: 'High Temperature', value: 'about 25' });
    expect(out.slot).toBe('temperature');
    expect(out.display).toBeNull();
  });

  it('never produces a display that could throw', () => {
    expect(() => annotateAttribute(
      DECIMALS_CONFIG_DEFAULT, { temperature: 999, humidity: -3 }, { key: 'High Temperature', value: '25' },
    )).not.toThrow();
  });
});
