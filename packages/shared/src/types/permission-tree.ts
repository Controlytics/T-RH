/**
 * PERMISSION_TREE — the single sidebar-anchored permission catalog.
 *
 * Source of truth: tasks/RBAC-SIDEBAR-REDESIGN-ANALYSIS.md §2.
 * Every node whose id exists in FEATURE_PRIVILEGES/FEATURE_TO_PERMISSION_MAP
 * has its label/category/icon and permissions array copied verbatim from those
 * oracles so that deriveFeaturePrivileges() and deriveFeatureToPermissionMap()
 * reproduce them exactly (verified by parity tests 1.2 and 1.3).
 *
 * Phase 1: additive, zero behavior change. Legacy exports are left untouched.
 * Phase 5A: added `gate: Permission[]` and optional `gateRoles?: string[]` to
 *   PermissionNode. The `gate` is the DISCRIMINATING backend permission set
 *   (what requirePermission/requireAnyPermission actually checks) — NOT the
 *   grant-expansion set in `permissions[]`. resolveNodeGate() and
 *   resolveNodeGateRoles() helper functions added.
 * Phase 5E: added `configurable?: boolean` to PermissionNode. The nodes
 *   that appear in FEATURE_PRIVILEGES/FEATURE_TO_PERMISSION_MAP are flagged
 *   `configurable: true`; all others omit the flag (treated as false).
 *   Count: 96 (was 99 — assets.create/edit/delete de-duplicated to enforced-only 2026-06-30).
 *   The three derive functions now select/sort by this flag instead of
 *   importing from the legacy hand-maintained files (which now derive from
 *   this tree). PERMISSION_TREE is the single source of truth.
 */

import type { Permission } from './permissions.js';
import type { ReauthAction } from './reauth-actions.js';
import type { FeaturePrivilege } from './feature-privileges.js';
import type { SidebarSection } from './sidebar-privilege-map.js';

export interface PermissionNode {
  /** Canonical dotted id, e.g. 'users.delete'. Matches a FEATURE_PRIVILEGES id where one exists. */
  id: string;
  /** Human label shown in the admin tree, e.g. 'Delete Users'. */
  label: string;
  /** Owning sidebar item id, e.g. 'users'. */
  sidebarId: string;
  /** Page label for grouping, e.g. 'Users'. */
  page: string;
  /** Action verb, e.g. 'Delete'. */
  action: string;
  /** Icon token (reuse FEATURE_PRIVILEGES icons). */
  icon: string;
  /** Admin-UI category (reuse FEATURE_PRIVILEGES categories so derivation matches). */
  category: string;
  /** Enforced uppercase PERMISSIONS this node grants. Verbatim from FEATURE_TO_PERMISSION_MAP. */
  permissions: Permission[];
  /** Cross-linked step-up action, if any (orthogonal axis). */
  reauthAction?: ReauthAction;
  /** Enforceability: a=enforceable today, b=needs new narrow gate, c=cosmetic-only. */
  enforce: 'a' | 'b' | 'c';
  /**
   * Phase 5A — discriminating backend gate.
   * The PERMISSIONS the backend requirePermission/requireAnyPermission actually
   * checks for this action. useCan() ORs over these vs the user's permissions.
   *
   * Conventions:
   *   • Single requirePermission('X')           → gate: ['X']
   *   • requireAnyPermission('A','B')           → gate: ['A','B']
   *   • requireSuperAdmin() / SA-only           → gate: []  (SA bypass in useCan handles it)
   *   • Role-gated (SA+ADMIN)                   → gate: [] + gateRoles: ['ADMIN']
   *   • cosmetic / ungated (enforce:'c')        → gate = page's VIEW perm
   *   • Theater perm (const exists, no BE route)→ gate = the intended perm constant
   */
  gate: Permission[];
  /**
   * Phase 5A — additional roles that bypass the gate (besides SUPER_ADMIN).
   * Only set when a route uses role-level checks (e.g. requireRole('ADMIN')).
   * Usually omitted; when present, useCan() allows if user.role is in this list.
   */
  gateRoles?: string[];
  /**
   * Phase 5E — marks this node as a configurable feature privilege.
   * When true, this node participates in FEATURE_PRIVILEGES / FEATURE_TO_PERMISSION_MAP
   * derivation. 96 nodes carry this flag (2026-06-30: assets.create/edit/delete dropped).
   * Absent (undefined) means false — node is enforced-only, not user-configurable.
   */
  configurable?: boolean;
}

export interface SidebarGroup {
  sidebarId: string;
  label: string;
  icon: string;
  description: string;
  /**
   * Visibility privilege ids that gate this sidebar item's display.
   * Populated verbatim from SIDEBAR_PRIVILEGE_MAP (the oracle).
   * Many-to-many: the same privilege id may appear in multiple groups.
   */
  visibilityPrivilegeIds: string[];
  nodes: PermissionNode[];
}

