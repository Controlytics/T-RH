import { describe, it, expect } from 'vitest';
import {
  primaryPermissionsForSidebarItem,
  privilegeTogglesFromPermissions,
  rebuildRolePermissions,
} from '../permission-tree.js';
import { FEATURE_TO_PERMISSION_MAP } from '../feature-privileges.js';
import { SIDEBAR_PRIVILEGE_MAP } from '../sidebar-privilege-map.js';
import { SIDEBAR_ITEMS } from '../sidebar-items.js';
import { PERMISSIONS } from '../permissions.js';

/**
 * The ONE rule a Roles & Access save writes `roles.permissions` with
 * (2026-11-03). It moved here from the API's `config.service.ts` so the
 * Permissions tab can show, before a save, which toggles come back ON.
 */

// The API's `planRolePermissions` set algebra and `primaryPermsForSidebarItem`
// EXACTLY as they stood at c3e9d831, before the move — the reference the
// shared rule must reproduce, order included.
function referencePrimary(sidebarId: string): string[] {
  if (sidebarId === 'admin-requests') return [];
  const section = SIDEBAR_PRIVILEGE_MAP.find(s => s.sidebarId === sidebarId);
  if (!section || section.privilegeIds.length === 0) return [];
  return FEATURE_TO_PERMISSION_MAP[section.privilegeIds[0]] ?? [];
}
function referenceRebuild(currentPerms: string[], permissions: Record<string, boolean> | undefined, effectiveSidebar: string[]): string[] {
  const allMappedPerms = new Set<string>();
  for (const perms of Object.values(FEATURE_TO_PERMISSION_MAP)) {
    for (const p of perms) allMappedPerms.add(p);
  }
  const sidebarPerms = effectiveSidebar.flatMap(referencePrimary);
  let permissionSet: Set<string>;
  if (permissions) {
    permissionSet = new Set<string>(currentPerms.filter(p => !allMappedPerms.has(p)));
    for (const [featureId, enabled] of Object.entries(permissions)) {
      if (enabled && FEATURE_TO_PERMISSION_MAP[featureId]) {
        for (const perm of FEATURE_TO_PERMISSION_MAP[featureId]) permissionSet.add(perm);
      }
    }
  } else {
    permissionSet = new Set<string>(currentPerms);
  }
  for (const perm of sidebarPerms) permissionSet.add(perm);
  return Array.from(permissionSet);
}

// The local install's roles as read on 2026-11-03 (permissions + role_configs.sidebar_items).
const ROLES: Array<{ name: string; perms: string[]; sidebar: string[] }> = [
  { name: 'SUPER_ADMIN', sidebar: [], perms: ['USER_CREATE', 'USER_READ', 'USER_UPDATE', 'USER_DELETE', 'USER_ENABLE_DISABLE', 'USER_UNLOCK', 'USER_RESET_PASSWORD', 'ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT', 'CONFIG_READ', 'CONFIG_UPDATE', 'FIELD_ID_UPDATE', 'AUDIT_READ', 'AUDIT_EXPORT', 'AUDIT_DELETE', 'ROLE_MANAGE', 'DASHBOARD_CREATE', 'DASHBOARD_MANAGE', 'DASHBOARD_VIEW', 'DASHBOARD_ASSIGN', 'NOTIFICATION_VIEW', 'NOTIFICATION_CREATE', 'NOTIFICATION_UPDATE', 'NOTIFICATION_DELETE', 'NOTIFICATION_MANAGE', 'BACKUP_MANAGE', 'BACKUP_RESTORE', 'READ_DEBUG_TRACE', 'MANAGE_DEBUG_TRACE'] },
  { name: 'ADMIN', sidebar: ['dashboard', 'users', 'admin-requests', 'configuration', 'notifications', 'audit', 'dashboards'], perms: ['DASHBOARD_VIEW', 'USER_READ', 'USER_CREATE', 'USER_UPDATE', 'USER_ENABLE_DISABLE', 'USER_UNLOCK', 'USER_RESET_PASSWORD', 'ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT', 'CONFIG_READ', 'CONFIG_UPDATE', 'BACKUP_EXPORT', 'BACKUP_RESTORE', 'NOTIFICATION_VIEW', 'AUDIT_READ', 'AUDIT_EXPORT', 'INSTRUMENT_READ'] },
  { name: 'SUPERVISOR', sidebar: ['dashboard', 'notifications', 'audit', 'alarms', 'data-report', 'reports', 'settings', 'dashboards'], perms: ['DASHBOARD_VIEW', 'NOTIFICATION_VIEW', 'AUDIT_READ', 'AUDIT_EXPORT', 'INSTRUMENT_READ', 'ALARM_READ', 'ALARM_ACKNOWLEDGE', 'REPORT_REVIEW_READ', 'INSTRUMENT_ATTRIBUTE_UPDATE'] },
  { name: 'MAINTENANCE', sidebar: ['dashboard', 'notifications', 'audit', 'instruments', 'functional-locations', 'alarms', 'data-report', 'reports', 'settings', 'dashboards'], perms: ['DASHBOARD_VIEW', 'NOTIFICATION_VIEW', 'AUDIT_READ', 'AUDIT_EXPORT', 'INSTRUMENT_READ', 'INSTRUMENT_CREATE', 'INSTRUMENT_UPDATE', 'FUNCTIONAL_LOCATION_READ', 'FUNCTIONAL_LOCATION_CREATE', 'FUNCTIONAL_LOCATION_UPDATE', 'ALARM_READ', 'ALARM_ACKNOWLEDGE', 'REPORT_REVIEW_READ'] },
  { name: 'OPERATOR', sidebar: ['dashboard', 'notifications', 'alarms', 'data-report', 'reports', 'settings', 'dashboards'], perms: ['DASHBOARD_VIEW', 'NOTIFICATION_VIEW', 'INSTRUMENT_READ', 'ALARM_READ', 'ALARM_ACKNOWLEDGE', 'REPORT_REVIEW_READ'] },
  { name: 'QA', sidebar: ['dashboard', 'notifications', 'audit', 'data-report', 'reports', 'dashboards'], perms: ['DASHBOARD_VIEW', 'NOTIFICATION_VIEW', 'AUDIT_READ', 'AUDIT_EXPORT', 'INSTRUMENT_READ', 'REPORT_REVIEW_READ', 'REPORT_REVIEW_APPROVE', 'REPORT_REVIEW_REJECT'] },
];
const TOGGLE_IDS = Object.keys(FEATURE_TO_PERMISSION_MAP);
const ALL_ON = Object.fromEntries(TOGGLE_IDS.map(id => [id, true]));
const ALL_OFF = Object.fromEntries(TOGGLE_IDS.map(id => [id, false]));
const ALL_SIDEBAR = SIDEBAR_ITEMS.map(i => i.id);

