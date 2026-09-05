import { describe, it, expect } from 'vitest';
import { buildChildAttributesBundle, childAttributesBundleTopic } from '../child-attributes-bundle.js';

/**
 * The whole-gateway attribute bundle (2026-09-05) — the pure half. What a
 * gateway reads from ONE retained message: every child as a block under
 * `devices`, `devN` first then its attributes, mirroring the telemetry batch
 * (operator: "can u do same for attributes also"), stably ordered, and the one
 * change that prompted the publish.
 */
describe('childAttributesBundleTopic', () => {
  it('is a sibling of the roster, under /children/, never the gateway\'s own attribute slot', () => {
    expect(childAttributesBundleTopic('IOTGW01')).toBe('instruments/IOTGW01/children/attributes');
    expect(childAttributesBundleTopic('CWH/GW/01')).toBe('instruments/CWH/GW/01/children/attributes');
  });
});

describe('buildChildAttributesBundle', () => {
  const ts = new Date('2026-09-05T10:00:00.000Z');
  const children = [
    { code: 'CWH/RDU/002-00', isActive: true, attributes: { 'Low Temperature Limit': '18', 'High Temperature Limit': '27' } },
    { code: 'CWH/RDU/001-00', isActive: false, attributes: { 'High Temperature Limit': '25' } },
  ];

  it('is a LIST of blocks, `devN` first then the COMPLETE attribute set as plain keys — the telemetry batch shape', () => {
    const out = buildChildAttributesBundle('IOTGW01', children, null, ts);
    expect(out.gateway).toBe('IOTGW01');
    expect(out.devices).toEqual([
      { devN: 'CWH/RDU/001-00', 'High Temperature Limit': '25' },
      { devN: 'CWH/RDU/002-00', 'High Temperature Limit': '27', 'Low Temperature Limit': '18' },
    ]);
    // `devN` is the FIRST key of every block, as it is in the telemetry batch.
    for (const b of out.devices) expect(Object.keys(b)[0]).toBe('devN');
    expect(out.ts).toBe('2026-09-05T10:00:00.000Z');
  });

  it('serialises identically for an unchanged state — blocks and keys sorted', () => {
    const a = JSON.stringify(buildChildAttributesBundle('IOTGW01', children, null, ts));
    const shuffled = [children[1], { ...children[0], attributes: { 'High Temperature Limit': '27', 'Low Temperature Limit': '18' } }];
    const b = JSON.stringify(buildChildAttributesBundle('IOTGW01', shuffled, null, ts));
    expect(a).toBe(b);
  });

  it('names the change by devN, and null for a membership-driven one', () => {
    const changed = { code: 'CWH/RDU/001-00', key: 'High Temperature Limit', value: '25' };
    expect(buildChildAttributesBundle('IOTGW01', children, changed, ts).changed)
      .toEqual({ devN: 'CWH/RDU/001-00', key: 'High Temperature Limit', value: '25' });
    expect(buildChildAttributesBundle('IOTGW01', children, null, ts).changed).toBeNull();
  });

  it('a removed attribute is ABSENT from the block and null in `changed`', () => {
    const after = [{ code: 'CWH/RDU/001-00', isActive: true, attributes: {} }];
    const out = buildChildAttributesBundle('IOTGW01', after, { code: 'CWH/RDU/001-00', key: 'Location', value: null }, ts);
    expect(out.devices).toEqual([{ devN: 'CWH/RDU/001-00' }]);
    expect(out.changed).toEqual({ devN: 'CWH/RDU/001-00', key: 'Location', value: null });
  });

  it('lists every child, active or not — the roster carries the flag', () => {
    const out = buildChildAttributesBundle('IOTGW01', children, null, ts);
    expect(out.devices.map((d) => d.devN)).toEqual(['CWH/RDU/001-00', 'CWH/RDU/002-00']);
  });

  it('is an empty list, not an absent message, for a gateway with no children', () => {
    expect(buildChildAttributesBundle('IOTGW01', [], null, ts).devices).toEqual([]);
  });
});