export const PERMISSION_TREE: SidebarGroup[] = [
  // ---- Dashboard ----
  {
    sidebarId: 'dashboard', label: 'Dashboard', icon: '🏠',
    description: 'Main dashboard view',
    visibilityPrivilegeIds: [],
    nodes: [
      { id: 'dashboard.view', label: 'View Dashboards', sidebarId: 'dashboard', page: 'Dashboard', action: 'View',
        icon: 'layout', category: 'Dashboards', permissions: ['DASHBOARD_VIEW'], enforce: 'b',
        gate: ['DASHBOARD_VIEW'], configurable: true },
      { id: 'dashboard.create', label: 'Create Dashboards', sidebarId: 'dashboard', page: 'Dashboard', action: 'Create',
        icon: 'plus', category: 'Dashboards', permissions: ['DASHBOARD_CREATE', 'DASHBOARD_VIEW'], enforce: 'b',
        gate: ['DASHBOARD_CREATE'], configurable: true },
      { id: 'dashboard.manage', label: 'Manage Dashboards', sidebarId: 'dashboard', page: 'Dashboard', action: 'Manage',
        icon: 'settings', category: 'Dashboards', permissions: ['DASHBOARD_MANAGE', 'DASHBOARD_VIEW'], enforce: 'c',
        gate: ['DASHBOARD_MANAGE'], configurable: true },
      { id: 'dashboard.assign', label: 'Assign Dashboards', sidebarId: 'dashboard', page: 'Dashboard', action: 'Assign',
        icon: 'link', category: 'Dashboards', permissions: ['DASHBOARD_ASSIGN', 'DASHBOARD_VIEW'], enforce: 'b',
        gate: ['DASHBOARD_ASSIGN'], configurable: true },
    ],
  },

  // ---- Users ----
  {
    sidebarId: 'users', label: 'Users', icon: '👥', description: 'User management',
    visibilityPrivilegeIds: ['users.view', 'users.create', 'users.edit', 'users.delete', 'users.reset_password', 'users.unlock', 'users.enable_disable'],
    nodes: [
      { id: 'users.view', label: 'View Users', sidebarId: 'users', page: 'Users', action: 'View',
        icon: 'user', category: 'User Management', permissions: ['USER_READ'], enforce: 'a',
        gate: ['USER_READ'], configurable: true },
      { id: 'users.create', label: 'Create Users', sidebarId: 'users', page: 'Users', action: 'Add',
        icon: 'user-plus', category: 'User Management', permissions: ['USER_CREATE', 'USER_READ'], enforce: 'a',
        gate: ['USER_CREATE'], configurable: true },
      { id: 'users.edit', label: 'Edit Users', sidebarId: 'users', page: 'Users', action: 'Edit',
        icon: 'user-edit', category: 'User Management', permissions: ['USER_UPDATE', 'USER_READ'], enforce: 'a',
        gate: ['USER_UPDATE'], configurable: true },
      { id: 'users.delete', label: 'Delete Users', sidebarId: 'users', page: 'Users', action: 'Delete',
        icon: 'user-minus', category: 'User Management', permissions: ['USER_DELETE', 'USER_READ'],
        reauthAction: 'DELETE_USER', enforce: 'b',
        gate: [], configurable: true },
      { id: 'users.enable_disable', label: 'Enable/Disable Accounts', sidebarId: 'users', page: 'Users', action: 'Enable/Disable',
        icon: 'toggle', category: 'User Management', permissions: ['USER_ENABLE_DISABLE', 'USER_READ'], enforce: 'a',
        gate: ['USER_ENABLE_DISABLE'], configurable: true },
      { id: 'users.unlock', label: 'Unlock Accounts', sidebarId: 'users', page: 'Users', action: 'Unlock',
        icon: 'unlock', category: 'User Management', permissions: ['USER_UNLOCK', 'USER_READ'], enforce: 'a',
        gate: ['USER_UNLOCK'], configurable: true },
      { id: 'users.reset_password', label: 'Reset Passwords', sidebarId: 'users', page: 'Users', action: 'Reset Password',
        icon: 'key', category: 'User Management', permissions: ['USER_RESET_PASSWORD', 'USER_READ'], enforce: 'a',
        gate: ['USER_RESET_PASSWORD'], configurable: true },
    ],
  },

  // ---- Admin Requests ----
  {
    sidebarId: 'admin-requests', label: 'Admin Requests', icon: '📋',
    description: 'Review and process user requests',
    // 2026-06-30: 2 action perms only (no view/review level). Menu visible if either; the
    // sidebar item does NOT auto-grant (see config.service primaryPermsForSidebarItem special-case)
    // so APPROVE/REJECT stay independently revocable.
    visibilityPrivilegeIds: ['admin_requests.approve', 'admin_requests.reject'],
    nodes: [
      { id: 'admin_requests.approve', label: 'Approve Admin Requests', sidebarId: 'admin-requests', page: 'Admin Requests', action: 'Approve',
        icon: 'check-circle', category: 'User Management', permissions: ['ADMIN_REQUEST_APPROVE'],
        reauthAction: 'APPROVE_ADMIN_REQUEST', enforce: 'a',
        gate: ['ADMIN_REQUEST_APPROVE'], configurable: true },
      { id: 'admin_requests.reject', label: 'Reject Admin Requests', sidebarId: 'admin-requests', page: 'Admin Requests', action: 'Reject',
        icon: 'x-circle', category: 'User Management', permissions: ['ADMIN_REQUEST_REJECT'],
        reauthAction: 'APPROVE_ADMIN_REQUEST', enforce: 'a',
        gate: ['ADMIN_REQUEST_REJECT'], configurable: true },
    ],
  },

  // ---- Configuration ----
  {
    sidebarId: 'configuration', label: 'Configuration', icon: '⚙️', description: 'System settings',
    visibilityPrivilegeIds: ['config.view', 'config.edit'],
    nodes: [
      { id: 'config.view', label: 'View Configuration', sidebarId: 'configuration', page: 'Configuration', action: 'View',
        icon: 'settings', category: 'System', permissions: ['CONFIG_READ'], enforce: 'a',
        gate: ['CONFIG_READ'], configurable: true },
      { id: 'config.edit', label: 'Edit Configuration', sidebarId: 'configuration', page: 'Configuration', action: 'Edit',
        icon: 'settings-edit', category: 'System', permissions: ['CONFIG_UPDATE', 'CONFIG_READ'], enforce: 'a',
        gate: ['CONFIG_UPDATE'], configurable: true },
      { id: 'config.field_ids', label: 'Update Field Labels', sidebarId: 'configuration', page: 'Configuration', action: 'Edit Field Labels',
        icon: 'tag', category: 'System', permissions: ['FIELD_ID_UPDATE', 'CONFIG_READ'], enforce: 'a',
        gate: ['FIELD_ID_UPDATE'], configurable: true },
      { id: 'roles.manage', label: 'Manage Roles', sidebarId: 'configuration', page: 'Roles & Access', action: 'Manage',
        icon: 'shield', category: 'System', permissions: ['ROLE_MANAGE'], enforce: 'a',
        gate: ['ROLE_MANAGE'], configurable: true },
      { id: 'backup.export', label: 'Export / Download Backups', sidebarId: 'configuration', page: 'Backup & Restore', action: 'Export',
        icon: 'download', category: 'Backup & Restore', permissions: ['BACKUP_EXPORT'],
        reauthAction: 'EXPORT_BACKUP', enforce: 'a',
        gate: ['BACKUP_EXPORT'], configurable: true },
      { id: 'backup.restore', label: 'Restore from Backup', sidebarId: 'configuration', page: 'Backup & Restore', action: 'Restore',
        icon: 'upload', category: 'Backup & Restore', permissions: ['BACKUP_RESTORE'],
        reauthAction: 'RESTORE_BACKUP', enforce: 'a',
        gate: ['BACKUP_RESTORE'], configurable: true },
      // Enforced-only: fine-grained role-management actions (analysis §2.4)
      { id: 'roles.view', label: 'View Roles', sidebarId: 'configuration', page: 'Roles & Access', action: 'View',
        icon: 'shield', category: 'System', permissions: ['ROLE_MANAGE'], enforce: 'a',
        gate: ['ROLE_MANAGE'] },
      { id: 'roles.create', label: 'Create Role', sidebarId: 'configuration', page: 'Roles & Access', action: 'Create',
        icon: 'plus', category: 'System', permissions: ['ROLE_MANAGE'],
        reauthAction: 'CREATE_ROLE', enforce: 'a',
        gate: ['ROLE_MANAGE'] },
      { id: 'roles.edit', label: 'Edit Role', sidebarId: 'configuration', page: 'Roles & Access', action: 'Edit',
        icon: 'edit', category: 'System', permissions: ['ROLE_MANAGE'],
        reauthAction: 'UPDATE_ROLE', enforce: 'a',
        gate: ['ROLE_MANAGE'] },
      { id: 'roles.delete', label: 'Delete Role', sidebarId: 'configuration', page: 'Roles & Access', action: 'Delete',
        icon: 'trash', category: 'System', permissions: ['ROLE_MANAGE'],
        reauthAction: 'DELETE_ROLE', enforce: 'a',
        gate: ['ROLE_MANAGE'] },
      { id: 'roles.assign_permissions', label: 'Assign Permissions to Role', sidebarId: 'configuration', page: 'Roles & Access', action: 'Assign Permissions',
        icon: 'key', category: 'System', permissions: ['CONFIG_UPDATE'], enforce: 'b',
        gate: ['ROLE_MANAGE'] },
      { id: 'roles.configure_sidebar', label: 'Configure Role Sidebar', sidebarId: 'configuration', page: 'Roles & Access', action: 'Configure Sidebar',
        icon: 'layout', category: 'System', permissions: ['CONFIG_UPDATE'], enforce: 'b',
        gate: ['ROLE_MANAGE'] },
      { id: 'roles.configure_reauth', label: 'Configure Role Re-auth', sidebarId: 'configuration', page: 'Roles & Access', action: 'Configure Re-auth',
        icon: 'lock', category: 'System', permissions: ['CONFIG_UPDATE'], enforce: 'b',
        gate: ['ROLE_MANAGE'] },
    ],
  },

  // ---- Notifications ----
  {
    sidebarId: 'notifications', label: 'Notifications', icon: '🔔', description: 'Notification center',
    visibilityPrivilegeIds: ['notifications.view', 'notifications.manage', 'notifications.delete'],
    nodes: [
      { id: 'notifications.view', label: 'View Notifications', sidebarId: 'notifications', page: 'Notifications', action: 'View',
        // 2026-07-01: enforce 'a'->'c' — NOTIFICATION_VIEW is enforced by NO route (notification endpoints are
        // user-scoped/auth-only; delete is SUPER_ADMIN-only). This toggle is visibility-only (gates the sidebar item).
        icon: 'bell', category: 'System', permissions: ['NOTIFICATION_VIEW'], enforce: 'c',
        gate: ['NOTIFICATION_VIEW'], configurable: true },
      // 2026-07-01: notifications.manage removed from the picker (enforced-only) per user request.
      // NOTIFICATION_MANAGE is enforced by no route (notification endpoints are user-scoped/auth-only).
      { id: 'notifications.manage', label: 'Manage Notifications', sidebarId: 'notifications', page: 'Notifications', action: 'Manage',
        icon: 'bell', category: 'System',
        permissions: ['NOTIFICATION_MANAGE', 'NOTIFICATION_CREATE', 'NOTIFICATION_UPDATE', 'NOTIFICATION_DELETE', 'NOTIFICATION_VIEW'],
        enforce: 'c',
        gate: ['NOTIFICATION_MANAGE'] },
      // 2026-07-01: NOTIFICATION_DELETE is now a real grantable perm (was SUPER_ADMIN-only). gate = ['NOTIFICATION_DELETE']
      // so enabling this toggle actually shows the delete button; backend delete routes now requirePermission('NOTIFICATION_DELETE').
      { id: 'notifications.delete', label: 'Delete Notifications', sidebarId: 'notifications', page: 'Notifications', action: 'Delete',
        icon: 'bell', category: 'System', permissions: ['NOTIFICATION_DELETE'], enforce: 'a',
        gate: ['NOTIFICATION_DELETE'], configurable: true },
      { id: 'notifications.mark', label: 'Mark Notifications Read/Unread', sidebarId: 'notifications', page: 'Notifications', action: 'Mark Read',
        icon: 'check', category: 'System', permissions: ['NOTIFICATION_UPDATE'], enforce: 'c',
        gate: ['NOTIFICATION_VIEW'] },
    ],
  },

  // ---- Audit Trail ----
  {
    sidebarId: 'audit', label: 'Audit Trail', icon: '📝', description: 'Activity logs',
    visibilityPrivilegeIds: ['audit.view', 'audit.export'],
    nodes: [
      { id: 'audit.view', label: 'View Audit Trail', sidebarId: 'audit', page: 'Audit', action: 'View',
        icon: 'clipboard', category: 'System', permissions: ['AUDIT_READ'], enforce: 'a',
        gate: ['AUDIT_READ'], configurable: true },
      { id: 'audit.export', label: 'Export Audit Trail', sidebarId: 'audit', page: 'Audit', action: 'Export',
        icon: 'clipboard', category: 'System', permissions: ['AUDIT_EXPORT', 'AUDIT_READ'], enforce: 'c',
        gate: ['AUDIT_EXPORT'], configurable: true }, // 5C fix: gate on the dedicated export perm (UI gates on AUDIT_EXPORT); page-view perm would loosen export to any audit viewer
      // Enforced-only: audit administration
      { id: 'audit.redact', label: 'Redact Audit Record', sidebarId: 'audit', page: 'Audit', action: 'Redact',
        icon: 'slash', category: 'System', permissions: [],
        reauthAction: 'REDACT_AUDIT_RECORD', enforce: 'a',
        gate: [] },
      // 2026-07-01: PHYSICAL hard-delete (grantable picker toggle). WARNING: unlike
      // redact, deletion BREAKS the tamper-evident hash chain — verify-chain reports
      // the downstream chain invalid, permanently. Grant-set includes AUDIT_READ (must
      // see the page to delete). gate = the discriminating AUDIT_DELETE backend perm.
      { id: 'audit.delete', label: 'Delete Audit Record (permanent)', sidebarId: 'audit', page: 'Audit', action: 'Delete',
        icon: 'trash', category: 'System', permissions: ['AUDIT_DELETE', 'AUDIT_READ'],
        reauthAction: 'DELETE_AUDIT_RECORD', enforce: 'a',
        gate: ['AUDIT_DELETE'], configurable: true },
      { id: 'audit.verify_chain', label: 'Verify Hash Chain', sidebarId: 'audit', page: 'Audit', action: 'Verify Chain',
        icon: 'shield', category: 'System', permissions: [], enforce: 'a',
        gate: [] },
      // Enforced-only: report review workflow (folded here; no separate sidebar entry in oracle)
      { id: 'report_reviews.view', label: 'View Report Reviews', sidebarId: 'audit', page: 'Report Reviews', action: 'View',
        icon: 'eye', category: 'Reports', permissions: ['REPORT_REVIEW', 'REPORT_APPROVE'], enforce: 'b',
        gate: ['REPORT_REVIEW_SUBMIT', 'REPORT_REVIEW', 'REPORT_APPROVE'] },
      { id: 'report_reviews.review', label: 'Review Report', sidebarId: 'audit', page: 'Report Reviews', action: 'Review',
        icon: 'clipboard-check', category: 'Reports', permissions: ['REPORT_REVIEW'],
        reauthAction: 'REVIEW_REPORT', enforce: 'a',
        gate: ['REPORT_REVIEW'] },
      { id: 'report_reviews.approve', label: 'Approve Report', sidebarId: 'audit', page: 'Report Reviews', action: 'Approve',
        icon: 'check-circle', category: 'Reports', permissions: ['REPORT_APPROVE'],
        reauthAction: 'APPROVE_REPORT', enforce: 'a',
        gate: ['REPORT_APPROVE'] },
      { id: 'report_reviews.reject', label: 'Reject Report', sidebarId: 'audit', page: 'Report Reviews', action: 'Reject',
        icon: 'x-circle', category: 'Reports', permissions: ['REPORT_REVIEW', 'REPORT_APPROVE'], enforce: 'a',
        // 5C fix: reject is valid in BOTH stages — REVIEW-stage reject runs under REPORT_REVIEW
        // (POST /review action:reject), APPROVAL-stage under REPORT_APPROVE (POST /approve).
        gate: ['REPORT_REVIEW', 'REPORT_APPROVE'] },
    ],
  },

  // ---- System Health ----
  {
    sidebarId: 'system-health', label: 'System Health', icon: '📊', description: 'System health monitoring',
    visibilityPrivilegeIds: [],
    nodes: [
      { id: 'system_health.view', label: 'View System Health', sidebarId: 'system-health', page: 'System Health', action: 'View',
        icon: 'activity', category: 'System', permissions: [], enforce: 'b',
        gate: [], gateRoles: ['ADMIN'] },
    ],
  },

  // ---- Debug Traces ----
  {
    sidebarId: 'debug-traces', label: 'Debug Traces', icon: '🐛', description: 'Pipeline debug traces',
    visibilityPrivilegeIds: ['debug.view', 'debug.manage'],
    nodes: [
      { id: 'debug.view', label: 'View Debug Traces', sidebarId: 'debug-traces', page: 'Debug Traces', action: 'View',
        icon: 'terminal', category: 'Debug Traces', permissions: ['READ_DEBUG_TRACE'], enforce: 'a',
        gate: ['READ_DEBUG_TRACE'], configurable: true },
      { id: 'debug.manage', label: 'Manage Debug Traces', sidebarId: 'debug-traces', page: 'Debug Traces', action: 'Manage',
        icon: 'terminal', category: 'Debug Traces', permissions: ['MANAGE_DEBUG_TRACE'], enforce: 'a',
        gate: ['MANAGE_DEBUG_TRACE'], configurable: true },
    ],
  },

  // ---- Filter List ----
  {
    sidebarId: 'filter-list', label: 'Filters', icon: '🔍', description: 'Filter inventory by block',
    visibilityPrivilegeIds: ['assets.view', 'filters.operate', 'filters.events', 'filters.bulk_upload', 'filters.retire', 'filters.replace', 'filters.status_update', 'filters.hierarchy_create', 'filters.rfid_manage'],
    nodes: [
      // Asset / Filter viewing
      { id: 'assets.view', label: 'View Filters', sidebarId: 'filter-list', page: 'Filters', action: 'View',
        icon: 'eye', category: 'Asset Management', permissions: ['ASSET_VIEW', 'ASSET_READ'], enforce: 'b',
        gate: ['ASSET_VIEW'], configurable: true },
      // 2026-06-30: assets.create/edit/delete are DE-DUPLICATED out of the role-config
      // picker (configurable dropped → enforced-only). They were generic-asset toggles
      // that duplicated the filter-specific Create/Edit/Delete Filters + Block/Area/AHU
      // toggles — same capability under different names, because the backend create/edit/
      // delete endpoints accept ASSET_* OR FILTER_*/FILTER_HIERARCHY_* (requireAnyPermission).
      // The ASSET_CREATE/UPDATE/DELETE *perms* are KEPT as constants (still granted in
      // default roles + live DB, still accepted as backend alternates via requireAnyPermission).
      // **2026-07-01 UPDATE:** ASSET_* was REMOVED from the grant-expansion of
      // filters.hierarchy_create / filters.bulk_upload / filters.status_update /
      // equipment_groups.* — it was a broad over-grant that leaked edit/create/delete across
      // the Filters page via useCan (e.g. granting "Update Filter Status" handed out ASSET_UPDATE,
      // which satisfies the filters.edit / hierarchy_edit gates). ASSET_* now appears in NO
      // configurable grant-set, so it has LEFT allMappedPerms and is manual-managed (edit/create
      // is granted via the FILTER_* toggles). Existing roles' ASSET_* is preserved on re-save.
      // Nodes retained for gate/reauth resolution; only their picker visibility is removed.
      // See tasks/ASSET-FILTER-PERM-CONSOLIDATION-PLAN.md + CHANGELOG 2026-07-01.
      { id: 'assets.create', label: 'Create Assets', sidebarId: 'filter-list', page: 'Filters', action: 'Create Asset',
        icon: 'plus', category: 'Asset Management', permissions: ['ASSET_CREATE', 'ASSET_VIEW', 'ASSET_READ'],
        reauthAction: 'CREATE_ASSET', enforce: 'b',
        gate: ['ASSET_CREATE', 'FILTER_CREATE', 'FILTER_HIERARCHY_CREATE'] },
      { id: 'assets.edit', label: 'Edit Assets', sidebarId: 'filter-list', page: 'Filters', action: 'Edit Asset',
        icon: 'edit', category: 'Asset Management', permissions: ['ASSET_UPDATE', 'ASSET_VIEW', 'ASSET_READ'],
        reauthAction: 'UPDATE_ASSET', enforce: 'b',
        gate: ['ASSET_UPDATE', 'FILTER_EDIT', 'FILTER_HIERARCHY_EDIT'] },
      { id: 'assets.delete', label: 'Delete Assets', sidebarId: 'filter-list', page: 'Filters', action: 'Delete Asset',
        icon: 'trash', category: 'Asset Management', permissions: ['ASSET_DELETE', 'ASSET_VIEW', 'ASSET_READ'],
        reauthAction: 'DELETE_ASSET', enforce: 'b',
        gate: ['ASSET_DELETE', 'FILTER_DELETE', 'FILTER_HIERARCHY_DELETE'] },
      // 2026-07-01: RFID identifier toggles (assets.identifiers.create/delete) DE-DUPLICATED to
      // enforced-only — RFID assign/unassign is fully covered by the single filters.rfid_manage
      // toggle (both identifier endpoints accept FILTER_RFID_MANAGE via requireAnyPermission).
      // Perm constants KEPT (ASSET_IDENTIFIER_* are real route gates).
      // assets.relationships.create/delete nodes + the ASSET_RELATIONSHIP_CREATE/DELETE perm
      // constants were REMOVED ENTIRELY 2026-07-01 — those were grant-only perms never used as a
      // route gate; the relationship write capability IS the edit gate (ASSET_UPDATE/FILTER_EDIT/
      // FILTER_HIERARCHY_EDIT on PUT-instance, i.e. the assets.edit node).
      { id: 'assets.identifiers.create', label: 'Assign RFID Tags / Create Identifiers', sidebarId: 'filter-list', page: 'Filters', action: 'Assign RFID',
        icon: 'wifi', category: 'RFID & Identifiers', permissions: ['ASSET_IDENTIFIER_CREATE', 'ASSET_VIEW'],
        reauthAction: 'CREATE_ASSET_IDENTIFIER', enforce: 'a',
        gate: ['ASSET_IDENTIFIER_CREATE', 'FILTER_RFID_MANAGE'] },
      { id: 'assets.identifiers.delete', label: 'Unassign RFID Tags / Delete Identifiers', sidebarId: 'filter-list', page: 'Filters', action: 'Unassign RFID',
        icon: 'wifi', category: 'RFID & Identifiers', permissions: ['ASSET_IDENTIFIER_DELETE', 'ASSET_VIEW'],
        reauthAction: 'DELETE_ASSET_IDENTIFIER', enforce: 'a',
        gate: ['ASSET_IDENTIFIER_DELETE', 'FILTER_RFID_MANAGE'] },
      // Filter-specific page controls
      { id: 'filters.bulk_upload', label: 'Bulk Upload Filters', sidebarId: 'filter-list', page: 'Filters', action: 'Bulk Upload',
        icon: 'upload', category: 'Filters Page Controls', permissions: ['FILTER_BULK_UPLOAD'], // 2026-07-01: dropped ASSET_CREATE over-grant (leaked "create filters" via useCan; endpoint gates on FILTER_BULK_UPLOAD)
        reauthAction: 'BULK_UPLOAD_FILTERS', enforce: 'a',
        // 5C: per-action UI intent (old FE gated bulk-upload on FILTER_BULK_UPLOAD only).
        // Shared create endpoint also accepts ASSET_CREATE — residual API-looseness, not UI.
        gate: ['FILTER_BULK_UPLOAD'], configurable: true },
      { id: 'filters.retire', label: 'Retire Filters', sidebarId: 'filter-list', page: 'Filters', action: 'Retire',
        icon: 'archive', category: 'Filters Page Controls', permissions: ['FILTER_RETIRE', 'FILTER_OPERATE', 'ASSET_READ'],
        reauthAction: 'RETIRE_FILTER', enforce: 'a',
        gate: ['FILTER_RETIRE'], configurable: true },
      { id: 'filters.replace', label: 'Replace Filters', sidebarId: 'filter-list', page: 'Filters', action: 'Replace',
        icon: 'refresh', category: 'Filters Page Controls', permissions: ['FILTER_REPLACE', 'FILTER_OPERATE', 'ASSET_READ'],
        reauthAction: 'REPLACE_FILTER', enforce: 'a',
        gate: ['FILTER_REPLACE'], configurable: true },
      { id: 'filters.status_update', label: 'Update Filter Status', sidebarId: 'filter-list', page: 'Filters', action: 'Update Status',
        icon: 'edit', category: 'Filters Page Controls', permissions: ['FILTER_STATUS_UPDATE', 'ASSET_READ'], // 2026-07-01: dropped ASSET_UPDATE over-grant (leaked edit-everywhere via useCan; endpoint gates on FILTER_STATUS_UPDATE)
        reauthAction: 'UPDATE_FILTER_LIFECYCLE', enforce: 'a',
        gate: ['FILTER_STATUS_UPDATE'], configurable: true },
      { id: 'filters.hierarchy_create', label: 'Create Block / Area / AHU', sidebarId: 'filter-list', page: 'Filters', action: 'Create Hierarchy',
        icon: 'plus', category: 'Filters Page Controls', permissions: ['FILTER_HIERARCHY_CREATE', 'ASSET_READ'], enforce: 'a', // 2026-07-01: dropped ASSET_CREATE over-grant
        // 5C: per-action UI intent (old FE gated block/area/AHU create on FILTER_HIERARCHY_CREATE).
        gate: ['FILTER_HIERARCHY_CREATE'], configurable: true },
      { id: 'filters.create', label: 'Create Filters', sidebarId: 'filter-list', page: 'Filters', action: 'Create',
        icon: 'plus', category: 'Filters Page Controls', permissions: ['FILTER_CREATE', 'ASSET_READ'],
        reauthAction: 'CREATE_FILTER', enforce: 'a',
        gate: ['FILTER_CREATE'], configurable: true }, // 2026-07-01: dropped ASSET_CREATE alt so broad asset perms don't unlock "create filters"
      { id: 'filters.edit', label: 'Edit Filters', sidebarId: 'filter-list', page: 'Filters', action: 'Edit',
        icon: 'edit', category: 'Filters Page Controls', permissions: ['FILTER_EDIT', 'ASSET_READ'],
        reauthAction: 'EDIT_FILTER', enforce: 'a',
        gate: ['FILTER_EDIT'], configurable: true }, // 2026-07-01: dropped ASSET_UPDATE alt so broad asset perms (e.g. via Update Filter Status) don't unlock "edit filters"
      { id: 'filters.delete', label: 'Delete Filters', sidebarId: 'filter-list', page: 'Filters', action: 'Delete',
        icon: 'trash', category: 'Filters Page Controls', permissions: ['FILTER_DELETE', 'ASSET_READ'],
        reauthAction: 'DELETE_FILTER', enforce: 'a',
        gate: ['FILTER_DELETE'], configurable: true }, // 2026-07-01: dropped ASSET_DELETE alt
      { id: 'filters.hierarchy_edit', label: 'Edit Block / Area / AHU', sidebarId: 'filter-list', page: 'Filters', action: 'Edit Hierarchy',
        icon: 'edit', category: 'Filters Page Controls', permissions: ['FILTER_HIERARCHY_EDIT', 'ASSET_READ'],
        reauthAction: 'EDIT_HIERARCHY_NODE', enforce: 'a',
        gate: ['FILTER_HIERARCHY_EDIT'], configurable: true }, // 2026-07-01: dropped ASSET_UPDATE alt so broad asset perms don't unlock "edit block/area/AHU"
      { id: 'filters.hierarchy_delete', label: 'Delete Block / Area / AHU', sidebarId: 'filter-list', page: 'Filters', action: 'Delete Hierarchy',
        icon: 'trash', category: 'Filters Page Controls', permissions: ['FILTER_HIERARCHY_DELETE', 'ASSET_READ'],
        reauthAction: 'DELETE_HIERARCHY_NODE', enforce: 'a',
        gate: ['FILTER_HIERARCHY_DELETE'], configurable: true }, // 2026-07-01: dropped ASSET_DELETE alt
      // 2026-07-02: filters.rfid_manage made configurable AGAIN (re-added to the role-config picker).
      // Reverses the 2026-07-01 enforced-only decision: with the toggle gone, only SUPER_ADMIN (and
      // OPERATOR via a leftover ASSET_IDENTIFIER_CREATE grant) could assign RFID — every other role got
      // 403 on the tablet RFID-assign page with no UI way to grant it. Enabling this toggle grants
      // FILTER_RFID_MANAGE (satisfies the assign/unassign endpoint gate).
      { id: 'filters.rfid_manage', label: 'Assign / Unassign RFID Tags', sidebarId: 'filter-list', page: 'Filters', action: 'Manage RFID',
        icon: 'wifi', category: 'Filters Page Controls', permissions: ['FILTER_RFID_MANAGE', 'ASSET_IDENTIFIER_CREATE', 'ASSET_IDENTIFIER_DELETE', 'ASSET_READ'], enforce: 'a',
        gate: ['FILTER_RFID_MANAGE'], configurable: true },
      // 2026-07-01: hide/unhide the Filters-page Export (PDF/Excel) menu. enforce:'c' = frontend-only gate
      // (export happens client-side; no backend route). Mirrors retirement_list.export.
      { id: 'filters.export', label: 'Export Filter List (PDF / Excel)', sidebarId: 'filter-list', page: 'Filters', action: 'Export',
        icon: 'download', category: 'Filters Page Controls', permissions: ['FILTER_LIST_EXPORT'], enforce: 'c',
        gate: ['FILTER_LIST_EXPORT'], configurable: true },
    ],
  },

  // ---- Filter Retirements ----
  {
    sidebarId: 'filter-retirements', label: 'Retirement List', icon: '🚫', description: 'Retired filter inventory',
    visibilityPrivilegeIds: ['assets.view'],
    nodes: [
      { id: 'retirement_list.export', label: 'Export Retirement List Report (PDF / Excel)', sidebarId: 'filter-retirements', page: 'Retirement List', action: 'Export',
        icon: 'download', category: 'Filters Page Controls', permissions: ['RETIREMENT_LIST_EXPORT'], enforce: 'c',
        gate: ['RETIREMENT_LIST_EXPORT'], configurable: true }, // 5C fix: UI gates on RETIREMENT_LIST_EXPORT; page-view perm would loosen
      { id: 'retirement.view', label: 'View Retired Filters', sidebarId: 'filter-retirements', page: 'Retirement List', action: 'View',
        icon: 'eye', category: 'Asset Management', permissions: ['ASSET_VIEW', 'ASSET_READ'], enforce: 'b',
        gate: ['ASSET_READ'] },
    ],
  },

  // ---- RFID Track Record ----
  {
    sidebarId: 'rfid-track-record', label: 'RFID Track Record', icon: '📡',
    description: 'RFID assign / remove lifecycle history',
    visibilityPrivilegeIds: ['assets.view', 'filters.rfid_manage'],
    nodes: [
      { id: 'rfid_track.view', label: 'View RFID Track Record', sidebarId: 'rfid-track-record', page: 'RFID Track Record', action: 'View',
        icon: 'radio', category: 'RFID & Identifiers', permissions: ['FILTER_RFID_MANAGE', 'ASSET_VIEW'], enforce: 'b',
        gate: ['ASSET_VIEW', 'FILTER_RFID_MANAGE'] },
      { id: 'rfid_track.export', label: 'Export RFID Track Record', sidebarId: 'rfid-track-record', page: 'RFID Track Record', action: 'Export',
        icon: 'download', category: 'RFID & Identifiers', permissions: [], enforce: 'c',
        gate: ['ASSET_VIEW', 'FILTER_RFID_MANAGE'] },
    ],
  },

  // ---- Filter Replacements ----
  {
    sidebarId: 'filter-replacements', label: 'Replacement List', icon: '🔄',
    description: 'Filter replacement history + schedule (List | Schedule tabs)',
    visibilityPrivilegeIds: ['assets.view', 'replacement_schedule.view', 'replacement_schedule.upload', 'replacement_schedule.review', 'replacement_schedule.approve'],
    nodes: [
      { id: 'replacement_list.export', label: 'Export Replacement List Report (PDF / Excel)', sidebarId: 'filter-replacements', page: 'Replacement List', action: 'Export',
        icon: 'download', category: 'Filters Page Controls', permissions: ['REPLACEMENT_LIST_EXPORT'], enforce: 'c',
        gate: ['REPLACEMENT_LIST_EXPORT'], configurable: true }, // 5C fix: UI gates on REPLACEMENT_LIST_EXPORT; page-view perm would loosen
      { id: 'replacement_schedule.view', label: 'View Replacement Schedule', sidebarId: 'filter-replacements', page: 'Replacement List', action: 'View Schedule',
        icon: 'calendar', category: 'Filters Page Controls', permissions: ['REPLACEMENT_SCHEDULE_VIEW', 'REPLACEMENT_SCHEDULE_UPLOAD'], enforce: 'a',
        gate: ['REPLACEMENT_SCHEDULE_VIEW'], configurable: true },
      { id: 'replacement_schedule.upload', label: 'Upload Replacement Schedule', sidebarId: 'filter-replacements', page: 'Replacement List', action: 'Upload',
        icon: 'upload', category: 'Filters Page Controls', permissions: ['REPLACEMENT_SCHEDULE_UPLOAD'], enforce: 'a',
        gate: ['REPLACEMENT_SCHEDULE_UPLOAD'], configurable: true },
      { id: 'replacement_schedule.review', label: 'Review Replacement Schedule', sidebarId: 'filter-replacements', page: 'Replacement List', action: 'Review',
        icon: 'clipboard-check', category: 'Filters Page Controls', permissions: ['REPLACEMENT_SCHEDULE_REVIEW', 'REPLACEMENT_SCHEDULE_VIEW'],
        reauthAction: 'REVIEW_REPLACEMENT_SCHEDULE', enforce: 'a',
        gate: ['REPLACEMENT_SCHEDULE_REVIEW'], configurable: true },
      { id: 'replacement_schedule.approve', label: 'Approve Replacement Schedule', sidebarId: 'filter-replacements', page: 'Replacement List', action: 'Approve',
        icon: 'check-circle', category: 'Filters Page Controls', permissions: ['REPLACEMENT_SCHEDULE_APPROVE', 'REPLACEMENT_SCHEDULE_VIEW'],
        reauthAction: 'APPROVE_REPLACEMENT_SCHEDULE', enforce: 'a',
        gate: ['REPLACEMENT_SCHEDULE_APPROVE'], configurable: true },
      { id: 'replacement.view', label: 'View Replacement History', sidebarId: 'filter-replacements', page: 'Replacement List', action: 'View',
        icon: 'eye', category: 'Asset Management', permissions: ['ASSET_VIEW', 'ASSET_READ'], enforce: 'b',
        gate: ['ASSET_READ'] },
    ],
  },

  // ---- Filter Operations ----
  {
    sidebarId: 'filter-operations', label: 'Filter Operations', icon: '🔧',
    description: 'Filter cleaning operations',
    visibilityPrivilegeIds: ['filters.operate', 'filters.bypass', 'filters.events', 'checklists.submit'],
    nodes: [
      { id: 'filters.operate', label: 'Operate Filters (Start/Advance Cycles)', sidebarId: 'filter-operations', page: 'Filter Operations', action: 'Operate',
        icon: 'filter', category: 'Filter Management', permissions: ['FILTER_OPERATE', 'ASSET_READ'], enforce: 'a',
        gate: ['FILTER_OPERATE'], configurable: true },
      { id: 'filters.bypass', label: 'Bypass Filter Stages (Deviation)', sidebarId: 'filter-operations', page: 'Filter Operations', action: 'Bypass',
        icon: 'alert-circle', category: 'Filter Management', permissions: ['FILTER_BYPASS', 'ASSET_READ'], enforce: 'a',
        gate: ['FILTER_BYPASS'], configurable: true },
      { id: 'filters.events', label: 'View Filter Events', sidebarId: 'filter-operations', page: 'Filter Operations', action: 'View Events',
        icon: 'list', category: 'Filter Management', permissions: ['EVENT_READ', 'ASSET_READ'], enforce: 'a',
        gate: ['EVENT_READ'], configurable: true },
      // Enforced-only: granular cycle actions (analysis §2.1)
      { id: 'operations.start', label: 'Start Cleaning Cycle', sidebarId: 'filter-operations', page: 'Filter Operations', action: 'Start Cycle',
        icon: 'play', category: 'Filter Management', permissions: ['FILTER_OPERATE'],
        reauthAction: 'START_CLEANING_CYCLE', enforce: 'a',
        gate: ['FILTER_OPERATE'] },
      { id: 'operations.advance', label: 'Advance Filter Stage', sidebarId: 'filter-operations', page: 'Filter Operations', action: 'Advance Stage',
        icon: 'chevron-right', category: 'Filter Management', permissions: ['FILTER_OPERATE'],
        reauthAction: 'ADVANCE_FILTER_STAGE', enforce: 'a',
        gate: ['FILTER_OPERATE'] },
      { id: 'operations.submit_checklist', label: 'Submit Checklist (with Signature)', sidebarId: 'filter-operations', page: 'Filter Operations', action: 'Submit Checklist',
        icon: 'clipboard-check', category: 'Filter Management', permissions: ['FILTER_OPERATE', 'CHECKLIST_SUBMIT'],
        reauthAction: 'SUBMIT_CHECKLIST_WITH_SIGNATURE', enforce: 'a',
        gate: ['FILTER_OPERATE'] },
      { id: 'operations.bypass', label: 'Bypass Stage (Deviation)', sidebarId: 'filter-operations', page: 'Filter Operations', action: 'Bypass Stage',
        icon: 'alert-triangle', category: 'Filter Management', permissions: ['FILTER_BYPASS'],
        reauthAction: 'BYPASS_FILTER_STAGE', enforce: 'a',
        gate: ['FILTER_BYPASS'] },
      { id: 'operations.terminate', label: 'Terminate Cleaning Cycle', sidebarId: 'filter-operations', page: 'Filter Operations', action: 'Terminate',
        icon: 'x', category: 'Filter Management', permissions: ['FILTER_BYPASS'],
        reauthAction: 'TERMINATE_CLEANING_CYCLE', enforce: 'b',
        gate: ['FILTER_BYPASS'] },
    ],
  },

  // ---- Cleaning Cycles (Filter Cleaning Record) ----
  {
    sidebarId: 'cleaning-cycles', label: 'Filter Cleaning Record', icon: '🔄',
    description: 'Cleaning cycle history and timeline',
    visibilityPrivilegeIds: ['cycles.view'],
    nodes: [
      { id: 'cycles.view', label: 'View Cleaning Cycles', sidebarId: 'cleaning-cycles', page: 'Filter Cleaning Record', action: 'View',
        icon: 'refresh', category: 'Cleaning Cycles', permissions: ['CYCLE_READ'], enforce: 'a',
        gate: ['CYCLE_READ'], configurable: true },
      { id: 'cleaning_record.export', label: 'Export Cleaning Record', sidebarId: 'cleaning-cycles', page: 'Filter Cleaning Record', action: 'Export',
        icon: 'download', category: 'Cleaning Cycles', permissions: ['REPORT_EXPORT', 'REPORT_GENERATE'], enforce: 'c',
        gate: ['REPORT_EXPORT', 'REPORT_GENERATE'], configurable: true }, // #reports-removal 2026-07-04: now the GRANTABLE export toggle (was gate-only; the reports.export/generate toggles that used to grant these were removed). UI canExportPdf gates on REPORT_EXPORT||REPORT_GENERATE.
    ],
  },

  // ---- Filter Lifecycle Report ----
  {
    sidebarId: 'filter-lifecycle-report', label: 'Filter Lifecycle Report', icon: '📊',
    description: 'Per-filter cleaning lifecycle, cycle by cycle',
    visibilityPrivilegeIds: ['cycles.view'],
    nodes: [
      // #reports-removal 2026-07-04: the 9 report_templates.*/reports.* nodes
      // (orphaned generate/sign designer) were removed. lifecycle.export stays —
      // it's the active Filter Lifecycle PDF export, now the GRANTABLE toggle
      // (was gate-only; the reports.export/generate toggles that granted these
      // were removed with the module).
      { id: 'lifecycle.export', label: 'Export Filter Lifecycle Report', sidebarId: 'filter-lifecycle-report', page: 'Filter Lifecycle Report', action: 'Export',
        icon: 'download', category: 'Reports', permissions: ['REPORT_EXPORT', 'REPORT_GENERATE'], enforce: 'c',
        gate: ['REPORT_EXPORT', 'REPORT_GENERATE'], configurable: true }, // UI canExportPdf gates on REPORT_EXPORT||REPORT_GENERATE.
    ],
  },

  // ---- Checklists ----
  {
    sidebarId: 'checklists', label: 'Checklists', icon: '📋', description: 'Checklist profile management',
    // Visibility = who can MANAGE checklist profiles (create/edit/delete/toggle).
    // `checklists.submit` was removed 2026-07-04 (audit #1): submitting checklists
    // happens on the filter-operations page (it drives the filters group's
    // visibility, line ~493), not this profile-management page. Leaving it here
    // made the nav item show for operators (FILTER_OPERATE/CHECKLIST_SUBMIT) even
    // though the page 403s for them — and it diverged isSidebarItemVisible from the
    // derived SIDEBAR_PRIVILEGE_MAP (enforced-only nodes aren't in FEATURE_TO_PERMISSION_MAP).
    visibilityPrivilegeIds: ['checklists.create', 'checklists.edit', 'checklists.delete', 'checklists.toggle'],
    nodes: [
      { id: 'checklists.submit', label: 'Submit Checklists', sidebarId: 'checklists', page: 'Checklists', action: 'Submit',
        icon: 'clipboard-check', category: 'Checklists', permissions: ['CHECKLIST_SUBMIT'], enforce: 'a',
        // CHECKLIST_SUBMIT is a grant perm only; POST /api/filters/:id/submit-checklist enforces FILTER_OPERATE.
        // 2026-07-01: made enforced-only (dropped from picker) — redundant with filters.operate (same gate).
        gate: ['FILTER_OPERATE'] },
      { id: 'checklists.create', label: 'Create Checklist Profiles', sidebarId: 'checklists', page: 'Checklists', action: 'Create',
        icon: 'plus', category: 'Checklist Page Controls', permissions: ['CHECKLIST_CREATE', 'FCP_CREATE'],
        reauthAction: 'CREATE_CHECKLIST_PROFILE', enforce: 'a',
        gate: ['CHECKLIST_CREATE'], configurable: true }, // 5C: per-action UI intent (old canCreate=CHECKLIST_CREATE)
      { id: 'checklists.edit', label: 'Edit Checklist Profiles', sidebarId: 'checklists', page: 'Checklists', action: 'Edit',
        icon: 'edit', category: 'Checklist Page Controls', permissions: ['CHECKLIST_EDIT', 'FCP_UPDATE'],
        reauthAction: 'UPDATE_CHECKLIST_PROFILE', enforce: 'a',
        gate: ['FCP_UPDATE', 'CHECKLIST_EDIT'], configurable: true },
      { id: 'checklists.delete', label: 'Delete Checklist Profiles', sidebarId: 'checklists', page: 'Checklists', action: 'Delete',
        icon: 'trash', category: 'Checklist Page Controls', permissions: ['CHECKLIST_DELETE', 'FCP_DELETE'],
        reauthAction: 'DELETE_CHECKLIST_PROFILE', enforce: 'a',
        gate: ['CHECKLIST_DELETE'], configurable: true }, // 5C: per-action UI intent (old canDelete=CHECKLIST_DELETE)
      // 2026-07-01: made enforced-only — identical gate to checklists.edit (redundant picker toggle; CHECKLIST_TOGGLE is only a read-alternate).
      { id: 'checklists.toggle', label: 'Enable / Disable Checklists', sidebarId: 'checklists', page: 'Checklists', action: 'Enable/Disable',
        icon: 'toggle', category: 'Checklist Page Controls', permissions: ['CHECKLIST_TOGGLE', 'FCP_UPDATE'], enforce: 'a',
        gate: ['FCP_UPDATE', 'CHECKLIST_EDIT'] },
      // Enforced-only: checklist administration
      { id: 'checklists.view', label: 'View Checklist Profiles', sidebarId: 'checklists', page: 'Checklists', action: 'View',
        icon: 'eye', category: 'Checklist Page Controls', permissions: ['FCP_READ'], enforce: 'a',
        gate: ['FCP_READ', 'CHECKLIST_TOGGLE', 'VERSION_HISTORY_VIEW'] },
      { id: 'checklists.manage_questions', label: 'Manage Checklist Questions', sidebarId: 'checklists', page: 'Checklists', action: 'Manage Questions',
        icon: 'list', category: 'Checklist Page Controls', permissions: ['FCP_UPDATE'],
        reauthAction: 'UPDATE_CHECKLIST_PROFILE', enforce: 'a',
        gate: ['FCP_UPDATE', 'CHECKLIST_EDIT'] },
    ],
  },

  // ---- Cleaning Profiles ----
  {
    sidebarId: 'cleaning-profiles', label: 'Cleaning Profiles', icon: '🧹',
    description: 'Cleaning pipeline profile management',
    visibilityPrivilegeIds: ['cleaning_profiles.view', 'cleaning_profiles.create', 'cleaning_profiles.edit', 'cleaning_profiles.delete'],
    nodes: [
      { id: 'cleaning_profiles.view', label: 'View Cleaning Profiles', sidebarId: 'cleaning-profiles', page: 'Cleaning Profiles', action: 'View',
        icon: 'eye', category: 'Cleaning Profiles', permissions: ['FCP_READ'], enforce: 'a',
        gate: ['FCP_READ', 'CP_TOGGLE', 'VERSION_HISTORY_VIEW'], configurable: true },
      { id: 'cleaning_profiles.create', label: 'Create Cleaning Profiles', sidebarId: 'cleaning-profiles', page: 'Cleaning Profiles', action: 'Create',
        icon: 'plus', category: 'Cleaning Profile Page Controls', permissions: ['CP_PAGE_CREATE', 'FCP_CREATE', 'FCP_READ'],
        reauthAction: 'CREATE_CLEANING_PROFILE', enforce: 'a',
        gate: ['CP_PAGE_CREATE'], configurable: true }, // 5C: per-action UI intent (old canCreate=CP_PAGE_CREATE)
      { id: 'cleaning_profiles.edit', label: 'Edit Cleaning Profiles', sidebarId: 'cleaning-profiles', page: 'Cleaning Profiles', action: 'Edit',
        icon: 'edit', category: 'Cleaning Profile Page Controls', permissions: ['CP_PAGE_EDIT', 'FCP_UPDATE', 'FCP_READ'],
        reauthAction: 'UPDATE_CLEANING_PROFILE', enforce: 'a',
        gate: ['CP_PAGE_EDIT'], configurable: true }, // 5C: per-action UI intent (old canUpdate=CP_PAGE_EDIT)
      { id: 'cleaning_profiles.delete', label: 'Delete Cleaning Profiles', sidebarId: 'cleaning-profiles', page: 'Cleaning Profiles', action: 'Delete',
        icon: 'trash', category: 'Cleaning Profile Page Controls', permissions: ['CP_PAGE_DELETE', 'FCP_DELETE', 'FCP_READ'],
        reauthAction: 'DELETE_CLEANING_PROFILE', enforce: 'a',
        gate: ['CP_PAGE_DELETE'], configurable: true }, // 5C: per-action UI intent (old canDelete=CP_PAGE_DELETE)
      // 2026-07-01: made enforced-only — redundant with cleaning_profiles.edit (edit gate covers it; CP_TOGGLE is only a read-alternate).
      { id: 'cleaning_profiles.toggle', label: 'Enable / Disable Cleaning Profiles', sidebarId: 'cleaning-profiles', page: 'Cleaning Profiles', action: 'Enable/Disable',
        icon: 'toggle', category: 'Cleaning Profile Page Controls', permissions: ['CP_TOGGLE', 'FCP_UPDATE', 'FCP_READ'], enforce: 'a',
        gate: ['FCP_UPDATE', 'CP_PAGE_EDIT'] },
      // Filter Profiles (no standalone sidebar entry — folded under cleaning-profiles)
      { id: 'filter_profiles.view', label: 'View Filter Profiles', sidebarId: 'cleaning-profiles', page: 'Filter Profiles', action: 'View',
        icon: 'eye', category: 'Filter Profiles', permissions: ['FP_READ'], enforce: 'a',
        gate: ['FP_READ', 'VERSION_HISTORY_VIEW'], configurable: true },
      { id: 'filter_profiles.create', label: 'Create Filter Profiles', sidebarId: 'cleaning-profiles', page: 'Filter Profiles', action: 'Create',
        icon: 'plus', category: 'Filter Profiles', permissions: ['FP_CREATE', 'FP_READ'],
        reauthAction: 'CREATE_FILTER_PROFILE', enforce: 'a',
        gate: ['FP_CREATE'], configurable: true },
      { id: 'filter_profiles.edit', label: 'Edit Filter Profiles', sidebarId: 'cleaning-profiles', page: 'Filter Profiles', action: 'Edit',
        icon: 'edit', category: 'Filter Profiles', permissions: ['FP_UPDATE', 'FP_READ'],
        reauthAction: 'UPDATE_FILTER_PROFILE', enforce: 'a',
        gate: ['FP_UPDATE'], configurable: true },
      { id: 'filter_profiles.delete', label: 'Delete Filter Profiles', sidebarId: 'cleaning-profiles', page: 'Filter Profiles', action: 'Delete',
        icon: 'trash', category: 'Filter Profiles', permissions: ['FP_DELETE', 'FP_READ'],
        reauthAction: 'DELETE_FILTER_PROFILE', enforce: 'a',
        gate: ['FP_DELETE'], configurable: true },
      { id: 'filter_profiles.assign', label: 'Assign Filter Profiles to Filters', sidebarId: 'cleaning-profiles', page: 'Filter Profiles', action: 'Assign',
        icon: 'link', category: 'Filter Profiles', permissions: ['FP_ASSIGN', 'FP_READ'],
        reauthAction: 'ASSIGN_FILTER_PROFILE', enforce: 'a',
        gate: ['FP_ASSIGN'], configurable: true },
    ],
  },

  // ---- Equipment Groups ----
  {
    sidebarId: 'equipment-groups', label: 'Equipment Groups', icon: '⚙️',
    description: 'Equipment group configuration',
    visibilityPrivilegeIds: ['equipment_groups.view', 'equipment_groups.create', 'equipment_groups.edit', 'equipment_groups.delete'],
    nodes: [
      { id: 'equipment_groups.view', label: 'View Equipment Groups', sidebarId: 'equipment-groups', page: 'Equipment Groups', action: 'View',
        icon: 'eye', category: 'Equipment Group Controls', permissions: ['EG_VIEW', 'ASSET_READ'], enforce: 'a',
        gate: ['ASSET_READ', 'EG_VIEW', 'VERSION_HISTORY_VIEW'], configurable: true },
      { id: 'equipment_groups.create', label: 'Create Equipment Groups', sidebarId: 'equipment-groups', page: 'Equipment Groups', action: 'Create',
        icon: 'plus', category: 'Equipment Group Controls', permissions: ['EG_CREATE', 'ASSET_READ'], // 2026-07-01: dropped ASSET_CREATE over-grant
        reauthAction: 'CREATE_EQUIPMENT_GROUP', enforce: 'a',
        gate: ['EG_CREATE'], configurable: true }, // 5C: per-action UI intent (old canCreate=EG_CREATE)
      { id: 'equipment_groups.edit', label: 'Edit Equipment Groups', sidebarId: 'equipment-groups', page: 'Equipment Groups', action: 'Edit',
        icon: 'edit', category: 'Equipment Group Controls', permissions: ['EG_EDIT', 'ASSET_READ'], // 2026-07-01: dropped ASSET_UPDATE over-grant (leaked filter edit via useCan)
        reauthAction: 'UPDATE_EQUIPMENT_GROUP', enforce: 'a',
        gate: ['EG_EDIT'], configurable: true }, // 5C: per-action UI intent (old canEdit=EG_EDIT; covers edit + enable/disable)
      { id: 'equipment_groups.delete', label: 'Delete Equipment Groups', sidebarId: 'equipment-groups', page: 'Equipment Groups', action: 'Delete',
        icon: 'trash', category: 'Equipment Group Controls', permissions: ['EG_DELETE', 'ASSET_READ'], // 2026-07-01: dropped ASSET_DELETE over-grant
        reauthAction: 'DELETE_EQUIPMENT_GROUP', enforce: 'a',
        gate: ['EG_DELETE'], configurable: true }, // 5C: per-action UI intent (old canDelete=EG_DELETE)
      // 2026-07-16: `equipment_groups.toggle` (Enable/Disable) removed — a block
      // may now have multiple active equipment groups simultaneously; the
      // enable/disable capability is gone (delete is the only removal path). The
      // node was non-configurable (useCan-only), so FEATURE_PRIVILEGES /
      // FEATURE_TO_PERMISSION_MAP counts are unaffected.
    ],
  },

  // ---- PM Schedules ----
  {
    sidebarId: 'pm-schedules', label: 'PM Schedules', icon: '📅',
    description: 'Preventive maintenance scheduling',
    visibilityPrivilegeIds: ['pm.view', 'pm.create', 'pm.edit', 'pm.delete', 'pm.approve'],
    nodes: [
      { id: 'pm.view', label: 'View PM Schedules', sidebarId: 'pm-schedules', page: 'PM Schedules', action: 'View',
        icon: 'eye', category: 'PM Schedules', permissions: ['PM_READ'], enforce: 'a',
        gate: ['PM_READ'], configurable: true },
      { id: 'pm.create', label: 'Create PM Schedules', sidebarId: 'pm-schedules', page: 'PM Schedules', action: 'Create',
        icon: 'plus', category: 'PM Schedules', permissions: ['PM_CREATE', 'PM_READ'],
        reauthAction: 'CREATE_PM_SCHEDULE', enforce: 'a',
        gate: ['PM_CREATE'], configurable: true },
      { id: 'pm.edit', label: 'Edit PM Schedules', sidebarId: 'pm-schedules', page: 'PM Schedules', action: 'Edit',
        icon: 'edit', category: 'PM Schedules', permissions: ['PM_UPDATE', 'PM_READ'],
        reauthAction: 'UPDATE_PM_SCHEDULE', enforce: 'a',
        gate: ['PM_UPDATE'], configurable: true },
      { id: 'pm.delete', label: 'Delete PM Schedules', sidebarId: 'pm-schedules', page: 'PM Schedules', action: 'Delete',
        icon: 'trash', category: 'PM Schedules', permissions: ['PM_DELETE', 'PM_READ'],
        reauthAction: 'DELETE_PM_SCHEDULE', enforce: 'a',
        gate: [], configurable: true },
      { id: 'pm.execute', label: 'Execute PM Tasks', sidebarId: 'pm-schedules', page: 'PM Schedules', action: 'Execute',
        icon: 'play', category: 'PM Schedules', permissions: ['PM_EXECUTE', 'PM_READ'],
        reauthAction: 'START_PM_TASK', enforce: 'a',
        gate: ['PM_EXECUTE'], configurable: true },
      { id: 'pm.approve', label: 'Approve PM Schedules', sidebarId: 'pm-schedules', page: 'PM Schedules', action: 'Approve',
        icon: 'check-circle', category: 'PM Schedules', permissions: ['PM_APPROVE', 'PM_READ'],
        reauthAction: 'APPROVE_PM_SCHEDULE', enforce: 'a',
        gate: ['PM_APPROVE'], configurable: true },
      { id: 'pm.review', label: 'Review PM Schedules', sidebarId: 'pm-schedules', page: 'PM Schedules', action: 'Review',
        icon: 'clipboard-check', category: 'PM Schedules', permissions: ['PM_REVIEW', 'PM_READ'],
        reauthAction: 'REVIEW_PM_SCHEDULE', enforce: 'a',
        gate: ['PM_REVIEW'], configurable: true },
      { id: 'pm.download_template', label: 'Download PM Template', sidebarId: 'pm-schedules', page: 'PM Schedules', action: 'Download Template',
        icon: 'download', category: 'PM Schedules', permissions: ['PM_DOWNLOAD_TEMPLATE', 'PM_READ'], enforce: 'a',
        gate: ['PM_DOWNLOAD_TEMPLATE'], configurable: true }, // 5C: per-action UI intent (old canDownload=PM_DOWNLOAD_TEMPLATE)
      { id: 'pm.upload', label: 'Upload PM Schedules', sidebarId: 'pm-schedules', page: 'PM Schedules', action: 'Upload',
        icon: 'upload', category: 'PM Schedules', permissions: ['PM_UPLOAD', 'PM_CREATE', 'PM_READ'],
        reauthAction: 'UPLOAD_PM_SCHEDULES', enforce: 'a',
        gate: ['PM_UPLOAD'], configurable: true }, // 5C: per-action UI intent (old canUpload=PM_UPLOAD)
      { id: 'pm.edit_entry', label: 'Edit PM Entries', sidebarId: 'pm-schedules', page: 'PM Schedules', action: 'Edit Entry',
        icon: 'edit', category: 'PM Schedules', permissions: ['PM_EDIT_ENTRY', 'PM_UPDATE', 'PM_READ'],
        reauthAction: 'EDIT_PM_SCHEDULE', enforce: 'a',
        gate: ['PM_EDIT_ENTRY'], configurable: true }, // 5C: per-action UI intent (old canEditEntry=PM_EDIT_ENTRY)
      { id: 'pm.resubmit', label: 'Resubmit Rejected Entries', sidebarId: 'pm-schedules', page: 'PM Schedules', action: 'Resubmit',
        icon: 'refresh', category: 'PM Schedules', permissions: ['PM_RESUBMIT', 'PM_CREATE', 'PM_READ'],
        reauthAction: 'RESUBMIT_PM_ENTRY', enforce: 'a',
        gate: ['PM_RESUBMIT'], configurable: true }, // 5C: per-action UI intent (old canResubmit=PM_RESUBMIT)
      { id: 'pm.reject', label: 'Reject PM Schedule', sidebarId: 'pm-schedules', page: 'PM Schedules', action: 'Reject',
        icon: 'x-circle', category: 'PM Schedules', permissions: ['PM_APPROVE', 'PM_READ'],
        reauthAction: 'REJECT_PM_SCHEDULE', enforce: 'a',
        gate: ['PM_APPROVE'] },
    ],
  },

  // ---- My Tasks ----
  {
    sidebarId: 'my-tasks', label: 'My Tasks', icon: '🎯',
    description: 'Filters due for cleaning based on PM schedules',
    visibilityPrivilegeIds: ['pm.view', 'pm.execute'],
    nodes: [
      { id: 'my_tasks.view', label: 'View My PM Tasks', sidebarId: 'my-tasks', page: 'My Tasks', action: 'View',
        icon: 'eye', category: 'PM Schedules', permissions: ['PM_READ'], enforce: 'a',
        gate: ['PM_READ'] },
      { id: 'my_tasks.perform', label: 'Perform PM Task', sidebarId: 'my-tasks', page: 'My Tasks', action: 'Perform',
        icon: 'play', category: 'PM Schedules', permissions: ['PM_EXECUTE', 'PM_READ'], enforce: 'a',
        gate: ['PM_EXECUTE'] },
      { id: 'my_tasks.acknowledge', label: 'Acknowledge Overdue PM Task', sidebarId: 'my-tasks', page: 'My Tasks', action: 'Acknowledge',
        icon: 'check', category: 'PM Schedules', permissions: ['PM_READ'],
        reauthAction: 'ACKNOWLEDGE_PM_OVERDUE', enforce: 'a',
        gate: ['PM_READ'] },
    ],
  },

  // ---- Deviations ----
  {
    sidebarId: 'deviations', label: 'Deviations', icon: '⚠',
    description: 'Overdue PM cleaning deviations + audit trail',
    visibilityPrivilegeIds: ['pm.view', 'pm.approve'],
    nodes: [
      { id: 'deviations.view', label: 'View Deviations', sidebarId: 'deviations', page: 'Deviations', action: 'View',
        icon: 'alert-triangle', category: 'PM Schedules', permissions: ['PM_READ'], enforce: 'b',
        gate: ['PM_READ'] },
      { id: 'deviations.export', label: 'Export Deviations Report', sidebarId: 'deviations', page: 'Deviations', action: 'Export',
        icon: 'download', category: 'PM Schedules', permissions: [], enforce: 'c',
        gate: ['PM_READ'] },
    ],
  },

  // ---- Approvals (Block Change) ----
  {
    sidebarId: 'approvals', label: 'Approvals', icon: '✅',
    description: 'Block change approval requests',
    visibilityPrivilegeIds: ['block_change.request', 'block_change.approve'],
    nodes: [
      { id: 'block_change.view', label: 'View Block Change Requests', sidebarId: 'approvals', page: 'Approvals', action: 'View',
        icon: 'eye', category: 'Filter Management', permissions: ['BLOCK_CHANGE_REQUEST', 'BLOCK_CHANGE_APPROVE'], enforce: 'a',
        gate: ['BLOCK_CHANGE_REQUEST', 'BLOCK_CHANGE_APPROVE'] },
      { id: 'block_change.request', label: 'Request Block Change', sidebarId: 'approvals', page: 'Approvals', action: 'Request',
        icon: 'refresh', category: 'Filter Management', permissions: ['BLOCK_CHANGE_REQUEST'], enforce: 'a',
        gate: ['BLOCK_CHANGE_REQUEST'], configurable: true },
      { id: 'block_change.approve', label: 'Approve Block Change', sidebarId: 'approvals', page: 'Approvals', action: 'Approve',
        icon: 'check-circle', category: 'Filter Management', permissions: ['BLOCK_CHANGE_APPROVE'],
        reauthAction: 'APPROVE_BLOCK_CHANGE', enforce: 'a',
        gate: ['BLOCK_CHANGE_APPROVE'], configurable: true },
      { id: 'block_change.reject', label: 'Reject Block Change', sidebarId: 'approvals', page: 'Approvals', action: 'Reject',
        icon: 'x-circle', category: 'Filter Management', permissions: ['BLOCK_CHANGE_APPROVE'],
        reauthAction: 'REJECT_BLOCK_CHANGE', enforce: 'a',
        gate: ['BLOCK_CHANGE_APPROVE'] },
    ],
  },

  // ---- Stage Approvals ----
  {
    sidebarId: 'stage-approvals', label: 'Stage Approvals', icon: '🛡️',
    description: 'Approve cleaning stages (Wash Out / Dry Out) at the QA interlock',
    visibilityPrivilegeIds: ['stage_approvals.view', 'stage_approvals.decide'],
    nodes: [
      { id: 'stage_approvals.view', label: 'View Stage Approvals', sidebarId: 'stage-approvals', page: 'Stage Approvals', action: 'View',
        icon: 'shield', category: 'Filter Management', permissions: ['STAGE_APPROVAL_VIEW'], enforce: 'a',
        gate: ['STAGE_APPROVAL_VIEW'], configurable: true },
      { id: 'stage_approvals.decide', label: 'Approve/Reject Cleaning Stages', sidebarId: 'stage-approvals', page: 'Stage Approvals', action: 'Decide',
        icon: 'shield-check', category: 'Filter Management', permissions: ['STAGE_APPROVAL_DECIDE'], enforce: 'a',
        gate: ['STAGE_APPROVAL_DECIDE'], configurable: true },
      { id: 'stage_approvals.approve', label: 'Approve Cleaning Stage', sidebarId: 'stage-approvals', page: 'Stage Approvals', action: 'Approve',
        icon: 'check-circle', category: 'Filter Management', permissions: ['STAGE_APPROVAL_DECIDE'],
        reauthAction: 'APPROVE_CLEANING_STAGE', enforce: 'a',
        gate: ['STAGE_APPROVAL_DECIDE'] },
      { id: 'stage_approvals.reject', label: 'Reject Cleaning Stage', sidebarId: 'stage-approvals', page: 'Stage Approvals', action: 'Reject',
        icon: 'x-circle', category: 'Filter Management', permissions: ['STAGE_APPROVAL_DECIDE'],
        reauthAction: 'REJECT_CLEANING_STAGE', enforce: 'a',
        gate: ['STAGE_APPROVAL_DECIDE'] },
    ],
  },

  // ---- Version History ----
  {
    sidebarId: 'version-history', label: 'Version History', icon: '🕰️',
    description: 'Audit history of versioned definitions (cleaning profiles, filter profiles, checklist profiles, equipment groups)',
    visibilityPrivilegeIds: ['version_history.view'],
    nodes: [
      { id: 'version_history.view', label: 'View Version History', sidebarId: 'version-history', page: 'Version History', action: 'View',
        icon: 'history', category: 'Audit / Versions', permissions: ['VERSION_HISTORY_VIEW'], enforce: 'a',
        gate: ['VERSION_HISTORY_VIEW'], configurable: true },
    ],
  },
];