describe('primaryPermissionsForSidebarItem — what enabling a menu grants', () => {
  it('a menu grants its page\'s View permission', () => {
    expect(primaryPermissionsForSidebarItem('users')).toEqual(['USER_READ']);
    expect(primaryPermissionsForSidebarItem('configuration')).toEqual(['CONFIG_READ']);
    expect(primaryPermissionsForSidebarItem('data-report')).toEqual(['INSTRUMENT_READ']);
    expect(primaryPermissionsForSidebarItem('settings')).toEqual(['INSTRUMENT_READ']);
    expect(primaryPermissionsForSidebarItem('dashboards')).toEqual(['DASHBOARD_VIEW']);
  });

  it('a menu with no privilege, and an unknown id, grant nothing', () => {
    expect(primaryPermissionsForSidebarItem('dashboard')).toEqual([]);
    expect(primaryPermissionsForSidebarItem('system-health')).toEqual([]);
    expect(primaryPermissionsForSidebarItem('no-such-item')).toEqual([]);
  });

  it('admin-requests opts OUT although its section names privileges — Approve / Reject stay revocable', () => {
    expect(SIDEBAR_PRIVILEGE_MAP.find(s => s.sidebarId === 'admin-requests')!.privilegeIds.length).toBeGreaterThan(0);
    expect(primaryPermissionsForSidebarItem('admin-requests')).toEqual([]);
  });

  it('matches the API\'s former rule for every sidebar item, and hands back a copy', () => {
    for (const id of ALL_SIDEBAR) expect(primaryPermissionsForSidebarItem(id), id).toEqual(referencePrimary(id));
    const first = primaryPermissionsForSidebarItem('users');
    first.push('ROLE_MANAGE');
    expect(primaryPermissionsForSidebarItem('users')).toEqual(['USER_READ']);
    expect(FEATURE_TO_PERMISSION_MAP['users.view']).toEqual(['USER_READ']);
  });
});

