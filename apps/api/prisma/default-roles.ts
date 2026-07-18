/**
 * Default system roles — pure data, no side effects.
 *
 * Extracted from seed.ts so tests can import the role arrays without
 * triggering the seed's Prisma client construction and `main()` call.
 * seed.ts imports this and uses it identically to the former inline array.
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
      'AUDIT_READ', 'AUDIT_EXPORT', 'ROLE_MANAGE',
      'ASSET_CREATE', 'ASSET_UPDATE', 'ASSET_DELETE',
      'ASSET_IDENTIFIER_CREATE', 'ASSET_IDENTIFIER_DELETE', 'ASSET_VIEW', 'ASSET_READ',
      'DASHBOARD_CREATE', 'DASHBOARD_MANAGE', 'DASHBOARD_VIEW', 'DASHBOARD_ASSIGN',
      'NOTIFICATION_VIEW', 'NOTIFICATION_CREATE', 'NOTIFICATION_UPDATE', 'NOTIFICATION_DELETE', 'NOTIFICATION_MANAGE',
      'BACKUP_MANAGE', 'BACKUP_RESTORE',
      // Phase 2: Filter Management
      'FILTER_OPERATE', 'FILTER_BYPASS', 'CHECKLIST_SUBMIT', 'EVENT_READ',
      'FILTER_CREATE', 'FILTER_EDIT', 'FILTER_DELETE', 'FILTER_BULK_UPLOAD', 'FILTER_RETIRE', 'FILTER_REPLACE', 'FILTER_STATUS_UPDATE',
      'FILTER_HIERARCHY_CREATE', 'FILTER_HIERARCHY_EDIT', 'FILTER_HIERARCHY_DELETE', 'FILTER_RFID_MANAGE',
      'FCP_READ', 'FCP_CREATE', 'FCP_UPDATE', 'FCP_DELETE',
      'FP_READ', 'FP_CREATE', 'FP_UPDATE', 'FP_DELETE', 'FP_ASSIGN',
      'PM_READ', 'PM_CREATE', 'PM_UPDATE', 'PM_DELETE', 'PM_EXECUTE', 'PM_APPROVE',
      'CYCLE_READ', 'READ_DEBUG_TRACE', 'MANAGE_DEBUG_TRACE',
      'BLOCK_CHANGE_REQUEST', 'BLOCK_CHANGE_APPROVE',
      // Reports — PDF export + review/approval (generate/sign designer removed 2026-07-04)
      'REPORT_GENERATE', 'REPORT_EXPORT',
      'REPORT_REVIEW_SUBMIT', 'REPORT_REVIEW', 'REPORT_APPROVE',
      // Cleaning stage interlock (2026-06-12)
      'STAGE_APPROVAL_VIEW', 'STAGE_APPROVAL_DECIDE',
      // Audit / Versions (2026-05-02): SUPER_ADMIN gets cross-entity history viewer.
      // Other system roles do NOT — operators must be explicitly granted via Role Privileges.
      'VERSION_HISTORY_VIEW',
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
      // Phase 3 (2026-06-30): USER_DELETE / NOTIFICATION_DELETE / PM_DELETE removed —
      // those deletes are now SUPER_ADMIN-only (M3/M4/M5), so the perms gated nothing for ADMIN.
      'USER_CREATE', 'USER_READ', 'USER_UPDATE', 'USER_ENABLE_DISABLE', 'USER_UNLOCK', 'USER_RESET_PASSWORD',
      'ADMIN_REQUEST_APPROVE', 'ADMIN_REQUEST_REJECT',
      'CONFIG_READ', 'CONFIG_UPDATE', 'FIELD_ID_UPDATE', 'ROLE_MANAGE',
      'AUDIT_READ', 'AUDIT_EXPORT',
      'ASSET_CREATE', 'ASSET_UPDATE', 'ASSET_DELETE',
      'ASSET_IDENTIFIER_CREATE', 'ASSET_IDENTIFIER_DELETE', 'ASSET_VIEW', 'ASSET_READ',
      'DASHBOARD_CREATE', 'DASHBOARD_MANAGE', 'DASHBOARD_VIEW', 'DASHBOARD_ASSIGN',
      'NOTIFICATION_VIEW', 'NOTIFICATION_CREATE', 'NOTIFICATION_UPDATE', 'NOTIFICATION_MANAGE',
      'BACKUP_MANAGE', 'BACKUP_RESTORE',
      // Phase 2: Filter Management
      'FILTER_OPERATE', 'FILTER_BYPASS', 'CHECKLIST_SUBMIT', 'EVENT_READ',
      'FILTER_CREATE', 'FILTER_EDIT', 'FILTER_DELETE', 'FILTER_BULK_UPLOAD', 'FILTER_RETIRE', 'FILTER_REPLACE', 'FILTER_STATUS_UPDATE',
      'FILTER_HIERARCHY_CREATE', 'FILTER_HIERARCHY_EDIT', 'FILTER_HIERARCHY_DELETE', 'FILTER_RFID_MANAGE',
      'FCP_READ', 'FCP_CREATE', 'FCP_UPDATE', 'FCP_DELETE',
      'FP_READ', 'FP_CREATE', 'FP_UPDATE', 'FP_DELETE', 'FP_ASSIGN',
      'PM_READ', 'PM_CREATE', 'PM_UPDATE', 'PM_EXECUTE', 'PM_APPROVE',
      'CYCLE_READ', 'READ_DEBUG_TRACE', 'MANAGE_DEBUG_TRACE',
      'BLOCK_CHANGE_REQUEST', 'BLOCK_CHANGE_APPROVE',
      // Reports — PDF export + review/approval (generate/sign designer removed 2026-07-04)
      'REPORT_GENERATE', 'REPORT_EXPORT',
      'REPORT_REVIEW_SUBMIT', 'REPORT_REVIEW', 'REPORT_APPROVE',
      // Cleaning stage interlock (2026-06-12)
      'STAGE_APPROVAL_VIEW', 'STAGE_APPROVAL_DECIDE',
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
      'AUDIT_READ',
      'ASSET_VIEW', 'ASSET_READ', 'ASSET_CREATE',
      'DASHBOARD_VIEW',
      // Phase 2: Filter operations + read access
      'FILTER_OPERATE', 'CHECKLIST_SUBMIT', 'EVENT_READ',
      'FILTER_CREATE', 'FILTER_EDIT',
      'FCP_READ', 'FP_READ', 'PM_READ', 'CYCLE_READ',
      'BLOCK_CHANGE_REQUEST',
      // Cleaning stage interlock — SUPERVISOR is a natural approver role (2026-06-12)
      'STAGE_APPROVAL_VIEW', 'STAGE_APPROVAL_DECIDE',
      // Reports — PDF export (generate/sign designer removed 2026-07-04)
      'REPORT_GENERATE', 'REPORT_EXPORT',
    ],
    color: 'bg-gradient-to-r from-blue-500 to-cyan-500',
    isSystem: true,
  },
  {
    name: 'MAINTENANCE',
    displayName: 'Maintenance',
    description: 'Maintenance staff with entity and template management',
    hierarchyLevel: 3,
    permissions: [
      'AUDIT_READ',
      'ASSET_VIEW', 'ASSET_READ', 'ASSET_CREATE', 'ASSET_UPDATE',
      'DASHBOARD_VIEW',
      // Phase 2: Filter operations + checklist
      'FILTER_OPERATE', 'CHECKLIST_SUBMIT', 'EVENT_READ',
      'FCP_READ', 'FP_READ', 'PM_READ', 'CYCLE_READ',
      'BLOCK_CHANGE_REQUEST',
      // Reports — PDF export (generate/sign designer removed 2026-07-04)
      'REPORT_GENERATE', 'REPORT_EXPORT',
    ],
    color: 'bg-gradient-to-r from-amber-500 to-orange-500',
    isSystem: true,
  },
  {
    name: 'OPERATOR',
    displayName: 'Operator',
    description: 'Operator with read access and filter operations',
    hierarchyLevel: 2,
    permissions: [
      'AUDIT_READ',
      'ASSET_VIEW', 'ASSET_READ',
      'DASHBOARD_VIEW',
      // Phase 2: Filter operations + checklist
      'FILTER_OPERATE', 'CHECKLIST_SUBMIT', 'EVENT_READ',
      'FCP_READ', 'FP_READ', 'PM_READ', 'CYCLE_READ',
      'BLOCK_CHANGE_REQUEST',
      // (Reports: VIEWER had only the orphaned REPORT_VIEW — removed 2026-07-04.)
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
      'ASSET_VIEW', 'ASSET_READ',
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
