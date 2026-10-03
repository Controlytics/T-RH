import { describe, it, expect } from 'vitest';
import {
  parseLimitKeys,
  parseLimitValue,
  limitDisplayText,
  resolveLimit,
  ALARM_LIMIT_KEYS_DEFAULT,
  ALARM_LIMIT_ENABLE_KEYS_DEFAULT,
  ALARM_STATUS_TEXT_DEFAULT,
  parseEnableFlag,
  resolveEnableFlag,
} from './alarm-limits.js';

describe('parseLimitKeys', () => {
  it('splits on newlines, trims, drops blanks, lowercases', () => {
    expect(parseLimitKeys('High Temperature Limit\n  High Temperature \n\n')).toEqual([
      'high temperature limit',
      'high temperature',
    ]);
  });

  it('de-duplicates keeping first, because order is precedence', () => {
    expect(parseLimitKeys('A\nB\nA')).toEqual(['a', 'b']);
  });

  it('returns [] for null, undefined and blank', () => {
    expect(parseLimitKeys(null)).toEqual([]);
    expect(parseLimitKeys(undefined)).toEqual([]);
    expect(parseLimitKeys('   ')).toEqual([]);
  });

  it('ships defaults that parse to the documented lists', () => {
    expect(parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.temperatureHigh)).toEqual([
      'high temperature limit',
      'high temperature',
      'temp high',
    ]);
  });
});

describe('parseLimitValue', () => {
  it('parses plain and decimal numbers, including negatives and zero', () => {
    expect(parseLimitValue('25')).toBe(25);
    expect(parseLimitValue(' 25.0 ')).toBe(25);
    expect(parseLimitValue('-5.5')).toBe(-5.5);
    expect(parseLimitValue('0')).toBe(0);
  });

  it('returns null for blank rather than 0 — Number("") is 0 and would alarm forever', () => {
    expect(parseLimitValue('')).toBeNull();
    expect(parseLimitValue('   ')).toBeNull();
    expect(parseLimitValue(null)).toBeNull();
    expect(parseLimitValue(undefined)).toBeNull();
  });

  it('rejects values with no number in them', () => {
    expect(parseLimitValue('twenty five')).toBeNull();
    expect(parseLimitValue('n/a')).toBeNull();
    expect(parseLimitValue('NA')).toBeNull();
    expect(parseLimitValue('NaN')).toBeNull();
    expect(parseLimitValue('Infinity')).toBeNull();
  });

  // Operator, 2026-10-03: "text is included in limits and ranges" — the number
  // inside the text is the bound. CWH/RDU/101-00's `h_hl` reads
  // `60 (For Reference)` and had lost its humidity bound everywhere.
  it('takes the number out of a value that carries text', () => {
    expect(parseLimitValue('60 (For Reference)')).toBe(60);
    expect(parseLimitValue('NMT 27')).toBe(27);
    expect(parseLimitValue('25 C')).toBe(25);
    expect(parseLimitValue('limit -40')).toBe(-40);
    expect(parseLimitValue('27.5 degC')).toBe(27.5);
  });

  it('takes the FIRST number when there are several — keep the number first', () => {
    expect(parseLimitValue('v2 limit 60')).toBe(2);
  });
});

describe('limitDisplayText', () => {
  it('is null for a bare number — the number prints at the instrument precision', () => {
    expect(limitDisplayText('25')).toBeNull();
    expect(limitDisplayText(' 25.0 ')).toBeNull();
    expect(limitDisplayText('-5.5')).toBeNull();
    expect(limitDisplayText('0')).toBeNull();
  });

  it('is the whole trimmed value when it carries text beside the number', () => {
    expect(limitDisplayText(' 60 (For Reference) ')).toBe('60 (For Reference)');
    expect(limitDisplayText('NMT 27')).toBe('NMT 27');
  });

  it('is null when there is no number at all — nothing to caption', () => {
    expect(limitDisplayText('NA')).toBeNull();
    expect(limitDisplayText('')).toBeNull();
    expect(limitDisplayText(null)).toBeNull();
    expect(limitDisplayText(undefined)).toBeNull();
  });
});

