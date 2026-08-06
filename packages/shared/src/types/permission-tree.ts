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
 *   Count: 30 (26 after the 2026-07-18 domain strip, +4 for the instruments
 *   registry 2026-08-05).
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
   * derivation. 30 nodes carry this flag (26 core + 4 instruments, 2026-08-05).
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

  // ---- Instruments ----
  // The device registry. `instruments.edit` covers the three token actions
  // (reveal / set / regenerate) too — they take INSTRUMENT_UPDATE rather than a
  // permission of their own.
  //
  // No `reauthAction` on the edit node, deliberately (2026-08-06). It carried
  // `REGENERATE_INSTRUMENT_TOKEN` until that endpoint moved to
  // `enforceReauthAlways` and left `REAUTH_ACTIONS`. `reauthAction` is typed
  // against that registry and drives a per-role policy badge in the permissions
  // tab; an always-on gate has no policy to show. The password proof is still
  // demanded on all three token endpoints — it is simply not configurable, so
  // there is nothing here for an admin to manage.
  {
    sidebarId: 'instruments', label: 'Instruments', icon: '📡', description: 'Instrument registry and telemetry',
    visibilityPrivilegeIds: ['instruments.view', 'instruments.create', 'instruments.edit', 'instruments.delete'],
    nodes: [
      { id: 'instruments.view', label: 'View Instruments', sidebarId: 'instruments', page: 'Instruments', action: 'View',
        icon: 'radio', category: 'Instruments', permissions: ['INSTRUMENT_READ'], enforce: 'a',
        gate: ['INSTRUMENT_READ'], configurable: true },
      { id: 'instruments.create', label: 'Create Instruments', sidebarId: 'instruments', page: 'Instruments', action: 'Add',
        icon: 'plus', category: 'Instruments', permissions: ['INSTRUMENT_CREATE', 'INSTRUMENT_READ'], enforce: 'a',
        gate: ['INSTRUMENT_CREATE'], configurable: true },
      { id: 'instruments.edit', label: 'Edit Instruments / Manage Token', sidebarId: 'instruments', page: 'Instruments', action: 'Edit',
        icon: 'edit', category: 'Instruments', permissions: ['INSTRUMENT_UPDATE', 'INSTRUMENT_READ'], enforce: 'a',
        gate: ['INSTRUMENT_UPDATE'], configurable: true },
      { id: 'instruments.delete', label: 'Delete Instruments', sidebarId: 'instruments', page: 'Instruments', action: 'Delete',
        icon: 'trash', category: 'Instruments', permissions: ['INSTRUMENT_DELETE', 'INSTRUMENT_READ'], enforce: 'a',
        gate: ['INSTRUMENT_DELETE'], configurable: true },
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
  'config.view', 'config.edit', 'config.field_ids', 'roles.manage', 'notifications.view', 'notifications.delete', 'audit.view', 'audit.export', 'audit.delete',
  'dashboard.view', 'dashboard.create', 'dashboard.manage', 'dashboard.assign',
  'admin_requests.approve', 'admin_requests.reject',
  'debug.view', 'debug.manage',
  'backup.export', 'backup.restore',
  'instruments.view', 'instruments.create', 'instruments.edit', 'instruments.delete',
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
