# DigiLog — Backend Guide

> **2026-08-27 — re-synced to live code (drift sweep).** The previous
> "2026-07-03" sync (33 modules, 61 models, 23 enums) predates the Phase 0
> filter-domain strip (2026-07-18) and the 2026-08-20 vocabulary cleanup — every
> table below describing `filter-operations`, `filter-profiles`,
> `cleaning-profiles`, `checklist-profiles`, `pm-schedules`,
> `block-change-requests`, `stage-approvals`, `replacement-schedule`,
> `report-reviews`, `guest`, `sync`, `assets`, `hierarchy`, `equipment-groups`,
> or the `idempotency.ts` "offline replay dedup" lib was **describing modules
> that no longer exist**. Verified counts below come from:
> `ls apps/api/src/modules/ | wc -l` → **24**; `grep -cE "^model "` /
> `"^enum "` on `apps/api/prisma/schema.prisma` → **36 models, 13 enums**;
> `ls apps/api/src/modules/config/defs/*.def.ts | wc -l` → **25**. This fork
> also gained modules the old guide never listed: `alarms`, `alarm-webhooks`,
> `floorplans`, `functional-locations`, `instrument-profiles`, `instruments`. See root
> `CLAUDE.md` System Stats and `CHANGELOG.md` for history.

## Overview

Fastify 5 backend with TypeScript, **25 API modules** (verified `ls apps/api/src/modules/ | wc -l` 2026-10-05; 24 -> 25 on 2026-09-07 with `report-reviews`). Runs locally on Windows: `tsx watch` in dev, compiled JS for prod-style local builds. There is no live EC2/Linux production environment (`root CLAUDE.md` — "The app runs ONLY on local Windows for development"). `scripts/register-services.ps1` (WinSW-wrapped `DigiLogAPI`/`DigiLogDB` Windows services) and `docs/PHARMA_DEPLOYMENT_21CFR.md` still exist for a packaged-installer deployment path — verified present on disk — but that is a separate concern from the day-to-day dev loop described in root `CLAUDE.md`, which uses `start-app.bat` / `stop-app.bat`.

