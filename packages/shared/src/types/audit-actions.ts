/**
 * 21 CFR Part 11 inspector contracts — audit action enum.
 *
 * THE controlled vocabulary of audit-able events: every `action` the API
 * writes into `audit_trail` is a key here, and every key here has a default
 * template in `audit-templates.ts` (the editor at `/config/audit-templates`
 * renders one row per template). Two tests hold that:
 *
 *   - `apps/api/src/lib/__tests__/audit-actions-registry.test.ts` — every
 *     `action: '…'` literal under `apps/api/src` (non-test) is a key here;
 *   - `packages/shared/src/types/audit-actions.test.ts` — every key here has
 *     a template, and the registry carries no name nothing writes.
 *
 * **Re-synced 2026-10-05 (audit 2026-10-03, DATA-10).** The registry and the
 * writers had drifted BOTH ways: eleven actions were written in production
 * code and absent here (the redactions, the three ROLE_*, the admin request,
 * LDAP, the two notification-config writes, the super-admin API-access switch,
 * the dashboard), and twenty-eight entries had no writer anywhere in the tree
 * — the removed filter / rule-chain / UNS / data-ingestion domains and a
 * handful that were never wired (`SESSION_TIMEOUT`, `ROLE_ASSIGNED`,
 * `APPROVAL_*`, `STAGE_APPROVAL_*`, `DATA_*`, `ALARM_CREATED` / `_CLEARED` /
 * `_ESCALATED`, `RULE_CHAIN_*`, `UNS_*`, `DEVICE_CREDENTIAL_REGENERATED`,
 * `SEPARATION_OF_DUTIES_DISABLED`, `RETENTION_POLICY_UPDATED`,
 * `DATA_ARCHIVED`, `SYSTEM_CONFIG_UPDATED`, `SERVER_RESTART_TRIGGERED`,
 * `UNAUTHORIZED_ACTION_ATTEMPT`). The earlier header's "never delete an
 * unemitted entry" policy was written for a vocabulary inspectors had seen;
 * it was measured against both local databases before the prune — ZERO
 * `audit_trail` rows carry any of the removed names — so no stored record
 * loses its template, and a registry three-quarters true is not a controlled
 * vocabulary. If one of these actions is ever written again, add it back
 * WITH its template in the same commit; the two tests above fail otherwise.
 *
 * `RETENTION_EXECUTED` was on the never-written list and is kept: the
 * telemetry retention task writes it since the same day (DATA-9).
 */
