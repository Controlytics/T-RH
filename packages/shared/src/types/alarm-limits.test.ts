import { describe, it, expect } from 'vitest';
import {
  parseLimitKeys,
  parseLimitValue,
  resolveLimit,
  ALARM_LIMIT_KEYS_DEFAULT,
  ALARM_STATUS_TEXT_DEFAULT,
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

  it('rejects text and values carrying units', () => {
    expect(parseLimitValue('twenty five')).toBeNull();
    expect(parseLimitValue('25 C')).toBeNull();
    expect(parseLimitValue('n/a')).toBeNull();
    expect(parseLimitValue('NaN')).toBeNull();
    expect(parseLimitValue('Infinity')).toBeNull();
  });
});

describe('resolveLimit', () => {
  const keys = ['high temperature limit', 'high temperature'];

  it('matches case-insensitively on operator-typed keys', () => {
    expect(resolveLimit(keys, [{ key: 'HIGH TEMPERATURE', value: '25' }]))
      .toEqual({ key: 'HIGH TEMPERATURE', value: 25 });
  });

  it('prefers the earlier key when an instrument holds both', () => {
    // This is the live drift case: the database has both spellings today.
    const attrs = [
      { key: 'High Temperature', value: '30' },
      { key: 'High Temperature Limit', value: '25' },
    ];
    expect(resolveLimit(keys, attrs)).toEqual({ key: 'High Temperature Limit', value: 25 });
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
