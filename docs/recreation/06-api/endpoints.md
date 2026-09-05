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
| GET | `/api/instruments/telemetry-aggregate` | Min/mean/max across the instruments in a selection, bucketed. ALL VALUES DERIVED; limit bounds returned only when every instrument in the selection agrees |
| GET | `/api/instruments/telemetry-history?instrumentIds=a,b&from=&to=&limit=&offset=` | (2026-09-05) The merged, paged readings of SEVERAL instruments, newest first — the Instruments page's history widget. One row per (instrument, instant) with every key reported at it, pivoted in SQL so a page cannot split an instant; values RAW (the slot keys, limits and precision come from `telemetry-overview`). Visibility is applied to the id set: an out-of-scope id is absent, never 403. `total` counts instants. 400 on a malformed id or a reversed range. |
| GET | `/api/alarms?search=&from=&to=&type=&status=&severity=&functionalLocationId=&page=&pageSize=&sort=&dir=` | Alarm list. Filters, counts, sorts and pages SERVER-side (2026-08-31); returns `data`, `total` and `counts` (the four state counts, from one `groupBy`). `total` is DERIVED by summing `counts`, and `status` is excluded from the count query alone so choosing a state box does not zero the others. Every filter, the counts included, is ANDed INSIDE the caller's visibility scope — a location filter narrows within it and cannot escape it. A bad date or reversed range is a 400 by field; an unknown `sort` falls back. Legacy `state`/`acknowledged`/`instrumentId`/`limit` still accepted, `limit` being an alias for `pageSize` (ceiling 500). Rows carry `locationName` (the functional location); `roomLabel` was dropped 2026-08-31, though the room code remains searchable. Filter algebra: `modules/alarms/list-query.ts` |
| PUT · DELETE | `/api/config/my-dashboard-layout` | The caller's own dashboard arrangement. Authenticated only, NOT audited — a preference, not governance |
| PUT | `/api/roles/dashboard-layout/role/:name` | A role's DEFAULT arrangement (ROLE_MANAGE + reauth, audited) |
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
| POST | `/api/instruments/bulk` | Bulk-create from CSV, partial success, one token per created row |
| POST | `/api/instruments/{id}/regenerate-token` | Revoke the current credential and issue a new one; the new token is returned once in the body. Needs `INSTRUMENT_UPDATE` **and an always-on password re-auth** (`REGENERATE_INSTRUMENT_TOKEN`, `x-reauth-password` header) — as of 2026-08-06 this is not the admin-managed policy and cannot be switched off, matching the two `/token` verbs below |
| GET | `/api/instruments/{id}/telemetry` | Latest value per key + recent history for one instrument |
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

### /ingest/v1 — 3 paths (device-facing; NOT behind the auth hook)

| Method(s) | Path | Summary |
|---|---|---|
| POST | `/api/ingest/v1/telemetry` | Submit telemetry, authenticated by a per-instrument device token (`Authorization: Bearer <token>`). A gateway's token may also submit a batch covering its linked children, in either shape: keyed by code (`{"devices": {"<child code>": {...}}}`) or a LIST of blocks each naming its code under `devN` (`{"devices": [{"devN": "<child code>", ...}, ...]}`, 2026-09-05 — `devN` is stripped from the readings); a gateway's FLAT payload carrying a string `devN` (`{"devN": "<child code>", "t": 20.3, "h": 60.9}`) is routed to that child as a one-block batch — the plant firmware's one-child-per-message form; a non-gateway token sending a batch gets `400 NOT_A_GATEWAY`. Unknown/unowned child codes are dead-lettered against the gateway and the rest of the batch is still accepted, returning `{accepted, rejected}`. |
| POST | `/api/ingest/v1/mqtt-auth` | **Called by the broker, never by a device.** EMQX's `http` authenticator hook: body `{clientid, username, password}`, response `{"result": "allow" \| "deny"}`. `username` is the device token, resolved through the same `resolveInstrumentByToken` as every other transport; `clientid` must equal the resolved instrument's `code` or the answer is `deny` (the UUID from 2026-08-07 to 2026-09-04; the code again since, at the operator's request — a code with `+`/`#` is refused at registration, which is what keeps the ACL template safe). That binding is what makes the broker's `instruments/${clientid}/telemetry` topic ACL a real authorisation rule. Deny is the default on every unexpected body shape. Because EMQX asks per CONNECT instead of holding a credential, revocation takes effect on the next connection. Rate limited to 600/min, body-capped at 8 KB. |
| GET | `/api/ingest/v1/ws` | WebSocket upgrade (`wss://` is the same route behind `API_HTTPS=true`). Token from either the `Authorization: Bearer` header on the upgrade or the first frame `{"token":"..."}`; one JSON reading per frame thereafter, gateway batches included. Per-frame cap 64 KB, 600 messages/min per connection, 5 s absolute deadline to authenticate. **Absent from `/docs/json` by construction** — `@fastify/websocket` sets `schema.hide = true` on every websocket route. A missing allowlist entry shows up as `401` at the handshake, before any frame, not as a close code. |

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
