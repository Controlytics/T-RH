/**
 * Default system roles — pure data, no side effects.
 *
 * Extracted from seed.ts so tests can import the role arrays without
 * triggering the seed's Prisma client construction and `main()` call.
 * seed.ts imports this and uses it identically to the former inline array.
 *
 * Domain (cleanroom filter) permissions were removed with the domain strip
 * (2026-07-18); only the generic compliance/admin core permissions remain.
 */
export const defaultRoles = [
  {
    name: 'SUPER_ADMIN',
    displayName: 'Super Admin',
    description: 'System owner with full access to all features',
    hierarchyLevel: 6,
    permissions: [
      'USER_CREATE', 'USER_READ', 'USER_UPDATE', 'USER_DELETE', 'USER_ENABLE_DISABLE', 'USER_UNLOCK', 'USER_RESET_PASSWORD',
      'ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT',
      'CONFIG_READ', 'CONFIG_UPDATE', 'FIELD_ID_UPDATE',
      'AUDIT_READ', 'AUDIT_EXPORT', 'AUDIT_DELETE', 'ROLE_MANAGE',
      'DASHBOARD_CREATE', 'DASHBOARD_MANAGE', 'DASHBOARD_VIEW', 'DASHBOARD_ASSIGN',
      'NOTIFICATION_VIEW', 'NOTIFICATION_CREATE', 'NOTIFICATION_UPDATE', 'NOTIFICATION_DELETE', 'NOTIFICATION_MANAGE',
      'BACKUP_MANAGE', 'BACKUP_RESTORE',
      'READ_DEBUG_TRACE', 'MANAGE_DEBUG_TRACE',
    ],
    color: 'bg-gradient-to-r from-red-500 to-pink-500',
    isSystem: true,
  },
  {
    name: 'ADMIN',
    displayName: 'Admin',
    description: 'Administrator with user and configuration management access',
    hierarchyLevel: 5,
    permissions: [
      // Phase 3 (2026-06-30): USER_DELETE / NOTIFICATION_DELETE removed —
      // those deletes are now SUPER_ADMIN-only (M3/M4/M5).
      // 2026-10-24: only permissions the Permissions tab can show and revoke —
      // FIELD_ID_UPDATE, DASHBOARD_CREATE / _MANAGE / _ASSIGN and
      // NOTIFICATION_CREATE / _UPDATE / _MANAGE went (no screen they gate is
      // open to ADMIN; NOTIFICATION_MANAGE also covered the NOTIFICATION_DELETE
      // that M4/M5 made SUPER_ADMIN-only), BACKUP_MANAGE became BACKUP_EXPORT.
      'USER_CREATE', 'USER_READ', 'USER_UPDATE', 'USER_ENABLE_DISABLE', 'USER_UNLOCK', 'USER_RESET_PASSWORD',
      'ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT',
      'CONFIG_READ', 'CONFIG_UPDATE', 'ROLE_MANAGE',
      'AUDIT_READ', 'AUDIT_EXPORT',
      'DASHBOARD_VIEW',
      'NOTIFICATION_VIEW',
      'BACKUP_EXPORT', 'BACKUP_RESTORE',
      'READ_DEBUG_TRACE', 'MANAGE_DEBUG_TRACE',
    ],
    color: 'bg-gradient-to-r from-purple-500 to-indigo-500',
    isSystem: true,
  },
  {
    name: 'SUPERVISOR',
    displayName: 'Supervisor',
    description: 'Supervisor with approval and review capabilities',
    hierarchyLevel: 4,
    permissions: [
      'AUDIT_READ', 'AUDIT_EXPORT',
      'DASHBOARD_VIEW',
      'NOTIFICATION_VIEW',
    ],
    color: 'bg-gradient-to-r from-blue-500 to-cyan-500',
    isSystem: true,
  },
  {
    name: 'MAINTENANCE',
    displayName: 'Maintenance',
    description: 'Maintenance staff',
    hierarchyLevel: 3,
    permissions: [
      'AUDIT_READ',
      'DASHBOARD_VIEW',
      'NOTIFICATION_VIEW',
    ],
    color: 'bg-gradient-to-r from-amber-500 to-orange-500',
    isSystem: true,
  },
  {
    name: 'OPERATOR',
    displayName: 'Operator',
    description: 'Operator with read access',
    hierarchyLevel: 2,
    permissions: [
      'AUDIT_READ',
      'DASHBOARD_VIEW',
      'NOTIFICATION_VIEW',
    ],
    color: 'bg-gradient-to-r from-emerald-500 to-green-500',
    isSystem: true,
  },
  {
    name: 'VIEWER',
    displayName: 'Viewer',
    description: 'View-only access',
    hierarchyLevel: 1,
    permissions: [
      'AUDIT_READ',
      'DASHBOARD_VIEW',
    ],
    color: 'bg-gradient-to-r from-slate-400 to-slate-500',
    isSystem: true,
  },
] as const satisfies Array<{
  name: string;
  displayName: string;
  description: string;
  hierarchyLevel: number;
  permissions: readonly string[];
  color: string;
  isSystem: boolean;
}>;
