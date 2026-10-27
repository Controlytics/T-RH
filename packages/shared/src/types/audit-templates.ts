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
  REPORT_GENERATED: {
    label: 'Report Generation',
    category: 'Data & Approvals',
    template: '{targetType} report generated by {actor}',
    placeholders: ['actor', 'targetType'],
  },
  // Report review workflow (2026-09-07). Generic placeholders only, so no
  // audit-helpers substitution is needed; targetType is the reportType.
  REPORT_REVIEW_REQUESTED: {
    label: 'Report Approval Requested',
    category: 'Data & Approvals',
    template: '{targetType} report requested for approval by {actor}',
    placeholders: ['actor', 'targetType'],
  },
  REPORT_REVIEW_APPROVED: {
    label: 'Report Approved',
    category: 'Data & Approvals',
    template: '{targetType} report approved by {actor}',
    placeholders: ['actor', 'targetType'],
  },
  REPORT_REVIEW_REJECTED: {
    label: 'Report Rejected',
    category: 'Data & Approvals',
    template: '{targetType} report rejected by {actor}',
    placeholders: ['actor', 'targetType'],
  },
  REPORT_DOWNLOADED: {
    label: 'Approved Report Downloaded',
    category: 'Data & Approvals',
    template: '{targetType} report downloaded by {actor}',
    placeholders: ['actor', 'targetType'],
  },

  // Alarm Management
  ALARM_ACKNOWLEDGED: {
    label: 'Alarm Acknowledged',
    category: 'Instruments',
    template: 'Alarm "{targetName}" acknowledged by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  ALARMS_PURGED: {
    label: 'Alarms Purged',
    category: 'Instruments',
    // Only the generic placeholder: the counts deleted are in the row's
    // before-value, so no second substitution is needed in audit-helpers.ts.
    template: 'All alarm records and webhook delivery receipts purged by {actor}',
    placeholders: ['actor'],
  },
  ALARM_WEBHOOK_CREATED: {
    label: 'Alarm Webhook Created',
    category: 'Instruments',
    template: 'Alarm webhook "{targetName}" created by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  ALARM_WEBHOOK_UPDATED: {
    label: 'Alarm Webhook Updated',
    category: 'Instruments',
    template: 'Alarm webhook "{targetName}" updated by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  ALARM_WEBHOOK_DELETED: {
    label: 'Alarm Webhook Deleted',
    category: 'Instruments',
    template: 'Alarm webhook "{targetName}" deleted by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  ALARM_WEBHOOK_TESTED: {
    label: 'Alarm Webhook Tested',
    category: 'Instruments',
    template: 'Alarm webhook "{targetName}" test-fired by {actor}',
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
  // human record type from targetType. Also renders historical rows.
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

  // Data & Approvals
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
  LDAP_CONNECTION_TESTED: {
    label: 'LDAP Connection Tested',
    category: 'Configuration',
    template: 'LDAP connection tested by {actor}',
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
  DASHBOARD_UPDATED: {
    label: 'Dashboard Updated',
    category: 'Configuration',
    template: 'Dashboard "{targetName}" updated by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  DASHBOARD_DELETED: {
    label: 'Dashboard Deleted',
    category: 'Configuration',
    template: 'Dashboard "{targetName}" deleted by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  DASHBOARD_WIDGET_CREATED: {
    label: 'Dashboard Widget Added',
    category: 'Configuration',
    template: 'Widget "{targetName}" added to a dashboard by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  DASHBOARD_WIDGET_UPDATED: {
    label: 'Dashboard Widget Updated',
    category: 'Configuration',
    template: 'Widget "{targetName}" updated by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  DASHBOARD_WIDGET_DELETED: {
    label: 'Dashboard Widget Removed',
    category: 'Configuration',
    template: 'Widget "{targetName}" removed from a dashboard by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  DASHBOARD_ASSIGNED: {
    label: 'Dashboard Assigned',
    category: 'Configuration',
    template: 'Dashboard "{targetName}" assigned by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  DASHBOARD_UNASSIGNED: {
    label: 'Dashboard Unassigned',
    category: 'Configuration',
    template: 'Dashboard "{targetName}" assignment removed by {actor}',
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
  INSTRUMENT_TOKEN_VIEWED: {
    label: 'Instrument Token Viewed',
    category: 'Instruments',
    template: 'Access token for instrument "{instrument}" was revealed to {actor}',
    placeholders: ['actor', 'instrument'],
  },
  INSTRUMENT_TOKEN_SET: {
    label: 'Instrument Token Set',
    category: 'Instruments',
    template: 'Access token for instrument "{instrument}" replaced with an operator-supplied value by {actor} — the previous token was revoked',
    placeholders: ['actor', 'instrument'],
  },
  DEVICE_CERTIFICATE_ISSUED: {
    label: 'Device Certificate Issued',
    category: 'Instruments',
    template: 'Device certificate for instrument "{instrument}" issued by {actor} — any previous certificate stops working',
    placeholders: ['actor', 'instrument'],
  },
  DEVICE_CERTIFICATE_REVOKED: {
    label: 'Device Certificate Revoked',
    category: 'Instruments',
    template: 'Device certificate for instrument "{instrument}" revoked by {actor}',
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
  // {attribute} is the KEY. The values are deliberately not in the sentence:
  // one of these may be a 1000-character note, which would make the trail
  // unreadable. Both sides are in the row's before/after detail, where the
  // reader who cares can see them.
  INSTRUMENT_ATTRIBUTE_SET: {
    label: 'Instrument Attribute Set',
    category: 'Instruments',
    template: 'Attribute "{attribute}" on instrument "{instrument}" set by {actor}',
    placeholders: ['actor', 'instrument', 'attribute'],
  },
  INSTRUMENT_ATTRIBUTE_REPORTED: {
    label: 'Instrument Attribute Reported by Device',
    category: 'Instruments',
    // No {actor}: there is none. The reporting device's code is in the row's
    // after-value, and `{instrument}` names the instrument it was written on.
    template: 'Attribute "{attribute}" on instrument "{instrument}" reported by the device',
    placeholders: ['instrument', 'attribute'],
  },
  TELEMETRY_READING_REWRITTEN: {
    label: 'Stored Reading Rewritten by Device',
    category: 'Instruments',
    // No {actor}: a device re-sent the instant. The key is `{attribute}` (the
    // placeholder the audit view already substitutes); the instant, both
    // values and the sender are in the row's before/after values.
    template: 'Stored reading "{attribute}" on instrument "{instrument}" rewritten by a device re-send',
    placeholders: ['instrument', 'attribute'],
  },
  INSTRUMENT_ATTRIBUTE_REMOVED: {
    label: 'Instrument Attribute Removed',
    category: 'Instruments',
    template: 'Attribute "{attribute}" removed from instrument "{instrument}" by {actor}',
    placeholders: ['actor', 'instrument', 'attribute'],
  },
  // Instrument profiles (written since 2026-08-07; templates added 2026-10-05,
  // audit DATA-10 — the three actions rendered as their raw names until then).
  // The rows carry the profile's `name`, which {targetName} reads.
  INSTRUMENT_PROFILE_CREATED: {
    label: 'Instrument Profile Created',
    category: 'Instruments',
    template: 'Instrument profile "{targetName}" created by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  INSTRUMENT_PROFILE_UPDATED: {
    label: 'Instrument Profile Updated',
    category: 'Instruments',
    template: 'Instrument profile "{targetName}" updated by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  INSTRUMENT_PROFILE_DELETED: {
    label: 'Instrument Profile Deleted',
    category: 'Instruments',
    template: 'Instrument profile "{targetName}" deleted by {actor}',
    placeholders: ['actor', 'targetName'],
  },
  // A month of readings dropped by the telemetry retention task (2026-10-05,
  // audit DATA-9). A SYSTEM action — no {actor}; the partition name is the
  // targetId and {targetName} reads it, the row count is in the before-value.
  RETENTION_EXECUTED: {
    label: 'Telemetry Retention Executed',
    category: 'Instruments',
    template: 'Telemetry partition "{targetName}" dropped by the retention schedule',
    placeholders: ['targetName'],
  },
  FUNCTIONAL_LOCATION_CREATED: {
    label: 'Functional Location Created',
    category: 'Instruments',
    template: 'Functional location "{location}" created by {actor}',
    placeholders: ['actor', 'location'],
  },
  FUNCTIONAL_LOCATION_UPDATED: {
    label: 'Functional Location Updated',
    category: 'Instruments',
    template: 'Functional location "{location}" updated by {actor}',
    placeholders: ['actor', 'location'],
  },
  FUNCTIONAL_LOCATION_DELETED: {
    label: 'Functional Location Deleted',
    category: 'Instruments',
    template: 'Functional location "{location}" deleted by {actor}',
    placeholders: ['actor', 'location'],
  },
  FUNCTIONAL_LOCATION_INSTRUMENTS_CHANGED: {
    label: 'Functional Location Instruments Changed',
    category: 'Instruments',
    template: 'Instruments linked to functional location "{location}" changed by {actor}',
    placeholders: ['actor', 'location'],
  },
  FLOORPLAN_CREATED: {
    label: 'Floorplan Created',
    category: 'Instruments',
    template: 'Floorplan "{floorplan}" created by {actor}',
    placeholders: ['actor', 'floorplan'],
  },
  FLOORPLAN_UPDATED: {
    label: 'Floorplan Updated',
    category: 'Instruments',
    template: 'Floorplan "{floorplan}" updated by {actor}',
    placeholders: ['actor', 'floorplan'],
  },
  FLOORPLAN_DELETED: {
    label: 'Floorplan Deleted',
    category: 'Instruments',
    template: 'Floorplan "{floorplan}" deleted by {actor}',
    placeholders: ['actor', 'floorplan'],
  },
  FLOORPLAN_ROOM_CREATED: {
    label: 'Room Created',
    category: 'Instruments',
    template: 'Room "{room}" added to floorplan "{floorplan}" by {actor}',
    placeholders: ['actor', 'room', 'floorplan'],
  },
  FLOORPLAN_ROOM_UPDATED: {
    label: 'Room Updated',
    category: 'Instruments',
    template: 'Room "{room}" updated by {actor}',
    placeholders: ['actor', 'room'],
  },
  FLOORPLAN_ROOM_DELETED: {
    label: 'Room Deleted',
    category: 'Instruments',
    template: 'Room "{room}" deleted by {actor}',
    placeholders: ['actor', 'room'],
  },
  // A link between two rooms: an opening in their shared wall or a drawn
  // connector (Layout Designer, 2026-09-22). `{room}` carries "A ↔ B" — the
  // route writes it as `code`, so the existing substitution prints it and no
  // new placeholder (and no second edit in audit-helpers.ts) is needed.
  FLOORPLAN_LINK_CREATED: {
    label: 'Room Link Created',
    category: 'Instruments',
    template: 'Room link {room} created by {actor}',
    placeholders: ['actor', 'room'],
  },
  FLOORPLAN_LINK_UPDATED: {
    label: 'Room Link Updated',
    category: 'Instruments',
    template: 'Room link {room} updated by {actor}',
    placeholders: ['actor', 'room'],
  },
  FLOORPLAN_LINK_DELETED: {
    label: 'Room Link Deleted',
    category: 'Instruments',
    template: 'Room link {room} deleted by {actor}',
    placeholders: ['actor', 'room'],
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
