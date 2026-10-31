# Phase 6 — Complete API Endpoint Reference

*Generated from the live OpenAPI document, 2026-07-25:*

```bash
curl -sk https://localhost:3001/docs/json
```

**139 paths across 19 groups.** Method list per path is taken verbatim from the spec. (`/dashboards` 9 → 4 paths on 2026-10-29, re-derived from `routes.ts`, not from `/docs/json`.)
(`GET /api/roles/access-matrix` removed 2026-09-19 with the Module Guide page; re-derive the count from `/docs/json` before quoting it.)

## /config  — 35 paths

| Method(s) | Path | Summary |
|---|---|---|
| GET · PUT | `/api/config/access-matrix` | Get configuration access matrix |
| GET | `/api/config/access-matrix/my-modules` | Get modules allowed for the current role |
| GET · PUT | `/api/config/action-reauth` | Get action re-authentication configuration |
| GET | `/api/config/action-reauth/check` | Check if action requires re-authentication |
| GET | `/api/config/action-reauth/my-actions` | Get re-auth actions for current user |
| GET | `/api/instruments/telemetry-aggregate` | Min/mean/max across the instruments in a selection, bucketed. ALL VALUES DERIVED; limit bounds returned only when every instrument in the selection agrees |
| GET | `/api/instruments/telemetry-history?instrumentIds=a,b&keys=&from=&to=&limit=&offset=` | (2026-09-05; `keys` 2026-10-28 — comma list ≤ 20, only those keys, `total` = instants carrying one of them) The merged, paged readings of SEVERAL instruments, newest first — the Instruments page's history widget. One row per (instrument, instant) with every key reported at it, pivoted in SQL so a page cannot split an instant; values RAW (the slot keys, limits and precision come from `telemetry-overview`). Visibility is applied to the id set: an out-of-scope id is absent, never 403. `total` counts instants. 400 on a malformed id or a reversed range. |
| GET | `/api/alarms?search=&from=&to=&type=&status=&severity=&functionalLocationId=&functionalLocationDirect=&instrumentIds=&profileId=&page=&pageSize=&sort=&dir=` | Alarm list. (2026-10-29, dashboard builder) `instrumentIds` = a comma list of ≤ 200 uuids (present-but-EMPTY selects NOTHING; absent = no filter; a malformed or longer list is a 400 by field), `profileId` = one profile's instruments (uuid), `functionalLocationDirect=true` = the location itself without the Block → Areas expansion; all ANDed with the other filters inside visibility, the `counts` included. Filters, counts, sorts and pages SERVER-side (2026-08-31); returns `data`, `total` and `counts` (the four state counts, from one `groupBy`). `total` is DERIVED by summing `counts`, and `status` is excluded from the count query alone so choosing a state box does not zero the others. Every filter, the counts included, is ANDed INSIDE the caller's visibility scope — a location filter narrows within it and cannot escape it. A bad date or reversed range is a 400 by field; an unknown `sort` falls back. Legacy `state`/`acknowledged`/`instrumentId`/`limit` still accepted, `limit` being an alias for `pageSize` (ceiling 500). Rows carry `locationName` (the functional location); `roomLabel` was dropped 2026-08-31, though the room code remains searchable. Filter algebra: `modules/alarms/list-query.ts` |
| GET | `/api/alarms/counts?<the list's filters>` | (2026-10-30, dashboard builder phase 2 — the alarm counts widget and the alarm-type pie) The list's query language through the SAME `resolveAlarmQuery` + `buildAlarmWhere` and visibility (`instrumentIds`, `profileId`, `functionalLocationId` / `functionalLocationDirect`, `search`, `from` / `to`, `type`, legacy `state` / `acknowledged` / `instrumentId`); `status`, paging and sort are accepted and IGNORED. Returns `quadrants` `{activeUnack, activeAck, clearedUnack, clearedAck}` and `byType` `[{type, active, unacknowledged}]` (the list's type tokens; a `type` filter narrows it to that type), every inner key declared. One RepeatableRead transaction, so the two halves reconcile; the e2e compares `quadrants` with the list's `counts` for the same query. `ALARM_READ` (a viewer without it gets 403 and the widget says "Could not load this widget.") |
| PUT · DELETE | `/api/config/my-dashboard-layout` | The caller's own dashboard arrangement. Authenticated only, NOT audited — a preference, not governance. (2026-10-28) `layout.widgets` = built widgets, strict (400); OMITTED keeps the stored; a change by a non-SUPER_ADMIN is 403 `WIDGETS_SUPER_ADMIN_ONLY` |
| PUT | `/api/roles/dashboard-layout/role/:name` | A role's DEFAULT arrangement (ROLE_MANAGE + reauth, audited). (2026-10-28) carries `widgets` by the same rule as the caller's own layout — ROLE_MANAGE alone cannot change them (403) |
| GET · PUT | `/api/config/audit-templates` | Get audit text templates |
| GET | `/api/roles/panel-access` | Panel assignment for every role and every user override (ROLE_MANAGE) |
| PUT | `/api/roles/panel-access/role/:name` | Set a role's assignable panels (reauth, audited) |
| PUT | `/api/roles/panel-access/user/:userId` | Set one user's panels, overriding their role (reauth, audited) |
| GET | `/api/config/audit-templates/current` | Get effective audit text templates |
| GET · PUT | `/api/config/branding` | Get branding configuration |
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
| ~~POST~~ | ~~`/api/auth/verify`~~ | Removed 2026-10-05 (audit SEC-5): re-auth is proven inline per gated request (`_currentPassword` / `x-reauth-password`) |

