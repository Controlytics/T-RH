# Phase 6 — Complete API Endpoint Reference

*Generated from the live OpenAPI document, 2026-07-25:*

```bash
curl -sk https://localhost:3001/docs/json
```

**139 paths across 19 groups.** Method list per path is taken verbatim from the spec.

## /config  — 35 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET · PUT | `/api/config/access-matrix` | Get configuration access matrix |
| GET | `/api/config/access-matrix/my-modules` | Get modules allowed for the current role |
| GET · PUT | `/api/config/action-reauth` | Get action re-authentication configuration |
| GET | `/api/config/action-reauth/check` | Check if action requires re-authentication |
| GET | `/api/config/action-reauth/my-actions` | Get re-auth actions for current user |
| GET · PUT | `/api/config/audit-templates` | Get audit text templates |
| GET | `/api/config/audit-templates/current` | Get effective audit text templates |
| GET · PUT | `/api/config/branding` | Get branding configuration |
| PUT | `/api/config/dashboard-cards` | Update dashboard card visibility per role |
| GET | `/api/config/dashboard-cards/current` | Get dashboard card visibility settings |
| GET · PUT | `/api/config/datetime` | Get Datetime configuration |
| GET | `/api/config/datetime/current` | Get current datetime format settings |
| GET · PUT | `/api/config/dynamic/export-limit` | Get Export Limits config |
| GET · PUT | `/api/config/export-limit` | Get Export Limit configuration |
| GET | `/api/config/export-limit/current` | Get current export-limit settings |
| GET · PUT | `/api/config/export-options` | Get the role-wise export-format matrix |
| GET | `/api/config/export-options/current` | Export formats allowed for the current role |
| GET | `/api/config/field-ids` | List all field ID configurations |
| PUT | `/api/config/field-ids/{fieldId}` | Update field ID display name |
| GET · PUT | `/api/config/login-security` | Get Login Security configuration |
| GET | `/api/config/my-config` | Get current user effective configuration |
| GET · PUT | `/api/config/pagination` | Get Pagination configuration |
| GET | `/api/config/pagination/current` | Get current pagination settings |
| GET · PUT | `/api/config/password-policy` | Get Password Policy configuration |
| GET | `/api/config/password-policy/current` | Get current password policy settings |
| GET | `/api/config/registry/manifest` | Get config module manifest for dynamic UI rendering |
| GET · PUT | `/api/config/report-page-titles` | Get report page titles configuration |
| GET | `/api/config/report-page-titles/current` | Get current report page titles |
| GET | `/api/config/roles` | List all role configurations |
| GET · PUT | `/api/config/roles/{role}` | Get role configuration |
| GET · PUT | `/api/config/session` | Get Session configuration |
| GET · PUT | `/api/config/user-id` | Get User ID configuration |
| GET | `/api/config/user-id/next` | Get next available User ID |
| POST | `/api/config/user-id/validate` | Validate a User ID |
| GET · PUT | `/api/config/users/{userId}` | Get user-specific configuration |

## /notification-settings  — 14 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET · PUT | `/api/notification-settings/email` | Get email (SMTP) configuration |
| GET | `/api/notification-settings/email/oauth2/authorize` | Get OAuth2 authorization URL |
| GET | `/api/notification-settings/email/oauth2/code` | OAuth2 callback endpoint |
| GET | `/api/notification-settings/email/oauth2/redirect-uri` | Get OAuth2 redirect URI |
| GET | `/api/notification-settings/email/oauth2/status` | Check OAuth2 token status |
| POST | `/api/notification-settings/email/test` | Test email configuration |
| GET | `/api/notification-settings/logs` | Get notification delivery logs |
| GET | `/api/notification-settings/logs/stats` | Get notification delivery statistics |
| DELETE | `/api/notification-settings/logs/{id}` | Delete a notification log entry |
| POST | `/api/notification-settings/send` | Send a notification |
| GET · PUT | `/api/notification-settings/sms` | Get SMS configuration |
| POST | `/api/notification-settings/sms/test` | Test SMS configuration |
| GET · POST | `/api/notification-settings/templates` | List notification templates |
| PUT · DELETE | `/api/notification-settings/templates/{id}` | Update notification template |

## /users  — 12 paths

