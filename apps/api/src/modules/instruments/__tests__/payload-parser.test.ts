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

  // Audit 2026-10-03, INGEST-13: `JSON.parse` yields an OWN "__proto__" key,
  // and assigning it onto a plain `{}` hits Object.prototype's setter — the
  // reading vanished, stored nowhere and dead-lettered nowhere. The gateway
  // fan-out has guarded this since it was written; the flat path did not.
  it('does not silently drop a flat reading key literally named "__proto__"', () => {
    const p = parsePayload(Buffer.from('{"__proto__": 5, "temp": 21}'));
    expect(p.ok).toBe(true);
    expect(Object.keys(p.values).sort()).toEqual(['__proto__', 'temp']);
    expect(toReadings(p.values, new Date()).map((r) => [r.key, r.value])).toEqual([['__proto__', 5], ['temp', 21]]);
  });

  it('nor inside an envelope', () => {
    const p = parsePayload(Buffer.from('{"values": {"__proto__": 5, "t": 1}}'));
    expect(Object.keys(p.values).sort()).toEqual(['__proto__', 't']);
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

/**
 * The ENVELOPE shape (2026-09-03).
 *
 * A logger on this installation changed format in the field on 2026-09-01 and
 * cannot be changed back: it wraps its readings as `{"values": {...}}`. Before
 * this, that parsed as ONE flat reading keyed `values` holding the whole object,
 * so `t` and `h` never existed as keys and the dashboard's temperature/humidity
 * cells stayed blank while data arrived normally. 64 rows landed that way.
 */
describe('parsePayload — envelope shape', () => {
  const parse = (o: unknown) => parsePayload(Buffer.from(JSON.stringify(o)));

  // The exact payload from the device, byte for byte.
  it('unwraps the real device payload into its readings', () => {
    const r = parse({ values: { h: '48.5', t: '33.2', id: 3, ty: 3 } });
    expect(r.ok).toBe(true);
    expect(r.devices).toBeNull();
    expect(r.values).toEqual({ h: '48.5', t: '33.2', id: 3, ty: 3 });
    // The defect this fixes: `values` must NOT survive as a key of its own.
    expect(Object.keys(r.values)).not.toContain('values');
  });

  it('keeps the quoted numbers as strings for coerceReading to judge', () => {
    const r = parse({ values: { t: '25.7' } });
    expect(r.values.t).toBe('25.7');
  });

  it('still honours an OUTER timestamp alongside the envelope', () => {
    const r = parse({ values: { t: 1 }, ts: '2026-09-03T10:00:00Z' });
    expect(r.ts?.toISOString()).toBe('2026-09-03T10:00:00.000Z');
    expect(r.values).toEqual({ t: 1 });
  });

  /**
   * THE GUARD. Ambiguous payloads are NOT unwrapped, because unwrapping would
   * silently discard the outer reading — the one failure mode a §11 ingest path
   * must not have. Both values survive, and `values` stays a json reading.
   */
  it('does NOT unwrap when the payload also carries its own reading keys', () => {
    const r = parse({ values: { t: 1 }, t: 25 });
    expect(r.values).toEqual({ values: { t: 1 }, t: 25 });
    expect(classifyValue(r.values.values)).toBe('json');
  });

  it.each([
    ['a number', 5],
    ['a string', 'NA'],
    ['an array', [1, 2]],
    ['null', null],
  ])('leaves a `values` key that is %s as an ordinary reading', (_label, v) => {
    const r = parse({ values: v });
    expect(r.values).toEqual({ values: v });
  });

  // Consistent with a bare `{}`, which already parses ok with zero readings.
  it('yields zero readings for an empty envelope, like a bare {}', () => {
    expect(parse({ values: {} }).values).toEqual({});
    expect(parse({}).values).toEqual({});
  });

  /**
   * `ts`/`quality` are defined at the TOP level. Inside the envelope everything is
   * a reading, verbatim — so an inner `ts` is neither silently dropped nor
   * silently honoured as the record's timestamp.
   */
  it('treats the envelope contents as readings verbatim, including an inner ts', () => {
    const r = parse({ values: { t: 1, ts: '2020-01-01T00:00:00Z' } });
    expect(r.values).toEqual({ t: 1, ts: '2020-01-01T00:00:00Z' });
    expect(r.ts).toBeNull();
  });

  // A gateway batch is a different shape and must keep winning.
  it('leaves the batch shape untouched when both keys are present', () => {
    const r = parse({ devices: { c1: { t: 1 } }, values: { t: 9 } });
    expect(r.devices).toEqual({ c1: { t: 1 } });
    expect(r.values).toEqual({});
  });

  it('turns the envelope contents into readings', () => {
    const r = parse({ values: { h: '48.5', t: '33.2' } });
    const readings = toReadings(r.values, new Date('2026-09-03T10:00:00Z'));
    expect(readings.map((x) => x.key).sort()).toEqual(['h', 't']);
    expect(readings.every((x) => x.valueType === 'string')).toBe(true);
  });
});
