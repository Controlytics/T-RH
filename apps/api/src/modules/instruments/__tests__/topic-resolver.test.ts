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
  it('produces all 13 categories', () => {
    expect(TOPIC_CATEGORIES).toHaveLength(13);
    expect(Object.keys(resolveTopics(base))).toHaveLength(13);
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
});
