/**
 * Permissions the Permissions tab can no longer show or revoke (2026-10-24,
 * operator: "update all the permissions properly"), and what each leaves
 * behind. Pure — `scripts/strip-unused-permissions.ts` applies it to every
 * role with one ROLE_UPDATED row each; read that script's header for the why.
 *
 * - DASHBOARD_CREATE / _MANAGE / _ASSIGN gate nothing: since 2026-10-29 the
 *   `/api/dashboards` write routes check for the SUPER_ADMIN role instead.
 * - USER_DELETE: deleting a user is SUPER_ADMIN only (route + button).
 * - FIELD_ID_UPDATE: its screen (Display Settings → Field IDs) is SUPER_ADMIN only.
 * - NOTIFICATION_CREATE / _UPDATE / _MANAGE and BACKUP_MANAGE: no toggle ever
 *   offered them, so a role holding one carried a capability nobody could see
 *   or take away (the server reads X_MANAGE as X_VIEW / X_DELETE / X_EXPORT).
 */
export const UNUSED_PERMISSIONS = [
  'DASHBOARD_CREATE', 'DASHBOARD_MANAGE', 'DASHBOARD_ASSIGN',
  'USER_DELETE', 'FIELD_ID_UPDATE',
  'NOTIFICATION_CREATE', 'NOTIFICATION_UPDATE', 'NOTIFICATION_MANAGE',
  'BACKUP_MANAGE',
] as const;

/**
 * What a removed permission leaves behind, because a SCREEN offered it: the
 * Backup page let BACKUP_MANAGE download; DASHBOARD_MANAGE and
 * NOTIFICATION_MANAGE opened their pages. NOT NOTIFICATION_DELETE: M4/M5
 * (2026-06-30) made deleting notifications SUPER_ADMIN-only for ADMIN and no
 * screen offered it — only the MANAGE fallback kept it possible via the API.
 */
export const KEPT_AS: Partial<Record<(typeof UNUSED_PERMISSIONS)[number], string[]>> = {
  BACKUP_MANAGE: ['BACKUP_EXPORT'],
  DASHBOARD_MANAGE: ['DASHBOARD_VIEW'],
  NOTIFICATION_MANAGE: ['NOTIFICATION_VIEW'],
};

export function planUnusedPermissionStrip(held: readonly string[]): { after: string[]; removed: string[]; added: string[] } {
  const unused = new Set<string>(UNUSED_PERMISSIONS);
  const removed = held.filter((p) => unused.has(p));
  const kept = held.filter((p) => !unused.has(p));
  const replacements = removed.flatMap((p) => KEPT_AS[p as keyof typeof KEPT_AS] ?? []);
  const added = [...new Set(replacements)].filter((p) => !kept.includes(p));
  return { after: [...kept, ...added], removed, added };
}
