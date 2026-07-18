# API Endpoint Index

**Total registered HTTP endpoints:** ~398 across 59 route files (verified via grep of `apps/api/src/modules/**/*.ts`, 2026-04-29).

All endpoints are mounted under `/api/...` unless noted. Prefixes come from `apps/api/src/app.ts` (`app.register(..., { prefix: ... })`). The list below groups endpoints by their **mount prefix**, so to derive the full URL, concatenate the prefix with each route path. A `*` marks an endpoint that is public (does not require a bearer token); everything else goes through `authPlugin` + `rbacPlugin`.

This file is an **index** — for handler-level detail (request/response shapes, permissions required per route), see `future/backend/API_ENDPOINTS.md`. The `config` module is now split: `dynamic-routes.ts` for registry-discovered surfaces + `static-routes/` for 11 per-tab route files (bloat audit P2.3 done).

---

## Auth — `/api/auth`

- `POST /login`
- `POST /logout`
- `POST /refresh`
- `POST /beacon-logout`
- `GET  /me`
- `PUT  /profile`
- `POST /change-password`
- `POST /verify` (reauth)
- `POST /forgot-password` *

## Users — `/api/users`

- `POST /` — create user
- `GET  /` — list users
- `GET  /stats`
- `POST /bulk-delete`
- `GET  /:id`
- `PUT  /:id`
- `DELETE /:id`
- `POST /:id/enable | /disable | /unlock | /reset-password`
- `GET  /reset-requests` · `/reset-requests/pending` · `POST /reset-requests/:id/process`

## Roles — `/api/roles`

- `GET /` · `GET /active` * · `GET /permissions/all`
- `GET /:name` · `GET /:name/creatable`
- `POST /` · `PUT /:name` · `DELETE /:name`

## User groups — `/api/user-groups`

- `GET  /` · `POST /` · `PUT /:id` · `DELETE /:id`
- `GET  /:id/members` · `POST /:id/members` · `DELETE /:id/members/:userId`

## Config — `/api/config`

- Public reads: `/password-policy/current` * · `/report-settings/current` * · `/pagination/current` *
- Dynamic config (auto-registered per definition): `GET|PUT /:key`
- Core: `/dashboard-cards/current`, `PUT /dashboard-cards`
- Datetime: `/datetime/current`
- User-ID: `/user-id`, `PUT /user-id`, `/user-id/next`, `POST /user-id/validate`
- Branding: `/branding`, `PUT /branding`
- Roles config: `/roles`, `/roles/:role`, `PUT /roles/:role`
- Per-user: `/users/:userId`, `PUT /users/:userId`, `/my-config`
- Field IDs: `/field-ids`, `PUT /field-ids/:fieldId`
- Action reauth: `/action-reauth`, `PUT`, `/action-reauth/check`, `/action-reauth/my-actions`
- Audit templates: `/audit-templates`, `PUT`, `/audit-templates/current`
- ~~Alarm columns: `/alarm-columns`~~ *(removed 2026-05-17 with the rule-chain/alarm tear-out)*
- Cleaning profile assignment: `/cleaning-profile-assignment`, `PUT`
- Tablet access: `/tablet-access`, `PUT`, `/tablet-access/my-features`
- Access matrix: `/access-matrix`, `PUT`, `/access-matrix/my-modules`
- Dynamic config registry: `/registry/manifest`, `GET|PUT /dynamic/:moduleKey`

## Audit — `/api/audit`

- `GET /` · `GET /:id`
- `DELETE /:id` · `POST /bulk-delete`

## Uploads — `/api/uploads`

- `POST /photo`

## Notifications — `/api/notifications`

- `GET /` · `GET /unread-count`
- `PUT /mark-all-read` · `PUT /bulk-read` · `PUT /bulk-unread` · `POST /bulk-delete`
- `PUT /:id/read` · `PUT /:id/unread` · `DELETE /:id`

## Notification settings — `/api/notification-settings`

- Email: `GET /email`, `PUT /email`, `POST /email/test`
- Email OAuth2: `/email/oauth2/redirect-uri`, `/email/oauth2/authorize`, `/email/oauth2/code`, `/email/oauth2/status`
- SMS: `GET /sms`, `PUT /sms`, `POST /sms/test`
- Send: `POST /send`
- Logs: `/logs`, `/logs/stats`, `DELETE /logs/:id`
- Templates: `/templates`, `POST`, `PUT /templates/:id`, `DELETE /templates/:id`