| Method(s) | Path | Summary |
|---|---|---|
| POST · GET | `/api/users/` | Create user |
| POST | `/api/users/bulk-delete` | Bulk delete users |
| POST | `/api/users/password-expiry-sweep` | Run the password-expiry notification sweep now |
| GET | `/api/users/reset-requests` | List password reset requests |
| GET | `/api/users/reset-requests/pending` | Pending reset request count |
| POST | `/api/users/reset-requests/{id}/process` | Process reset request |
| GET | `/api/users/stats` | Get user statistics |
| GET · PUT · DELETE | `/api/users/{id}` | Get user by ID |
| POST | `/api/users/{id}/disable` | Disable user |
| POST | `/api/users/{id}/enable` | Enable user |
| POST | `/api/users/{id}/reset-password` | Reset password |
| POST | `/api/users/{id}/unlock` | Unlock user |

## /auth  — 9 paths

| Method(s) | Path | Summary |
|---|---|---|
| POST | `/api/auth/beacon-logout` | Beacon logout |
| POST | `/api/auth/change-password` | Change password |
| POST | `/api/auth/forgot-password` | Forgot password |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Get current user |
| PUT | `/api/auth/profile` | Update profile |
| POST | `/api/auth/refresh` | Refresh JWT token |
| POST | `/api/auth/verify` | Re-authenticate |

## /dashboards  — 9 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET · POST | `/api/dashboards/` | List dashboards visible to current user |
| GET | `/api/dashboards/widget-types` | List available widget types |
| DELETE | `/api/dashboards/{dashboardId}/assign/{assignmentId}` | Remove dashboard assignment |
| GET · PUT · DELETE | `/api/dashboards/{id}` | Get dashboard with all widgets |
| POST | `/api/dashboards/{id}/assign` | Assign dashboard to user/org/role |
| GET | `/api/dashboards/{id}/data/{widgetId}` | Fetch data for a specific widget |
| PUT | `/api/dashboards/{id}/layout` | Batch update widget positions after drag-and-drop |
| POST | `/api/dashboards/{id}/widgets` | Add widget to dashboard |
| PUT · DELETE | `/api/dashboards/{id}/widgets/{widgetId}` | Update widget |

## /notifications  — 9 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET | `/api/notifications/` | List notifications |
| POST | `/api/notifications/bulk-delete` | Delete selected notifications |
| PUT | `/api/notifications/bulk-read` | Mark selected notifications as read |
| PUT | `/api/notifications/bulk-unread` | Mark selected notifications as unread |
| PUT | `/api/notifications/mark-all-read` | Mark all notifications as read |
| GET | `/api/notifications/unread-count` | Get unread notification count |
| DELETE | `/api/notifications/{id}` | Delete a notification |
| PUT | `/api/notifications/{id}/read` | Mark notification as read |
| PUT | `/api/notifications/{id}/unread` | Mark notification as unread |

## /audit  — 7 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET | `/api/audit/` | Query audit trail |
| POST | `/api/audit/bulk-delete` | Permanently delete selected audit records |
| POST | `/api/audit/bulk-redact` | Redact selected audit records |
| POST | `/api/audit/report-export-log` | Record a report download/generation as an auditable event |
| GET | `/api/audit/verify-chain` | Verify audit chain integrity |
| GET · DELETE | `/api/audit/{id}` | Get audit record by ID |
| POST | `/api/audit/{id}/redact` | Redact audit record |

## /super-admin  — 7 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET · PUT | `/api/super-admin/api-lock` | Read the Super Admin API access switch (true = APIs enabled) |
| GET · POST | `/api/super-admin/data/admin-requests` | List admin requests (no audit trail) |
| PUT · DELETE | `/api/super-admin/data/admin-requests/{id}` | Edit admin request (no audit trail) |
| GET | `/api/super-admin/data/audit-trail` | List audit trail entries (no audit trail) |
| GET · POST | `/api/super-admin/data/notifications` | List notifications (no audit trail) |
| PUT · DELETE | `/api/super-admin/data/notifications/{id}` | Edit notification (no audit trail) |
| GET | `/api/super-admin/stats` | Platform-wide statistics |

## /roles  — 6 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET · POST | `/api/roles/` | List all roles |
| GET | `/api/roles/access-matrix` | Role access matrix for the Module Guide |
| GET | `/api/roles/active` | List active roles |
| GET | `/api/roles/permissions/all` | List all available permissions |
| GET · PUT · DELETE | `/api/roles/{name}` | Get role by name |
| GET | `/api/roles/{name}/creatable` | Get creatable roles for a role |

