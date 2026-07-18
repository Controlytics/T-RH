# Backend API — Endpoint Reference

This is the canonical endpoint reference derived from the actual route files. See `future/overview/API_LIST.md` for the shorter summary. For full request/response shapes, hit `/docs` on a running instance — every route declares a Fastify schema.

---

## Conventions

- All endpoints are mounted under `/api/...` except `/uploads/*` (static). *(The `/api/ws` WebSocket was removed 2026-07-03 with the pub/sub tear-out.)*
- Authentication is via `Authorization: Bearer <jwt>` except for public paths (listed in `future/backend/README.md`).
- Mutations on business data trigger an **audit row** via `auditLoggerPlugin`.
- 21 CFR-sensitive mutations also require **reauth** — the client calls `POST /api/auth/verify` within the reauth window before the destructive action.
- ~~Device-token routes (`/api/data/telemetry`, `/attributes`, `/binary`, `/event`) use a per-entity device token~~ *(removed 2026-06-17 with the data-ingestion tear-out).*

## Header conventions

| Header | Sent by | Purpose |
|---|---|---|
| `Authorization: Bearer <jwt>` | browser + tablet | user auth |
| `x-offline-replay: true` | sync engine | marks a replayed offline operation |
| `x-device-token: <token>` | devices | telemetry ingestion auth |

Request bodies for offline-replayed mutations include an `offlinePerformedAt` timestamp to preserve the original event time.

---