**Entry point:** `apps/api/src/app.ts`
**Dev:** `cd apps/api && npx tsx watch src/app.ts` (the code default is port 3000 — `app.ts` `PORT ?? '3000'` — but THIS checkout's `apps/api/.env` sets `PORT=3001` and `WEB_PORT=5176` so it cannot collide with the sibling DigiLog checkout on 3000 / 5175; see root `CLAUDE.md` Key Local URLs)
**Build:** `npx tsc -p apps/api/tsconfig.json` → `apps/api/dist/`
**Production smoke-test:** `cd api && node dist/app.js` (foreground — no auto-restart; for a manual deploy). Under the `DigiLog-Setup.exe` installer the API runs as the `DigiLogAPI` Windows service (WinSW, via `scripts/register-services.ps1`) for boot persistence + restart-on-crash; `scripts/verify-windows-deployment.ps1` smoke-checks a running deployment. PM2 was retired in Phase 4 (commits `127f25d..60d3c90` on `feature/phase4-tooling`).

## App Setup (app.ts)

Verified against `apps/api/src/app.ts` 2026-08-24 (import order + registration order):

1. **Fastify instance** — pino logger
2. **Helmet, CORS, rate limiter** — security headers, configured origins, global rate limit
3. **`@fastify/multipart`** — multipart uploads
4. **`@fastify/websocket`** — registered (`maxPayload: 1MB`); used by
   `modules/instruments/listeners/ws-listener.ts` for instrument ingest. This
   contradicts the old claim (still in root `CLAUDE.md` as of this sweep) that
   the WebSocket plugin was removed as dead code 2026-07-03 — it is imported
   and registered live in `app.ts` today, evidently reintroduced for the
   instrument-ingest work. Flagged for `CLAUDE.md`'s owner; not fixed here
   (out of this pass's file scope).
5. **Swagger** — OpenAPI docs at `/docs`
6. **Auth plugin** — JWT verification, user lookup, session validation
7. **RBAC plugin** — `requirePermission()` decorator
8. **24 route modules** — registered under `/api/` prefix, plus instrument
   ingest listeners (TCP, MQTT bridge, WS)
9. **Job runner** — one graphile-worker Runner registers **6** task handlers:
   `notification`, `password_expiry_check`, `session_sweep`,
   `telemetry_partition_maintenance`, `alarm_evaluation`, `alarm_webhook`
   (verified against the `taskList` in `app.ts:458-489`, 2026-08-27; the
   "3 tasks" figure root `CLAUDE.md` carried until 2026-08-24 was stale and has
   since been corrected there too)
10. **Config discovery** — auto-registers 34 config definitions (re-derived `ls` 2026-10-01; this line read 25 and was stale)
11. **Static uploads** — serves `/uploads/` directory
12. **Health check** — `GET /api/health`
13. **Error handler** — unified error responses (AppError → HTTP codes)

## 23 API Modules

(Authoritative list: `ls apps/api/src/modules/` — verified 2026-08-24. The
previous 35-module list here named 17 modules from the filter/AHU/RFID/report
domain that no longer exist anywhere in this repo — `filter-operations`,
`filter-profiles`, `cleaning-profiles`, `checklist-profiles`, `pm-schedules`,
`block-change-requests`, `stage-approvals`, `replacement-schedule`,
`report-reviews`, `guest`, `sync`, `assets`, `hierarchy`, `equipment-groups`,
`deployment-check` — and never listed the instrument/floorplan/alarm modules
this fork actually has. Endpoint counts are omitted rather than guessed; read
each module's `routes.ts` for its exact surface.)

### Auth & User Management

| Module | Prefix | Key Features |
|---|---|---|
| `auth` | `/api/auth` | Login, logout, refresh, verify, change-password, forgot-password, password-expiry sweep |
| `users` | `/api/users` | CRUD, enable/disable, unlock, reset-password |
| `roles` | `/api/roles` | Role CRUD, permissions, `role_configs` (instrument scope, attribute access) |
| `user-groups` | `/api/user-groups` | Group CRUD, member management |

### Admin

| Module | Prefix | Key Features |
|---|---|---|
| `super-admin` | `/api/super-admin` | Platform-wide admin, system stats, data management |
| `admin-requests` | `/api/admin-requests` | Admin action request workflow |

DigiLog is single-tenant, single-site (`Organization` model + `org-admin`/`tenant-admin` modules removed 2026-04-30).

### Instrument Monitoring

| Module | Prefix | Key Features |
|---|---|---|
| `instruments` | `/api/instruments` | Telemetry ingest (MQTT/TCP/WS), overview, per-instrument history, visibility scope, attribute access/downlink, gateway fan-out |
| `instrument-profiles` | — | Device-type profile CRUD |
| `functional-locations` | `/api/functional-locations` | Block/Area tree — authoritative instrument grouping |
| `floorplans` | `/api/floorplans` | Plan + room CRUD, room membership, bucketed room history |
| `alarms` | `/api/alarms` | Alarm rule CRUD, decision engine, notification enqueue |
| `alarm-webhooks` | `/api/alarm-webhooks` | Webhook/hooter target CRUD, scope resolution, test fire, §11 delivery log |

### Notifications

| Module | Prefix | Key Features |
|---|---|---|
| `notifications` | `/api/notifications` | User notifications, unread count, bulk actions |
| `notification-rules` | `/api/notification-rules` | Event-based notification triggers |
| `notification-delivery` | `/api/notification-settings` | Email/SMS/Telegram/Slack channel config |

### Configuration

| Module | Prefix | Key Features |
|---|---|---|
| `config` | `/api/config` | 34 config definitions (`config/defs/`, `ls` 2026-10-01), `dynamic-routes.ts` for registry-discovered surfaces + `static-routes/` per-tab files |

### Infrastructure

| Module | Prefix | Key Features |
|---|---|---|
| `uploads` | `/api/uploads` | Profile photo / floorplan / app background / browser-tab favicon upload (4 routes) |
| `help` | `/api/help` | Help article CRUD |
| `ldap` | `/api/ldap` | LDAP integration config, sync |

### System

| Module | Prefix | Key Features |
|---|---|---|
| `audit` | `/api/audit` | Audit trail query, hash-chain verification |
| `backup` | `/api/backup` | Database export/restore |
| `system-health` | `/api/system-health` | System metrics |
| `dashboards` | `/api/dashboards` | Dashboard CRUD, widget management |
| `debug-traces` | `/api/debug/traces` | Audited-action traces for the Debug UI |

## Shared Libraries (apps/api/src/lib/)

| File | Purpose |
|---|---|
| `prisma.ts` | Prisma client singleton |
| `audit.ts` | SHA-256 hash-chain audit logger |
| `jwt.ts` | JWT token creation, verification, refresh |
| `build-context.ts` | Extract RequestContext from Fastify request |
| `reauth-check.ts` | Re-authentication enforcement (10s in-memory cache) |
| `sanitize.ts` | HTML stripping on all text inputs |
| `password.ts` | bcrypt hashing, password validation |
| `password-validator.ts` | Policy-based password strength rules |
| `errors.ts` | AppError class (statusCode, code, message) |
| `error-schemas.ts` | Fastify error response schemas |
| `config-discovery.ts` | Auto-discover config definitions at startup |
| `config-registry.ts` | Self-registering config module pattern |
| `hash-chain.ts` | SHA-256 chain verification for audit integrity |
| `swagger.ts` | OpenAPI/Swagger configuration |
| `user-id-validator.ts` | Custom user ID format validation |

(`idempotency.ts` — the old "offline replay dedup" lib keyed on `FilterEvent.attributes.clientOpId` — does not exist; verified `find apps/api/src -iname "idempotency*"` returns nothing. `FilterEvent` and the offline-replay flow it belonged to were removed with the filter domain.)

## Plugins (apps/api/src/plugins/)

| Plugin | Purpose |
|---|---|
| `auth.ts` | JWT verification, user lookup from DB, attach `req.user`; maintains `PUBLIC_GET_PATHS` allowlist for unauthenticated endpoints (`/api/health`, `/api/auth/login`, `/api/admin-requests/user-lookup`, `/api/config/password-policy/current`, `/api/config/report-settings/current`, `/api/roles/active`, etc.) |
| `rbac.ts` | `requirePermission(perm)` — single perm check; `requireAnyPermission(...perms)` — accepts any of the listed perms (used for granular toggle fallbacks like `FCP_* OR CHECKLIST_*`); `enforceReauth(action, req, reply)` accepts `string \| string[]` and reauths if any configured for role. |
| `audit-logger.ts` | Auto-log mutations with before/after values; SHA-256 hash-chained per-org. |

## Workers (`apps/api/src/workers/`)

**6** graphile-worker task handlers (verified against the `taskList` in
`app.ts:458-489`, 2026-08-27 — the "3 tasks: notification / pm_overdue_check /
session_sweep" figure recorded elsewhere is stale; there is no
`pm_overdue_check` task in this fork — PM scheduling was part of the removed
filter domain):

| Worker | Task | Purpose |
|---|---|---|
| `notification.worker.ts` | `notification` | On-demand (enqueued by app events) |
| `password-expiry.worker.ts` | `password_expiry_check` | Flags/expires aging passwords |
| `session-sweep.worker.ts` | `session_sweep` | Expires stale sessions |
| `telemetry-partition.worker.ts` | `telemetry_partition_maintenance` | Maintains partitioned instrument-telemetry history table |
| `alarm-evaluation.worker.ts` | `alarm_evaluation` | Every minute: raises / clears the four evaluator-driven alarm sources — instrument limits, inactivity, RS485 sensor failure, sensor range — from each instrument's own attributes and latest readings. There are NO alarm rules: `AlarmRule` and the rule pass were removed 2026-08-31 (row corrected 2026-10-05) |
| `alarm-webhook.worker.ts` | `alarm_webhook` | Annunciates an alarm to matching webhook targets. Event-driven — **no crontab entry on purpose**; enqueued `maxAttempts: 1` with retry bounded inside the task (3 attempts, ~2s apart), so backoff cannot buzz a hooter long after the excursion cleared |

## Instruments module (`apps/api/src/modules/instruments/`)

The largest single module today (replaces the old "Assets module" section,
which described `assets/routes|services|repositories/` — that directory does
not exist; `find apps/api/src/modules -iname "assets"` returns nothing).
Flat file layout, not sub-directories per layer: `routes.ts`,
`ingest-routes.ts` / `ingest-core.ts` / `ingest-auth.ts` (MQTT/TCP/WS ingest),
`mqtt-auth-routes.ts`, `listeners/` (tcp-listener, mqtt-bridge, ws-listener),
`visibility.ts` (instrument-scope resolution), `attribute-access.ts` /
`attribute-downlink.ts`, `decimals.ts` (per-instrument display precision),
`telemetry-overview.ts` / `telemetry.repository.ts`, `bulk-csv.ts`,
`gateway-children.ts` / `gateway-fanout.ts` / `gateway-invariants.ts` /
`child-roster.ts` (gateway-device hierarchy), `token.ts` / `token-crypto.ts`
(device auth tokens), `payload-parser.ts`, `last-seen.ts`.

## Shared `RequestContext` type (`apps/api/src/types/context.ts`)

Single source of truth for "who is making this request":

```typescript
interface RequestContext {
  userId: string;
  username: string;
  fullName: string;
  role: string;
  scope: string;     // always 'GLOBAL' post-MT-removal
  permissions: string[];
}
```

Built by `lib/build-context.ts`. (Pre-MT-removal this also carried an `organizationId` and was consumed by `lib/org-scope.ts`'s `orgWhere(ctx)` helper. Both were removed 2026-04-30; every service that previously scoped queries by org now operates against the full table.)

## E2E Tests (`apps/api/src/e2e/`)

Automated end-to-end test suites (`*.test.ts`) — Vitest-driven, hits a live test database. Run via `npx vitest run e2e`:

| Suite | Coverage |
|---|---|
| `auth.test.ts`, `auth-profile-reauth.test.ts`, `password-expiry-sweep.test.ts` | Login, logout, session, JWT refresh, reauth, password expiry |
| `users.test.ts` | User CRUD, enable/disable/unlock |
| `roles.test.ts`, `role-attribute-access.e2e.test.ts` | Role CRUD, permission assignment, attribute-access rule |
| `audit.test.ts`, `audit-chain.test.ts`, `audit-export-log.test.ts`, `audit-trail-gaps.test.ts` | Audit trail hash-chain integrity, export, gap detection |
| `config.test.ts` | Config defs, registry, partial update |
| `health.test.ts`, `system-health.test.ts` | `/api/health`, system metrics |
| `help-articles.test.ts` | Help CRUD + versioning |
| `notifications.test.ts`, `notification-config-audit-masking.test.ts` | In-app notification flow, secret masking in audit |
| `instruments.test.ts`, `instrument-attributes.test.ts`, `instrument-attribute-downlink.test.ts`, `instrument-child-roster.test.ts`, `instrument-limit-alarms.e2e.test.ts`, `instrument-profiles.e2e.test.ts`, `instrument-token.test.ts`, `instrument-ingest.test.ts`, `limit-attribute-retirement.e2e.test.ts` | Instrument CRUD, attributes/downlink, gateway children, limit alarms, ingest tokens |
| `mqtt-ingest.test.ts`, `mqtt-auth.test.ts`, `tcp-ingest.test.ts`, `ws-ingest.test.ts`, `gateway-ingest.test.ts` | Telemetry ingest over MQTT/TCP/WS + device auth |
| `floorplans.e2e.test.ts`, `room-history.e2e.test.ts`, `telemetry-overview.e2e.test.ts` | Floorplan/room CRUD, bucketed history, dashboard overview |
| `alarm-acknowledge.e2e.test.ts`, `alarm-claim-clear.e2e.test.ts`, `alarm-list-filters.e2e.test.ts`, `alarm-inactivity.e2e.test.ts`, `alarm-rs485.e2e.test.ts`, `alarm-sensor-range.e2e.test.ts` | Acknowledgment, clear, the server-side list filters, and the inactivity / RS485 / sensor-range sources (`ls apps/api/src/e2e/` filtered on `alarm`, 2026-10-05 — there is no `alarm-rules.e2e.test.ts`; rules went 2026-08-31) |
| `alarm-webhooks.test.ts` | Webhook target CRUD, reauth enforcement, audit rows, response-schema completeness, delete refused while deliveries exist, `POST /:id/test` writing a `TEST` delivery row |
| `ldap-directory.e2e.test.ts` | LDAP sync |
| `super-admin-data-delete.test.ts` | Super-admin data management |
| `test-helper.ts` | Shared bootstrapper (sets up + tears down test DB) |

(Verified `ls apps/api/src/e2e/`. The old list here named `entities.test.ts`,
`checklist-submission.test.ts`, `checklist-templates.test.ts` — none exist;
they covered the removed filter/checklist domain. Its "gap" note about
"filter operations, RFID, offline replay, reports, block-change, PM My Tasks"
having no e2e tests is moot — none of those features exist to test.)

## Database Schema (37 models, 13 enums)

> `apps/api/prisma/schema.prisma` is authoritative (verified `grep -cE "^model "` / `"^enum "` 2026-10-05; 36 → 37 on 2026-09-22 with `FloorplanRoomLink`; earlier 34 → 36 on 2026-08-27, `AlarmWebhookTarget` + `AlarmWebhookDelivery`, with no new enum — their `method`/`event`/`status` are validated strings). The
> previous "61 models, 23 enums" figure predates the Phase 0 filter-domain
> strip; every model below in the old "Asset / Filter Operation / Scheduling /
> Report" groups (`AssetTemplate`, `AssetInstance`, `FilterCleaningProfile`,
> `CleaningCycle`, `FilterEvent`, `ChecklistProfile`, `EquipmentGroup`,
> `PmSchedule`, `BlockChangeRequest`, `ReportReview`, and their `*Version`
> sidecars) is gone.

### Core Models
`User`, `Role`, `Session`, `PasswordHistory`, `PasswordResetRequest`, `SystemConfig`, `FieldIdConfig`, `RoleConfig`, `UserConfig`

### Instrument Monitoring Models
`Instrument`, `InstrumentProfile`, `InstrumentCredential`, `InstrumentAttribute`, `InstrumentTelemetryLatest`, `FunctionalLocation`, `Floorplan`, `FloorplanRoom`, `AlarmRule`, `Alarm`, `AlarmWebhookTarget`, `AlarmWebhookDelivery`, `DeadLetter` (verified `grep -E "^model " apps/api/prisma/schema.prisma` 2026-08-27; the last two added that day — `AlarmWebhookDelivery` is the §11 receipt, one row per delivery attempt, and both its FKs `Restrict` so deleting a target cannot erase the record of what it annunciated)

### Notification Models
`Notification`, `NotificationLog`, `NotificationTemplate`, `NotificationRule`, `NotificationRuleRecipient`, `UserGroup`, `UserGroupMember`

### System Models
`AuditTrail`, `Dashboard`, `DashboardWidget`, `DashboardAssignment`, `HelpArticle`, `HelpArticleVersion`, `AdminRequest`

## Environment Variables

Verified against `apps/api/.env.example` 2026-08-24 (previous version here
still listed `capacitor://localhost` in `ALLOWED_ORIGINS`, `JWT_EXPIRES_IN=8h`,
and claimed TimescaleDB/MQTT vars were fully retired — MQTT vars are back,
see below):

```env
# PostgreSQL — also used by graphile-worker (shares the same DB)
DATABASE_URL=postgresql://digilog:CHANGE_ME@localhost:5432/digilog_db?schema=public

# JWT
JWT_SECRET=change-this-to-a-secure-random-string
# VERIFICATION_TOKEN_SECRET — removed 2026-10-05 (audit SEC-5); nothing reads it
JWT_EXPIRES_IN=1h

# Audit chain integrity (21 CFR §11.10(e)) — AUDIT_CHAIN_KEY + AUDIT_CHAIN_KEYED_FROM,
# see apps/api/.env.example for the full pairing rationale

# Server — these are apps/api/.env.example's DEFAULTS. This checkout's apps/api/.env
# overrides PORT=3001 / WEB_PORT=5176 (root CLAUDE.md Key Local URLs) and ALLOWED_ORIGINS
# must then name the port the SPA is actually served from.
NODE_ENV=production
API_PORT=3000
WEB_PORT=5175
API_HTTPS=true

# CORS
CORS_ORIGIN=http://localhost:5175
ALLOWED_ORIGINS=http://localhost:5175,http://localhost:5173,http://localhost:3000

# Uploads
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=5242880
```

**No TSDB_*/UNS_* keys** (Phase 7 TimescaleDB/data-ingestion removal, 2026-06-17,
still holds). **MQTT came back 2026-08-06** with the Instruments ingest bridge —
an external EMQX broker feeding readings into the same ingest core the HTTP
route uses; see the instrument-ingest block in `apps/api/.env.example` for its
keys. This is a distinct mechanism from the pre-Phase-7 MQTT/Mosquitto layer
that was torn out.

## Key Architectural Patterns

1. **Module pattern** — Each feature is a self-contained module with routes + service (+ repository where the module is large enough to split)
2. **Single-tenant, single-site** — no per-org scoping; JWT `scope` always stamps `GLOBAL`
3. **Permission-based RBAC** — `requirePermission('PERM')` on every protected route
4. **Re-authentication** — `enforceReauth('ACTION', req, reply)`, **48** reauth actions defined in `packages/shared/src/types/reauth-actions.ts` (verified `grep -cE "^\s+[A-Z_]+:"`; the "81 sensitive operations" figure previously here was a leftover from the removed filter/PM/RFID domain's reauth-gated actions)
5. **Audit logging** — Every mutation auto-logged with SHA-256 hash chain (optionally keyed HMAC-SHA256, see `AUDIT_CHAIN_KEY` above)
6. **Input sanitization** — All text fields stripped of HTML via `sanitize.ts`
7. **Config registry** — 34 config definitions (2026-10-01) auto-discovered at startup
8. **Instrument governance** — per-role/per-user instrument visibility scope (`instrument_scope` JSONB), per-role attribute editability (`attribute_access` JSONB), per-instrument display-decimal precision frozen onto alarm records at raise time — see root `CLAUDE.md` System Stats for the full rules. (The old point 8 here described `FilterCleaningProfile`/`ChecklistProfile`/`EquipmentGroup` versioning sidecars and a "Tablet/offline contract" — those models and the whole versioning scheme are gone with the filter domain. `future/offline-version-sync-contract.md` still exists on disk as a forward-looking design note, per its `future/` location, but nothing in live code implements it.)
9. **Immutable audit trail** — audit rows stored with checksums, never modified (21 CFR Part 11); the old point 9 ("Filter events stored with checksums") described the removed `FilterEvent` model specifically
10. **Error handling** — `AppError(statusCode, code, message)` → unified JSON error response
