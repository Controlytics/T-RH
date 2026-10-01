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
  it('adds without binary-float noise', () => {
    expect(applyOffset(23.4, 2)).toBe(25.4);
    expect(applyOffset(45.1, -1.2)).toBe(43.9);
  });
  it('corrects only the slot keys, keeps the raw value, and stores a NUMBER (a quoted reading counts)', () => {
    const out = offsetReadings([
      { key: 't', value: 23.4, valueType: 'number' },
      { key: 'H', value: '45.0', valueType: 'string' },
      { key: 'battery', value: 3.3, valueType: 'number' },
    ], aliases, { temperature: 2, humidity: -1.5 });
    expect(out[0]).toMatchObject({ value: 25.4, valueType: 'number', rawValue: 23.4 });
    expect(out[1]).toMatchObject({ value: 43.5, valueType: 'number', rawValue: '45.0' });
    expect(out[2]).toEqual({ key: 'battery', value: 3.3, valueType: 'number' });
  });
  it('leaves a sensor-failure word exactly as sent, and changes nothing with no or a zero offset', () => {
    const out = offsetReadings([{ key: 't', value: 'NA', valueType: 'string' }, { key: 'h', value: 50, valueType: 'number' }], aliases, { temperature: 2, humidity: 0 });
    expect(out[0]).toEqual({ key: 't', value: 'NA', valueType: 'string' });
    expect(out[1]).toEqual({ key: 'h', value: 50, valueType: 'number' });
  });
});

describe('config', () => {
  it('defaults to ON with the operator\'s names, folded', () => {
    const c = coerceSensorOffsetConfig(undefined);
    expect(c.enabled).toBe(true);
    expect(c.keys).toEqual({ temperature: ['temp off set'], humidity: ['humid off set'] });
    expect(isOffsetAttributeKey(c, ' Temp Off set ')).toBe(true);
    expect(isOffsetAttributeKey(c, 'HUMID OFF SET')).toBe(true);
    expect(isOffsetAttributeKey(c, 'temp_decimals')).toBe(false);
  });
  it('reads the switch and administered key lists, never empty', () => {
    const c = coerceSensorOffsetConfig({ enabled: false, temperatureKeys: 'T_Offset\nTemp Off set', humidityKeys: '' });
    expect(c.enabled).toBe(false);
    expect(c.keys.temperature).toEqual(['t_offset', 'temp off set']);
    expect(c.keys.humidity).toEqual(['humid off set']);
  });
});