## Auth — `/api/auth`

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/login` | public | Returns access + refresh token |
| POST | `/logout` | JWT | Revokes refresh token |
| POST | `/refresh` | refresh | Rotates tokens |
| POST | `/beacon-logout` | public | `navigator.sendBeacon` endpoint used on tab close |
| GET | `/me` | JWT | Current user + permissions |
| PUT | `/profile` | JWT | Self-update |
| POST | `/change-password` | JWT | Self-serve password change |
| POST | `/verify` | JWT | Reauth verification (21 CFR) |
| POST | `/forgot-password` | public | Emails reset link |

## Users — `/api/users`

| Method | Path | Notes |
|---|---|---|
| POST | `/` | Create user (admin path; contrast with admin-requests flow) |
| GET | `/` | List with pagination + filters |
| GET | `/stats` | Counts by status/role |
| POST | `/bulk-delete` | |
| GET | `/:id` | Detail |
| PUT | `/:id` | Update |
| DELETE | `/:id` | Hard delete |
| POST | `/:id/enable` | |
| POST | `/:id/disable` | |
| POST | `/:id/unlock` | Reset lockout counter |
| POST | `/:id/reset-password` | Admin-forced reset |
| GET | `/reset-requests` | List password-reset self-requests |
| GET | `/reset-requests/pending` | |
| POST | `/reset-requests/:id/process` | approve/reject + execute |

## Roles — `/api/roles`

| Method | Path | Notes |
|---|---|---|
| GET | `/` | All roles |
| GET | `/active` | **public** — used by contact-admin page |
| GET | `/permissions/all` | Full permission catalog |
| GET | `/:name` | |
| GET | `/:name/creatable` | Roles that `:name` is allowed to create |
| POST | `/` | |
| PUT | `/:name` | |
| DELETE | `/:name` | |

## Config — `/api/config`

Static routes (40) grouped by surface:

| Area | Paths |
|---|---|
| Generic dynamic (per-module) | `GET /:key`, `PUT /:key` |
| Core config | `GET /password-policy/current` *, `GET /report-settings/current` *, `GET /pagination/current` * |
| Dashboard | `GET /dashboard-cards/current`, `PUT /dashboard-cards` |
| Datetime | `GET /datetime/current` |
| User-ID | `GET /user-id`, `PUT /user-id`, `GET /user-id/next`, `POST /user-id/validate` |
| Branding | `GET /branding`, `PUT /branding` |
| Roles | `GET /roles`, `GET /roles/:role`, `PUT /roles/:role` |
| Per-user | `GET /users/:userId`, `PUT /users/:userId`, `GET /my-config` |
| Field IDs | `GET /field-ids`, `PUT /field-ids/:fieldId` |
| Reauth | `GET /action-reauth`, `PUT /action-reauth`, `GET /action-reauth/check`, `GET /action-reauth/my-actions` |
| Audit templates | `GET /audit-templates`, `PUT`, `GET /audit-templates/current` |
| ~~Alarm columns~~ | *(removed 2026-05-17 with the rule-chain/alarm tear-out)* |
| Cleaning profile assignment | `GET /cleaning-profile-assignment`, `PUT` |
| Tablet access | `GET /tablet-access`, `PUT`, `GET /tablet-access/my-features` |
| Access matrix | `GET /access-matrix`, `PUT`, `GET /access-matrix/my-modules` |

Dynamic routes (3, registered per config def at startup): `GET /registry/manifest`, `GET /dynamic/:moduleKey`, `PUT /dynamic/:moduleKey`.

## Filter operations — `/api/filters` (cleaning cycle state machine)

| Method | Path | Notes |
|---|---|---|
| GET | `/:id/current-state` | Returns filter state + next valid actions |
| GET | `/batch-states` | Batch variant for multi-filter pages |
| POST | `/:id/start-cycle` | Open a new cleaning cycle |
| POST | `/:id/advance` | Move to next stage (blocks if pending checklist unchecked) |
| POST | `/:id/submit-checklist` | Answer the pending checklist |
| POST | `/:id/bypass` | Deviation path (skip a stage with reason) |
| POST | `/:id/retire` | |
| POST | `/:id/replace` | |
| POST | `/:id/terminate-cycle` | Close a cycle without completion |
| GET | `/retirements` | |
| GET | `/replacements` | |
| GET | `/events` | (from events-routes.ts) |
| GET | `/cycles` + `/cycles/:id` | |
| GET | `/dashboard-stats` | |
| GET | `/reasons` | Cleaning reasons catalog |

All mutation endpoints accept `x-offline-replay` + `offlinePerformedAt`. Server-side validation is authoritative; client-side validation happens against the cached pipeline graph during offline queuing.

## Admin requests — `/api/admin-requests`

| Method | Path | Notes |
|---|---|---|
| POST | `/` | Create request (create-user / unlock / reset / modify) |
| GET | `/user-lookup` | **public** — look up a user for modify requests |
| GET | `/` | List |
| GET | `/pending-count` | Badge for approver UIs |
| POST | `/:id/process` | Approve or reject; on approve, executes the requested action |

The request body requires requester Employee ID; the flow audits both the request creation and the execution separately. UUIDs are hidden in the audit trail.

## PM schedules — `/api/pm-schedules`

| Method | Path | Notes |
|---|---|---|
| GET | `/template.csv` | Download upload template |
| POST | `/upload` | Bulk upload CSV |
| GET | `/ahu-configs` | |
| PUT | `/ahu-configs/:ahuId` | |
| GET | `/entries` + `/entries/pending-counts` | |
| POST | `/entries/approve` + `/entries/reject` | |
| POST | `/entries/:id/resubmit` | |
| PUT | `/entries/:id/edit` | |
| GET | `/due` | Tasks due now |
| GET | `/:entityId` + `/:entityId/history` | |
| POST | `/` + `PUT /:id` + `DELETE /:id` | |

PM executions are separate: `POST /api/pm-executions/` (start). PM completion is derived from cleaning-cycle records by the My Tasks endpoint, not from `PmExecution.status`, so there is no PUT — the formerly-orphan status endpoint was removed in the H3 cleanup (2026-05-04).

## Super-admin — `/api/super-admin`

Split into Orgs, Stats, Filter-data admin, and a **Data management console**:

| Section | Resources |
|---|---|
| Orgs | `GET /organizations`, `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id` |
| Stats | `GET /stats` |
| Filter data | Retirements: `PUT|DELETE|POST .../unretire` • Replacements: `PUT|DELETE` |
| Data console | `GET|PUT|DELETE` on each of: `/data/cleaning-cycles`, `/data/filter-events`, `/data/audit-trail`, `/data/alarms`, `/data/notifications`, `/data/admin-requests`, `/data/block-change-requests`, `/data/pm-entries` |

All Data-console routes share a `dataPreHandler` and a `dataSchema(description)` helper for uniform audit logging.

## Other module endpoints

For every remaining module, see `future/overview/API_LIST.md` — same data, structured for fast scanning.

---

## Swagger

When the API is running, a full interactive OpenAPI spec is at:

- Dev: `http://localhost:3000/docs`
- Prod: disabled (stay inside `PUBLIC_PATHS` in dev only)

## Not over HTTP

- ~~**MQTT topics:** Mosquitto 2.0 broker on 1883~~ *(removed 2026-06-17 — MQTT/Mosquitto/EMQX broker + `transport/mqtt-handler.ts` + `/api/internal/mqtt/refresh-acl` all torn out with the data-ingestion tear-out; no broker anymore).*
- ~~**WebSocket:** `/api/ws`~~ *(removed — the WS handler + Redis pub/sub bridge are gone; pub/sub was retired 2026-05-01 and the `/ws` plugin removed 2026-07-03).*