// ─── Phase 5E: Canonical ordering for derived maps ───────────────────────────
/**
 * Canonical ordering of configurable privileges.
 * Preserves the original FEATURE_PRIVILEGES array order exactly.
 * Used by deriveFeaturePrivileges() to produce order-stable output.
 */
const CONFIGURABLE_PRIVILEGE_ORDER: readonly string[] = [
  'users.create', 'users.view', 'users.edit', 'users.delete', 'users.enable_disable', 'users.unlock', 'users.reset_password',
  'config.view', 'config.edit', 'config.field_ids', 'roles.manage', 'notifications.view', 'notifications.delete', 'audit.view', 'audit.export', 'audit.delete', // notifications.manage removed from picker 2026-07-01; audit.delete added 2026-07-01
  'assets.view', // assets.create/edit/delete de-duplicated to enforced-only 2026-06-30 (not configurable)
  // assets.relationships.create/delete + assets.identifiers.create/delete de-duplicated to
  // enforced-only 2026-07-01 (RFID covered by filters.rfid_manage; relationships via edit gate).
  'dashboard.view', 'dashboard.create', 'dashboard.manage', 'dashboard.assign',
  'checklists.create', 'checklists.edit', 'checklists.delete', // checklists.submit + .toggle enforced-only 2026-07-01
  'filters.operate', 'filters.bypass', 'filters.events',
  'filters.bulk_upload', 'filters.retire', 'filters.replace', 'filters.status_update',
  'filters.create', 'filters.edit', 'filters.delete',
  'retirement_list.export', 'replacement_list.export',
  'filters.hierarchy_create', 'filters.hierarchy_edit', 'filters.hierarchy_delete', 'filters.rfid_manage', 'filters.export', // rfid_manage re-added to picker 2026-07-02 (was enforced-only since 2026-07-01)
  'replacement_schedule.view', 'replacement_schedule.upload', 'replacement_schedule.review', 'replacement_schedule.approve',
  'block_change.request', 'block_change.approve',
  'stage_approvals.view', 'stage_approvals.decide',
  'cleaning_profiles.view', 'cleaning_profiles.create', 'cleaning_profiles.edit', 'cleaning_profiles.delete', // .toggle enforced-only 2026-07-01
  'filter_profiles.view', 'filter_profiles.create', 'filter_profiles.edit', 'filter_profiles.delete', 'filter_profiles.assign',
  'cycles.view',
  'pm.view', 'pm.create', 'pm.edit', 'pm.delete', 'pm.execute', 'pm.approve', 'pm.review', 'pm.download_template', 'pm.upload', 'pm.edit_entry', 'pm.resubmit',
  'equipment_groups.view', 'equipment_groups.create', 'equipment_groups.edit', 'equipment_groups.delete',
  'admin_requests.approve', 'admin_requests.reject',
  'debug.view', 'debug.manage',
  'cleaning_record.export', 'lifecycle.export', // #reports-removal 2026-07-04: grantable PDF-export toggles (replaced the removed reports.export/generate)
  'version_history.view',
  'backup.export', 'backup.restore',
] as const;

