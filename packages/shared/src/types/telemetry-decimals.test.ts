import { describe, it, expect } from 'vitest';
import {
  parseDecimalsValue,
  resolveDecimals,
  clampDecimals,
  formatDecimals,
  TELEMETRY_DECIMALS_MAX,
  TELEMETRY_DECIMALS_KEYS_DEFAULT,
} from './telemetry-decimals.js';
import { parseTelemetryAliases } from './telemetry-slots.js';

const KEYS = parseTelemetryAliases(TELEMETRY_DECIMALS_KEYS_DEFAULT.temperature);

describe('parseDecimalsValue', () => {
  it('reads "0" as zero, not as absent — the whole point of the feature', () => {
    expect(parseDecimalsValue('0')).toBe(0);
  });

  it('reads a plain integer', () => {
    expect(parseDecimalsValue('1')).toBe(1);
    expect(parseDecimalsValue('2')).toBe(2);
    expect(parseDecimalsValue(' 3 ')).toBe(3);
  });

  it('returns null for blank, so a cleared attribute falls back instead of forcing integers', () => {
    expect(parseDecimalsValue('')).toBeNull();
    expect(parseDecimalsValue('   ')).toBeNull();
    expect(parseDecimalsValue(null)).toBeNull();
    expect(parseDecimalsValue(undefined)).toBeNull();
  });

  it('refuses anything that is not a whole count rather than rounding it', () => {
    expect(parseDecimalsValue('2.5')).toBeNull();
    expect(parseDecimalsValue('two')).toBeNull();
    expect(parseDecimalsValue('1 dp')).toBeNull();
    expect(parseDecimalsValue('-1')).toBeNull();
    expect(parseDecimalsValue('+2')).toBeNull();
  });

  it('clamps an absurd count instead of falling back — "999" means "as many as you can"', () => {
    expect(parseDecimalsValue('999')).toBe(TELEMETRY_DECIMALS_MAX);
  });
});

describe('resolveDecimals', () => {
  it('uses the instrument attribute when it has one', () => {
    expect(resolveDecimals(KEYS, [{ key: 'temp_decimals', value: '2' }], 1)).toBe(2);
  });

  it('honours a declared 0 over the fallback', () => {
    expect(resolveDecimals(KEYS, [{ key: 'temp_decimals', value: '0' }], 1)).toBe(0);
  });

  it('matches the key case-insensitively and ignores surrounding space', () => {
    expect(resolveDecimals(KEYS, [{ key: ' Temp_Decimals ', value: '3' }], 1)).toBe(3);
  });

  it('falls back when the instrument declares nothing', () => {
    expect(resolveDecimals(KEYS, [{ key: 'assetTag', value: 'AT-1' }], 1)).toBe(1);
    expect(resolveDecimals(KEYS, [], 2)).toBe(2);
  });

  it('falls back on a matched-but-unparseable value instead of trying the next key', () => {
    const keys = parseTelemetryAliases('temp_decimals\ntemp decimals');
    const attrs = [
      { key: 'temp_decimals', value: 'two' },
      { key: 'temp decimals', value: '3' },
    ];
    expect(resolveDecimals(keys, attrs, 1)).toBe(1);
  });

  it('takes the first KEY that matches, not the first attribute', () => {
    const keys = parseTelemetryAliases('temp_decimals\ntemp decimals');
    const attrs = [
      { key: 'temp decimals', value: '3' },
      { key: 'temp_decimals', value: '0' },
    ];
    expect(resolveDecimals(keys, attrs, 1)).toBe(0);
  });

  it('sanitises a poisoned fallback so it can never reach toFixed', () => {
    expect(resolveDecimals(KEYS, [], Number.NaN)).toBe(1);
    expect(resolveDecimals(KEYS, [], -5)).toBe(0);
    expect(resolveDecimals(KEYS, [], 500)).toBe(TELEMETRY_DECIMALS_MAX);
  });
});

describe('clampDecimals', () => {
  it('keeps a legal count', () => {
    expect(clampDecimals(0)).toBe(0);
    expect(clampDecimals(4)).toBe(4);
  });

  it('bounds every value toFixed would throw on', () => {
    expect(clampDecimals(-1)).toBe(0);
    expect(clampDecimals(101)).toBe(TELEMETRY_DECIMALS_MAX);
    expect(clampDecimals(Number.NaN)).toBe(1);
    expect(clampDecimals('nonsense')).toBe(1);
    expect(clampDecimals(undefined)).toBe(1);
    expect(clampDecimals(2.7)).toBe(2);
  });

  it('never lets toFixed throw for any input this codebase can produce', () => {
    for (const bad of [-1, 101, 1e9, Number.NaN, Number.POSITIVE_INFINITY, '3', null, {}]) {
      expect(() => (25).toFixed(clampDecimals(bad))).not.toThrow();
    }
  });
});

describe('formatDecimals', () => {
  it('formats to the given precision', () => {
    expect(formatDecimals(22.456, 0)).toBe('22');
    expect(formatDecimals(22.456, 1)).toBe('22.5');
    expect(formatDecimals(22.456, 2)).toBe('22.46');
    expect(formatDecimals(22, 2)).toBe('22.00');
  });

  it('returns null for a value that is not a reading, so callers can show their own placeholder', () => {
    expect(formatDecimals(null, 1)).toBeNull();
    expect(formatDecimals(undefined, 1)).toBeNull();
    expect(formatDecimals('warm', 1)).toBeNull();
    expect(formatDecimals(Number.NaN, 1)).toBeNull();
  });

  it('formats 0, which is a real reading', () => {
    expect(formatDecimals(0, 1)).toBe('0.0');
  });
});
