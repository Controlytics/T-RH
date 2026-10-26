export const PERMISSIONS = {

  // User management
  USER_CREATE: 'USER_CREATE',
  USER_READ: 'USER_READ',
  USER_UPDATE: 'USER_UPDATE',
  USER_DELETE: 'USER_DELETE',
  USER_ENABLE_DISABLE: 'USER_ENABLE_DISABLE',
  USER_UNLOCK: 'USER_UNLOCK',
  USER_RESET_PASSWORD: 'USER_RESET_PASSWORD',

  // Reports (2026-09-07) — the report review workflow: every PDF download is a
  // REQUEST; READ sees the Reports page, raises requests and downloads approved
  // reports one is a party to; APPROVE signs a request; REJECT turns it down.
  // Two permissions since 2026-10-26 (operator: "approve and reject reports
  // both should be two different permissions") — APPROVE covered both until then.
  REPORT_REVIEW_READ: 'REPORT_REVIEW_READ',
  REPORT_REVIEW_APPROVE: 'REPORT_REVIEW_APPROVE',
  REPORT_REVIEW_REJECT: 'REPORT_REVIEW_REJECT',

  // Configuration
  CONFIG_READ: 'CONFIG_READ',
  CONFIG_UPDATE: 'CONFIG_UPDATE',
  FIELD_ID_UPDATE: 'FIELD_ID_UPDATE',
  ROLE_MANAGE: 'ROLE_MANAGE',

  // Audit
  AUDIT_READ: 'AUDIT_READ',
  AUDIT_EXPORT: 'AUDIT_EXPORT',
  // 2026-07-01: physical hard-delete of audit rows (grantable via the "Delete Audit
  // Record" picker toggle). WARNING: deletion breaks the tamper-evident hash chain —
  // see apps/api/src/modules/audit/routes.ts. Re-added at explicit operator request
  // after the 2026-05 removal (REDACT is the chain-preserving alternative).
  AUDIT_DELETE: 'AUDIT_DELETE',

  // Notifications
  NOTIFICATION_VIEW: 'NOTIFICATION_VIEW',
  NOTIFICATION_CREATE: 'NOTIFICATION_CREATE',
  NOTIFICATION_UPDATE: 'NOTIFICATION_UPDATE',
  NOTIFICATION_DELETE: 'NOTIFICATION_DELETE',
  NOTIFICATION_MANAGE: 'NOTIFICATION_MANAGE',

  // Dashboard
  DASHBOARD_CREATE: 'DASHBOARD_CREATE',
  DASHBOARD_MANAGE: 'DASHBOARD_MANAGE',
  DASHBOARD_VIEW: 'DASHBOARD_VIEW',
  DASHBOARD_ASSIGN: 'DASHBOARD_ASSIGN',

  // Debug Trace
  READ_DEBUG_TRACE: 'READ_DEBUG_TRACE',
  MANAGE_DEBUG_TRACE: 'MANAGE_DEBUG_TRACE',

  // Backup
  // BACKUP_MANAGE implicitly grants BACKUP_EXPORT via the suffix-expansion
  // map below (`_EXPORT` ∈ MANAGE_PERMISSION_SUFFIXES). BACKUP_RESTORE is
  // INTENTIONALLY NOT in that suffix map — restoring a database overwrites
  // history and is treated as a higher-risk grant than export. Roles that
  // need restore must be granted BACKUP_RESTORE explicitly (SUPER_ADMIN +
  // ADMIN today). Wired up 2026-05-14 — before that, both /export and
  // /restore checked CONFIG_UPDATE and BACKUP_MANAGE was dead scaffolding.
  BACKUP_MANAGE: 'BACKUP_MANAGE',
  // 2026-05-26 audit fix (PA-CLEANUP-3): BACKUP_EXPORT was used as a
  // literal string at apps/api/src/modules/backup/routes.ts:17 + on
  // the FE backup page. It worked via suffix-expansion
  // (`BACKUP_MANAGE` grants `_EXPORT`); declaring it here is
  // hygiene-only (typing + searchability + stable identifier).
  BACKUP_EXPORT: 'BACKUP_EXPORT',
  BACKUP_RESTORE: 'BACKUP_RESTORE',

  // Admin Requests (2026-06-30): two distinct action permissions, no separate review/view
  // level. The page + request details are visible to anyone holding APPROVE or REJECT.
  // (The former single ADMIN_REQUEST_REVIEW perm was removed — it gated everything AND was
  // the sidebar primary, so it could never be revoked while the menu was enabled.)
  ADMIN_REQUEST_APPROVE: 'ADMIN_REQUEST_APPROVE',
  ADMIN_REQUEST_REJECT: 'ADMIN_REQUEST_REJECT',

  // Instruments (2026-08-05) — the device registry behind /api/ingest/v1.
  // These gate the OPERATOR-facing registry (create / edit / delete an
  // instrument and issue its credential). They do NOT gate ingest itself:
  // a device authenticates with its own token, never a user permission.
  INSTRUMENT_READ: 'INSTRUMENT_READ',
  INSTRUMENT_CREATE: 'INSTRUMENT_CREATE',
  INSTRUMENT_UPDATE: 'INSTRUMENT_UPDATE',
  INSTRUMENT_DELETE: 'INSTRUMENT_DELETE',

  // Functional Locations — the authoritative Block > Area grouping of
  // instruments (2026-08-13). Separate from INSTRUMENT_* on purpose: deciding
  // how the estate is organised is a different authority from editing a device.
  FUNCTIONAL_LOCATION_READ: 'FUNCTIONAL_LOCATION_READ',
  FUNCTIONAL_LOCATION_CREATE: 'FUNCTIONAL_LOCATION_CREATE',
  FUNCTIONAL_LOCATION_UPDATE: 'FUNCTIONAL_LOCATION_UPDATE',
  FUNCTIONAL_LOCATION_DELETE: 'FUNCTIONAL_LOCATION_DELETE',

  // Alarms (2026-08-13). Rule authoring and alarm acknowledgement are separate
  // authorities on purpose: deciding what constitutes an excursion is an
  // engineering decision, accepting one is a quality decision, and the same person
  // should not necessarily hold both.
  ALARM_RULE_READ: 'ALARM_RULE_READ',
  ALARM_RULE_MANAGE: 'ALARM_RULE_MANAGE',
  ALARM_READ: 'ALARM_READ',
  ALARM_ACKNOWLEDGE: 'ALARM_ACKNOWLEDGE',

  // VERSION_HISTORY_VIEW was removed with the Version History page — all four
  // versioned entities it browsed all went in the Phase 0 domain strip, so the
  // page had no reachable data and every one of its tabs 404'd.
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Suffixes that `*_MANAGE` permissions implicitly grant.
 *
 * Authoritative list consulted by the API's RBAC plugin (`requirePermission`
 * + `requireAnyPermission` in `apps/api/src/plugins/rbac.ts`). If a route
 * requires e.g. `NOTIFICATION_UPDATE` and the user's role doesn't have it
 * directly, the gate falls back to checking whether the user has
 * `NOTIFICATION_MANAGE` (built by stripping the suffix and replacing with
 * `_MANAGE`).
 *
 * Why this list lives here and not inline in rbac.ts:
 * - The 2026-05-04 code review (tasks/CODE-REVIEW-2026-05-04-api-supporting.md)
 *   flagged the previous hand-rolled inline array as brittle and inconsistent.
 *   E.g. `BACKUP_MANAGE` was implicitly granting `BACKUP_EXPORT` but NOT
 *   `BACKUP_RESTORE` because `_RESTORE` wasn't in the suffix list.
 * - Co-locating with `PERMISSIONS` makes the implication policy auditable
 *   alongside the permission constants themselves.
 * - Changes here automatically apply to both `requirePermission` and
 *   `requireAnyPermission` — no chance of the two getting out of sync.
 *
 * Adding a new suffix to this list grants `*_MANAGE` holders the new
 * sub-permission across every domain (USER_, BACKUP_, NOTIFICATION_, etc.).
 * Removing a suffix tightens the gate everywhere. Both are security-relevant
 * decisions — make them deliberately.
 *
 * `_RESTORE` is INTENTIONALLY omitted: backup restore is destructive and
 * narrowly scoped enough that granting it by virtue of `BACKUP_MANAGE` is
 * not the desired posture. Roles that should be able to restore must be
 * granted `BACKUP_RESTORE` explicitly (added 2026-05-14 — see the BACKUP
 * permissions block above and the seed assignments for SUPER_ADMIN +
 * ADMIN).
 */