// ─── Derive Functions ────────────────────────────────────────────────────────
// Phase 5E: these no longer import from feature-privileges or sidebar-privilege-map.
// They select/sort by the `configurable` flag + CONFIGURABLE_PRIVILEGE_ORDER.

/**
 * Phase 5E — Derives FEATURE_PRIVILEGES from the tree.
 *
 * Filters nodes with `configurable: true`, then sorts by CONFIGURABLE_PRIVILEGE_ORDER
 * to preserve the original array order. Returns {id, label, category, icon} per node.
 */
export function deriveFeaturePrivileges(tree: SidebarGroup[] = PERMISSION_TREE): FeaturePrivilege[] {
  const orderMap = new Map(CONFIGURABLE_PRIVILEGE_ORDER.map((id, i) => [id, i]));
  return tree
    .flatMap(g => g.nodes)
    .filter(n => n.configurable === true)
    .sort((a, b) => (orderMap.get(a.id) ?? 9999) - (orderMap.get(b.id) ?? 9999))
    .map(n => ({ id: n.id, label: n.label, category: n.category, icon: n.icon }));
}

/**
 * Phase 5E — Derives FEATURE_TO_PERMISSION_MAP from the tree.
 *
 * Iterates CONFIGURABLE_PRIVILEGE_ORDER, finds each node with `configurable: true`,
 * and returns { [nodeId]: permissions[] }. Key order follows CONFIGURABLE_PRIVILEGE_ORDER.
 */
