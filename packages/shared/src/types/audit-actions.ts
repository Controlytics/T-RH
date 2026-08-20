/**
 * 21 CFR Part 11 inspector contracts — audit action enum.
 *
 * **Deprecation policy:** entries are NEVER deleted, even if no production
 * code currently emits them. The audit-template editor at
 * `/config/audit-templates` renders one row per entry so operators can
 * customise the human-readable description for each action. Inspectors
 * reference the enum by name as the controlled vocabulary of audit-able
 * events; removing an entry would orphan any operator-customised template
 * tied to it and would force a regulatory documentation update.
 *
 * **Currently unemitted entries (audit 2026-05-16):** the following 16
 * entries have zero `audit.log({ action: 'X' })` call-sites in apps/api/src
 * but are retained per the policy above. If you wire one up, no annotation
 * change is needed — emitting it just makes the contract truthful again.
 *
 *   ROLE_ASSIGNED, APPROVAL_REQUESTED, APPROVAL_GRANTED, APPROVAL_REJECTED,
 *   DATA_VIEWED, DATA_EXPORTED, ALARM_ESCALATED,
 *   SEPARATION_OF_DUTIES_DISABLED, RULE_CHAIN_SET_ROOT, RULE_CHAIN_IMPORTED,
 *   DEVICE_CREDENTIAL_REGENERATED, RETENTION_POLICY_UPDATED, DATA_ARCHIVED,
 *   RETENTION_EXECUTED, SYSTEM_CONFIG_UPDATED, SERVER_RESTART_TRIGGERED
 *
 * Future code reviewers: do NOT delete unemitted entries on dead-code
 * cleanup grounds. See tasks/CLEANUP-ANALYSIS-2026-05-16.md §3.7 + Tier 3
 * "Deliberate Keep" items.
 */