## Notification rules — `/api/notification-rules`

- `GET /event-types` · `GET /` · `GET /:id`
- `POST /` · `PUT /:id` · `DELETE /:id`
- `PUT /:id/toggle` · `POST /:id/test`

## Backup — `/api/backup`

- `GET /export` · `POST /restore` · `POST /validate`

## Assets — `/api/assets` (split across four route files)

- **Templates** (`template.routes.ts`): `GET /templates`, `POST`, `GET /templates/:id`, `PUT`, `DELETE`, `GET /templates/:id/versions`
- **Instances** (`instance.routes.ts`): `GET /instances`, `POST`, `GET /instances/tree`, `GET /instances/:id`, `POST /instances/bulk-upload-filters`, `PUT /instances/:id`, `PATCH /instances/:id/status`, `PATCH /instances/:id/lifecycle-state`, `DELETE /instances/:id`, `GET /instances/:id/children`
- **Relationships** (`relationship.routes.ts`): `GET /relationships`, `POST`, `DELETE /relationships/:id`
- **Identifiers** (`identifier.routes.ts`): `GET /identifiers`, `GET /identifiers/lookup/:value`, `POST /identifiers`, `DELETE /identifiers/:id`

## ~~Internal MQTT auth — `/api/internal/mqtt`~~ *(REMOVED 2026-06-17 with the MQTT broker tear-out)*

## ~~Data ingestion — `/api/data`~~ *(REMOVED 2026-06-17 with the data-ingestion tear-out)*

## Debug traces — `/api/debug/traces` *(SURVIVES)*

- `GET /` · `GET /stats` · `GET /:id` · `PUT /entity/:entityId/toggle`
- *(Repurposed 2026-06-12: no longer an ingestion-pipeline inspector — now reads from `audit_trail`, rendering each audited action as a single-stage trace.)*

## ~~Rule chains — `/api/rule-chains`~~ *(REMOVED 2026-05-17 with the rule-chain tear-out)*

## ~~UNS (unified namespace) — `/api/uns`~~ *(REMOVED 2026-06-17 with the UNS tear-out)*

## ~~Queries — `/api` (mounted at `/api/*` via `queriesModule`)~~ *(REMOVED 2026-06-17 — telemetry / export / retention / alarm query routes all torn out; alarms went 2026-05-17)*

## ~~Connectivity — `/api/connectivity`~~ *(REMOVED 2026-06-17 with the connectivity tear-out)*

## QR codes — `/api/qr`

- (one endpoint; see `modules/qr-code/routes.ts`)

## Help articles — `/api/help`

- `GET /` · `GET /:key`
- `POST /` · `PUT /:id` · `DELETE /:id`
- `GET /:id/versions`

## System health — `/api/system-health`

- `GET /` — aggregated service health

## Super-admin — `/api/super-admin`

- Organizations: `GET /organizations`, `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id`
- `GET /stats`
- Filter data admin: retirements (`GET|PUT|DELETE|POST .../unretire`) and replacements (`GET|PUT|DELETE`)
- Data management console: `/data/cleaning-cycles`, `/data/filter-events`, `/data/audit-trail`, `/data/alarms`, `/data/notifications`, `/data/admin-requests`, `/data/block-change-requests`, `/data/pm-entries` — each supports `GET` (list), `PUT /:id` (edit), `DELETE /:id`

## LDAP — `/api/ldap`

- `GET /config` · `PUT /config` · `POST /test-connection` · `GET /status`

## Tenant admin — `/api/organizations`

- Base routes: `GET /`, `POST /`, `GET /:id`, `PUT /:id`, `DELETE /:id`, `GET /info`
- Per-org detail (`org-detail-routes.ts`):
  - Users: `GET|POST /:orgId/users`, `PUT|DELETE /:orgId/users/:userId`
  - Entities: `GET|POST /:orgId/entities`, `DELETE /:orgId/entities/:entityId`
  - Templates: `GET|POST /:orgId/templates`, `DELETE /:orgId/templates/:templateId`
  - User-entity assignments: `GET|POST /:orgId/users/:userId/entities`, `DELETE .../:assignmentId`, `POST /.../templates`, `GET /.../visible-entities`

## Entity assignments — `/api/entity-assignments`

- `GET /my-entities`
- `GET /:entityId` · `POST /` · `POST /bulk` · `PUT /:id` · `DELETE /:id`

## Org admin — (mounted indirectly; see app.ts) 

- `GET /users` · `GET /entities` · `GET /info` (org-scoped read-only views)

