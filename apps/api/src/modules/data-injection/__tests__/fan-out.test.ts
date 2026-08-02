import { describe, it, expect } from 'vitest';
import { fanOut, type InstrumentResolver } from '../fan-out.js';
import { parsePayload } from '../payload-parser.js';

const buf = (o: unknown) => Buffer.from(JSON.stringify(o));
const AT = new Date('2026-08-01T10:00:00.000Z');

const BASE = 'acme/area-02/gw-001';
const GWID = 'gateway-uuid-1';

// bySlug is keyed on baseTopic, byDeviceKey on gatewayId — see TopicRoute.
const resolver: InstrumentResolver = {
  bySlug: (base, i) => (base === BASE && i === 'temp001' ? 'inst-1' : null),
  byDeviceKey: (gid, k) =>
    gid === GWID ? ({ temp001: 'inst-1', hum002: 'inst-2' } as Record<string, string>)[k] ?? null : null,
};

const route = (instrumentSlug: string | null, category = 'TELEMETRY' as const) => ({
  gatewayId: GWID, gatewaySlug: 'gw-001', baseTopic: BASE, instrumentSlug, category,
});

describe('fanOut', () => {
  it('topic-addressed: one batch for the resolved instrument', () => {
    const r = fanOut(
      route('temp001'),
      parsePayload(buf({ temp: 21.5 })), resolver, AT);
    expect(r.deadLetters).toEqual([]);
    expect(r.batches).toHaveLength(1);
    expect(r.batches[0].instrumentId).toBe('inst-1');
    expect(r.batches[0].readings[0]).toMatchObject({ key: 'temp', value: 21.5, valueType: 'float' });
  });

  it('topic-addressed: unknown instrument dead-letters, no batch', () => {
    const r = fanOut(
      route('nope'),
      parsePayload(buf({ temp: 1 })), resolver, AT);
    expect(r.batches).toEqual([]);
    expect(r.deadLetters[0].reason).toBe('UNKNOWN_INSTRUMENT');
  });

  it('payload-addressed: splits a batch into one entry per device', () => {
    const r = fanOut(
      route(null),
      parsePayload(buf({ devices: { temp001: { temp: 21.5 }, hum002: { rh: 45 } } })), resolver, AT);
    expect(r.deadLetters).toEqual([]);
    expect(r.batches.map(b => b.instrumentId).sort()).toEqual(['inst-1', 'inst-2']);
  });

  it('payload-addressed: ONE unknown deviceKey does not discard the good ones', () => {
    const r = fanOut(
      route(null),
      parsePayload(buf({ devices: { temp001: { temp: 21.5 }, ghost: { x: 1 } } })), resolver, AT);
    expect(r.batches).toHaveLength(1);
    expect(r.batches[0].instrumentId).toBe('inst-1');
    expect(r.deadLetters).toHaveLength(1);
    expect(r.deadLetters[0].reason).toBe('UNKNOWN_DEVICE_KEY');
    expect(r.deadLetters[0].detail).toContain('ghost');
  });

  it('uses the device-supplied timestamp when present', () => {
    const r = fanOut(
      route('temp001'),
      parsePayload(buf({ ts: '2026-07-01T00:00:00.000Z', temp: 1 })), resolver, AT);
    expect(r.batches[0].readings[0].ts.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('falls back to receivedAt when the device sent no timestamp', () => {
    const r = fanOut(
      route('temp001'),
      parsePayload(buf({ temp: 1 })), resolver, AT);
    expect(r.batches[0].readings[0].ts).toEqual(AT);
  });

  it('dead-letters an unparseable payload', () => {
    const r = fanOut(
      route('temp001'),
      parsePayload(Buffer.from('{bad')), resolver, AT);
    expect(r.batches).toEqual([]);
    expect(r.deadLetters[0].reason).toBe('UNPARSEABLE_PAYLOAD');
  });

  it('produces no batch when a resolved device carries no usable readings', () => {
    const r = fanOut(
      route('temp001'),
      parsePayload(buf({ a: null })), resolver, AT);
    expect(r.batches).toEqual([]);
    expect(r.deadLetters[0].reason).toBe('NO_READINGS');
  });
});

describe('fanOut category guard', () => {
  // P2 stores telemetry only. Anything else must surface as a dead letter
  // rather than being written to the telemetry tables, where an alarm would
  // become indistinguishable from a reading.
  it.each(['ALARM', 'STATUS', 'HEARTBEAT', 'EVENT', 'COMMAND', 'RPC'] as const)(
    'dead-letters category %s instead of storing it as telemetry',
    (category) => {
      const r = fanOut(
        route('temp001', category),
        parsePayload(buf({ temp: 21.5 })), resolver, AT);
      expect(r.batches).toEqual([]);
      expect(r.deadLetters).toHaveLength(1);
      expect(r.deadLetters[0].reason).toBe('UNSUPPORTED_CATEGORY');
      expect(r.deadLetters[0].detail).toContain(category);
    },
  );

  it('rejects before resolution — an unsupported category never hits the resolver', () => {
    const exploding: InstrumentResolver = {
      bySlug: () => { throw new Error('resolver must not be consulted'); },
      byDeviceKey: () => { throw new Error('resolver must not be consulted'); },
    };
    const r = fanOut(
      route('temp001', 'COMMAND' as const),
      parsePayload(buf({ temp: 1 })), exploding, AT);
    expect(r.deadLetters[0].reason).toBe('UNSUPPORTED_CATEGORY');
  });

  it('still accepts TELEMETRY', () => {
    const r = fanOut(
      route('temp001'),
      parsePayload(buf({ temp: 21.5 })), resolver, AT);
    expect(r.deadLetters).toEqual([]);
    expect(r.batches).toHaveLength(1);
  });
});