## /dashboards  — 4 paths, 7 routes (rewritten 2026-10-29, dashboard builder phase 1; was 9 paths / 13 routes)

Re-derived `grep -nE "app\.(get|post|put|delete)\(" apps/api/src/modules/dashboards/routes.ts` (7; 13 at `6ec4de5`).
A dashboard is ONE document `{version, source, timeWindow, items, widgets}` in `dashboards.layout`.
**Reads** need `DASHBOARD_VIEW` and an assignment to the caller or their role (a SUPER_ADMIN sees every
active one; ADMIN is not special; no assignment = none); anything not visible is a **404, never a 403**.
**Writes** are SUPER_ADMIN by ROLE — a `preValidation` hook, 403 `DASHBOARDS_SUPER_ADMIN_ONLY` before
the path or body is validated, whatever `DASHBOARD_*` grants the caller holds — then the active row
(404 `DASHBOARD_NOT_FOUND`), re-auth `UPDATE_DASHBOARD`, validation (400 `VALIDATION_ERROR`, the strict
`parseDashboardDocument` naming the widget), and ONE transaction with the audit rows (the eight
`DASHBOARD_*` actions, each value carrying `name`; an unchanged save writes and audits nothing).

| Method(s) | Path | Summary |
|---|---|---|
| GET | `/api/dashboards/` | `{data: DashboardSummary[]}` — `id, title, description, sourceSummary {mode, label}, widgetCount, updatedAt`, plus `assignments {roles, users[{id, username, fullName}]}` for a SUPER_ADMIN ONLY (absent otherwise). Ordered by title ignoring case; no paging (D5). `sourceSummary.mode` is `all` / `profile` / `location` / `instruments` / `unreadable`; a deleted profile or location reads "Profile no longer exists" / "Location no longer exists" |
| POST | `/api/dashboards/` | SUPER_ADMIN. `{title (1..200), description? (≤ 500), document?}` → 201 detail. No document = `emptyDashboardDocument()` (no widgets, `{mode:'all'}`, 24h) |
| GET | `/api/dashboards/{id}` | `DashboardDetail` = the summary + `document` (the FORGIVING read: a bad widget is dropped with its item; an unreadable source is `null` = no instruments, never all). 404 when not visible |
| PUT | `/api/dashboards/{id}` | SUPER_ADMIN. `{title?, description?, document?, expectedUpdatedAt}` (`additionalProperties: false`) → 200 detail. Conditional on `expectedUpdatedAt` (a 1 ms window; the new stamp is at least `expected + 1 ms`): a dashboard changed since is **409 `DASHBOARD_CHANGED`** and nothing is written; an unchanged body is a 200 no-op (checked first). A document save audits `DASHBOARD_UPDATED` (source / window / items) and one `DASHBOARD_WIDGET_CREATED` / `UPDATED` / `DELETED` per widget, diffed by id |
| DELETE | `/api/dashboards/{id}` | SUPER_ADMIN. Soft delete (`isActive: false`) → `{success: true}`; `DASHBOARD_DELETED` |
| POST | `/api/dashboards/{id}/duplicate` | SUPER_ADMIN. A copy titled "<title> (copy)" (cut to fit 200, suffix kept), every widget a fresh id, **no assignments** → 201 detail |
| PUT | `/api/dashboards/{id}/assignments` | SUPER_ADMIN. The WHOLE set `{roles: string[], userIds: string[]}` → `{roles, users}`. An unknown role or user is a 400 naming the first; only the difference is written (row locked), one `DASHBOARD_ASSIGNED` / `UNASSIGNED` per role or user |