export const AUDIT_ACTIONS = {
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_DELETED: 'USER_DELETED',
  USER_ENABLED: 'USER_ENABLED',
  USER_DISABLED: 'USER_DISABLED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  ROLE_ASSIGNED: 'ROLE_ASSIGNED',
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  SESSION_TIMEOUT: 'SESSION_TIMEOUT',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_UNLOCKED: 'ACCOUNT_UNLOCKED',
  PASSWORD_EXPIRED: 'PASSWORD_EXPIRED',
  CONFIG_CHANGED: 'CONFIG_CHANGED',
  APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
  APPROVAL_GRANTED: 'APPROVAL_GRANTED',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',
  // Cleaning stage interlock — QA approve/reject signature (2026-06-12)
  STAGE_APPROVAL_APPROVED: 'STAGE_APPROVAL_APPROVED',
  STAGE_APPROVAL_REJECTED: 'STAGE_APPROVAL_REJECTED',
  // Closed WITHOUT a decision — the filter left the gate before the approver acted,
  // so no e-signature was ever given. Not a decision; the inspector's record of WHY
  // a §11 approval request ended undecided (2026-07-15).
  STAGE_APPROVAL_SUPERSEDED: 'STAGE_APPROVAL_SUPERSEDED',
  DATA_VIEWED: 'DATA_VIEWED',
  DATA_EXPORTED: 'DATA_EXPORTED',
  UNAUTHORIZED_ACTION_ATTEMPT: 'UNAUTHORIZED_ACTION_ATTEMPT',
  BULK_USER_DELETED: 'BULK_USER_DELETED',
  BACKUP_CREATED: 'BACKUP_CREATED',
  BACKUP_RESTORED: 'BACKUP_RESTORED',


  // Data Ingestion & Integration (Phase A)
  DATA_ATTRIBUTES_UPDATED: 'DATA_ATTRIBUTES_UPDATED',

  // Alarms — retained per 21 CFR §11 — no longer emitted as of 2026-05-17
  ALARM_CREATED: 'ALARM_CREATED',
  ALARM_ACKNOWLEDGED: 'ALARM_ACKNOWLEDGED',
  ALARM_CLEARED: 'ALARM_CLEARED',
  ALARM_ESCALATED: 'ALARM_ESCALATED',

  // Segregation-of-duties control
  SEPARATION_OF_DUTIES_DISABLED: 'SEPARATION_OF_DUTIES_DISABLED',

  // Rule chain — retained per 21 CFR §11 — no longer emitted as of 2026-05-17
  RULE_CHAIN_CREATED: 'RULE_CHAIN_CREATED',
  RULE_CHAIN_UPDATED: 'RULE_CHAIN_UPDATED',
  RULE_CHAIN_DELETED: 'RULE_CHAIN_DELETED',
  RULE_CHAIN_SET_ROOT: 'RULE_CHAIN_SET_ROOT',
  RULE_CHAIN_IMPORTED: 'RULE_CHAIN_IMPORTED',

  // Auth (additional)
  FORCED_LOGOUT: 'FORCED_LOGOUT',
  PROFILE_UPDATED: 'PROFILE_UPDATED',

  // Password Reset Requests
  PASSWORD_RESET_REQUEST_APPROVED: 'PASSWORD_RESET_REQUEST_APPROVED',
  PASSWORD_RESET_REQUEST_REJECTED: 'PASSWORD_RESET_REQUEST_REJECTED',

  // Audit Record Management
  AUDIT_RECORD_DELETED: 'AUDIT_RECORD_DELETED',
  AUDIT_RECORDS_BULK_DELETED: 'AUDIT_RECORDS_BULK_DELETED',

  // Credentials
  DEVICE_CREDENTIAL_REGENERATED: 'DEVICE_CREDENTIAL_REGENERATED',

  // UNS
  UNS_PATH_OVERRIDDEN: 'UNS_PATH_OVERRIDDEN',
  UNS_CONFIG_UPDATED: 'UNS_CONFIG_UPDATED',

  // User Groups — membership drives notification recipient resolution
  // (notification-dispatcher.ts), so every mutation is a record change.
  USER_GROUP_CREATED: 'USER_GROUP_CREATED',
  USER_GROUP_UPDATED: 'USER_GROUP_UPDATED',
  USER_GROUP_DELETED: 'USER_GROUP_DELETED',
  USER_GROUP_MEMBERS_ADDED: 'USER_GROUP_MEMBERS_ADDED',
  USER_GROUP_MEMBER_REMOVED: 'USER_GROUP_MEMBER_REMOVED',

  // Notification rules
  NOTIFICATION_RULE_CREATED: 'NOTIFICATION_RULE_CREATED',
  NOTIFICATION_RULE_UPDATED: 'NOTIFICATION_RULE_UPDATED',
  NOTIFICATION_RULE_DELETED: 'NOTIFICATION_RULE_DELETED',

  // Notification records — physical deletes, no soft-delete fallback.
  NOTIFICATION_DELETED: 'NOTIFICATION_DELETED',
  NOTIFICATIONS_BULK_DELETED: 'NOTIFICATIONS_BULK_DELETED',
  // Delivery log (who was emailed/SMS'd about what) — destroying a row destroys
  // the evidence of the dispatch it recorded.
  NOTIFICATION_LOG_DELETED: 'NOTIFICATION_LOG_DELETED',

  // Help
  HELP_ARTICLE_CREATED: 'HELP_ARTICLE_CREATED',
  HELP_ARTICLE_UPDATED: 'HELP_ARTICLE_UPDATED',
  HELP_ARTICLE_DELETED: 'HELP_ARTICLE_DELETED',

  // Retention
  RETENTION_POLICY_UPDATED: 'RETENTION_POLICY_UPDATED',
  DATA_ARCHIVED: 'DATA_ARCHIVED',
  RETENTION_EXECUTED: 'RETENTION_EXECUTED',

  // System Config
  SYSTEM_CONFIG_UPDATED: 'SYSTEM_CONFIG_UPDATED',
  SERVER_RESTART_TRIGGERED: 'SERVER_RESTART_TRIGGERED',


  // Report generation / export — emitted when a user downloads a report
  // (audit trail, instrument activity, etc.) as PDF/Excel.
  REPORT_GENERATED: 'REPORT_GENERATED',


  // Instruments — the device registry (2026-08-05). Bulk creation emits one
  // INSTRUMENT_CREATED per instrument rather than one row per batch, so the
  // trail stays per-entity and a single device's history is complete on its own.
  INSTRUMENT_CREATED: 'INSTRUMENT_CREATED',
  INSTRUMENT_UPDATED: 'INSTRUMENT_UPDATED',
  INSTRUMENT_DELETED: 'INSTRUMENT_DELETED',
  INSTRUMENT_TOKEN_REGENERATED: 'INSTRUMENT_TOKEN_REGENERATED',
  // Reading a credential back is itself the auditable act (2026-08-06, the D5
  // reversal). It is the compensating control that makes a retrievable token
  // acceptable at all: the token stays a secret, but WHO looked at it and WHEN
  // never is. Neither row ever carries the token value — only its prefix.
  INSTRUMENT_TOKEN_VIEWED: 'INSTRUMENT_TOKEN_VIEWED',
  INSTRUMENT_TOKEN_SET: 'INSTRUMENT_TOKEN_SET',
  // Profiles are grouping only, but a RENAME changes what an inspector reads
  // against every instrument inside the profile — so the change to the profile
  // is itself an auditable event. MOVING an instrument between profiles is
  // covered by the existing INSTRUMENT_UPDATED row, whose before/after already
  // carries changed fields.
  INSTRUMENT_PROFILE_CREATED: 'INSTRUMENT_PROFILE_CREATED',
  INSTRUMENT_PROFILE_UPDATED: 'INSTRUMENT_PROFILE_UPDATED',
  INSTRUMENT_PROFILE_DELETED: 'INSTRUMENT_PROFILE_DELETED',
  // Gateway wiring is an ACCESS-CONTROL change, not metadata: `gatewayId` is
  // the rule deciding which credential may write an instrument's telemetry, so
  // every link/unlink/enable/disable gets its own row rather than hiding inside
  // a generic INSTRUMENT_UPDATED.
  INSTRUMENT_GATEWAY_ENABLED: 'INSTRUMENT_GATEWAY_ENABLED',
  INSTRUMENT_GATEWAY_DISABLED: 'INSTRUMENT_GATEWAY_DISABLED',
  INSTRUMENT_LINKED_TO_GATEWAY: 'INSTRUMENT_LINKED_TO_GATEWAY',
  INSTRUMENT_UNLINKED_FROM_GATEWAY: 'INSTRUMENT_UNLINKED_FROM_GATEWAY',
  // Free-form attributes (2026-08-06). ONE ROW PER KEY, carrying the key and
  // both values — not a single "attributes changed" row. An attribute may hold a
  // calibration due date or a validation reference, so "who moved the
  // calibration date, from what, to what" has to be answerable directly from the
  // trail rather than by diffing two blobs.
  INSTRUMENT_ATTRIBUTE_SET: 'INSTRUMENT_ATTRIBUTE_SET',
  INSTRUMENT_ATTRIBUTE_REMOVED: 'INSTRUMENT_ATTRIBUTE_REMOVED',

  // Floorplans and their rooms. A room carries the environmental SPECIFICATION
  // for a space, so "who changed this temperature limit, from what, to what"
  // must be answerable. This is the opposite of telemetry itself, which stays
  // deliberately unaudited as process data (see telemetry.repository.ts).
  FLOORPLAN_CREATED: 'FLOORPLAN_CREATED',
  FLOORPLAN_UPDATED: 'FLOORPLAN_UPDATED',
  FLOORPLAN_DELETED: 'FLOORPLAN_DELETED',
  FLOORPLAN_ROOM_CREATED: 'FLOORPLAN_ROOM_CREATED',
  FLOORPLAN_ROOM_UPDATED: 'FLOORPLAN_ROOM_UPDATED',
  FUNCTIONAL_LOCATION_CREATED: 'FUNCTIONAL_LOCATION_CREATED',
  FUNCTIONAL_LOCATION_UPDATED: 'FUNCTIONAL_LOCATION_UPDATED',
  FUNCTIONAL_LOCATION_DELETED: 'FUNCTIONAL_LOCATION_DELETED',
  FUNCTIONAL_LOCATION_INSTRUMENTS_CHANGED: 'FUNCTIONAL_LOCATION_INSTRUMENTS_CHANGED',
  FLOORPLAN_ROOM_DELETED: 'FLOORPLAN_ROOM_DELETED',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