export const AUDIT_ACTIONS = {
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_DELETED: 'USER_DELETED',
  USER_ENABLED: 'USER_ENABLED',
  USER_DISABLED: 'USER_DISABLED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_UNLOCKED: 'ACCOUNT_UNLOCKED',
  PASSWORD_EXPIRED: 'PASSWORD_EXPIRED',
  CONFIG_CHANGED: 'CONFIG_CHANGED',
  BULK_USER_DELETED: 'BULK_USER_DELETED',
  BACKUP_CREATED: 'BACKUP_CREATED',
  BACKUP_RESTORED: 'BACKUP_RESTORED',

  // Roles (written by roles/role.service.ts since the fork; registered
  // 2026-10-05).
  ROLE_CREATED: 'ROLE_CREATED',
  ROLE_UPDATED: 'ROLE_UPDATED',
  ROLE_DELETED: 'ROLE_DELETED',

  // Alarms
  ALARM_ACKNOWLEDGED: 'ALARM_ACKNOWLEDGED',
  /**
   * Every alarm record and every webhook delivery receipt deleted at once
   * (2026-09-21, operator: "once remove all the alarms data"). Written by
   * `apps/api/scripts/purge-alarms.ts`, never by a route — there is no
   * endpoint that deletes an alarm. The counts deleted are in the before-value.
   */
  ALARMS_PURGED: 'ALARMS_PURGED',
  ALARM_WEBHOOK_CREATED: 'ALARM_WEBHOOK_CREATED',
  ALARM_WEBHOOK_UPDATED: 'ALARM_WEBHOOK_UPDATED',
  ALARM_WEBHOOK_DELETED: 'ALARM_WEBHOOK_DELETED',
  ALARM_WEBHOOK_TESTED: 'ALARM_WEBHOOK_TESTED',

  // Auth (additional)
  FORCED_LOGOUT: 'FORCED_LOGOUT',
  PROFILE_UPDATED: 'PROFILE_UPDATED',

  // Password Reset Requests
  PASSWORD_RESET_REQUEST_APPROVED: 'PASSWORD_RESET_REQUEST_APPROVED',
  PASSWORD_RESET_REQUEST_REJECTED: 'PASSWORD_RESET_REQUEST_REJECTED',

  // Admin requests — the PUBLIC "contact an administrator" form; a SYSTEM
  // action (no authenticated caller), see SYSTEM_AUDIT_ACTIONS in lib/audit.ts.
  ADMIN_REQUEST_SUBMITTED: 'ADMIN_REQUEST_SUBMITTED',

  // Audit Record Management. REDACT clears a row's payloads and keeps the
  // chain; DELETE is the physical removal behind AUDIT_DELETE. Each writes a
  // meta row naming what it touched — the verifier cross-checks every redacted
  // row against one (lib/audit-verify.ts).
  AUDIT_RECORD_REDACTED: 'AUDIT_RECORD_REDACTED',
  AUDIT_RECORDS_BULK_REDACTED: 'AUDIT_RECORDS_BULK_REDACTED',
  AUDIT_RECORD_DELETED: 'AUDIT_RECORD_DELETED',
  AUDIT_RECORDS_BULK_DELETED: 'AUDIT_RECORDS_BULK_DELETED',

  // Directory and super-admin configuration
  LDAP_CONFIG_UPDATED: 'LDAP_CONFIG_UPDATED',
  SUPER_ADMIN_API_ACCESS_CHANGED: 'SUPER_ADMIN_API_ACCESS_CHANGED',

  // Notification delivery configuration (SMTP / SMS). The names are the
  // route's own since 2026-05; kept as written so historic rows keep their
  // template.
  UPDATE_EMAIL_CONFIG: 'UPDATE_EMAIL_CONFIG',
  UPDATE_SMS_CONFIG: 'UPDATE_SMS_CONFIG',

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

  // Dashboards (a saved dashboard layout row)
  DASHBOARD_CREATED: 'DASHBOARD_CREATED',

  // Help
  HELP_ARTICLE_CREATED: 'HELP_ARTICLE_CREATED',
  HELP_ARTICLE_UPDATED: 'HELP_ARTICLE_UPDATED',
  HELP_ARTICLE_DELETED: 'HELP_ARTICLE_DELETED',

  // Retention — a month of telemetry dropped by the scheduled task
  // (telemetry-partition.worker.ts, 2026-10-05). A SYSTEM action; one row per
  // partition, the row count it held in the before-value.
  RETENTION_EXECUTED: 'RETENTION_EXECUTED',

  // Report generation / export — emitted when a user downloads a report
  // (audit trail, instrument activity, etc.) as PDF/Excel.
  REPORT_GENERATED: 'REPORT_GENERATED',
  // Report review workflow (2026-09-07): a request, its decision, and each
  // download of the approved document. targetType carries the reportType.
  REPORT_REVIEW_REQUESTED: 'REPORT_REVIEW_REQUESTED',
  REPORT_REVIEW_APPROVED: 'REPORT_REVIEW_APPROVED',
  REPORT_REVIEW_REJECTED: 'REPORT_REVIEW_REJECTED',
  REPORT_DOWNLOADED: 'REPORT_DOWNLOADED',

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
  /** An attribute written by the DEVICE over MQTT (`…/attributes/report`,
   *  2026-09-05) — no human actor; the gateway/instrument code is in the row. */
  INSTRUMENT_ATTRIBUTE_REPORTED: 'INSTRUMENT_ATTRIBUTE_REPORTED',
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
  // A link between two rooms of one plan — an opening in their shared wall or
  // a drawn connector (Layout Designer, 2026-09-22).
  FLOORPLAN_LINK_CREATED: 'FLOORPLAN_LINK_CREATED',
  FLOORPLAN_LINK_UPDATED: 'FLOORPLAN_LINK_UPDATED',
  FLOORPLAN_LINK_DELETED: 'FLOORPLAN_LINK_DELETED',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
