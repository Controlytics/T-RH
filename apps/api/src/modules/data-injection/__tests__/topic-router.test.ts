import { describe, it, expect } from 'vitest';
import { tailOf, routeTail, type TopicRoute } from '../topic-router.js';

const BASE = 'controlyt/india/area-02/gw-001';

describe('tailOf', () => {
  it('strips the subscribed gateway base, leaving instrument + category', () => {
    expect(tailOf(`${BASE}/temp001/telemetry`, BASE, '/')).toBe('temp001/telemetry');
  });

  it('strips the base, leaving a bare category (payload-addressed)', () => {
    expect(tailOf(`${BASE}/telemetry`, BASE, '/')).toBe('telemetry');
  });

  it('is independent of hierarchy depth — the base absorbs it', () => {
    expect(tailOf('a/gw-001/temp001/alarm', 'a/gw-001', '/')).toBe('temp001/alarm');
    expect(tailOf('a/b/c/d/e/f/gw-001/temp001/alarm', 'a/b/c/d/e/f/gw-001', '/'))
      .toBe('temp001/alarm');
  });

  it('returns null when the topic is not under the base', () => {
    expect(tailOf('other/india/gw-002/telemetry', BASE, '/')).toBeNull();
  });

  it('respects segment boundaries — gw-1 must not match gw-10', () => {
    expect(tailOf('a/gw-10/telemetry', 'a/gw-1', '/')).toBeNull();
  });

  it('returns null when the topic IS the base, with no tail', () => {
    expect(tailOf(BASE, BASE, '/')).toBeNull();
  });

  it('honours a dot separator', () => {
    expect(tailOf('controlyt.india.gw-001.temp001.status', 'controlyt.india.gw-001', '.'))
      .toBe('temp001.status');
  });
});

describe('routeTail', () => {
  it('reads instrument + category (topic-addressed)', () => {
    expect(routeTail('temp001/telemetry', '/'))
      .toEqual({ instrumentSlug: 'temp001', category: 'TELEMETRY' });
  });

  it('reads a bare category (payload-addressed)', () => {
    expect(routeTail('telemetry', '/'))
      .toEqual({ instrumentSlug: null, category: 'TELEMETRY' });
  });

  it('is case-insensitive on the category segment', () => {
    expect(routeTail('temp001/Telemetry', '/')?.category).toBe('TELEMETRY');
  });

  it('returns null when the last segment is not a known category', () => {
    expect(routeTail('temp001/bogus', '/')).toBeNull();
  });

  it('returns null for a tail deeper than instrument + category', () => {
    // Ambiguous — surface it rather than silently picking an interpretation.
    expect(routeTail('a/temp001/telemetry', '/')).toBeNull();
  });

  it('returns null for an empty tail', () => {
    expect(routeTail('', '/')).toBeNull();
  });

  it('honours a dot separator', () => {
    expect(routeTail('temp001.status', '.'))
      .toEqual({ instrumentSlug: 'temp001', category: 'STATUS' });
  });
});

describe('composition into TopicRoute (the seam Task 4 consumes)', () => {
  // The gateway comes from the subscription, never from parsing. This is the
  // exact join the ingestion service performs.
  const route = (topic: string, gatewaySlug: string, base: string): TopicRoute | null => {
    const tail = tailOf(topic, base, '/');
    if (tail === null) return null;
    const routed = routeTail(tail, '/');
    return routed && { gatewaySlug, ...routed };
  };

  it('builds a topic-addressed route', () => {
    expect(route(`${BASE}/temp001/telemetry`, 'gw-001', BASE))
      .toEqual({ gatewaySlug: 'gw-001', instrumentSlug: 'temp001', category: 'TELEMETRY' });
  });

  it('builds a payload-addressed route', () => {
    expect(route(`${BASE}/telemetry`, 'gw-001', BASE))
      .toEqual({ gatewaySlug: 'gw-001', instrumentSlug: null, category: 'TELEMETRY' });
  });

  it('yields the same route regardless of hierarchy depth', () => {
    const shallow = route('a/gw-001/temp001/telemetry', 'gw-001', 'a/gw-001');
    const deep = route('a/b/c/d/e/f/gw-001/temp001/telemetry', 'gw-001', 'a/b/c/d/e/f/gw-001');
    expect(shallow).toEqual(deep);
    expect(deep)
      .toEqual({ gatewaySlug: 'gw-001', instrumentSlug: 'temp001', category: 'TELEMETRY' });
  });

  it('rejects a message published outside the subscribed base', () => {
    expect(route('elsewhere/gw-002/temp001/telemetry', 'gw-001', BASE)).toBeNull();
  });
});
