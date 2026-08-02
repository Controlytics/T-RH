import { describe, it, expect } from 'vitest';
import { parsePayload, classifyValue, toReadings } from '../payload-parser.js';

const buf = (o: unknown) => Buffer.from(JSON.stringify(o));

describe('classifyValue', () => {
  it('distinguishes int from float', () => {
    expect(classifyValue(21)).toBe('int');
    expect(classifyValue(21.5)).toBe('float');
  });
  it('classifies the remaining types', () => {
    expect(classifyValue(true)).toBe('boolean');
    expect(classifyValue('ok')).toBe('string');
    expect(classifyValue({ a: 1 })).toBe('json');
    expect(classifyValue([1, 2])).toBe('json');
  });
});

describe('parsePayload', () => {
  it('parses a flat reading object', () => {
    const p = parsePayload(buf({ temp: 21.5, rh: 45 }));
    expect(p.ok).toBe(true);
    expect(p.devices).toBeNull();
    expect(p.values).toEqual({ temp: 21.5, rh: 45 });
  });

  it('detects a batch payload keyed by deviceKey', () => {
    const p = parsePayload(buf({ devices: { temp001: { temp: 21.5 }, hum002: { rh: 45 } } }));
    expect(p.ok).toBe(true);
    expect(Object.keys(p.devices!)).toEqual(['temp001', 'hum002']);
  });

  it('reports invalid JSON instead of throwing', () => {
    const p = parsePayload(Buffer.from('{not json'));
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/json/i);
  });

  it('rejects a non-object payload', () => {
    expect(parsePayload(buf(42)).ok).toBe(false);
    expect(parsePayload(buf('hello')).ok).toBe(false);
  });

  it('honours an explicit timestamp when present', () => {
    const p = parsePayload(buf({ ts: '2026-08-01T10:00:00.000Z', temp: 21.5 }));
    expect(p.ts?.toISOString()).toBe('2026-08-01T10:00:00.000Z');
    expect(p.values).toEqual({ temp: 21.5 });   // ts must not become a reading
  });

  it('ignores an unparseable timestamp rather than failing the message', () => {
    const p = parsePayload(buf({ ts: 'not-a-date', temp: 21.5 }));
    expect(p.ok).toBe(true);
    expect(p.ts).toBeNull();
  });
});

describe('toReadings', () => {
  it('produces one typed reading per key', () => {
    const now = new Date('2026-08-01T10:00:00.000Z');
    expect(toReadings({ temp: 21.5, on: true }, now)).toEqual([
      { key: 'temp', value: 21.5, valueType: 'float', ts: now },
      { key: 'on', value: true, valueType: 'boolean', ts: now },
    ]);
  });

  it('skips null and undefined values', () => {
    const now = new Date();
    expect(toReadings({ a: null, b: undefined, c: 1 }, now).map(r => r.key)).toEqual(['c']);
  });
});
