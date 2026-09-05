import { describe, it, expect } from 'vitest';
import { parseDeviceTs, parsePayload } from '../payload-parser.js';
import { fanoutDevices, type ChildMap } from '../gateway-fanout.js';

/**
 * The device's OWN timestamp on the wire (2026-09-05). The plant gateway sends
 * an epoch in MILLISECONDS AS A STRING — `"ts":"1788599495138"` — which
 * `new Date(string)` cannot read, so every reading had been stamped with its
 * arrival time, ~43 s late. A wrong measurement time on a §11 record, with
 * nothing on screen to say so.
 */
describe('parseDeviceTs', () => {
  it('reads a 13-digit string as epoch milliseconds', () => {
    expect(parseDeviceTs('1788599495138')!.toISOString()).toBe('2026-09-05T09:11:35.138Z');
  });
  it('reads a 10-digit string as epoch seconds', () => {
    expect(parseDeviceTs('1788599495')!.toISOString()).toBe('2026-09-05T09:11:35.000Z');
  });
  it('still reads an epoch NUMBER and an ISO string', () => {
    expect(parseDeviceTs(1788599495138)!.toISOString()).toBe('2026-09-05T09:11:35.138Z');
    expect(parseDeviceTs('2026-09-05T09:11:35.138Z')!.toISOString()).toBe('2026-09-05T09:11:35.138Z');
  });
  it('is null for nothing, garbage, or a shape that is neither', () => {
    expect(parseDeviceTs(undefined)).toBeNull();
    expect(parseDeviceTs('yesterday')).toBeNull();
    expect(parseDeviceTs({ ts: 1 })).toBeNull();
    expect(parseDeviceTs('12345')).toBeNull();   // five digits is not an epoch, and not a date
  });
});

describe('the device timestamp on the wire', () => {
  it('a flat envelope with a string epoch carries the DEVICE time, not the arrival time', () => {
    const p = parsePayload(Buffer.from(JSON.stringify({ ts: '1788599495138', values: { devN: 'X', t: '27.1' } })));
    expect(p.ok).toBe(true);
    expect(p.ts!.toISOString()).toBe('2026-09-05T09:11:35.138Z');
  });

  it('a per-block string epoch wins over the envelope time in a batch', () => {
    const map: ChildMap = new Map([['A', { id: 'i-a', isActive: true }]]);
    const r = fanoutDevices({ A: { ts: '1788599495138', t: 1 } }, map, new Date('2026-09-05T10:00:00Z'), 'GW');
    expect(r.readings[0].ts.toISOString()).toBe('2026-09-05T09:11:35.138Z');
  });
});
