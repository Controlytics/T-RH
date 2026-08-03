import { describe, it, expect } from 'vitest';
import { PERMISSIONS } from '../permissions.js';
import { REAUTH_ACTIONS } from '../reauth-actions.js';
import { SIDEBAR_ITEMS } from '../sidebar-items.js';

describe('data-injection RBAC surface', () => {
  it('adds 16 P1 permissions + 3 P3 alarm permissions (30 → 46 → 49)', () => {
    expect(Object.keys(PERMISSIONS)).toHaveLength(49);
    for (const p of [
      'HIERARCHY_VIEW', 'HIERARCHY_CREATE', 'HIERARCHY_UPDATE', 'HIERARCHY_DELETE',
      'GATEWAY_VIEW', 'GATEWAY_CREATE', 'GATEWAY_UPDATE', 'GATEWAY_DELETE',
      'INSTRUMENT_VIEW', 'INSTRUMENT_CREATE', 'INSTRUMENT_UPDATE', 'INSTRUMENT_DELETE',
      'COMM_PROFILE_VIEW', 'COMM_PROFILE_CREATE', 'COMM_PROFILE_UPDATE', 'COMM_PROFILE_DELETE',
      'ALARM_VIEW', 'ALARM_ACKNOWLEDGE', 'ALARM_THRESHOLD_MANAGE',
    ]) expect(PERMISSIONS).toHaveProperty(p, p);
  });

  it('adds 12 P1 + 2 P3 reauth actions (39 → 51 → 53), all in the Data Injection category', () => {
    expect(Object.keys(REAUTH_ACTIONS)).toHaveLength(53);
    expect(REAUTH_ACTIONS.CREATE_INSTRUMENT).toEqual({
      label: 'Create Instrument', category: 'Data Injection',
    });
    expect(REAUTH_ACTIONS.ACKNOWLEDGE_ALARM).toEqual({
      label: 'Acknowledge Alarm', category: 'Data Injection',
    });
    expect(REAUTH_ACTIONS.MANAGE_ALARM_THRESHOLD).toEqual({
      label: 'Manage Alarm Threshold', category: 'Data Injection',
    });
  });

  it('adds the data-injection sidebar item (9 → 10)', () => {
    expect(SIDEBAR_ITEMS).toHaveLength(10);
    expect(SIDEBAR_ITEMS.find(i => i.id === 'data-injection')?.label).toBe('Data Injection');
  });
});