export function deriveFeatureToPermissionMap(
  tree: SidebarGroup[] = PERMISSION_TREE,
): Record<string, string[]> {
  const allNodes = tree.flatMap(g => g.nodes);
  const out: Record<string, string[]> = {};
  for (const id of CONFIGURABLE_PRIVILEGE_ORDER) {
    const node = allNodes.find(n => n.id === id && n.configurable === true);
    if (node) out[node.id] = [...node.permissions];
  }
  return out;
}

/**
 * Phase 5E — Derives SIDEBAR_PRIVILEGE_MAP from the tree.
 *
 * Returns one SidebarSection per group, using the group's explicit
 * visibilityPrivilegeIds. Icon, label, and description come from the tree group.
 */
export function deriveSidebarPrivilegeMap(
  tree: SidebarGroup[] = PERMISSION_TREE,
): SidebarSection[] {
  return tree.map(g => ({
    sidebarId: g.sidebarId,
    label: g.label,
    icon: g.icon,
    description: g.description,
    privilegeIds: [...g.visibilityPrivilegeIds],
  }));
}

/**
 * Task 1.5 — Resolve the GRANT-expansion permissions for a tree node by id
 * (i.e. the permissions enabling this node's toggle grants a role — same set
 * as FEATURE_TO_PERMISSION_MAP). Returns [] for unknown ids.
 *
 * NOTE: this is the grant set, NOT an authorization gate. Do not OR over it to
 * decide "can the user perform this action" — it includes read dependencies
 * (e.g. USER_READ) that must not authorize writes. The Phase 5 useCan() hook
 * will gate on a separate per-node `gate` set sourced from backend
 * requireAnyPermission(...) sets, not on this grant expansion.
 */
