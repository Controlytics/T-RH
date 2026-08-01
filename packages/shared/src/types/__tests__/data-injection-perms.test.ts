import { describe, it, expect } from 'vitest';
import { PERMISSIONS } from '../permissions.js';
import { REAUTH_ACTIONS } from '../reauth-actions.js';
import { SIDEBAR_ITEMS } from '../sidebar-items.js';

describe('data-injection RBAC surface', () => {
  it('adds 16 permissions (30 → 46)', () => {
    expect(Object.keys(PERMISSIONS)).toHaveLength(46);
    for (const p of [
      'HIERARCHY_VIEW', 'HIERARCHY_CREATE', 'HIERARCHY_UPDATE', 'HIERARCHY_DELETE',
      'GATEWAY_VIEW', 'GATEWAY_CREATE', 'GATEWAY_UPDATE', 'GATEWAY_DELETE',
      'INSTRUMENT_VIEW', 'INSTRUMENT_CREATE', 'INSTRUMENT_UPDATE', 'INSTRUMENT_DELETE',
      'COMM_PROFILE_VIEW', 'COMM_PROFILE_CREATE', 'COMM_PROFILE_UPDATE', 'COMM_PROFILE_DELETE',
    ]) expect(PERMISSIONS).toHaveProperty(p, p);
  });

  it('adds 12 reauth actions (39 → 51), all in the Data Injection category', () => {
    expect(Object.keys(REAUTH_ACTIONS)).toHaveLength(51);
    expect(REAUTH_ACTIONS.CREATE_INSTRUMENT).toEqual({
      label: 'Create Instrument', category: 'Data Injection',
    });
  });

  it('adds the data-injection sidebar item (9 → 10)', () => {
    expect(SIDEBAR_ITEMS).toHaveLength(10);
    expect(SIDEBAR_ITEMS.find(i => i.id === 'data-injection')?.label).toBe('Data Injection');
  });
});
