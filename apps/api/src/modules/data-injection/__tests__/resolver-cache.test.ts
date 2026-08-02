import { describe, it, expect } from 'vitest';
import { buildResolverMaps, type ResolverRow } from '../telemetry.repository.js';

const row = (
  id: string, slug: string, gatewaySlug: string | null, deviceKey: string | null = null,
): ResolverRow => ({
  id, slug, deviceKey, gateway: gatewaySlug === null ? null : { slug: gatewaySlug },
});

describe('buildResolverMaps', () => {
  it('maps slug and deviceKey under their gateway', () => {
    const c = buildResolverMaps([row('inst-1', 'temp001', 'gw-001', 'DEV-1')]);
    expect(c.bySlug.get('gw-001|temp001')).toBe('inst-1');
    expect(c.byDeviceKey.get('gw-001|DEV-1')).toBe('inst-1');
    expect(c.collisions).toEqual([]);
  });

  it('skips instruments with no gateway', () => {
    const c = buildResolverMaps([row('inst-1', 'temp001', null)]);
    expect(c.bySlug.size).toBe(0);
  });

  it('omits deviceKey mapping when the instrument has none', () => {
    const c = buildResolverMaps([row('inst-1', 'temp001', 'gw-001', null)]);
    expect(c.byDeviceKey.size).toBe(0);
  });

  it('separates identical slugs under DIFFERENT gateways', () => {
    const c = buildResolverMaps([
      row('inst-1', 'temp001', 'gw-001'),
      row('inst-2', 'temp001', 'gw-002'),
    ]);
    expect(c.bySlug.get('gw-001|temp001')).toBe('inst-1');
    expect(c.bySlug.get('gw-002|temp001')).toBe('inst-2');
    expect(c.collisions).toEqual([]);
  });

  it("the '|' separator prevents gw-1 + 0temp colliding with gw-10 + temp", () => {
    const c = buildResolverMaps([
      row('inst-1', '0temp', 'gw-1'),
      row('inst-2', 'temp', 'gw-10'),
    ]);
    expect(c.bySlug.get('gw-1|0temp')).toBe('inst-1');
    expect(c.bySlug.get('gw-10|temp')).toBe('inst-2');
    expect(c.collisions).toEqual([]);
  });

  // No @@unique([gatewayId, slug]) exists, so two instruments under different
  // hierarchy nodes may legally share a gateway and a slug.
  it('drops BOTH entries on a slug collision rather than misattributing readings', () => {
    const c = buildResolverMaps([
      row('inst-1', 'temp001', 'gw-001'),
      row('inst-2', 'temp001', 'gw-001'),
    ]);
    expect(c.bySlug.has('gw-001|temp001')).toBe(false);
    expect(c.collisions).toEqual(['gw-001|temp001']);
  });

  it('a collision does not disturb other instruments', () => {
    const c = buildResolverMaps([
      row('inst-1', 'temp001', 'gw-001'),
      row('inst-2', 'temp001', 'gw-001'),
      row('inst-3', 'rh002', 'gw-001'),
    ]);
    expect(c.bySlug.get('gw-001|rh002')).toBe('inst-3');
    expect(c.bySlug.size).toBe(1);
  });

  it('is idempotent when the same instrument appears twice', () => {
    const c = buildResolverMaps([
      row('inst-1', 'temp001', 'gw-001'),
      row('inst-1', 'temp001', 'gw-001'),
    ]);
    expect(c.bySlug.get('gw-001|temp001')).toBe('inst-1');
    expect(c.collisions).toEqual([]);
  });
});