## /debug  — 5 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET | `/api/debug/traces/` | List audited operations (trace view) |
| PUT | `/api/debug/traces/entity/{id}/toggle` | Per-entity tracing toggle (no-op) |
| GET · PUT | `/api/debug/traces/operation-trace` | Operation-trace flag (vestigial) |
| GET | `/api/debug/traces/stats` | Operations trace stats |
| GET | `/api/debug/traces/{id}` | Get one audited operation (trace detail) |

## /notification-rules  — 5 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET · POST | `/api/notification-rules/` | List notification rules |
| GET | `/api/notification-rules/event-types` | List available event types |
| GET · PUT · DELETE | `/api/notification-rules/{id}` | Get notification rule |
| POST | `/api/notification-rules/{id}/test` | Test-fire a notification rule |
| PUT | `/api/notification-rules/{id}/toggle` | Toggle notification rule active status |

## /admin-requests  — 4 paths

| Method(s) | Path | Summary |
|---|---|---|
| POST · GET | `/api/admin-requests/` | Submit an admin request |
| GET | `/api/admin-requests/pending-count` | Count pending admin requests |
| GET | `/api/admin-requests/user-lookup` | Lookup a user by employee ID (username) |
| POST | `/api/admin-requests/{id}/process` | Process (approve/reject) an admin request |

## /help  — 4 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET · POST | `/api/help/` | List help articles |
| PUT · DELETE | `/api/help/{id}` | Update help article |
| GET | `/api/help/{id}/versions` | Get article version history |
| GET | `/api/help/{key}` | Get help article by key |

## /user-groups  — 4 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET · POST | `/api/user-groups/` | List user groups |
| PUT · DELETE | `/api/user-groups/{id}` | Update user group |
| GET · POST | `/api/user-groups/{id}/members` | List group members |
| DELETE | `/api/user-groups/{id}/members/{userId}` | Remove user from group |

## /backup  — 3 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET | `/api/backup/export` | Export database backup |
| POST | `/api/backup/restore` | Restore database from backup |
| POST | `/api/backup/validate` | Validate backup file |

## /ldap  — 3 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET · PUT | `/api/ldap/config` | Get LDAP configuration |
| GET | `/api/ldap/status` | Get LDAP status |
| POST | `/api/ldap/test-connection` | Test LDAP connection |

## /health  — 1 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET | `/api/health` | Health check |

## /system-health  — 1 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET | `/api/system-health/` | Get system health metrics |

## /uploads  — 1 paths

| Method(s) | Path | Summary |
|---|---|---|
| POST | `/api/uploads/photo` | Upload a profile photo |

---

## Added after the 2026-07-25 generation

The listing above is a snapshot of the OpenAPI document as it stood on
2026-07-25. The Instruments feature landed afterwards and its paths are recorded
here by hand — re-generate the whole file next time the snapshot is refreshed.

Verified against the running API on 2026-08-05: **144 paths** (139 above + the
5 below).

### /instruments — 4 paths (registry; JWT + permission gated)

| Method(s) | Path | Summary |
|---|---|---|
| GET · POST | `/api/instruments` | List instruments · Create instrument (returns the access token **once**) |
| GET · PUT · DELETE | `/api/instruments/{id}` | Instrument detail · Update (never `code`) · Delete |
| POST | `/api/instruments/bulk` | Bulk-create from CSV, partial success, one token per created row |
| POST | `/api/instruments/{id}/regenerate-token` | Revoke the current credential and issue a new one (re-auth: `REGENERATE_INSTRUMENT_TOKEN`) |

Gates: `INSTRUMENT_READ` (reads), `INSTRUMENT_CREATE` (create + bulk),
`INSTRUMENT_UPDATE` (update + regenerate), `INSTRUMENT_DELETE` (delete).
The plaintext token appears in exactly two response schemas — create and
regenerate. Everything else returns `tokenPrefix` only, and Fastify's response
serialisation is what enforces that, not handler discipline.

### /ingest/v1 — 1 path (device-facing; NOT behind the auth hook)

| Method(s) | Path | Summary |
|---|---|---|
| POST | `/api/ingest/v1/telemetry` | Submit telemetry, authenticated by a per-instrument device token (`Authorization: Bearer <token>`) |

This is the only route reachable without a login. It is on the auth-hook
allowlist (invariant-tested in `plugins/__tests__/public-paths.test.ts`), rate
limited to 600/min, and body-capped at 64 KB.
