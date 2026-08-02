import { describe, it, expect } from 'vitest';
import { buildResolverMaps, type ResolverRow } from '../telemetry.repository.js';

const row = (
  id: string, slug: string, baseTopic: string | null,
  deviceKey: string | null = null, gatewayId: string | null = 'gw-id-1',
): ResolverRow => ({ id, slug, deviceKey, gatewayId, baseTopic });

describe('buildResolverMaps', () => {
  it('keys slugs on baseTopic and deviceKeys on gatewayId', () => {
    const c = buildResolverMaps([row('inst-1', 'temp001', 'acme/area-02/gw-001', 'DEV-1')]);
    expect(c.bySlug.get('acme/area-02/gw-001|temp001')).toBe('inst-1');
    expect(c.byDeviceKey.get('gw-id-1|DEV-1')).toBe('inst-1');
    expect(c.collisions).toEqual([]);
  });

  it('skips instruments with no derived base topic', () => {
    const c = buildResolverMaps([row('inst-1', 'temp001', null)]);
    expect(c.bySlug.size).toBe(0);
  });

  it('omits the deviceKey mapping when the instrument has none', () => {
    const c = buildResolverMaps([row('inst-1', 'temp001', 'acme/gw-001', null)]);
    expect(c.byDeviceKey.size).toBe(0);
  });

  it('omits the deviceKey mapping when the instrument has no gateway', () => {
    const c = buildResolverMaps([row('inst-1', 'temp001', 'acme/site', 'DEV-1', null)]);
    expect(c.byDeviceKey.size).toBe(0);
    expect(c.bySlug.get('acme/site|temp001')).toBe('inst-1');   // still topic-addressable
  });

  // THE CASE THAT MOTIVATED THE KEY CHANGE. One gateway, two instruments with the
  // same slug in different hierarchy nodes. P1 derives an instrument's topic from
  // the INSTRUMENT's ancestry, so these publish to genuinely different topics.
  // Keyed on gatewaySlug they would have collided and one would have been
  // attributed the other's readings; keyed on baseTopic they stay distinct.
  it('separates same-slug instruments on one gateway in different hierarchy nodes', () => {
    const c = buildResolverMaps([
      row('inst-1', 'temp001', 'acme/area-02/gw-001', null, 'gw-id-1'),
      row('inst-2', 'temp001', 'acme/area-07/gw-001', null, 'gw-id-1'),
    ]);
    expect(c.bySlug.get('acme/area-02/gw-001|temp001')).toBe('inst-1');
    expect(c.bySlug.get('acme/area-07/gw-001|temp001')).toBe('inst-2');
    expect(c.collisions).toEqual([]);
  });

  it('separates identical slugs under different gateways', () => {
    const c = buildResolverMaps([
      row('inst-1', 'temp001', 'acme/area-02/gw-001'),
      row('inst-2', 'temp001', 'acme/area-02/gw-002'),
    ]);
    expect(c.bySlug.size).toBe(2);
    expect(c.collisions).toEqual([]);
  });

  // Gateway slugs are unique per hierarchy node, NOT globally, so two gateways
  // may share one. Keying deviceKeys on gatewayId keeps them apart.
  it('separates identical deviceKeys on two gateways sharing a slug', () => {
    const c = buildResolverMaps([
      row('inst-1', 'a', 'acme/area-02/gw-x', 'DEV-1', 'gw-id-1'),
      row('inst-2', 'b', 'acme/area-07/gw-x', 'DEV-1', 'gw-id-2'),
    ]);
    expect(c.byDeviceKey.get('gw-id-1|DEV-1')).toBe('inst-1');
    expect(c.byDeviceKey.get('gw-id-2|DEV-1')).toBe('inst-2');
  });

  it("the '|' separator prevents base 'a/gw-1' + '0temp' colliding with 'a/gw-10' + 'temp'", () => {
    const c = buildResolverMaps([
      row('inst-1', '0temp', 'a/gw-1'),
      row('inst-2', 'temp', 'a/gw-10'),
    ]);
    expect(c.bySlug.get('a/gw-1|0temp')).toBe('inst-1');
    expect(c.bySlug.get('a/gw-10|temp')).toBe('inst-2');
    expect(c.collisions).toEqual([]);
  });

  it('is idempotent when the same instrument appears twice', () => {
    const c = buildResolverMaps([
      row('inst-1', 'temp001', 'acme/gw-001'),
      row('inst-1', 'temp001', 'acme/gw-001'),
    ]);
    expect(c.bySlug.get('acme/gw-001|temp001')).toBe('inst-1');
    expect(c.collisions).toEqual([]);
  });

  // Should be unreachable given the constraints, but the safety net must work if
  // an assumption above is ever violated.
  it('still drops both entries if a genuine collision somehow occurs', () => {
    const c = buildResolverMaps([
      row('inst-1', 'temp001', 'acme/gw-001'),
      row('inst-2', 'temp001', 'acme/gw-001'),
    ]);
    expect(c.bySlug.has('acme/gw-001|temp001')).toBe(false);
    expect(c.collisions).toEqual(['acme/gw-001|temp001']);
  });
});