export const MANAGE_PERMISSION_SUFFIXES = [
  '_CREATE',
  '_UPDATE',
  '_DELETE',
  '_VIEW',
  '_READ',
  '_EXPORT',
] as const;

/**
 * Returns true if `perms` effectively grants `permission`, applying the
 * documented fallback rules:
 *
 *   1. Direct match: `perms` contains `permission` literally.
 *   2. `*_VIEW` <- `*_READ` fallback: a route gated on `INSTRUMENT_VIEW` is
 *      satisfied by a role with `INSTRUMENT_READ` (read-only access).
 *   3. `*_<suffix> <- *_MANAGE` fallback: for each suffix in
 *      `MANAGE_PERMISSION_SUFFIXES`, if the requested permission ends with
 *      that suffix and the user has the corresponding `*_MANAGE`, grant.
 *
 * Pure helper — no DB / async I/O. Importable from anywhere; used by the
 * API's RBAC plugin and available to tests + tooling.
 */
export function hasEffectivePermission(perms: readonly string[], permission: string): boolean {
  if (perms.includes(permission)) return true;

  if (permission.endsWith('_VIEW')) {
    const readVariant = permission.slice(0, -'_VIEW'.length) + '_READ';
    if (perms.includes(readVariant)) return true;
  }

  for (const suffix of MANAGE_PERMISSION_SUFFIXES) {
    if (permission.endsWith(suffix)) {
      const managePermission = permission.slice(0, -suffix.length) + '_MANAGE';
      if (perms.includes(managePermission)) return true;
    }
  }

  return false;
}