describe('resolveLimit', () => {
  const keys = ['high temperature limit', 'high temperature'];

  it('matches case-insensitively on operator-typed keys', () => {
    expect(resolveLimit(keys, [{ key: 'HIGH TEMPERATURE', value: '25' }]))
      .toEqual({ key: 'HIGH TEMPERATURE', value: 25, text: null });
  });

  it('prefers the earlier key when an instrument holds both', () => {
    // This is the live drift case: the database has both spellings today.
    const attrs = [
      { key: 'High Temperature', value: '30' },
      { key: 'High Temperature Limit', value: '25' },
    ];
    expect(resolveLimit(keys, attrs)).toEqual({ key: 'High Temperature Limit', value: 25, text: null });
  });

  it('carries the text beside the number, so the set point can print it', () => {
    expect(resolveLimit(keys, [{ key: 'High Temperature Limit', value: '27 (For Reference)' }]))
      .toEqual({ key: 'High Temperature Limit', value: 27, text: '27 (For Reference)' });
  });

  it('returns null when no key matches', () => {
    expect(resolveLimit(keys, [{ key: 'Slave ID', value: '3' }])).toBeNull();
  });

  it('returns null when the matched attribute is not numeric', () => {
    expect(resolveLimit(keys, [{ key: 'High Temperature', value: 'warm' }])).toBeNull();
  });

  it('does not fall through to a later key when an earlier one is non-numeric', () => {
    // Deliberate: a mistyped value on the preferred key must be visible as
    // "no limit", not silently replaced by a different attribute's value.
    const attrs = [
      { key: 'High Temperature Limit', value: 'warm' },
      { key: 'High Temperature', value: '25' },
    ];
    expect(resolveLimit(keys, attrs)).toBeNull();
  });
});

describe('ALARM_STATUS_TEXT_DEFAULT', () => {
  it('keeps cleared-unacknowledged distinct from cleared', () => {
    expect(ALARM_STATUS_TEXT_DEFAULT.clearedUnack).not.toBe(ALARM_STATUS_TEXT_DEFAULT.clearedAck);
  });
});

describe('per-bound enable flags', () => {
  it('reads both vocabularies live data actually holds', () => {
    // 99 instruments here write 0/1; one writes "True".
    expect(parseEnableFlag('1')).toBe(true);
    expect(parseEnableFlag('0')).toBe(false);
    expect(parseEnableFlag('True')).toBe(true);
    expect(parseEnableFlag('false')).toBe(false);
    expect(parseEnableFlag(' YES ')).toBe(true);
    expect(parseEnableFlag('Off')).toBe(false);
  });

  it('treats an absent, blank or unreadable flag as ENABLED', () => {
    // The safety decision in this module: a monitoring system fails toward
    // alarming. A typo must never be able to silence a bound.
    expect(parseEnableFlag(undefined)).toBe(true);
    expect(parseEnableFlag(null)).toBe(true);
    expect(parseEnableFlag('')).toBe(true);
    expect(parseEnableFlag('   ')).toBe(true);
    expect(parseEnableFlag('maybe')).toBe(true);
  });

  it('resolves the flag by key precedence, like resolveLimit', () => {
    const attrs = [
      { key: 'Enable_Temp_NMT', value: '0' },
      { key: 'Temp High Enabled', value: '1' },
    ];
    expect(resolveEnableFlag(['enable_temp_nmt', 'temp high enabled'], attrs))
      .toEqual({ key: 'Enable_Temp_NMT', enabled: false });
    // Reversed preference picks the other spelling, deterministically.
    expect(resolveEnableFlag(['temp high enabled', 'enable_temp_nmt'], attrs))
      .toEqual({ key: 'Temp High Enabled', enabled: true });
  });

  it('returns null when the instrument carries no flag at all', () => {
    // The caller turns that into "enabled" — one instrument here has no flag.
    expect(resolveEnableFlag(['enable_temp_nmt'], [{ key: 'Model', value: 'X' }])).toBeNull();
  });

  it('ships the keys the plant already uses, NMT high and NLT low', () => {
    // "Not more than" is the high bound; "not less than" the low one. Getting
    // these the wrong way round would disable the opposite bound silently.
    expect(ALARM_LIMIT_ENABLE_KEYS_DEFAULT.temperatureHigh).toBe('Enable_Temp_NMT');
    expect(ALARM_LIMIT_ENABLE_KEYS_DEFAULT.temperatureLow).toBe('Enable_Temp_NLT');
    expect(ALARM_LIMIT_ENABLE_KEYS_DEFAULT.humidityHigh).toBe('Enable_Humid_NMT');
    expect(ALARM_LIMIT_ENABLE_KEYS_DEFAULT.humidityLow).toBe('Enable_Humid_NLT');
  });
});
