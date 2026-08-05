// apps/api/src/modules/instruments/__tests__/gateway-fanout.test.ts
import { describe, it, expect } from 'vitest';
import { fanoutDevices, type ChildMap } from '../gateway-fanout.js';

const TS = new Date('2026-08-05T10:00:00Z');
const map: ChildMap = new Map([
  ['SENSOR-A', { id: 'id-a', isActive: true }],
  ['SENSOR-B', { id: 'id-b', isActive: true }],
  ['SENSOR-OFF', { id: 'id-off', isActive: false }],
]);

describe('fanoutDevices', () => {
  it('attributes each block to its own instrument', () => {
    const r = fanoutDevices(
      { 'SENSOR-A': { temperature: 21.5 }, 'SENSOR-B': { humidity: 47 } },
      map, TS, 'GW-1',
    );
    expect(r.rejected).toEqual([]);
    expect(r.readings).toEqual([
      { instrumentId: 'id-a', key: 'temperature', value: 21.5, valueType: 'float', ts: TS },
      { instrumentId: 'id-b', key: 'humidity', value: 47, valueType: 'int', ts: TS },
    ]);
  });

  it('rejects a code this gateway does not own, and keeps the rest', () => {
    // Partial success (spec D5): one mistyped code must not discard a
    // 40-sensor payload.
    const r = fanoutDevices(
      { 'SENSOR-A': { temperature: 21.5 }, 'NOT-MINE': { temperature: 9 } },
      map, TS, 'GW-1',
    );
    expect(r.readings).toHaveLength(1);
    expect(r.readings[0].instrumentId).toBe('id-a');
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].code).toBe('NOT-MINE');
    // The reason must name the gateway — otherwise a dead-letter in a fleet of
    // 30 gateways cannot be traced back to the one that sent it.
    expect(r.rejected[0].reason).toMatch(/GW-1/);
  });

  it('rejects an inactive child', () => {
    const r = fanoutDevices({ 'SENSOR-OFF': { temperature: 1 } }, map, TS, 'GW-1');
    expect(r.readings).toEqual([]);
    expect(r.rejected[0].reason).toMatch(/not active/i);
  });

  it('rejects a block that is not an object', () => {
    const r = fanoutDevices({ 'SENSOR-A': 42 }, map, TS, 'GW-1');
    expect(r.readings).toEqual([]);
    expect(r.rejected[0].reason).toMatch(/object/i);
  });

  it('honours a per-block timestamp over the envelope one', () => {
    const own = '2026-08-05T09:00:00Z';
    const r = fanoutDevices({ 'SENSOR-A': { ts: own, temperature: 5 } }, map, TS, 'GW-1');
    expect(r.readings).toHaveLength(1);
    expect(r.readings[0].ts.toISOString()).toBe(new Date(own).toISOString());
  });

  it('returns nothing for an empty devices map', () => {
    expect(fanoutDevices({}, map, TS, 'GW-1')).toEqual({ readings: [], rejected: [] });
  });

  it('does not silently drop a reading key literally named "__proto__"', () => {
    // JSON.parse produces an own "__proto__" property (unlike an object literal,
    // which would set the prototype instead) — this is exactly the shape a
    // device payload arrives in after `JSON.parse(buf)`.
    const block = JSON.parse('{"__proto__": 5, "temperature": 21}');
    const r = fanoutDevices({ 'SENSOR-A': block }, map, TS, 'GW-1');
    expect(r.rejected).toEqual([]);
    expect(r.readings).toEqual(
      expect.arrayContaining([
        { instrumentId: 'id-a', key: '__proto__', value: 5, valueType: 'int', ts: TS },
        { instrumentId: 'id-a', key: 'temperature', value: 21, valueType: 'int', ts: TS },
      ]),
    );
    expect(r.readings).toHaveLength(2);
  });
});