**Retired 2026-10-29 (8 routes):** `GET /widget-types`, `POST /{id}/widgets`, `PUT /{id}/widgets/{widgetId}`,
`DELETE /{id}/widgets/{widgetId}`, `PUT /{id}/layout`, `GET /{id}/data/{widgetId}` (the six per-widget /
layout / data routes the spec retires — a save sends the whole document, and widget data comes from
the instrument and alarm routes under the viewer's own scope), plus `POST /{id}/assign` and
`DELETE /{dashboardId}/assign/{assignmentId}`, superseded by `PUT /{id}/assignments`. The
`dashboard_widgets` table is left in place, unused.

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
| POST | `/api/audit/report-export-log` | Record a report download/generation as an auditable event. Since 2026-10-01 a **PDF** must name its `reportKind` and follows Configuration → Report Downloads: 409 `REPORT_REQUIRES_APPROVAL` when that type is Request; remarks and the password (`enforceReauthAlways`) exactly as configured. **Excel** keeps the per-role `DOWNLOAD_REPORT` re-auth and required remarks |
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

Re-derived against the running API on 2026-08-06, after the multi-protocol
listener work:

```bash
curl -s http://127.0.0.1:3001/docs/json -o docs.json
node -e "const d=require('./docs.json');console.log(Object.keys(d.paths).length)"
# -> 149
```

**150 addressable HTTP paths: 149 in the OpenAPI document, plus one it can never
contain.** The decomposition, so the tables below add up to the headline:

| | paths | in OpenAPI |
|---|---|---|
| the 2026-07-25 snapshot above | 139 | 139 |
| `/instruments` (below) | 8 | 8 |
| `/ingest/v1` (below) | 3 | 2 |
| **total** | **150** | **149** |

`GET /api/ingest/v1/ws` is the one path the spec is missing, because
`@fastify/websocket` forces `schema.hide = true` on every websocket route — an
HTTP upgrade is not expressible in OpenAPI 3.0 — so the route's `schema` block
is in-source documentation only. **Anyone re-deriving this number from
`/docs/json` will get 149 and be wrong by one**; state the adjustment rather
than publishing the raw count. Grepping the live document for `/ingest/`
returns `/api/ingest/v1/telemetry` and `/api/ingest/v1/mqtt-auth` and nothing
else, which is the check.

The **TCP and MQTT listeners are not HTTP routes at all** and will never appear
here under any count. TCP is a socket server on `INGEST_TCP_PORT`; MQTT is an
outbound subscription to an external broker. The only HTTP surface MQTT has is
`POST /api/ingest/v1/mqtt-auth` below, which the broker calls — devices never
touch it.

This section previously recorded 148 (2026-08-06, earlier the same day). The
live count of 149 was derived fresh by the command above; the two path sets were
**not** diffed against each other, so treat the difference as "at least
`mqtt-auth` was added" rather than as a proof that nothing else changed. The
2026-08-05 update (144 = 139 + 5) undercounted even at the time —
`/api/instruments/{id}/telemetry` and `/api/instruments/{id}/dead-letters` were
already live but had never been added to this table, which is precisely why a
number here should be re-derived and never carried forward.

### /instruments — 8 paths (registry; JWT + permission gated)

| Method(s) | Path | Summary |
|---|---|---|
| GET · POST | `/api/instruments` | List instruments (filterable by `block`/`area`/`location`/`isGateway`) · Create instrument (returns the access token **once**) |
| GET · PUT · DELETE | `/api/instruments/{id}` | Instrument detail · Update (never `code`) · Delete |
| POST | `/api/instruments/bulk` | Bulk-create from CSV, partial success, one token per created row. Since 2026-10-28 an EXISTING Instrument ID (ignoring case, same profile, in view) is UPDATED with the attribute cells that differ (blank keeps) — `updated[]` `{id, code, row, changes[{key, column, from|null, to}]}`, `unchanged[]` `{row, code}`; body `reason` required when a change overwrites a recorded value (400 `REMARK_REQUIRED`, nothing written) |
| POST | `/api/instruments/bulk/preview` | (2026-10-28) The same plan as `/bulk`, writing nothing: `create`, `update` (with each change's `from` / `to`), `unchanged`, `errors`, `warnings`, `remarkRequired`. INSTRUMENT_CREATE, no re-auth |
| POST | `/api/instruments/{id}/regenerate-token` | Revoke the current credential and issue a new one; the new token is returned once in the body. Needs `INSTRUMENT_UPDATE` **and an always-on password re-auth** (`REGENERATE_INSTRUMENT_TOKEN`, `x-reauth-password` header) — as of 2026-08-06 this is not the admin-managed policy and cannot be switched off, matching the two `/token` verbs below |
| GET | `/api/instruments/{id}/device-certificate` | Device certificate status (2026-10-27): `available` (the server has a device CA), `required` (the instrument's profile requires one), `profileName`, and the current certificate's `issued` metadata (`issueId`, `fingerprint`, `issuedAt`, `issuedBy`, `notAfter`) or null. Never key material. `INSTRUMENT_READ`, visibility-scoped (out of view = 404) |
| POST | `/api/instruments/{id}/device-certificate` | Issue / re-issue the device certificate; returns `{issued, fileName, bundle}` ONCE (`bundle` = base64 zip of `client.crt`, `client.key`, and the server `ca.crt` when known — the key is not kept). Any previous certificate stops working at once. `INSTRUMENT_UPDATE` + always-on re-auth (`ISSUE_DEVICE_CERTIFICATE`); 409 `DEVICE_CA_NOT_CONFIGURED` when inert. Audited `DEVICE_CERTIFICATE_ISSUED` |
| DELETE | `/api/instruments/{id}/device-certificate` | Revoke it; a required instrument is refused until a new one is issued. Same gate (`REVOKE_DEVICE_CERTIFICATE`); 409 `NOT_ISSUED`. Audited `DEVICE_CERTIFICATE_REVOKED` |
| GET | `/api/instruments/{id}/telemetry` | Latest value per key + recent history for one instrument. `keys` (2026-10-28): comma list ≤ 20, on both the paged and the chart (`points`) path; not with `key` (400). A raw key's summary has null bounds and breach counts; `count - numericCount` = its text readings. Since 2026-10-28 a reading's `slot` (and its bounds) is the instrument's RESOLVED key only — a second device key of the same measurement is raw |
| GET | `/api/instruments/{id}/telemetry-keys` | The keys this instrument has sent (from the latest table), newest first: `key`, `slot`, `lastSeen`, and since 2026-10-28 `numeric` (its latest reading is a number — a quoted number counts) and `measurement` (`{code, name, unit}` when the key is the instrument's RESOLVED key for a measurement, else null; `slot` follows the same rule). Visibility-scoped (404) |
| GET | `/api/instruments/data-keys?instrumentIds=a,b` \| `functionalLocationId=` [`&functionalLocationDirect=true`] \| `profileId=` \| `all=true` | (2026-10-28, widget data keys) Every TELEMETRY key the instruments have sent and every ATTRIBUTE key they carry — a key appears with its first stored reading, nothing to configure. Exactly one selector (400 otherwise); an id list is capped at 200, and an EMPTY one (`instrumentIds=`) is answered `[]`; a Block includes its Areas unless `functionalLocationDirect=true` (the dashboard's direct-only view); `all=true` = every instrument in the caller's view (phase 2, the dashboard's All Instruments). A telemetry key is `measurement`-labelled when it is the RESOLVED key of its slot on at least one instrument (`resolvedSlotFor`). Each entry: `source`, `key`, `label` (measurement name / administered attribute display name / the key), `numeric` (a hint, never a gate), `instruments`, `lastSeen`, `measurement`. Attribute keys fold case; blank values are left out; offset keys are SUPER_ADMIN-only (absent otherwise). Visibility applied to the id set: out-of-scope instruments are absent, never 403. `INSTRUMENT_READ` |
| GET | `/api/instruments/telemetry-overview?floorplanId=&functionalLocationId=&functionalLocationDirect=&profileId=&instrumentIds=` | Every visible instrument's latest slot readings, limits, status and placement (the dashboard readings table, the widgets' instrument list). (2026-10-29, dashboard builder) gained `profileId` (one profile's instruments) and `instrumentIds` (a comma list of ≤ 200 uuids; present-but-EMPTY = `[]`; absent = every visible instrument as before; malformed or longer = 400 `VALIDATION_ERROR`), both declared in the schema, applied after visibility and ANDed with the location / floorplan filters. (2026-10-30, dashboard builder phase 2) every row also carries `judged` — TRUE when the instrument's PROFILE measures temperature or humidity AND maps at least one device key to it, i.e. `status` is a verdict about something; a pressure-only profile is FALSE, its `status` stays `NO_DATA`, and the status widgets read it "Not judged" while reporting, "Offline" when not — and `lastSeenAt` (ISO, the last instant it reported anything, null if never); both declared. `INSTRUMENT_READ` |
| GET | `/api/instruments/telemetry-buckets?instrumentIds=a,b&keys=&from=&to=&bucket=hour\|day\|week&agg=avg\|min\|max\|count&groupBy=all\|instrument` | (2026-10-30, dashboard builder phase 2 — the bar chart) The numeric readings of the named TELEMETRY keys binned into LOCAL hours, days or weeks in the `datetime` config's timezone (default `Asia/Kolkata`; an unknown zone is UTC and `timezone` says so): a day starts at local midnight, a week on a local Monday, and each bucket start is returned as a UTC ISO instant. EVERY value is COMPUTED (`avg` / `min` / `max` / `count`), and each point carries `readings` (how many readings are behind it) and `instruments`. Response `{from, to, bucket, agg, timezone, bucketSeconds, series: [{instrumentId|null, key, points: [{ts, value, readings, instruments}]}]}`, every field declared; a bucket with no reading is absent, and a key with no reading has no series. `instrumentIds` ≤ 50 (`WIDGET_INSTRUMENTS_MAX`; empty = none), `keys` required (400 "Name at least one key."), `from` < `to`, at most 1,000 buckets (400 in the server's words). Visibility applied to the id set, in the order asked (out of scope = absent, never 403). Defaults `hour` / `avg` / `all`. `INSTRUMENT_READ` |
| POST | `/api/instruments/latest-values` | (2026-10-28, widget data keys) Body `{instrumentIds: uuid[] (0..200; empty = `[]`), keys: [{source: 'telemetry'\|'attribute', key}] (1..20)}`, validated by the shared `latestValuesRequestSchema`. One row per visible instrument (overview order: code, name, `functionalLocationName`, `locationAttribute`, `reporting`, `lastSeenAt`) with `values` in the REQUESTED order: `value` (stored JSON as received, null when never sent), `ts`, `unit`, `decimals`, `display`, `judged`. A MEASURED key (its profile maps it, and it is the key that slot resolved to) carries the overview's own precision, unit and `judged` = `{limitMin, limitMax, limitMinText, limitMaxText, sensorError, rangeError}`; a RAW key carries `unit`/`decimals`/`judged` = null. Attribute keys fold case; `display` is the server's formatting (a limit at its reading's precision); offset keys are SUPER_ADMIN-only (null otherwise). Read-only, no audit row. Out-of-scope instruments are absent. `INSTRUMENT_READ` |
| PUT | `/api/instrument-profiles/:id/display-keys` | (2026-10-29, widget data keys phase 3) The trend page's EXTRA keys for every instrument of the profile: body `{displayKeys: [{source:'telemetry', key, label?, unit?, decimals?, color?}] (≤ 12, no duplicate), reason?}`. SUPER_ADMIN (403 `SUPER_ADMIN_ONLY`, behind `INSTRUMENT_UPDATE`), re-auth `UPDATE_INSTRUMENT_PROFILE`, 400 on an attribute / 13th key; unchanged = no write, no audit; a change audits `INSTRUMENT_PROFILE_UPDATED` with before / after. `GET /api/instrument-profiles[/:id]` return `displayKeys` (corrupt stored value = `[]`) |
| GET | `/api/instruments/{id}/dead-letters` | Rejected payloads for one instrument |
| GET | `/api/instruments/eligible-children` | Active instruments eligible to be linked to a gateway (not themselves a gateway, not already linked — D2/D3) |
| GET | `/api/instruments/{id}/children` | Instruments currently linked to this gateway |
| GET · PUT | `/api/instruments/{id}/token` | Reveal the live plaintext token · Set an operator-chosen one. Both need `INSTRUMENT_UPDATE` **and an always-on password re-auth** (`x-reauth-password` header, or `_currentPassword` in the PUT body) — not the admin-managed policy, it cannot be switched off. Every reveal writes an `INSTRUMENT_TOKEN_VIEWED` audit row; a set writes `INSTRUMENT_TOKEN_SET` and revokes the previous credential. Neither row carries the value. Reveal 409s `TOKEN_NOT_RECOVERABLE` for a credential issued before 2026-08-06 |
| GET · POST | `/api/instruments/{id}/attributes` | List free-form attributes (`INSTRUMENT_READ`) · Set one, idempotent on the trimmed key (`INSTRUMENT_UPDATE`; 201 on create, 200 on update) |
| PUT · DELETE | `/api/instruments/{id}/attributes/{key}` | Edit an existing attribute's value · Remove it (`INSTRUMENT_UPDATE`). PUT does NOT create — a key that is not there 404s `ATTRIBUTE_NOT_FOUND`. Each mutation writes one audit row naming the key and both values |

Gates: `INSTRUMENT_READ` (reads, including both gateway-child endpoints),
`INSTRUMENT_CREATE` (create + bulk), `INSTRUMENT_UPDATE` (update + regenerate),
`INSTRUMENT_DELETE` (delete — unlinks a gateway's children via `ON DELETE SET
NULL`, never deletes them). The plaintext token appears in exactly two
response schemas — create and regenerate. Everything else returns
`tokenPrefix` only, and Fastify's response serialisation is what enforces
that, not handler discipline.

**Placement on create (2026-10-26).** `POST /api/instruments` and
`POST /api/instruments/bulk` take an optional `functionalLocationId` (bulk: a
sibling of `csv`, one for the whole upload). A caller whose instrument view is
LIMITED must place the instrument inside it: no location → 400
`LOCATION_REQUIRED`, a location outside the view → 400 `LOCATION_OUT_OF_SCOPE`,
an unknown id → 400 `LOCATION_NOT_FOUND`. Enforced inside the create
transaction by reading the new row back through the caller's visibility
fragment, before the credential and the `INSTRUMENT_CREATED` row; bulk also
refuses once up front so nothing is created. `GET /api/functional-locations`
marks each node `placeable` and returns `placementRequired` beside `data` —
the pickers on New Instrument and Bulk Upload read those and nothing else.
`GET /api/instruments/{id}` returns `gatewayCode` and `gatewayVisible`: a child
names its gateway even when the caller cannot open it (the detail page no
longer looks the gateway up by id).

### /ingest/v1 — 3 paths (device-facing; NOT behind the auth hook)

| Method(s) | Path | Summary |
|---|---|---|
| POST | `/api/ingest/v1/telemetry` | Submit telemetry, authenticated by a per-instrument device token (`Authorization: Bearer <token>`). A gateway's token may also submit a batch covering its linked children, in either shape: keyed by code (`{"devices": {"<child code>": {...}}}`) or a LIST of blocks each naming its code under `devN` (`{"devices": [{"devN": "<child code>", ...}, ...]}`, 2026-09-05 — `devN` is stripped from the readings); a gateway's FLAT payload carrying a string `devN` (`{"devN": "<child code>", "t": 20.3, "h": 60.9}`) is routed to that child as a one-block batch — the plant firmware's one-child-per-message form; a non-gateway token sending a batch gets `400 NOT_A_GATEWAY`. **Device certificates (2026-10-27):** an instrument whose profile requires one gets `403 DEVICE_CERTIFICATE_REQUIRED` / `_NOT_ISSUED` / `_MISMATCH` unless the TLS connection presented its current client certificate; a gateway's batch drops a requiring child unless the connection presented the gateway's own. Unknown/unowned child codes are dead-lettered against the gateway and the rest of the batch is still accepted, returning `{accepted, rejected}`. |
| POST | `/api/ingest/v1/attributes` | (2026-10-28) A device REPORTS attributes — the MQTT `…/attributes/report` body, same device token, rate limit, 64 KB cap and certificate rule as `/telemetry`. 200 `{written, unchanged, refused}`; 202 unparseable; 400 `NOT_A_GATEWAY` |
| GET | `/api/ingest/v1/attributes` | (2026-10-28) The device's current attributes, offsets excluded: `{device, attributes, ts, children: [{device, attributes}]}` (children for a gateway, minus any that require a certificate on an unverified connection). Poll — HTTP cannot push |
| MQTT | `instruments/<code>/attributes/report` | (2026-09-05, broker topic, not an HTTP route) A device PUBLISHES attribute values here in the telemetry batch's shape; the bridge writes them, audits each as `INSTRUMENT_ATTRIBUTE_REPORTED` (system action, device code in the row), skips unchanged values, refuses keys outside the administered device-writable list into the dead-letter log, and republishes the downlink slots. See `LOCAL_SETUP_WINDOWS.md` §9C.2. |
| POST | `/api/ingest/v1/mqtt-auth` | **Called by the broker, never by a device.** EMQX's `http` authenticator hook: body `{clientid, username, password, cert_subject, cert_common_name}` (the last two since 2026-10-27 — when the instrument's profile requires a device certificate, or a gateway has a child that does, `cert_subject` must carry the current certificate's `SERIALNUMBER=<issue id>`; `""` = none), response `{"result": "allow" \| "deny"}`. `username` is the device token, resolved through the same `resolveInstrumentByToken` as every other transport; `clientid` must equal the resolved instrument's `code` or the answer is `deny` (the UUID from 2026-08-07 to 2026-09-04; the code again since, at the operator's request — a code with `+`/`#` is refused at registration, which is what keeps the ACL template safe). That binding is what makes the broker's `instruments/${clientid}/telemetry` topic ACL a real authorisation rule. Deny is the default on every unexpected body shape. Because EMQX asks per CONNECT instead of holding a credential, revocation takes effect on the next connection. Rate limited to 600/min, body-capped at 8 KB. |
| GET | `/api/ingest/v1/ws` | WebSocket upgrade (`wss://` is the same route behind `API_HTTPS=true`). Token from either the `Authorization: Bearer` header on the upgrade or the first frame `{"token":"..."}`; one JSON reading per frame thereafter, gateway batches included. Per-frame cap 64 KB, 600 messages/min per connection, 5 s absolute deadline to authenticate. **Absent from `/docs/json` by construction** — `@fastify/websocket` sets `schema.hide = true` on every websocket route. A missing allowlist entry shows up as `401` at the handshake, before any frame, not as a close code. |
| — | WS / TCP attribute frames | (2026-10-28) After the token, a frame / line whose ONLY key is `attributes` (an object) is an attribute report (the MQTT report payload); `{"subscribe":"attributes"}` answers the current set — one `{device, attributes, changed: {}, ts}` per instrument (a gateway's own and each child's) — then pushes every committed change as `{device, attributes, changed, ts}`. TCP: one JSON object per line both ways. Hand-written here: the WS route is hidden from OpenAPI |

These are the only routes reachable without a login, and the allowlist is pinned
to exactly these three by an invariant test
(`plugins/__tests__/public-paths.test.ts`) — that test failing when you add a
route is the system working. `/telemetry` is rate limited to 600/min and
body-capped at 64 KB.

**Two ingest listeners have no HTTP surface whatsoever** and so appear nowhere
in this file's counts: the raw TCP server (`INGEST_TCP_PORT`, newline-delimited
JSON, first line `{"token":"..."}`) and the MQTT bridge (an outbound QoS-1
subscription to `instruments/#` on the broker at `MQTT_BROKER_URL` — `#` since
2026-09-04 because the topic segment is the instrument CODE, which at this plant
carries slashes; the bridge reads the code between `instruments/` and
`/telemetry` and ignores its own retained downlink slots by suffix).
Both funnel into the same `ingestPayload()` core as the routes above.

### /floorplans — room links (added 2026-09-22, Layout Designer)

The floorplan module predates this dossier's floorplan section (none was ever
written); these three joined the existing plan and room routes that day.

| Method | Path | Gate | Notes |
|---|---|---|---|
| POST | `/api/floorplans/:id/links` | CONFIG_UPDATE + `UPDATE_FLOORPLAN_ROOM` reauth | OPENING (on `fromRoom`'s edge, checked against the rooms' real outlines — 400 `NOT_ADJACENT`) or CONNECTOR (409 `DUPLICATE_LINK`); audited `FLOORPLAN_LINK_CREATED` |
| PUT | `/api/floorplans/:id/links/:linkId` | same | same checks; audited before/after |
| DELETE | `/api/floorplans/:id/links/:linkId` | same | 204; audited; a room's delete cascades its links |

Rooms carry `points` (polygon corners, NULL = a rectangle) and doors by `edge`;
plans carry `links` on `GET /api/floorplans` and `GET /api/floorplans/:id`.
`POST /api/floorplans` accepts `imagePath: null` (a blank plan; width/height are
then the canvas size).

## /report-reviews and the report download configuration (2026-09-07; reshaped 2026-10-01)

Missing from this dossier until 2026-10-01 — the module landed on 2026-09-07 without a row here.

| Method | Path | Gate | Notes |
|---|---|---|---|
| POST | `/api/report-reviews` | `REPORT_REVIEW_READ`; password per the type's config | Raise a request: `reportKind`, `reportType`, `title`, `requestMeta`, `dataSnapshot`, `instrumentIds`, `remarks` (blank allowed only when the type's remarks are off). **Names no approver** — the configured roles and users are FROZEN onto the row. 409 `REPORT_IS_DIRECT` for a Direct type; 400 `NO_APPROVER` (none configured) or `NO_ELIGIBLE_APPROVER` (nobody but the requester could decide it: permission, scope, not self); 404 for an instrument outside the requester's scope; 403 for the Audit Trail without `AUDIT_EXPORT` (2026-10-24). The 201 carries `eligibleApproverCount` (2026-10-24) — the users notified; 0 only for a SUPER_ADMIN's request, which is accepted anyway |
| GET | `/api/report-reviews?list=queue\|mine\|approved&page&pageSize` | `REPORT_REVIEW_READ` | queue = pending, I am an approver, in my scope, not mine; mine = raised by me or my ROLE, in my scope; approved = visible to me |
| GET | `/api/report-reviews/:id` | `REPORT_REVIEW_READ` | The row with its frozen snapshot; 404 (never 403) unless SUPER_ADMIN, a signer, or the requester's role / an approver within instrument scope |
| POST | `/api/report-reviews/:id/approve` · `/reject` | `REPORT_REVIEW_APPROVE` + `APPROVE_REPORT` re-auth · `REPORT_REVIEW_REJECT` + `REJECT_REPORT` re-auth (two permissions since 2026-10-26; list rows carry `canApprove` / `canReject`) | An approver in scope; never the requester (SUPER_ADMIN exempt); one decision (409) |
| POST | `/api/report-reviews/:id/download-log` | `REPORT_REVIEW_READ` | Audits a download of the APPROVED copy, written before the save |
| GET | `/api/config/report-approvers/current` | authenticated | `{approverRoles, approverUserCount}` — the ACTIVE approvers a request would freeze; users as a count, never ids |
| GET | `/api/config/report-approvers/candidates` | `CONFIG_READ` | `[{value: userId, label: "username — name (ROLE)"}]` for the Approver users setting; enabled, never SUPER_ADMIN |
| GET | `/api/roles/attribute-access/users` | `ROLE_MANAGE` | (2026-10-24) every enabled user: own attribute rule `{mode, keys, requireReauth}`, `effective` (combined with the role's by `effectiveAttributeAccess`), `roleHasUpdate` |
| PUT | `/api/roles/attribute-access/user/:userId` | `ROLE_MANAGE` + `UPDATE_ROLE_CONFIG` re-auth | (2026-10-24) a user's own attribute rule; `reason` REQUIRED; 404 unknown user; privilege rule; `CONFIG_CHANGED` `user_config` audit. The role PUT `/api/roles/attribute-access/:name` requires `reason` from the same date |
| GET | `/api/config/report-approvers/readiness` | `CONFIG_READ` | (2026-10-24) `{roles: {name: [toggle labels]}, users: {id: [toggle labels]}}` — the Permissions-tab toggles each role (and each candidate user, by role) lacks to DECIDE a request (`approvalPermissionsMissing`, the check `eligibleApprovers` applies); `[]` = can approve. Report Settings shows it beside each ticked approver |
| GET | `/api/config/report-downloads/current` | authenticated | `{ [kind]: {mode, remarksRequired, passwordRequired} }` for the EIGHT kinds, coerced (a split kind inherits). NOT the stored row's shape. Both rows are edited on the `/config/report-settings` page |
| GET · PUT | `/api/config/dynamic/report-downloads` | SUPER_ADMIN | The stored row: `<prefix>Mode` / `<prefix>Remarks` / `<prefix>Password` per kind |

