import { describe, it, expect } from 'vitest';
import { classifyDeviceFrame } from '../device-attributes.js';

/**
 * WebSocket frames and TCP lines carry attributes too (2026-10-28, operator:
 * "add for all protocals"). The envelope is strict so a telemetry frame can
 * never be mistaken for one.
 */
describe('classifyDeviceFrame', () => {
  it('a frame whose ONE key is `attributes` with an object value is a report, unwrapped', () => {
    const f = classifyDeviceFrame('{"attributes":{"Location":"Room A"}}');
    expect(f.kind).toBe('attributes');
    if (f.kind !== 'attributes') throw new Error('unreachable');
    expect(JSON.parse(f.raw.toString('utf8'))).toEqual({ Location: 'Room A' });
  });

  it('{"subscribe":"attributes"} subscribes', () => {
    expect(classifyDeviceFrame(Buffer.from('{"subscribe":"attributes"}'))).toEqual({ kind: 'subscribe' });
  });

  it('everything else is telemetry: an `attributes` reading beside others, a non-object value, junk', () => {
    for (const raw of [
      '{"attributes":{"x":1},"temperature":21}',
      '{"attributes":5}',
      '{"attributes":["x"]}',
      '{"subscribe":"telemetry"}',
      '{"temperature":21.5}',
      'not json',
      '[1,2]',
    ]) expect(classifyDeviceFrame(raw), raw).toEqual({ kind: 'telemetry' });
  });
});
