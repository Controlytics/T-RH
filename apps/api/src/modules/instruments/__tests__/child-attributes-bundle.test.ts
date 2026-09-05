import { describe, it, expect } from 'vitest';
import { buildChildAttributeChange, childAttributesBundleTopic } from '../child-attributes-bundle.js';

/**
 * The gateway's child attribute CHANGE event (2026-09-05) — the pure half.
 * Exactly the change: the child's code and the one key that moved. No
 * timestamp (operator: "remove the time stamp").
 */
describe('childAttributesBundleTopic', () => {
  it('is a sibling of the roster, under /children/, never the gateway\'s own attribute slot', () => {
    expect(childAttributesBundleTopic('IOTGW01')).toBe('instruments/IOTGW01/children/attributes');
    expect(childAttributesBundleTopic('CWH/GW/01')).toBe('instruments/CWH/GW/01/children/attributes');
  });
});

describe('buildChildAttributeChange', () => {
  it('carries ONLY the changed key under the child\'s devN, and nothing else', () => {
    const out = buildChildAttributeChange('IOTGW01', { code: 'CWH/RDU/002-01', key: 'Location', value: 'LCMS Room-II' });
    expect(out).toEqual({ gateway: 'IOTGW01', devices: [{ devN: 'CWH/RDU/002-01', Location: 'LCMS Room-II' }] });
    expect(Object.keys(out)).toEqual(['gateway', 'devices']);
    expect(Object.keys(out.devices[0])).toEqual(['devN', 'Location']);
  });

  it('a removed key is carried as null', () => {
    const out = buildChildAttributeChange('IOTGW01', { code: 'X', key: 'Location', value: null });
    expect(out.devices).toEqual([{ devN: 'X', Location: null }]);
  });
});
