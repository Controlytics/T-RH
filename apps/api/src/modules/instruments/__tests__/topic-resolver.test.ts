import { describe, it, expect } from 'vitest';
import { resolveTopics, TOPIC_CATEGORIES } from '../topic-resolver.js';

const settings = { prefix: 'controlyt', separator: '/', includeGateway: true };
const base = {
  settings,
  ancestry: ['india', 'hyderabad', 'plant01', 'blocka', 'area02', 'packing'],
  gatewaySlug: 'gw001',
  instrumentSlug: 'temp001',
  overrides: {},
};

describe('resolveTopics', () => {
  it('produces exactly the 13 documented categories', () => {
    expect(TOPIC_CATEGORIES).toEqual([
      'TELEMETRY', 'ATTRIBUTES', 'ALARM', 'COMMAND', 'RPC', 'HEARTBEAT', 'EVENT',
      'STATUS', 'CONFIG', 'RESPONSE', 'SETTINGS', 'PUBLISH', 'SUBSCRIBE',
    ]);
    expect(Object.keys(resolveTopics(base)).sort()).toEqual([...TOPIC_CATEGORIES].sort());
  });

  it('builds the documented UNS topic', () => {
    expect(resolveTopics(base).TELEMETRY).toBe(
      'controlyt/india/hyderabad/plant01/blocka/area02/packing/gw001/temp001/telemetry',
    );
  });

  it('omits the gateway segment for an independent instrument', () => {
    expect(resolveTopics({ ...base, gatewaySlug: null }).ALARM).toBe(
      'controlyt/india/hyderabad/plant01/blocka/area02/packing/temp001/alarm',
    );
  });

  it('omits the gateway segment when includeGateway is false', () => {
    const s = { ...settings, includeGateway: false };
    expect(resolveTopics({ ...base, settings: s }).COMMAND).toContain('/packing/temp001/command');
    expect(resolveTopics({ ...base, settings: s }).COMMAND).not.toContain('gw001');
  });

  it('honours an explicit override verbatim', () => {
    const out = resolveTopics({ ...base, overrides: { TELEMETRY: 'legacy/raw/feed' } });
    expect(out.TELEMETRY).toBe('legacy/raw/feed');
    expect(out.ALARM).toContain('controlyt/'); // others still derived
  });

  it('handles hierarchy gaps without emitting blank segments', () => {
    const out = resolveTopics({ ...base, ancestry: ['india', 'packing'] });
    expect(out.HEARTBEAT).toBe('controlyt/india/packing/gw001/temp001/heartbeat');
    expect(out.HEARTBEAT).not.toContain('//');
  });

  it('respects a custom separator and empty prefix', () => {
    const out = resolveTopics({
      ...base, settings: { prefix: '', separator: '.', includeGateway: false },
      ancestry: ['india'],
    });
    expect(out.STATUS).toBe('india.temp001.status');
  });

  it('combines an override with a hierarchy gap and no gateway', () => {
    const out = resolveTopics({
      ...base,
      ancestry: ['india', 'packing'],
      gatewaySlug: null,
      overrides: { EVENT: 'legacy/events' },
    });
    expect(out.EVENT).toBe('legacy/events');
    expect(out.STATUS).toBe('controlyt/india/packing/temp001/status');
    expect(out.STATUS).not.toContain('//');
  });

  it('treats a blank/whitespace-only override as absent, falling through to the derived topic', () => {
    const out = resolveTopics({ ...base, overrides: { TELEMETRY: '', ALARM: '   ' } });
    expect(out.TELEMETRY).toBe(
      'controlyt/india/hyderabad/plant01/blocka/area02/packing/gw001/temp001/telemetry',
    );
    expect(out.ALARM).toBe(
      'controlyt/india/hyderabad/plant01/blocka/area02/packing/gw001/temp001/alarm',
    );
  });

  it('throws rather than silently comma-joining when separator is missing', () => {
    const badSettings = { prefix: 'controlyt', includeGateway: true } as any;
    expect(() => resolveTopics({ ...base, settings: badSettings })).toThrow(/separator/);
  });

  it('throws when separator is an empty string', () => {
    const badSettings = { ...settings, separator: '' };
    expect(() => resolveTopics({ ...base, settings: badSettings })).toThrow(/separator/);
  });

  it('throws when prefix or includeGateway is the wrong type', () => {
    expect(() => resolveTopics({ ...base, settings: { ...settings, prefix: null as any } })).toThrow(/prefix/);
    expect(() => resolveTopics({ ...base, settings: { ...settings, includeGateway: 'yes' as any } })).toThrow(/includeGateway/);
  });

  it('still allows an empty-string prefix (documented, cleanly omitted case)', () => {
    expect(() => resolveTopics({ ...base, settings: { ...settings, prefix: '' } })).not.toThrow();
  });
});
