import { describe, it, expect } from 'vitest';
import {
  coerceSensorOffsetConfig, isOffsetAttributeKey, parseOffsetValue, formatOffsetValue, applyOffset, offsetReadings,
} from '../sensor-offsets.js';

describe('parseOffsetValue — a number with an optional + / - sign', () => {
  it('accepts integers and decimals, signed or not: + adds, - subtracts, none adds', () => {
    expect(parseOffsetValue('2')).toBe(2);
    expect(parseOffsetValue('1.0')).toBe(1);
    expect(parseOffsetValue('+2')).toBe(2);
    expect(parseOffsetValue('-2')).toBe(-2);
    expect(parseOffsetValue(' -0.5 ')).toBe(-0.5);
    expect(parseOffsetValue('.5')).toBe(0.5);
    expect(parseOffsetValue('3.')).toBe(3);
  });
  it('refuses anything that is not a number', () => {
    for (const v of ['', ' ', 'two', '2 C', '1,5', '+-2', '--1', '2e3', 'NaN', null, undefined]) expect(parseOffsetValue(v as string)).toBeNull();
  });
  it('formats with the sign always written', () => {
    expect(formatOffsetValue(2)).toBe('+2');
    expect(formatOffsetValue(-1.5)).toBe('-1.5');
    expect(formatOffsetValue(0)).toBe('+0');
  });
});

describe('applyOffset / offsetReadings', () => {
  const aliases = { temperature: ['temperature', 't'], humidity: ['humidity', 'h'] };
  // The caller's vocabulary (the API's `classifyValue` for a number), handed in
  // rather than restated here — audit 2026-10-03, INGEST-11.
  const classify = (n: number) => (Number.isInteger(n) ? 'int' : 'float');
  it('adds without binary-float noise', () => {
    expect(applyOffset(23.4, 2)).toBe(25.4);
    expect(applyOffset(45.1, -1.2)).toBe(43.9);
  });
  it('corrects only the slot keys, keeps the raw value, and stores a NUMBER (a quoted reading counts)', () => {
    const out = offsetReadings([
      { key: 't', value: 23.4, valueType: 'float' },
      { key: 'H', value: '45.0', valueType: 'string' },
      { key: 'battery', value: 3.3, valueType: 'float' },
    ], aliases, { temperature: 2, humidity: -1.5 }, classify);
    expect(out[0]).toMatchObject({ value: 25.4, valueType: 'float', rawValue: 23.4 });
    expect(out[1]).toMatchObject({ value: 43.5, valueType: 'float', rawValue: '45.0' });
    expect(out[2]).toEqual({ key: 'battery', value: 3.3, valueType: 'float' });
  });
  it('names the corrected value\'s type through the caller\'s classifier, never a literal of its own', () => {
    // `"20"` + 2 = 22, an integer: the type is whatever the caller's vocabulary
    // says for 22, so the stored row reads like every other ingested integer.
    const out = offsetReadings([{ key: 't', value: '20', valueType: 'string' }], aliases, { temperature: 2 }, classify);
    expect(out[0]).toMatchObject({ value: 22, valueType: 'int', rawValue: '20' });
    const spy = offsetReadings([{ key: 't', value: 1, valueType: 'int' }], aliases, { temperature: 0.5 }, () => 'custom');
    expect(spy[0].valueType).toBe('custom');
  });
  it('leaves a sensor-failure word exactly as sent, and changes nothing with no or a zero offset', () => {
    const out = offsetReadings([{ key: 't', value: 'NA', valueType: 'string' }, { key: 'h', value: 50, valueType: 'int' }], aliases, { temperature: 2, humidity: 0 }, classify);
    expect(out[0]).toEqual({ key: 't', value: 'NA', valueType: 'string' });
    expect(out[1]).toEqual({ key: 'h', value: 50, valueType: 'int' });
  });
});

// The offset KEYS are each instrument PROFILE's since 2026-10-26 (they were
// this config row's until then); the row keeps only the master switch.
describe('config', () => {
  it('defaults to ON', () => {
    expect(coerceSensorOffsetConfig(undefined).enabled).toBe(true);
  });
  it('reads the switch, and nothing else', () => {
    expect(coerceSensorOffsetConfig({ enabled: false, temperatureKeys: 'T_Offset' })).toEqual({ enabled: false });
  });
});

describe('isOffsetAttributeKey', () => {
  it('folds case and space against the given (folded) key set', () => {
    const keys = new Set(['temp off set', 'humid off set']);
    expect(isOffsetAttributeKey(keys, ' Temp Off set ')).toBe(true);
    expect(isOffsetAttributeKey(keys, 'HUMID OFF SET')).toBe(true);
    expect(isOffsetAttributeKey(keys, 'temp_decimals')).toBe(false);
  });
});
