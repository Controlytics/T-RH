export const PERMISSIONS = {

  // User management
  USER_CREATE: 'USER_CREATE',
  USER_READ: 'USER_READ',
  USER_UPDATE: 'USER_UPDATE',
  USER_DELETE: 'USER_DELETE',
  USER_ENABLE_DISABLE: 'USER_ENABLE_DISABLE',
  USER_UNLOCK: 'USER_UNLOCK',
  USER_RESET_PASSWORD: 'USER_RESET_PASSWORD',

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

  // Filter Events
  EVENT_READ: 'EVENT_READ',

  // Notifications
  NOTIFICATION_VIEW: 'NOTIFICATION_VIEW',
  NOTIFICATION_CREATE: 'NOTIFICATION_CREATE',
  NOTIFICATION_UPDATE: 'NOTIFICATION_UPDATE',
  NOTIFICATION_DELETE: 'NOTIFICATION_DELETE',
  NOTIFICATION_MANAGE: 'NOTIFICATION_MANAGE',

  // Asset Management
  ASSET_READ: 'ASSET_READ',
  ASSET_VIEW: 'ASSET_VIEW',
  ASSET_CREATE: 'ASSET_CREATE',
  ASSET_UPDATE: 'ASSET_UPDATE',
  ASSET_DELETE: 'ASSET_DELETE',

  // Asset Identifiers
  ASSET_IDENTIFIER_CREATE: 'ASSET_IDENTIFIER_CREATE',
  ASSET_IDENTIFIER_DELETE: 'ASSET_IDENTIFIER_DELETE',

  // Dashboard
  DASHBOARD_CREATE: 'DASHBOARD_CREATE',
  DASHBOARD_MANAGE: 'DASHBOARD_MANAGE',
  DASHBOARD_VIEW: 'DASHBOARD_VIEW',
  DASHBOARD_ASSIGN: 'DASHBOARD_ASSIGN',

  // (UNS_VIEW + UNS_MANAGE removed with data-ingestion removal.)

  // Checklist
  CHECKLIST_SUBMIT: 'CHECKLIST_SUBMIT',

  // Debug Trace
  READ_DEBUG_TRACE: 'READ_DEBUG_TRACE',
  MANAGE_DEBUG_TRACE: 'MANAGE_DEBUG_TRACE',

  // Filter Operations (Phase 2)
  FILTER_OPERATE: 'FILTER_OPERATE',
  FILTER_BYPASS: 'FILTER_BYPASS',

  // Filter List Page Controls (visibility toggles)
  FILTER_BULK_UPLOAD: 'FILTER_BULK_UPLOAD',
  FILTER_CREATE: 'FILTER_CREATE',
  FILTER_EDIT: 'FILTER_EDIT',
  FILTER_DELETE: 'FILTER_DELETE',
  FILTER_RETIRE: 'FILTER_RETIRE',
  FILTER_REPLACE: 'FILTER_REPLACE',
  FILTER_STATUS_UPDATE: 'FILTER_STATUS_UPDATE',
  // Report exports for the retirement / replacement list pages (PDF + Excel)
  RETIREMENT_LIST_EXPORT: 'RETIREMENT_LIST_EXPORT',
  REPLACEMENT_LIST_EXPORT: 'REPLACEMENT_LIST_EXPORT',
  FILTER_LIST_EXPORT: 'FILTER_LIST_EXPORT',
  FILTER_HIERARCHY_CREATE: 'FILTER_HIERARCHY_CREATE',
  FILTER_HIERARCHY_EDIT: 'FILTER_HIERARCHY_EDIT',
  FILTER_HIERARCHY_DELETE: 'FILTER_HIERARCHY_DELETE',
  FILTER_RFID_MANAGE: 'FILTER_RFID_MANAGE',
  // Replacement Schedule (upload-driven, 2026-06-02). UPLOAD is the one
  // SUPER_ADMIN grants to whichever role may upload schedules.
  REPLACEMENT_SCHEDULE_VIEW: 'REPLACEMENT_SCHEDULE_VIEW',
  REPLACEMENT_SCHEDULE_UPLOAD: 'REPLACEMENT_SCHEDULE_UPLOAD',
  REPLACEMENT_SCHEDULE_REVIEW: 'REPLACEMENT_SCHEDULE_REVIEW',
  REPLACEMENT_SCHEDULE_APPROVE: 'REPLACEMENT_SCHEDULE_APPROVE',

  // Filter Cleaning Profiles (Phase 2)
  FCP_READ: 'FCP_READ',
  FCP_CREATE: 'FCP_CREATE',
  FCP_UPDATE: 'FCP_UPDATE',
  FCP_DELETE: 'FCP_DELETE',

  // Checklist Page Controls
  CHECKLIST_CREATE: 'CHECKLIST_CREATE',
  CHECKLIST_EDIT: 'CHECKLIST_EDIT',
  CHECKLIST_DELETE: 'CHECKLIST_DELETE',
  CHECKLIST_TOGGLE: 'CHECKLIST_TOGGLE',

  // Cleaning Profile Page Controls
  CP_TOGGLE: 'CP_TOGGLE',
  CP_PAGE_CREATE: 'CP_PAGE_CREATE',
  CP_PAGE_EDIT: 'CP_PAGE_EDIT',
  CP_PAGE_DELETE: 'CP_PAGE_DELETE',

  // Equipment Group Page Controls
  EG_VIEW: 'EG_VIEW',
  EG_CREATE: 'EG_CREATE',
  EG_EDIT: 'EG_EDIT',
  EG_DELETE: 'EG_DELETE',

  // Filter Profiles (Phase 2)
  FP_READ: 'FP_READ',
  FP_CREATE: 'FP_CREATE',
  FP_UPDATE: 'FP_UPDATE',
  FP_DELETE: 'FP_DELETE',
  FP_ASSIGN: 'FP_ASSIGN',

  // PM Schedules (Phase 2)
  PM_READ: 'PM_READ',
  PM_CREATE: 'PM_CREATE',
  PM_UPDATE: 'PM_UPDATE',
  PM_DELETE: 'PM_DELETE',
  PM_EXECUTE: 'PM_EXECUTE',
  PM_APPROVE: 'PM_APPROVE',
  PM_REVIEW: 'PM_REVIEW',

  // PM Page Controls
  PM_DOWNLOAD_TEMPLATE: 'PM_DOWNLOAD_TEMPLATE',
  PM_UPLOAD: 'PM_UPLOAD',
  PM_EDIT_ENTRY: 'PM_EDIT_ENTRY',
  PM_RESUBMIT: 'PM_RESUBMIT',

  // Cleaning Cycles (Phase 2)
  CYCLE_READ: 'CYCLE_READ',

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

  // Block Change Requests
  BLOCK_CHANGE_REQUEST: 'BLOCK_CHANGE_REQUEST',
  BLOCK_CHANGE_APPROVE: 'BLOCK_CHANGE_APPROVE',

  // Report PDF export — gate for the cleaning-record + filter-lifecycle PDF
  // export (client-side render). The orphaned reports generate/sign module +
  // its REPORT_TEMPLATE_*/REPORT_VIEW/REPORT_SIGN/REPORT_DELETE perms were
  // removed 2026-07-04; these two survive solely as the export gate.
  REPORT_GENERATE: 'REPORT_GENERATE',
  REPORT_EXPORT: 'REPORT_EXPORT',
  // Report review/approval workflow (2026-06-11)
  REPORT_REVIEW_SUBMIT: 'REPORT_REVIEW_SUBMIT', // send a generated report for review
  REPORT_REVIEW: 'REPORT_REVIEW',               // act on the review (stage 2)
  REPORT_APPROVE: 'REPORT_APPROVE',             // act on the approval (stage 3)
  // Cleaning stage interlock (QA approval after WASH_OUT/DRY_OUT) — 2026-06-12
  STAGE_APPROVAL_VIEW: 'STAGE_APPROVAL_VIEW',     // see the stage approval inbox
  STAGE_APPROVAL_DECIDE: 'STAGE_APPROVAL_DECIDE', // approve/reject a cleaning stage

  // Admin Requests (2026-06-30): two distinct action permissions, no separate review/view
  // level. The page + request details are visible to anyone holding APPROVE or REJECT.
  // (The former single ADMIN_REQUEST_REVIEW perm was removed — it gated everything AND was
  // the sidebar primary, so it could never be revoked while the menu was enabled.)
  ADMIN_REQUEST_APPROVE: 'ADMIN_REQUEST_APPROVE',
  ADMIN_REQUEST_REJECT: 'ADMIN_REQUEST_REJECT',

  // Version History (2026-05-02): cross-entity audit-history viewer for the
  // four versioned entities (CleaningProfile lineage, FilterProfile sidecar,
  // ChecklistProfile sidecar, EquipmentGroup composite sidecar). SUPER_ADMIN
  // only by default; assignable to other roles via Role Privileges config.
  // The four `/api/<entity>/:id/versions` route gates also accept this perm
  // (in addition to the entity-specific read perms) so a user granted ONLY
  // VERSION_HISTORY_VIEW can browse history without entity edit rights.
  VERSION_HISTORY_VIEW: 'VERSION_HISTORY_VIEW',
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
 *   2. `*_VIEW` <- `*_READ` fallback: a route gated on `ASSET_VIEW` is
 *      satisfied by a role with `ASSET_READ` (read-only access).
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