export function resolveNodePermissions(
  nodeId: string,
  tree: SidebarGroup[] = PERMISSION_TREE,
): string[] {
  for (const g of tree) {
    const n = g.nodes.find(x => x.id === nodeId);
    if (n) return [...n.permissions];
  }
  return [];
}

/**
 * Phase 5A — Resolve the DISCRIMINATING backend gate for a tree node by id.
 *
 * The gate is the set of PERMISSIONS that requirePermission/requireAnyPermission
 * actually checks on the backend. useCan() ORs these vs the user's permissions.
 *
 * Returns [] for unknown ids (treated as SA-only / deny in useCan).
 * Returns [] for SA-only nodes (users.delete, pm.delete, etc.) — useCan handles
 * the SA bypass separately.
 */
export function resolveNodeGate(
  nodeId: string,
  tree: SidebarGroup[] = PERMISSION_TREE,
): Permission[] {
  for (const g of tree) {
    const n = g.nodes.find(x => x.id === nodeId);
    if (n) return [...n.gate];
  }
  return [];
}

/**
 * Phase 5A — Resolve the additional role bypass list for a tree node by id.
 *
 * Returns [] for unknown ids or nodes with no role bypass.
 * Non-empty only for role-gated nodes (e.g. system_health.view → ['ADMIN']).
 * SUPER_ADMIN is always bypassed by useCan() and is NOT in this list.
 */
export function resolveNodeGateRoles(
  nodeId: string,
  tree: SidebarGroup[] = PERMISSION_TREE,
): string[] {
  for (const g of tree) {
    const n = g.nodes.find(x => x.id === nodeId);
    if (n) return [...(n.gateRoles ?? [])];
  }
  return [];
}