## Dashboards — `/api/dashboards`

- `GET /` · `GET /:id` · `POST /` · `PUT /:id` · `DELETE /:id`
- Widgets: `POST /:id/widgets`, `PUT /:id/widgets/:widgetId`, `DELETE /:id/widgets/:widgetId`
- Layout: `PUT /:id/layout`
- Assign: `POST /:id/assign`, `DELETE /:dashboardId/assign/:assignmentId`
- Data: `GET /:id/data/:widgetId`
- Widget catalog: `GET /widget-types`

## Cleaning profiles — `/api/filter-cleaning-profiles`

- `GET /` · `GET /:id` · `POST /` · `PUT /:id` · `PATCH /:id/toggle-status` · `DELETE /:id`
- `GET /:id/assigned-assets` · `POST /:id/assign-assets`
- `POST /:id/validate`

## Checklist profiles — `/api/checklist-profiles`

- `GET /` · `GET /:id` · `POST /` · `PUT /:id` · `DELETE /:id`
- Questions: `POST /:id/questions`, `PUT /:id/questions/:questionId`, `DELETE /:id/questions/:questionId`
- Reorder: `PUT /:id/reorder`

## Filter profiles — `/api/filter-profiles`

- `GET /` · `GET /:id` · `POST /` · `PUT /:id` · `DELETE /:id`
- `POST /:id/assign`

## Filter operations — `/api/filters`

Core state machine for cleaning cycles; split across `routes.ts` and `events-routes.ts`.

- State: `GET /:id/current-state` · `GET /batch-states`
- Cycle: `POST /:id/start-cycle` · `POST /:id/advance` · `POST /:id/submit-checklist`
- `POST /:id/bypass` · `POST /:id/retire` · `POST /:id/replace` · `POST /:id/terminate-cycle`
- Lists: `GET /retirements` · `GET /replacements`
- Events & cycles (events-routes): `GET /events` · `GET /cycles` · `GET /cycles/:id` · `GET /dashboard-stats` · `GET /reasons`

## Equipment groups — `/api/equipment-groups`

- `GET /` · `GET /:id` · `GET /by-block/:blockId`
- `POST /` · `PUT /:id` · `DELETE /:id`

## PM schedules — `/api/pm-schedules` (+ execution routes at `/api/pm-executions`)

- Template + upload: `GET /template.csv`, `POST /upload`
- AHU configs: `GET /ahu-configs`, `PUT /ahu-configs/:ahuId`
- Entries: `GET /entries`, `GET /entries/pending-counts`, `POST /entries/approve`, `POST /entries/reject`, `POST /entries/:id/resubmit`, `PUT /entries/:id/edit`
- Due + history: `GET /due`, `GET /:entityId`, `GET /:entityId/history`
- CRUD: `POST /`, `PUT /:id`, `DELETE /:id`
- Executions (separate prefix): `POST /`, `PUT /:id`

## Reports — REMOVED (2026-07-04)

The `/api/report-templates` (template designer) and `/api/reports` (generate/sign engine)
endpoints were removed with the orphaned reports generate/sign tear-out. The surviving
report surface is `/api/report-reviews` (ad-hoc submit/review/approve) + the report-config
endpoints (`report-page-titles` / `report-labels` / `report-signatories`); PDF export of the
cleaning-record / filter-lifecycle pages is client-side (`lib/pdf-report.ts`).

## Deployment check — `/api/deployment-check`

- Dev/ops endpoint that verifies module wiring (used in CI/smoke tests).

## Admin requests — `/api/admin-requests`

- `POST /` — create request (create user / unlock / reset / modify)
- `GET /user-lookup` — look up existing user for modify requests
- `GET /` · `GET /pending-count`
- `POST /:id/process` — approve/reject & execute the action

## Block change requests — `/api/block-change-requests`

- `GET /` · `GET /pending-count`
- `POST /` · `POST /:id/approve` · `POST /:id/reject`

## WebSocket

- Mounted via `wsHandler` (see `apps/api/src/transport/ws-handler.ts`). Real-time entity updates for the SPA.

## Notes

- **394** endpoints is a count of `app.(get|post|put|patch|delete)(...)` declarations, including `dynamic-routes.ts` which programmatically registers config endpoints per config definition at startup. Actual runtime count is dependent on the number of active config definitions (+3 per definition: get/put/readonly registry).
- Full OpenAPI/Swagger spec is served at `/docs` when the API is running (`@fastify/swagger-ui`).
