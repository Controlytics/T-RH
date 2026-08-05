export interface AuditTemplateDefinition {
  label: string;
  category: string;
  template: string;
  placeholders: string[];
}

export const AUDIT_TEMPLATE_CATEGORIES = [
  'User Management',
  'Authentication',
  'Configuration',
  'Role Management',
  'Backup',
  'Data & Approvals',
  'Hierarchy & Filters',
  'Filter Management',
  'Filter Operations',
  'Cleaning Profiles',
  'Filter Profiles',
  'Equipment Groups',
  'PM Schedules',
  'Instruments',
] as const;

export type AuditTemplateCategory = (typeof AUDIT_TEMPLATE_CATEGORIES)[number];

export const AUDIT_TEMPLATE_DEFAULTS: Record<string, AuditTemplateDefinition> = {
  // User Management
  USER_CREATED: {
    label: 'User Created',
    category: 'User Management',
    template: 'User "{targetUser}" created by {actor}',
    placeholders: ['actor', 'targetUser'],
  },
  USER_UPDATED: {
    label: 'User Updated',
    category: 'User Management',
    template: 'User "{targetUser}" updated by {actor}',
    placeholders: ['actor', 'targetUser'],
  },
  USER_UPDATED_SELF: {
    label: 'User Updated (Self)',
    category: 'User Management',
    template: 'User "{actor}" updated their own account',
    placeholders: ['actor'],
  },
  USER_DELETED: {
    label: 'User Deleted',
    category: 'User Management',
    template: 'User "{targetUser}" disabled by {actor}',
    placeholders: ['actor', 'targetUser'],
  },
  BULK_USER_DELETED: {
    label: 'Bulk User Delete',
    category: 'User Management',
    template: 'Multiple users deleted in bulk by {actor}',
    placeholders: ['actor'],
  },
  USER_ENABLED: {
    label: 'User Enabled',
    category: 'User Management',
    template: 'User "{targetUser}" enabled by {actor}',
    placeholders: ['actor', 'targetUser'],
  },
  USER_DISABLED: {
    label: 'User Disabled',
    category: 'User Management',
    template: 'User "{targetUser}" disabled by {actor}',
    placeholders: ['actor', 'targetUser'],
  },
  ACCOUNT_LOCKED: {
    label: 'Account Locked',
    category: 'User Management',
    template: 'Account "{targetUser}" locked due to failed login attempts',
    placeholders: ['targetUser'],
  },
  ACCOUNT_UNLOCKED: {
    label: 'Account Unlocked',
    category: 'User Management',
    template: 'Account "{targetUser}" unlocked by {actor}',
    placeholders: ['actor', 'targetUser'],
  },

  // Password actions
  PROFILE_UPDATED: {
    label: 'Profile Updated',
    category: 'User Management',
    template: 'Profile updated for "{targetUser}" by {actor}',
    placeholders: ['actor', 'targetUser'],
  },
  PROFILE_UPDATED_SELF: {
    label: 'Profile Updated (Self)',
    category: 'User Management',
    template: 'User "{actor}" updated their own profile',
    placeholders: ['actor'],
  },
  PASSWORD_CHANGED: {
    label: 'Password Changed',
    category: 'User Management',
    template: 'Password changed for "{targetUser}" by {actor}',
    placeholders: ['actor', 'targetUser'],
  },
  PASSWORD_CHANGED_SELF: {
    label: 'Password Changed (Self)',
    category: 'User Management',
    template: 'User "{actor}" changed their own password',
    placeholders: ['actor'],
  },
  PASSWORD_RESET: {
    label: 'Password Reset',
    category: 'User Management',
    template: 'Password reset for "{targetUser}" by {actor}',
    placeholders: ['actor', 'targetUser'],
  },
  PASSWORD_EXPIRED: {
    label: 'Password Expired',
    category: 'User Management',
    template: 'Password expired for "{targetUser}"',
    placeholders: ['targetUser'],
  },

  // Authentication
  LOGIN_SUCCESS: {
    label: 'Login Success',
    category: 'Authentication',
    template: 'User "{actor}" logged in successfully',
    placeholders: ['actor'],
  },
  LOGIN: {
    label: 'Login',
    category: 'Authentication',
    template: 'User "{actor}" logged in successfully',
    placeholders: ['actor'],
  },
  LOGIN_FAILED: {
    label: 'Login Failed',
    category: 'Authentication',
    template: 'Failed login attempt for "{actor}"',
    placeholders: ['actor'],
  },
  LOGOUT: {
    label: 'Logout',
    category: 'Authentication',
    template: 'User "{actor}" logged out',
    placeholders: ['actor'],
  },
  FORCED_LOGOUT: {
    label: 'Forced Logout',
    category: 'Authentication',
    template: 'Previous sessions terminated for "{targetUser}"',
    placeholders: ['targetUser', 'actor'],
  },

  // Configuration
  CONFIG_CHANGED: {
    label: 'Config Changed',
    category: 'Configuration',
    template: 'Configuration "{configKey}" updated by {actor}',
    placeholders: ['actor', 'configKey'],
  },

  // Role Management
  ROLE_CREATED: {
    label: 'Role Created',
    category: 'Role Management',
    template: 'Role "{targetName}" created by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  ROLE_UPDATED: {
    label: 'Role Updated',
    category: 'Role Management',
    template: 'Role "{targetName}" updated by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  ROLE_DELETED: {
    label: 'Role Deleted',
    category: 'Role Management',
    template: 'Role "{targetName}" deleted by {actor}',
    placeholders: ['actor', 'targetName'],
  },

  // Backup
  BACKUP_CREATED: {
    label: 'Backup Created',
    category: 'Backup',
    template: 'Database backup created by {actor}',
    placeholders: ['actor'],
  },
  BACKUP_RESTORED: {
    label: 'Backup Restored',
    category: 'Backup',
    template: 'Database restored from backup by {actor}',
    placeholders: ['actor'],
  },

  // Data & Approvals
  DATA_EXPORTED: {
    label: 'Data Exported',
    category: 'Data & Approvals',
    template: '{targetType} exported by {actor}',
    placeholders: ['actor', 'targetType'],
  },
  REPORT_GENERATED: {
    label: 'Report Generation',
    category: 'Data & Approvals',
    template: '{targetType} report generated by {actor}',
    placeholders: ['actor', 'targetType'],
  },

  // Template Management (Block / Area / AHU / Filter type definitions)
  ASSET_TEMPLATE_CREATED: {
    label: 'Template Created',
    category: 'Hierarchy & Filters',
    template: 'New template "{targetName}" created with its fields and settings by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  ASSET_TEMPLATE_UPDATED: {
    label: 'Template Updated',
    category: 'Hierarchy & Filters',
    template: 'Template "{targetName}" updated (new version {version}) by {actor}',
    placeholders: ['actor', 'targetName', 'version'],
  },
  ASSET_TEMPLATE_DELETED: {
    label: 'Template Deactivated',
    category: 'Hierarchy & Filters',
    template: 'Template "{targetName}" deactivated by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  ASSET_TEMPLATE_VERSION_CREATED: {
    label: 'Template Version Created',
    category: 'Hierarchy & Filters',
    template: 'Version {version} snapshot of template "{targetName}" created by {actor}',
    placeholders: ['actor', 'targetName', 'version'],
  },

  // Block / Area / AHU / Filter records. {entityKind} resolves to the specific
  // kind (Block / Area / AHU / Filter) from the row's data; older rows without
  // a kind fall back to a neutral word.
  ASSET_CREATED: {
    label: 'Created',
    category: 'Hierarchy & Filters',
    // {parentClause} is ' under <ParentKind> "<ParentName>"' when created under a
    // parent, else empty — a create-under-parent is ONE audit row (no separate
    // relationship row). E.g. 'New AHU "L8" created under Block "B1" by EMP-004'.
    template: 'New {entityKind} "{targetName}" created{parentClause} by {actor}',
    placeholders: ['actor', 'entityKind', 'targetName', 'parentClause'],
  },
  ASSET_UPDATED: {
    label: 'Updated',
    category: 'Hierarchy & Filters',
    template: '{entityKind} "{targetName}" updated by {actor}',
    placeholders: ['actor', 'entityKind', 'targetName'],
  },
  ASSET_STATUS_CHANGED: {
    label: 'Status Changed',
    category: 'Hierarchy & Filters',
    template: '{entityKind} "{targetName}" status changed from "{beforeStatus}" to "{afterStatus}" by {actor}',
    placeholders: ['actor', 'entityKind', 'targetName', 'beforeStatus', 'afterStatus'],
  },
  ASSET_DELETED: {
    label: 'Deactivated',
    category: 'Hierarchy & Filters',
    template: '{entityKind} "{targetName}" and everything under it deactivated by {actor}',
    placeholders: ['actor', 'entityKind', 'targetName'],
  },

  // Hierarchy links (a child placed under its parent). {sourceName}/{sourceKind}
  // is the parent; {targetName}/{targetKind} is the child that was placed under it.
  ASSET_RELATIONSHIP_CREATED: {
    label: 'Placed Under Parent',
    category: 'Hierarchy & Filters',
    template: '{targetKind} "{targetName}" placed under {sourceKind} "{sourceName}" by {actor}',
    placeholders: ['actor', 'sourceKind', 'sourceName', 'targetKind', 'targetName'],
  },
  ASSET_RELATIONSHIP_DELETED: {
    label: 'Removed From Parent',
    category: 'Hierarchy & Filters',
    template: '{targetKind} "{targetName}" removed from under {sourceKind} "{sourceName}" by {actor}',
    placeholders: ['actor', 'sourceKind', 'sourceName', 'targetKind', 'targetName'],
  },

  // Entity Identifiers
  ASSET_IDENTIFIER_CREATED: {
    label: 'Filter Identifier Added',
    category: 'Filter Management',
    template: 'New identifier ({identifierType}: {identifierValue}) added to filter "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName', 'identifierType', 'identifierValue'],
  },
  ASSET_IDENTIFIER_DELETED: {
    label: 'Filter Identifier Removed',
    category: 'Filter Management',
    template: 'Identifier ({identifierType}: {identifierValue}) removed from filter "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName', 'identifierType', 'identifierValue'],
  },

  // Alarm Management
  ALARM_ACKNOWLEDGED: {
    label: 'Alarm Acknowledged',
    category: 'Hierarchy & Filters',
    template: 'Alarm "{targetName}" acknowledged by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  ALARM_CLEARED: {
    label: 'Alarm Cleared',
    category: 'Hierarchy & Filters',
    template: 'Alarm "{targetName}" cleared by {actor}',
    placeholders: ['actor', 'targetName'],
  },

  // Phase 2: Filter Operations
  CYCLE_STARTED: {
    label: 'Cleaning Cycle Started',
    category: 'Filter Operations',
    template: 'Cleaning cycle started for filter "{targetName}" with reason "{reason}" by {actor}',
    placeholders: ['actor', 'targetName', 'reason'],
  },
  STATE_TRANSITION: {
    label: 'Filter Stage Advanced',
    category: 'Filter Operations',
    // 2026-05-20: include the previous stage so operators can audit
    // movement direction (advance vs. rewind on bypass). Genesis transitions
    // out of a null fromState render the "from" half as "(start)".
    template: 'Filter "{targetName}" advanced from "{fromStage}" to "{stage}" by {actor}',
    placeholders: ['actor', 'targetName', 'fromStage', 'stage'],
  },
  // Checklist profile questions — {targetName} is the owning profile's name,
  // since the question row itself has no name an inspector would recognise.
  CHECKLIST_QUESTION_ADDED: {
    label: 'Checklist Question Added',
    category: 'Data & Approvals',
    template: 'Question added to checklist "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  CHECKLIST_QUESTION_UPDATED: {
    label: 'Checklist Question Updated',
    category: 'Data & Approvals',
    template: 'Question updated on checklist "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  CHECKLIST_QUESTION_DELETED: {
    label: 'Checklist Question Deleted',
    category: 'Data & Approvals',
    template: 'Question deleted from checklist "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  CHECKLIST_QUESTIONS_REORDERED: {
    label: 'Checklist Questions Reordered',
    category: 'Data & Approvals',
    template: 'Questions reordered on checklist "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },

  CHECKLIST_COMPLETED: {
    label: 'Checklist Completed',
    category: 'Filter Operations',
    template: 'Checklist "{targetName}" completed for filter by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  BYPASS_DEVIATION: {
    label: 'Stage Bypassed (Deviation)',
    category: 'Filter Operations',
    template: 'Stage "{stage}" bypassed for filter "{targetName}" by {actor} — deviation recorded',
    placeholders: ['actor', 'targetName', 'stage'],
  },
  CYCLE_TERMINATED: {
    label: 'Cleaning Cycle Terminated',
    category: 'Filter Operations',
    template: 'Cleaning cycle terminated for filter "{targetName}" by {actor} — reason: "{reason}"',
    placeholders: ['actor', 'targetName', 'reason'],
  },
  STAGE_APPROVAL_APPROVED: {
    label: 'Cleaning Stage Approved (Interlock)',
    category: 'Filter Operations',
    template: 'Cleaning stage "{stageKey}" approved for filter "{filterName}" by {actor}',
    placeholders: ['actor', 'stageKey', 'filterName'],
  },
  STAGE_APPROVAL_REJECTED: {
    label: 'Cleaning Stage Rejected (Interlock)',
    category: 'Filter Operations',
    template: 'Cleaning stage "{stageKey}" rejected for filter "{filterName}" by {actor} — restart from "{rejectToStateKey}"',
    placeholders: ['actor', 'stageKey', 'filterName', 'rejectToStateKey'],
  },
  STAGE_APPROVAL_SUPERSEDED: {
    label: 'Cleaning Stage Approval Superseded (Closed Undecided)',
    category: 'Filter Operations',
    template: 'Cleaning stage "{stageKey}" approval request for filter "{filterName}" closed without a decision — the filter had already moved on to "{currentState}" ({reason})',
    placeholders: ['stageKey', 'filterName', 'currentState', 'reason'],
  },

  // Cleaning Profiles
  CLEANING_PROFILE_CREATED: {
    label: 'Cleaning Profile Created',
    category: 'Cleaning Profiles',
    template: 'Cleaning profile "{targetName}" created by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  CLEANING_PROFILE_UPDATED: {
    label: 'Cleaning Profile Updated',
    category: 'Cleaning Profiles',
    template: 'Cleaning profile "{targetName}" updated (new version) by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  CLEANING_PROFILE_DELETED: {
    label: 'Cleaning Profile Archived',
    category: 'Cleaning Profiles',
    template: 'Cleaning profile "{targetName}" archived by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  CLEANING_PROFILE_STATUS_CHANGED: {
    label: 'Cleaning Profile Status Changed',
    category: 'Cleaning Profiles',
    template: 'Cleaning profile "{targetName}" status changed to "{status}" by {actor}',
    placeholders: ['actor', 'targetName', 'status'],
  },

  // Filter Profiles
  FILTER_PROFILE_CREATED: {
    label: 'Filter Profile Created',
    category: 'Filter Profiles',
    template: 'Filter profile created for "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  FILTER_PROFILE_UPDATED: {
    label: 'Filter Profile Updated',
    category: 'Filter Profiles',
    template: 'Filter profile updated for "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  FILTER_PROFILE_ASSIGNED: {
    label: 'Filter Profile Assigned',
    category: 'Filter Profiles',
    template: 'Cleaning profile assigned to filter "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },

  // Equipment Groups
  EQUIPMENT_GROUP_CREATED: {
    label: 'Equipment Group Created',
    category: 'Equipment Groups',
    template: 'Equipment group "{targetName}" created for block by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  EQUIPMENT_GROUP_UPDATED: {
    label: 'Equipment Group Updated',
    category: 'Equipment Groups',
    template: 'Equipment group "{targetName}" instruments updated by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  EQUIPMENT_GROUP_DELETED: {
    label: 'Equipment Group Deleted',
    category: 'Equipment Groups',
    template: 'Equipment group "{targetName}" deactivated by {actor}',
    placeholders: ['actor', 'targetName'],
  },

  // PM Schedules
  PM_SCHEDULE_CREATED: {
    label: 'PM Schedule Created',
    category: 'PM Schedules',
    template: 'PM schedule created for "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  PM_SCHEDULE_UPDATED: {
    label: 'PM Schedule Updated',
    category: 'PM Schedules',
    template: 'PM schedule updated for "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  PM_SCHEDULE_DELETED: {
    label: 'PM Schedule Deleted',
    category: 'PM Schedules',
    template: 'PM schedule deleted for "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },

  // Admin Requests
  ADMIN_REQUEST_SUBMITTED: {
    label: 'Admin Request Submitted',
    category: 'Data & Approvals',
    template: 'Admin request submitted — "{targetName}"',
    placeholders: ['targetName'],
  },
  ADMIN_REQUEST_APPROVED: {
    label: 'Admin Request Approved',
    category: 'Data & Approvals',
    template: 'Admin request approved — "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  ADMIN_REQUEST_REJECTED: {
    label: 'Admin Request Rejected',
    category: 'Data & Approvals',
    template: 'Admin request rejected — "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },

  // ── 2026-07-08 reconciliation: templates for actions the app emits but that
  // previously had none (they were rendering as bare title-case). ──

  // Record CRUD — generic verbs disambiguated by record type. {recordType} is the
  // human record type from targetType (Cleaning Profile / Filter Profile /
  // Checklist Profile / PM Schedule). Also renders historical rows.
  CREATED: {
    label: 'Created',
    category: 'Data & Approvals',
    template: 'New {recordType} "{targetName}" created by {actor}',
    placeholders: ['actor', 'recordType', 'targetName'],
  },
  UPDATED: {
    label: 'Updated',
    category: 'Data & Approvals',
    template: '{recordType} "{targetName}" updated by {actor}',
    placeholders: ['actor', 'recordType', 'targetName'],
  },
  DELETED: {
    label: 'Deleted',
    category: 'Data & Approvals',
    template: '{recordType} "{targetName}" deleted by {actor}',
    placeholders: ['actor', 'recordType', 'targetName'],
  },
  ARCHIVED: {
    label: 'Archived',
    category: 'Data & Approvals',
    template: '{recordType} "{targetName}" archived by {actor}',
    placeholders: ['actor', 'recordType', 'targetName'],
  },
  ASSIGNED: {
    label: 'Assigned',
    category: 'Data & Approvals',
    template: '{recordType} assignment updated for "{targetName}" by {actor}',
    placeholders: ['actor', 'recordType', 'targetName'],
  },

  // PM Schedules — deviations + approval workflow
  DEVIATION_OPENED: {
    label: 'PM Deviation Opened',
    category: 'PM Schedules',
    template: 'Overdue-PM deviation opened for AHU "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  DEVIATION_CLOSED: {
    label: 'PM Deviation Closed',
    category: 'PM Schedules',
    template: 'Overdue-PM deviation closed for AHU "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  DEVIATION_OPEN_BLOCKED: {
    label: 'PM Deviation Could Not Be Opened',
    category: 'PM Schedules',
    template: 'Overdue-PM deviation for AHU "{targetName}" could NOT be opened — a closed deviation already occupies this PM task',
    placeholders: ['actor', 'targetName'],
  },
  ACKNOWLEDGE_PM_OVERDUE: {
    label: 'Overdue PM Acknowledged',
    category: 'PM Schedules',
    template: 'Overdue PM task acknowledged for "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  PM_STARTED: {
    label: 'PM Started',
    category: 'PM Schedules',
    template: 'PM started for "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  AHU_PM_FILTER_SET_MODE_UPDATED: {
    label: 'AHU PM Filter-Set Mode Updated',
    category: 'PM Schedules',
    template: 'PM filter-set mode updated for AHU "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  PM_SCHEDULE_APPROVED: {
    label: 'PM Schedule Approved',
    category: 'PM Schedules',
    template: 'PM schedule "{targetName}" approved by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  PM_SCHEDULE_REJECTED: {
    label: 'PM Schedule Rejected',
    category: 'PM Schedules',
    template: 'PM schedule "{targetName}" rejected by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  PM_SCHEDULE_REVIEWED: {
    label: 'PM Schedule Reviewed',
    category: 'PM Schedules',
    template: 'PM schedule "{targetName}" reviewed by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  PM_SCHEDULE_REVIEW_MODIFIED: {
    label: 'PM Schedule Revised in Review',
    category: 'PM Schedules',
    template: 'PM schedule "{targetName}" modified during review by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  PM_SCHEDULE_EDIT_REQUESTED: {
    label: 'PM Schedule Edit Requested',
    category: 'PM Schedules',
    template: 'Edit requested for PM schedule "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  PM_SCHEDULE_RESUBMITTED: {
    label: 'PM Schedule Resubmitted',
    category: 'PM Schedules',
    template: 'PM schedule "{targetName}" resubmitted by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  PM_SCHEDULE_IMPORTED: {
    label: 'PM Schedule Imported',
    category: 'PM Schedules',
    template: 'PM schedule imported for "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },

  // Filter Operations
  DRYER_STARTED: {
    label: 'Dryer Started',
    category: 'Filter Operations',
    template: 'Dryer started for filter "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  DRYER_READINGS_SUBMITTED: {
    label: 'Dryer Readings Submitted',
    category: 'Filter Operations',
    template: 'Dryer readings submitted for filter "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  FILTER_LIFECYCLE_STATE_CHANGED: {
    label: 'Filter Lifecycle State Changed',
    category: 'Filter Operations',
    template: 'Filter "{targetName}" lifecycle state changed by {actor}',
    placeholders: ['actor', 'targetName'],
  },

  // Filter Management — replacement / retirement / bulk / block change
  FILTER_REPLACED: {
    label: 'Filter Replaced',
    category: 'Filter Management',
    template: 'Filter "{targetName}" replaced by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  FILTER_RETIRED: {
    label: 'Filter Retired',
    category: 'Filter Management',
    template: 'Filter "{targetName}" retired by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  BULK_FILTER_UPLOAD: {
    label: 'Filters Bulk Uploaded',
    category: 'Filter Management',
    template: 'Filters bulk-uploaded by {actor}',
    placeholders: ['actor'],
  },
  BLOCK_CHANGE_REQUESTED: {
    label: 'Block Change Requested',
    category: 'Filter Management',
    template: 'Block change requested for filter "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  REPLACEMENT_SCHEDULE_UPLOADED: {
    label: 'Replacement Schedule Uploaded',
    category: 'Filter Management',
    template: 'Replacement schedule uploaded by {actor}',
    placeholders: ['actor'],
  },
  REPLACEMENT_SCHEDULE_APPROVED: {
    label: 'Replacement Schedule Approved',
    category: 'Filter Management',
    template: 'Replacement schedule "{targetName}" approved by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  REPLACEMENT_SCHEDULE_REJECTED: {
    label: 'Replacement Schedule Rejected',
    category: 'Filter Management',
    template: 'Replacement schedule "{targetName}" rejected by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  REPLACEMENT_SCHEDULE_REVIEWED: {
    label: 'Replacement Schedule Reviewed',
    category: 'Filter Management',
    template: 'Replacement schedule "{targetName}" reviewed by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  REPLACEMENT_SCHEDULE_REVIEW_MODIFIED: {
    label: 'Replacement Schedule Revised in Review',
    category: 'Filter Management',
    template: 'Replacement schedule "{targetName}" modified during review by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  REPLACEMENT_SCHEDULE_RESUBMITTED: {
    label: 'Replacement Schedule Resubmitted',
    category: 'Filter Management',
    template: 'Replacement schedule "{targetName}" resubmitted by {actor}',
    placeholders: ['actor', 'targetName'],
  },

  // Data & Approvals
  GUEST_CLEANING_REQUEST_SUBMITTED: {
    label: 'Guest Cleaning Request',
    category: 'Data & Approvals',
    template: 'Guest cleaning request submitted for filter "{targetName}"',
    placeholders: ['targetName'],
  },
  REPORT_REVIEW_SUBMITTED: {
    label: 'Report Sent for Review',
    category: 'Data & Approvals',
    template: 'Report "{targetName}" sent for review by {actor}',
    placeholders: ['actor', 'targetName'],
  },

  // User Management
  USER_GROUP_CREATED: {
    label: 'User Group Created',
    category: 'User Management',
    template: 'User group "{targetName}" created by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  USER_GROUP_UPDATED: {
    label: 'User Group Updated',
    category: 'User Management',
    template: 'User group "{targetName}" updated by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  USER_GROUP_DELETED: {
    label: 'User Group Deleted',
    category: 'User Management',
    template: 'User group "{targetName}" deleted by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  USER_GROUP_MEMBERS_ADDED: {
    label: 'User Group Members Added',
    category: 'User Management',
    template: 'Members added to user group "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  USER_GROUP_MEMBER_REMOVED: {
    label: 'User Group Member Removed',
    category: 'User Management',
    template: 'Member removed from user group "{targetName}" by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  PASSWORD_RESET_REQUEST_APPROVED: {
    label: 'Password Reset Approved',
    category: 'User Management',
    template: 'Password reset request approved for "{targetUser}" by {actor}',
    placeholders: ['actor', 'targetUser'],
  },
  PASSWORD_RESET_REQUEST_REJECTED: {
    label: 'Password Reset Rejected',
    category: 'User Management',
    template: 'Password reset request rejected for "{targetUser}" by {actor}',
    placeholders: ['actor', 'targetUser'],
  },

  // Configuration — help, notifications, integrations, audit self-admin
  HELP_ARTICLE_CREATED: {
    label: 'Help Article Created',
    category: 'Configuration',
    template: 'Help article "{targetName}" created by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  HELP_ARTICLE_UPDATED: {
    label: 'Help Article Updated',
    category: 'Configuration',
    template: 'Help article "{targetName}" updated by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  HELP_ARTICLE_DELETED: {
    label: 'Help Article Deleted',
    category: 'Configuration',
    template: 'Help article "{targetName}" deleted by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  NOTIFICATION_RULE_CREATED: {
    label: 'Notification Rule Created',
    category: 'Configuration',
    template: 'Notification rule "{targetName}" created by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  NOTIFICATION_RULE_UPDATED: {
    label: 'Notification Rule Updated',
    category: 'Configuration',
    template: 'Notification rule "{targetName}" updated by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  NOTIFICATION_RULE_DELETED: {
    label: 'Notification Rule Deleted',
    category: 'Configuration',
    template: 'Notification rule "{targetName}" deleted by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  NOTIFICATION_DELETED: {
    label: 'Notification Deleted',
    category: 'Configuration',
    template: 'Notification "{targetName}" permanently deleted by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  NOTIFICATIONS_BULK_DELETED: {
    label: 'Notifications Bulk Deleted',
    category: 'Configuration',
    template: 'Multiple notifications permanently deleted by {actor}',
    placeholders: ['actor'],
  },
  NOTIFICATION_LOG_DELETED: {
    label: 'Notification Delivery Log Deleted',
    category: 'Configuration',
    template: 'Notification delivery log "{targetName}" permanently deleted by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  LDAP_CONFIG_UPDATED: {
    label: 'LDAP Configuration Updated',
    category: 'Configuration',
    template: 'LDAP configuration updated by {actor}',
    placeholders: ['actor'],
  },
  UPDATE_EMAIL_CONFIG: {
    label: 'Email Settings Updated',
    category: 'Configuration',
    template: 'Email (SMTP) settings updated by {actor}',
    placeholders: ['actor'],
  },
  UPDATE_SMS_CONFIG: {
    label: 'SMS Settings Updated',
    category: 'Configuration',
    template: 'SMS gateway settings updated by {actor}',
    placeholders: ['actor'],
  },
  DASHBOARD_CREATED: {
    label: 'Dashboard Created',
    category: 'Configuration',
    template: 'Dashboard "{targetName}" created by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  SUPER_ADMIN_API_ACCESS_CHANGED: {
    label: 'Super Admin API Access Changed',
    category: 'Configuration',
    template: 'Super Admin API access changed by {actor}',
    placeholders: ['actor'],
  },
  GRANT_OFFLINE_REPLAY: {
    label: 'Offline Replay Granted',
    category: 'Configuration',
    template: 'Offline replay window granted by {actor}',
    placeholders: ['actor'],
  },
  AUDIT_RECORD_DELETED: {
    label: 'Audit Record Deleted',
    category: 'Configuration',
    template: 'Audit record permanently deleted by {actor} — reason: "{reason}"',
    placeholders: ['actor', 'reason'],
  },
  AUDIT_RECORD_REDACTED: {
    label: 'Audit Record Redacted',
    category: 'Configuration',
    template: 'Audit record redacted by {actor} — reason: "{reason}"',
    placeholders: ['actor', 'reason'],
  },
  AUDIT_RECORDS_BULK_DELETED: {
    label: 'Audit Records Bulk Deleted',
    category: 'Configuration',
    template: 'Multiple audit records permanently deleted by {actor} — reason: "{reason}"',
    placeholders: ['actor', 'reason'],
  },
  AUDIT_RECORDS_BULK_REDACTED: {
    label: 'Audit Records Bulk Redacted',
    category: 'Configuration',
    template: 'Multiple audit records redacted by {actor} — reason: "{reason}"',
    placeholders: ['actor', 'reason'],
  },

  // Instruments — {instrument} renders the human code (e.g. "PROBE-01"), not the
  // UUID, so the trail is readable without a lookup.
  INSTRUMENT_CREATED: {
    label: 'Instrument Created',
    category: 'Instruments',
    template: 'Instrument "{instrument}" created by {actor}',
    placeholders: ['actor', 'instrument'],
  },
  INSTRUMENT_UPDATED: {
    label: 'Instrument Updated',
    category: 'Instruments',
    template: 'Instrument "{instrument}" updated by {actor}',
    placeholders: ['actor', 'instrument'],
  },
  INSTRUMENT_DELETED: {
    label: 'Instrument Deleted',
    category: 'Instruments',
    template: 'Instrument "{instrument}" deleted by {actor}',
    placeholders: ['actor', 'instrument'],
  },
  INSTRUMENT_TOKEN_REGENERATED: {
    label: 'Instrument Token Regenerated',
    category: 'Instruments',
    template: 'Access token for instrument "{instrument}" regenerated by {actor} — the previous token was revoked',
    placeholders: ['actor', 'instrument'],
  },
  INSTRUMENT_GATEWAY_ENABLED: {
    label: 'Instrument Gateway Mode Enabled',
    category: 'Instruments',
    template: 'Instrument "{instrument}" enabled as a gateway by {actor}',
    placeholders: ['actor', 'instrument'],
  },
  INSTRUMENT_GATEWAY_DISABLED: {
    label: 'Instrument Gateway Mode Disabled',
    category: 'Instruments',
    template: 'Gateway mode disabled on instrument "{instrument}" by {actor}',
    placeholders: ['actor', 'instrument'],
  },
  INSTRUMENT_LINKED_TO_GATEWAY: {
    label: 'Instrument Linked to Gateway',
    category: 'Instruments',
    template: 'Instrument "{instrument}" linked to gateway "{gateway}" by {actor}',
    placeholders: ['actor', 'instrument', 'gateway'],
  },
  INSTRUMENT_UNLINKED_FROM_GATEWAY: {
    label: 'Instrument Unlinked from Gateway',
    category: 'Instruments',
    template: 'Instrument "{instrument}" unlinked from gateway "{gateway}" by {actor}',
    placeholders: ['actor', 'instrument', 'gateway'],
  },
};

/** Extract just the template strings as defaults for the config schema */
export function getDefaultTemplates(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, def] of Object.entries(AUDIT_TEMPLATE_DEFAULTS)) {
    result[key] = def.template;
  }
  return result;
}
