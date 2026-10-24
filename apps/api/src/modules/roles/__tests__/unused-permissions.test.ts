import { describe, it, expect } from 'vitest';
import { privilegeTogglesFromPermissions, deriveFeatureToPermissionMap, hasEffectivePermission, PERMISSIONS } from '@digilog/shared';
import { UNUSED_PERMISSIONS, planUnusedPermissionStrip } from '../unused-permissions.js';

/**
 * 2026-10-24: `scripts/strip-unused-permissions.ts` removes from every role
 * the permissions the Permissions tab can no longer show or revoke. These pin
 * what it takes, what it leaves behind, and that afterwards everything a role
 * holds is something the tab can show and take away.
 */
const ADMIN_AS_FOUND = [
  'USER_CREATE', 'USER_READ', 'USER_UPDATE', 'USER_ENABLE_DISABLE', 'USER_UNLOCK', 'USER_RESET_PASSWORD',
  'ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT', 'CONFIG_READ', 'CONFIG_UPDATE', 'FIELD_ID_UPDATE', 'ROLE_MANAGE',
  'AUDIT_READ', 'AUDIT_EXPORT', 'DASHBOARD_CREATE', 'DASHBOARD_MANAGE', 'DASHBOARD_VIEW', 'DASHBOARD_ASSIGN',
  'NOTIFICATION_VIEW', 'NOTIFICATION_CREATE', 'NOTIFICATION_UPDATE', 'NOTIFICATION_MANAGE',
  'BACKUP_MANAGE', 'BACKUP_RESTORE', 'READ_DEBUG_TRACE', 'MANAGE_DEBUG_TRACE', 'INSTRUMENT_READ',
];

describe('planUnusedPermissionStrip', () => {
  it('ADMIN as found: the unused permissions go, Export Backup takes BACKUP_MANAGE\'s place', () => {
    const { after, removed, added } = planUnusedPermissionStrip(ADMIN_AS_FOUND);
    expect(removed.sort()).toEqual(['BACKUP_MANAGE', 'DASHBOARD_ASSIGN', 'DASHBOARD_CREATE', 'DASHBOARD_MANAGE',
      'FIELD_ID_UPDATE', 'NOTIFICATION_CREATE', 'NOTIFICATION_MANAGE', 'NOTIFICATION_UPDATE']);
    expect(added).toEqual(['BACKUP_EXPORT']);
    for (const p of UNUSED_PERMISSIONS) expect(after).not.toContain(p);
    expect(after).toEqual(expect.arrayContaining(['BACKUP_EXPORT', 'BACKUP_RESTORE', 'DASHBOARD_VIEW', 'NOTIFICATION_VIEW']));
  });

  it('keeps what a screen offered, and NOT Delete Notifications (SUPER_ADMIN only since M4/M5)', () => {
    expect(planUnusedPermissionStrip(['DASHBOARD_MANAGE']).after).toEqual(['DASHBOARD_VIEW']);
    expect(planUnusedPermissionStrip(['NOTIFICATION_MANAGE']).after).toEqual(['NOTIFICATION_VIEW']);
    expect(planUnusedPermissionStrip(['BACKUP_MANAGE']).after).toEqual(['BACKUP_EXPORT']);
    expect(planUnusedPermissionStrip(['NOTIFICATION_MANAGE']).after).not.toContain('NOTIFICATION_DELETE');
  });

  it('a role holding none of them is untouched', () => {
    const held = ['AUDIT_READ', 'DASHBOARD_VIEW', 'NOTIFICATION_VIEW', 'INSTRUMENT_READ'];
    expect(planUnusedPermissionStrip(held)).toEqual({ after: held, removed: [], added: [] });
  });

  // The point of the strip: afterwards the tab is the whole truth. Every
  // capability the role has (by the server's rule) is one some toggle shows ON
  // for it, so the tab can take it away.
  it('after the strip, every capability of the role is shown ON by some toggle', () => {
    const map = deriveFeatureToPermissionMap();
    const { after } = planUnusedPermissionStrip(ADMIN_AS_FOUND);
    const toggles = privilegeTogglesFromPermissions(after);
    const shownOn = new Set(Object.entries(toggles).filter(([, on]) => on).flatMap(([id]) => map[id]));
    const capabilities = (Object.values(PERMISSIONS) as string[]).filter((p) => hasEffectivePermission(after, p));
    expect(capabilities.filter((p) => !shownOn.has(p))).toEqual([]);
  });
});
