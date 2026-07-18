export const REAUTH_ACTIONS = {
  // User Management
  CREATE_USER: { label: 'Create User', category: 'User Management' },
  UPDATE_USER: { label: 'Update User', category: 'User Management' },
  DELETE_USER: { label: 'Delete User', category: 'User Management' },
  BULK_DELETE_USERS: { label: 'Bulk Delete Users', category: 'User Management' },
  ENABLE_USER: { label: 'Enable User', category: 'User Management' },
  DISABLE_USER: { label: 'Disable User', category: 'User Management' },
  UNLOCK_USER: { label: 'Unlock User', category: 'User Management' },
  RESET_PASSWORD: { label: 'Reset Password', category: 'User Management' },
  PROCESS_RESET_REQUEST: { label: 'Process Reset Request', category: 'User Management' },
  UPDATE_PROFILE: { label: 'Update Own Profile', category: 'User Management' },
  // M1 (audit 2026-05-04): admin-request approve/reject was reusing CREATE_USER.
  // That conflated audit trails for password-reset / unlock / modify-user
  // approvals (none of which are user-creation). Distinct action keeps the
  // audit trail truthful: "submitter created the user" vs "approver executed
  // the request".
  APPROVE_ADMIN_REQUEST: { label: 'Approve / Reject Admin Request', category: 'User Management' },

  // Config Changes
  UPDATE_PASSWORD_POLICY: { label: 'Update Password Policy', category: 'Configuration' },
  UPDATE_LOGIN_SECURITY: { label: 'Update Login Security', category: 'Configuration' },
  UPDATE_SESSION_CONFIG: { label: 'Update Session Config', category: 'Configuration' },
  UPDATE_DATETIME_CONFIG: { label: 'Update Date/Time Config', category: 'Configuration' },
  UPDATE_USERID_CONFIG: { label: 'Update User ID Config', category: 'Configuration' },
  UPDATE_BRANDING: { label: 'Update Branding', category: 'Configuration' },
  UPDATE_ROLE_CONFIG: { label: 'Update Role Config', category: 'Configuration' },
  // Audit 2026-06-08: PUT /api/config/users/:userId can grant per-user PERMISSION
  // overrides (privilege escalation) — dedicated reauth key + unambiguous audit.
  UPDATE_USER_CONFIG: { label: 'Update User Config', category: 'Configuration' },
  // (MANAGE_DEVICE_CREDENTIAL removed with data-ingestion removal — DeviceCredential model dropped.)
  // C6 (review 2026-05-04): the action-reauth save itself was a privilege
  // escalation — anyone with CONFIG_UPDATE could PUT /api/config/action-reauth
  // without challenge, including disabling reauth on DELETE_USER then deleting
  // users. Dedicated key (rather than reusing UPDATE_ROLE_CONFIG) keeps the
  // audit trail unambiguous: "operator changed who-needs-reauth-for-what".
  UPDATE_REAUTH_CONFIG: { label: 'Update Re-auth Config', category: 'Configuration' },
  // C3 (review 2026-05-04): notification-delivery routes called
  // enforceReauth('UPDATE_EMAIL_CONFIG'/'UPDATE_SMS_CONFIG') against actions
  // that did not exist in this map — isReauthRequired() would always return
  // false, silently disabling the gate. Added so the operator-facing reauth
  // policy page can require step-up auth on outbound-comms credential edits.
  UPDATE_EMAIL_CONFIG: { label: 'Update Email Config', category: 'Configuration' },
  UPDATE_SMS_CONFIG: { label: 'Update SMS Config', category: 'Configuration' },
  // Offline-cache settings are SUPER_ADMIN-only; require step-up auth on
  // changes because operators rely on the configured staleness + hard-cutoff
  // values for 21 CFR Part 11 read-only-lockout enforcement.
  UPDATE_OFFLINE_CACHE_CONFIG: { label: 'Update Offline Cache Config', category: 'Configuration' },

  // Role Management
  CREATE_ROLE: { label: 'Create Role', category: 'Role Management' },
  UPDATE_ROLE: { label: 'Update Role', category: 'Role Management' },
  DELETE_ROLE: { label: 'Delete Role', category: 'Role Management' },

  // Backup
  EXPORT_BACKUP: { label: 'Export Backup', category: 'Backup' },
  RESTORE_BACKUP: { label: 'Restore Backup', category: 'Backup' },

  // Asset Management
  CREATE_ASSET: { label: 'Create Asset', category: 'Asset Management' },
  UPDATE_ASSET: { label: 'Update Asset', category: 'Asset Management' },
  DELETE_ASSET: { label: 'Delete Asset', category: 'Asset Management' },
  // 2026-05-26 audit fix (PA-CLEANUP-4): CREATE_ASSET_RELATIONSHIP +
  // DELETE_ASSET_RELATIONSHIP removed — neither FE nor BE ever called
  // enforceReauth / reauth.execute with those names. Dead constants.
  CREATE_ASSET_IDENTIFIER: { label: 'Create Asset Identifier', category: 'Asset Management' },
  DELETE_ASSET_IDENTIFIER: { label: 'Delete Asset Identifier', category: 'Asset Management' },

  // Data Ingestion & Integration (Phase A)
  CREATE_CHECKLIST_PROFILE: { label: 'Create Checklist Profile', category: 'Checklist' },
  UPDATE_CHECKLIST_PROFILE: { label: 'Update Checklist Profile', category: 'Checklist' },
  DELETE_CHECKLIST_PROFILE: { label: 'Delete Checklist Profile', category: 'Checklist' },
  SUBMIT_CHECKLIST_WITH_SIGNATURE: { label: 'Submit Checklist with Signature', category: 'Checklist' },
  // (OVERRIDE_UNS_PATH / DELETE_UNS_MAPPING / UPDATE_UNS_CONFIG removed with data-ingestion removal.)
  CREATE_HELP_ARTICLE: { label: 'Create Help Article', category: 'Help' },
  UPDATE_HELP_ARTICLE: { label: 'Update Help Article', category: 'Help' },
  DELETE_HELP_ARTICLE: { label: 'Delete Help Article', category: 'Help' },
  // (UPDATE_RETENTION_POLICY / EXECUTE_RETENTION removed with data-ingestion removal.)
  // Audit deletion (audit 2026-05-04 fix #5 — web-routes review H4):
  // 21 CFR Part 11 § 11.10(e) requires audit-trail records be "secure".
  // Deletion is NOT allowed — it broke the hash chain at the deletion point.
  // REDACT replaces it: payload is NULLed but checksum + chain link preserved.
  // Distinct keys for single vs bulk so the surviving audit row records the
  // operator's intent. Delta-audit 2026-05-20 §C1 / May 16 §1.2 fix.
  REDACT_AUDIT_RECORD: { label: 'Redact Audit Record', category: 'Configuration' },
  BULK_REDACT_AUDIT_RECORDS: { label: 'Bulk Redact Audit Records', category: 'Configuration' },
  // 2026-07-01: physical hard-delete of audit rows (breaks the hash chain — see
  // modules/audit/routes.ts). Distinct keys from redact so the reauth policy can
  // differ, and the surviving meta-audit row records single vs bulk intent.
  DELETE_AUDIT_RECORD: { label: 'Delete Audit Record', category: 'Configuration' },
  BULK_DELETE_AUDIT_RECORDS: { label: 'Bulk Delete Audit Records', category: 'Configuration' },
  // 2026-05-26 audit fix (PA-REAUTH-4): notification bulk-delete is
  // destructive (irreversible, no recycle bin) and was missing reauth.
  // Single-delete uses the same key — same blast radius per row.
  DELETE_NOTIFICATION: { label: 'Delete Notification', category: 'Notifications' },
  BULK_DELETE_NOTIFICATIONS: { label: 'Bulk Delete Notifications', category: 'Notifications' },
  // 2026-05-26 audit fix (PA-REAUTH-3): super-admin filter-data
  // routes (super-admin/routes.ts) can edit/delete cleaning cycles,
  // filter events, notifications, admin-requests, etc. with no audit
  // trail (per current code comment). Adding reauth on every mutation
  // is the bare-minimum hardening pending the larger audit-trail
  // retrofit. Applies to every PUT/DELETE/POST in super-admin/routes.ts.
  SUPER_ADMIN_DATA_EDIT: { label: 'Super-Admin Data Edit', category: 'Super Admin' },
  // LDAP config (audit 2026-05-04 fix #5 — web-routes review H2):
  // bind credentials and base-DN edits can redirect every login to an
  // attacker-controlled directory. Distinct from UPDATE_LOGIN_SECURITY
  // so the audit trail makes the source-of-trust change explicit.
  UPDATE_LDAP_CONFIG: { label: 'Update LDAP Config', category: 'Configuration' },
  // (CREATE/UPDATE/DELETE_TEMPLATE_KIND removed 2026-07-04 — dead/theater: they
  //  rendered in the action-reauth config UI but no endpoint ever enforced them.
  //  Template kinds are seed-only; there is no runtime template-kind CRUD route.)
  // Audit 2026-05-04 fix #5 (web-routes review H — lower-blast config
  // surfaces). Distinct keys would force operators to maintain a check
  // matrix per page; this single umbrella reauth action covers the
  // remaining smaller-blast config writes (dashboard-cards visibility,
  // cleaning-profile-assignment rules, filter-cleaning-reasons
  // dropdown, ahu-filter-set-config mode toggle). The audit row's
  // targetType + targetId distinguishes the surface; the action is
  // shared so operators can opt in / out via one reauth-policy entry.
  UPDATE_CONFIG_PAGE: { label: 'Update Configuration Page', category: 'Configuration' },

  // Phase 2: Filter Management
  START_CLEANING_CYCLE: { label: 'Start Cleaning Cycle', category: 'Filter Management' },
  // Audit S-4 (2026-05-29): POST /:id/advance was the only cycle endpoint
  // without enforceReauth. Every sibling (start-cycle, submit-checklist,
  // bypass, retire, replace, terminate-cycle) requires step-up auth.
  // Advancing through a stage IS a 21 CFR §11 signature-of-intent event —
  // it is the highest-frequency operator action and must be operator-owned.
  ADVANCE_FILTER_STAGE: { label: 'Advance Filter to Next Stage', category: 'Filter Management' },
  BYPASS_FILTER_STAGE: { label: 'Bypass Filter Stage (Deviation)', category: 'Filter Management' },
  // Cleaning stage interlock — always-on signature (not config-toggleable). Listed
  // here for the audit/registry view only; enforced via enforceReauthAlways.
  APPROVE_CLEANING_STAGE: { label: 'Approve Cleaning Stage (Interlock)', category: 'Filter Management' },
  REJECT_CLEANING_STAGE: { label: 'Reject Cleaning Stage (Interlock)', category: 'Filter Management' },
  TERMINATE_CLEANING_CYCLE: { label: 'Terminate Cleaning Cycle', category: 'Filter Management' },
  CREATE_FILTER: { label: 'Create Filter', category: 'Filter Management' },
  EDIT_FILTER: { label: 'Edit Filter', category: 'Filter Management' },
  DELETE_FILTER: { label: 'Delete Filter', category: 'Filter Management' },
  RETIRE_FILTER: { label: 'Retire Filter', category: 'Filter Management' },
  REPLACE_FILTER: { label: 'Replace Filter', category: 'Filter Management' },
  BULK_UPLOAD_FILTERS: { label: 'Bulk Upload Filters', category: 'Filter Management' },
  REVIEW_REPLACEMENT_SCHEDULE: { label: 'Review Replacement Schedule', category: 'Filter Management' },
  APPROVE_REPLACEMENT_SCHEDULE: { label: 'Approve Replacement Schedule', category: 'Filter Management' },
  REJECT_REPLACEMENT_SCHEDULE: { label: 'Reject Replacement Schedule', category: 'Filter Management' },
  // M2 (audit 2026-05-04): manual filter lifecycle PATCH (INSTALLED / WASH_IN /
  // ... / IN_USE) was reusing the generic UPDATE_ASSET action, hiding cleanroom
  // lifecycle moves under the same audit key as ordinary asset edits. Dedicated
  // action makes inspector audits unambiguous.
  UPDATE_FILTER_LIFECYCLE: { label: 'Update Filter Lifecycle State', category: 'Filter Management' },
  EDIT_HIERARCHY_NODE: { label: 'Edit Hierarchy Node', category: 'Filter Management' },
  DELETE_HIERARCHY_NODE: { label: 'Delete Hierarchy Node', category: 'Filter Management' },
  CREATE_CLEANING_PROFILE: { label: 'Create Cleaning Profile', category: 'Cleaning Profiles' },
  UPDATE_CLEANING_PROFILE: { label: 'Update Cleaning Profile', category: 'Cleaning Profiles' },
  DELETE_CLEANING_PROFILE: { label: 'Delete Cleaning Profile', category: 'Cleaning Profiles' },
  CREATE_FILTER_PROFILE: { label: 'Create Filter Profile', category: 'Filter Profiles' },
  UPDATE_FILTER_PROFILE: { label: 'Update Filter Profile', category: 'Filter Profiles' },
  DELETE_FILTER_PROFILE: { label: 'Delete Filter Profile', category: 'Filter Profiles' },
  ASSIGN_FILTER_PROFILE: { label: 'Assign Filter Profile', category: 'Filter Profiles' },
  CREATE_PM_SCHEDULE: { label: 'Create PM Schedule', category: 'PM Schedules' },
  UPDATE_PM_SCHEDULE: { label: 'Update PM Schedule', category: 'PM Schedules' },
  DELETE_PM_SCHEDULE: { label: 'Delete PM Schedule', category: 'PM Schedules' },
  EDIT_PM_SCHEDULE: { label: 'Edit PM Entry', category: 'PM Schedules' },
  APPROVE_PM_SCHEDULE: { label: 'Approve PM Schedule', category: 'PM Schedules' },
  REJECT_PM_SCHEDULE: { label: 'Reject PM Schedule', category: 'PM Schedules' },
  REVIEW_PM_SCHEDULE: { label: 'Review PM Schedule', category: 'PM Schedules' },
  // Audit 2026-05-09 fix: bulk PM upload + execution-start + entry resubmit
  // were missing reauth gates. SUPER_ADMIN bulk uploads auto-approve every
  // row (pm-import.ts:133), so the upload was a high-trust mutation with no
  // password challenge. PM execution start creates an immutable PmExecution
  // row comparable to start-cycle (which IS reauth-gated). Resubmit flips
  // REJECTED → PENDING — minor but inconsistent with approve/reject.
  UPLOAD_PM_SCHEDULES: { label: 'Bulk Upload PM Schedules', category: 'PM Schedules' },
  START_PM_TASK: { label: 'Start PM Task', category: 'PM Schedules' },
  RESUBMIT_PM_ENTRY: { label: 'Resubmit PM Entry', category: 'PM Schedules' },
  ACKNOWLEDGE_PM_OVERDUE: { label: 'Acknowledge Overdue PM Task', category: 'PM Schedules' },
  CREATE_EQUIPMENT_GROUP: { label: 'Create Equipment Group', category: 'Equipment Groups' },
  UPDATE_EQUIPMENT_GROUP: { label: 'Update Equipment Group', category: 'Equipment Groups' },
  DELETE_EQUIPMENT_GROUP: { label: 'Delete Equipment Group', category: 'Equipment Groups' },

  // Block Change
  APPROVE_BLOCK_CHANGE: { label: 'Approve Block Change', category: 'Filter Management' },
  REJECT_BLOCK_CHANGE: { label: 'Reject Block Change', category: 'Filter Management' },

  // Reports
  // (CREATE/UPDATE/DELETE_REPORT_TEMPLATE, GENERATE_REPORT, SIGN_REPORT,
  // REJECT_REPORT, DELETE_REPORT removed 2026-07-04 with the orphaned reports
  // generate/sign module.) The active report-reviews workflow keeps these two:
  REVIEW_REPORT: { label: 'Review Report', category: 'Reports' },
  APPROVE_REPORT: { label: 'Approve Report', category: 'Reports' },
} as const;

export type ReauthAction = keyof typeof REAUTH_ACTIONS;

export const REAUTH_ACTION_CATEGORIES = [
  'User Management',
  'Configuration',
  'Role Management',
  'Backup',
  'Asset Management',
  'Checklist',
  // ('UNS' + 'Retention' categories removed with data-ingestion removal.)
  'Help',
  'Filter Management',
  'Cleaning Profiles',
  'Filter Profiles',
  'PM Schedules',
  'Equipment Groups',
  'Reports',
  // Both editors (config/action-reauth.tsx and roles-components/reauth-tab.tsx)
  // build their lists by iterating THIS array, so an action whose category is
  // missing here renders nowhere and its policy can never be set. These two were
  // absent, hiding DELETE_NOTIFICATION, BULK_DELETE_NOTIFICATIONS and
  // SUPER_ADMIN_DATA_EDIT from both screens.
  'Notifications',
  'Super Admin',
] as const;

export type ReauthActionCategory = (typeof REAUTH_ACTION_CATEGORIES)[number];
