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

  // Role Management
  CREATE_ROLE: { label: 'Create Role', category: 'Role Management' },
  UPDATE_ROLE: { label: 'Update Role', category: 'Role Management' },
  DELETE_ROLE: { label: 'Delete Role', category: 'Role Management' },

  // Backup
  EXPORT_BACKUP: { label: 'Export Backup', category: 'Backup' },
  RESTORE_BACKUP: { label: 'Restore Backup', category: 'Backup' },

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

  // Floorplans. Separate from UPDATE_CONFIG_PAGE because a room's temperature
  // and humidity limits ARE the quality specification for a space — a site may
  // reasonably want re-authentication on that while leaving the general config
  // pages alone.
  UPDATE_FLOORPLAN: { label: 'Create / Update / Delete Floorplan', category: 'Configuration' },
  UPDATE_FLOORPLAN_ROOM: { label: 'Create / Update / Delete Room', category: 'Configuration' },
  CREATE_FUNCTIONAL_LOCATION: { label: 'Create Functional Location', category: 'Configuration' },
  UPDATE_FUNCTIONAL_LOCATION: { label: 'Update Functional Location / Instrument Links', category: 'Configuration' },
  DELETE_FUNCTIONAL_LOCATION: { label: 'Delete Functional Location', category: 'Configuration' },
  MANAGE_ALARM_RULE: { label: 'Create / Update / Delete Alarm Rule', category: 'Configuration' },
  ACKNOWLEDGE_ALARM: { label: 'Acknowledge Alarm', category: 'Configuration' },

  // Instruments — DELIBERATELY EMPTY. All THREE token actions
  // (`REVEAL_INSTRUMENT_TOKEN`, `SET_INSTRUMENT_TOKEN`,
  // `REGENERATE_INSTRUMENT_TOKEN`) were listed here on 2026-08-06 and all three
  // were removed the same day. Everything in this registry is an admin-managed
  // POLICY — the config page renders one per-role toggle per entry — and all
  // three endpoints now use `enforceReauthAlways`, so their password proof is
  // intrinsic and no toggle can switch it off. Listing them would render a
  // control that does nothing, which is exactly the "reauth theater" the three
  // `*_TEMPLATE_KIND` entries were deleted for.
  // `TOGGLE_SUPER_ADMIN_API_ACCESS` — the other always-on gate — is absent for
  // the same reason. The action strings still travel in the 401 bodies. See
  // `apps/api/src/modules/instruments/routes.ts`.
  //
  // Creating / editing / deleting an instrument carries no reauth at all —
  // those are ordinary registry edits.
} as const;

export type ReauthAction = keyof typeof REAUTH_ACTIONS;

export const REAUTH_ACTION_CATEGORIES = [
  'User Management',
  'Configuration',
  'Role Management',
  'Backup',
  'Help',
  // Both editors (config/action-reauth.tsx and roles-components/reauth-tab.tsx)
  // build their lists by iterating THIS array, so an action whose category is
  // missing here renders nowhere and its policy can never be set. These two were
  // absent, hiding DELETE_NOTIFICATION, BULK_DELETE_NOTIFICATIONS and
  // SUPER_ADMIN_DATA_EDIT from both screens.
  'Notifications',
  'Super Admin',
  // 'Instruments' was here until 2026-08-06. Its only member,
  // REGENERATE_INSTRUMENT_TOKEN, moved to an always-on gate and left the
  // registry with the other two token actions, so the category had no members
  // left and rendered as an empty heading on both editor screens.
] as const;

export type ReauthActionCategory = (typeof REAUTH_ACTION_CATEGORIES)[number];