describe('rebuildRolePermissions — a Permissions save', () => {
  it('rebuilds the mapped permissions from the toggles and keeps every permission no toggle maps', () => {
    const out = rebuildRolePermissions({
      currentPermissions: ['BACKUP_MANAGE', 'AUDIT_DELETE', 'USER_DELETE', 'NOTIFICATION_MANAGE'],
      toggles: { 'users.edit': true, 'audit.view': true, 'audit.delete': false },
      sidebarItems: ['configuration'],
    });
    // Order: kept as held, then each ON toggle's grant set, then the sidebar.
    expect(out).toEqual(['BACKUP_MANAGE', 'USER_DELETE', 'NOTIFICATION_MANAGE', 'USER_UPDATE', 'USER_READ', 'AUDIT_READ', 'CONFIG_READ']);
  });

  it('an empty toggle map is still a Permissions save — every mapped permission goes', () => {
    expect(rebuildRolePermissions({ currentPermissions: ['USER_READ', 'USER_DELETE'], toggles: {}, sidebarItems: [] })).toEqual(['USER_DELETE']);
  });

  it('an enabled sidebar item re-grants its View permission — so View Users comes back ON', () => {
    const out = rebuildRolePermissions({ currentPermissions: ['USER_READ'], toggles: { 'users.view': false }, sidebarItems: ['users'] });
    expect(out).toEqual(['USER_READ']);
    expect(privilegeTogglesFromPermissions(out)['users.view']).toBe(true);
  });

  it('another ON toggle holds a View toggle the save turned OFF — the bounce, by the server\'s rule', () => {
    const out = rebuildRolePermissions({ currentPermissions: [], toggles: { 'users.view': false, 'users.edit': true }, sidebarItems: [] });
    expect(privilegeTogglesFromPermissions(out)['users.view']).toBe(true);
    const implied = rebuildRolePermissions({ currentPermissions: [], toggles: { 'settings.edit': false, 'instruments.edit': true }, sidebarItems: [] });
    expect(implied).not.toContain('INSTRUMENT_ATTRIBUTE_UPDATE');
    expect(privilegeTogglesFromPermissions(implied)['settings.edit']).toBe(true);
  });

  it('the admin-requests menu grants nothing, so its Approve toggle can be turned off', () => {
    expect(rebuildRolePermissions({
      currentPermissions: ['ADMIN_REQUEST_APPROVE'], toggles: { 'admin_requests.approve': false }, sidebarItems: ['admin-requests'],
    })).toEqual([]);
  });

  it('an unknown toggle id, or one naming an Object prototype property, grants nothing and does not throw', () => {
    const toggles = JSON.parse('{"no.such": true, "constructor": true, "toString": true, "hasOwnProperty": true}') as Record<string, boolean>;
    expect(rebuildRolePermissions({ currentPermissions: [], toggles, sidebarItems: [] })).toEqual([]);
    // The reference threw here — the one place the shared rule differs from it.
    expect(() => referenceRebuild([], toggles, [])).toThrow();
  });
});

describe('rebuildRolePermissions — a Sidebar-only save', () => {
  it('keeps every current permission, mapped ones included, and adds each item\'s primary permission', () => {
    expect(rebuildRolePermissions({ currentPermissions: ['AUDIT_DELETE', 'USER_READ'], sidebarItems: ['users', 'alarms'] }))
      .toEqual(['AUDIT_DELETE', 'USER_READ', 'ALARM_READ']);
  });

  it('switching every menu off revokes nothing', () => {
    expect(rebuildRolePermissions({ currentPermissions: ['USER_READ', 'CONFIG_READ'], sidebarItems: [] })).toEqual(['USER_READ', 'CONFIG_READ']);
  });
});

describe('rebuildRolePermissions reproduces the API\'s former algebra exactly, order included', () => {
  const samples: string[][] = [
    ...ROLES.map(r => r.perms),
    ...(Object.values(PERMISSIONS) as string[]).map(p => [p]),
    ...Object.values(FEATURE_TO_PERMISSION_MAP),
    [],
  ];
  const sidebars: string[][] = [[], ALL_SIDEBAR, ...ROLES.map(r => r.sidebar), ...ALL_SIDEBAR.map(id => [id])];

  it('over every sample, toggle map and sidebar list — both branches', () => {
    let compared = 0;
    for (const held of samples) {
      const shown = privilegeTogglesFromPermissions(held);
      const toggleMaps: Array<Record<string, boolean> | undefined> = [undefined, {}, shown, ALL_ON, ALL_OFF];
      for (const toggles of toggleMaps) {
        for (const sidebar of sidebars) {
          expect(rebuildRolePermissions({ currentPermissions: held, toggles, sidebarItems: sidebar }), `${held.join(',')} | ${sidebar.join(',')}`)
            .toEqual(referenceRebuild(held, toggles, sidebar));
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it('for each role, with each one of its displayed toggles flipped — what a Permissions save sends', () => {
    for (const role of ROLES) {
      const shown = privilegeTogglesFromPermissions(role.perms);
      for (const id of TOGGLE_IDS) {
        const toggles = { ...shown, [id]: !shown[id] };
        expect(rebuildRolePermissions({ currentPermissions: role.perms, toggles, sidebarItems: role.sidebar }), `${role.name} ${id}`)
          .toEqual(referenceRebuild(role.perms, toggles, role.sidebar));
      }
    }
  });
});
