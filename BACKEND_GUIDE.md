# DigiLog — Backend Guide

> **2026-07-03 — synced to the current codebase.** The Phase 6/7 tear-out
> sections (`data-ingestion` / `uns` / `connectivity` / `queries` / `rule-chain` /
> `transport/` / Mosquitto / MQTT / TimescaleDB / `packages/db`) were removed from
> this guide, and counts/tables reconciled to live (**33 modules, 61 models, 23
> enums** — reports + report-templates removed 2026-07-04). See root `CLAUDE.md` Phase 7 snapshot + `apps/api/CLAUDE.md` for the
> authoritative module list + `CHANGELOG.md` for tear-out details.

## Overview

Fastify 5 backend with TypeScript, **33 API modules** (verified `ls` 2026-07-04 — see `apps/api/CLAUDE.md`). Runs locally on Windows: `tsx watch` in dev, compiled JS for prod-style local builds. Under the `DigiLog-Setup.exe` installer, production runs as the `DigiLogAPI` Windows service (WinSW-wrapped `node dist/app.js`, via `scripts/register-services.ps1`); a manual deploy can run `node dist/app.js` in the foreground (Phase 4 retired PM2). See `docs/PHARMA_DEPLOYMENT_21CFR.md`. EC2 is no longer in scope.

**Entry point:** `apps/api/src/app.ts`
**Dev:** `cd apps/api && npx tsx watch src/app.ts` (port 3000)
**Build:** `npx tsc -p apps/api/tsconfig.json` → `apps/api/dist/`
**Production smoke-test:** `cd api && node dist/app.js` (foreground — no auto-restart; for a manual deploy). Under the `DigiLog-Setup.exe` installer the API runs as the `DigiLogAPI` Windows service (WinSW, via `scripts/register-services.ps1`) for boot persistence + restart-on-crash; `scripts/verify-windows-deployment.ps1` smoke-checks a running deployment. PM2 was retired in Phase 4 (commits `127f25d..60d3c90` on `feature/phase4-tooling`).

## App Setup (app.ts)

The main application file registers everything in this order:

1. **Fastify instance** — body limit 10MB, logger (pino)
2. **Helmet** — security headers (HSTS, no CSP)
3. **CORS** — configured origins from .env
4. **Rate limiter** — 500 requests/minute global
5. **Swagger** — OpenAPI docs at `/docs`
6. **Auth plugin** — JWT verification, user lookup, session validation
7. **RBAC plugin** — `requirePermission()` decorator
8. **Audit logger plugin** — SHA-256 hash-chain logging
9. **33 route modules** — registered under `/api/` prefix
10. **Job runner** — one graphile-worker Runner registers the task handlers
   (`notification`, `pm_overdue_check`, `session_sweep`) + the maintenance
   crontab (Phase 2 swapped from BullMQ). *The MQTT client, `/ws` handler, and
   the ingestion/maintenance workers were removed in the Phase 7 tear-out.*
11. **Config discovery** — auto-registers 35 config definitions
12. **Static uploads** — serves `/uploads/` directory
13. **Health check** — `GET /api/health`
14. **Error handler** — unified error responses (AppError → HTTP codes)

## 35 API Modules

(Authoritative list: `ls apps/api/src/modules/` — see `apps/api/CLAUDE.md`. Endpoint counts below are approximate.)

### Auth & User Management

| Module | Prefix | Endpoints | Key Features |
|---|---|---|---|
| `auth` | `/api/auth` | 9 | Login, logout, refresh, verify, change-password, forgot-password |
| `users` | `/api/users` | 14 | CRUD, enable/disable, unlock, reset-password, bulk-delete |
| `roles` | `/api/roles` | 8 | Role CRUD, permissions, hierarchy, creatable roles |
| `user-groups` | `/api/user-groups` | 7 | Group CRUD, member management |

### Admin

| Module | Prefix | Endpoints | Key Features |
|---|---|---|---|
| `super-admin` | `/api/super-admin` | ~30 | Platform-wide admin, system stats, data management (org CRUD removed in MT removal 2026-04-30) |
| `admin-requests` | `/api/admin-requests` | 4 | Admin action request workflow |

> **Note (MT removal 2026-04-30):** `org-admin` and `tenant-admin` modules were deleted entirely. DigiLog is now single-tenant.

### Asset Management

| Module | Prefix | Endpoints | Key Features |
|---|---|---|---|
| `assets` | `/api/assets` | 30+ | Templates, instances, relationships, identifiers (sub-routes) |
| `hierarchy` | `/api/hierarchy` | 10+ | Typed Block/Area/AHU/Filter hierarchy read + typed filter create (Wave 2/3) |
| `equipment-groups` | `/api/equipment-groups` | 6 | AHU equipment group CRUD |

### Filter Operations

| Module | Prefix | Endpoints | Key Features |
|---|---|---|---|
| `filter-operations` | `/api/filters` | 15 | Cycle start/advance/bypass, checklist submit, events |
| `filter-profiles` | `/api/filter-profiles` | 8 | Filter-to-profile assignments + Phase A.3 sidecar versioning + version-history endpoints |
| `cleaning-profiles` | `/api/filter-cleaning-profiles` | 11 | Pipeline profile CRUD, lineage-based versioning (Phase A.2 — `lineageId` UUID), version-history endpoints, validation |
| `checklist-profiles` | `/api/checklist-profiles` | 9 | Checklist template + question management |
| `pm-schedules` | `/api/pm-schedules` | 18 | PM scheduling, entries, executions, approvals |
| `block-change-requests` | `/api/block-change-requests` | 5 | Block reassignment approval workflow |
| `stage-approvals` | `/api/stage-approvals` | 6 | Stage-interlock approval workflow (WASH_OUT/DRY_OUT QA gate) |
| `replacement-schedule` | `/api/replacement-schedules` | 6 | Scheduled filter-replacement workflow |

### Reports

| Module | Prefix | Endpoints | Key Features |
|---|---|---|---|
| `report-reviews` | `/api/report-reviews` | 6 | Report review/approval workflow |

### Notifications

| Module | Prefix | Endpoints | Key Features |
|---|---|---|---|
| `notifications` | `/api/notifications` | 9 | User notifications, unread count, bulk actions |
| `notification-rules` | `/api/notification-rules` | 8 | Event-based notification triggers |
| `notification-delivery` | `/api/notification-settings` | 18 | Email/SMS/Telegram/Slack channel config |

### Configuration

| Module | Prefix | Endpoints | Key Features |
|---|---|---|---|
| `config` | `/api/config` | 40+ | 35 config definitions (`config/defs/`), `dynamic-routes.ts` for registry-discovered surfaces + `static-routes/` per-tab files (split done in bloat audit P2.3) |

**Static-routes split** (`apps/api/src/modules/config/static-routes/`, 18 files): `access-matrix.routes.ts`, `action-reauth.routes.ts`, `ahu-completion-process.routes.ts`, `audit-templates.routes.ts`, `branding.routes.ts`, `cleaning-profile-assignment.routes.ts`, `dashboard-cards.routes.ts`, `export-options.routes.ts`, `field-ids.routes.ts`, `offline-cache.routes.ts`, `pm-schedule-filters.routes.ts`, `replacement-schedule-filters.routes.ts`, `report-labels.routes.ts`, `report-page-titles.routes.ts`, `report-signatories.routes.ts`, `roles.routes.ts`, `tablet-access.routes.ts`, `user-id.routes.ts` (`alarm-columns.routes.ts` removed 2026-05-17 with the rule-chain/alarm tear-out). Top-level `routes.ts` is now a registration loop (~170 LOC, was 1003).

### Infrastructure

| Module | Prefix | Endpoints | Key Features |
|---|---|---|---|
| `guest` | `/api/guest` | 1 | Unauthenticated guest filter-cleaning request |
| `uploads` | `/api/uploads` | 1 | Profile photo upload |
| `help` | `/api/help` | 6 | Help article CRUD |
| `ldap` | `/api/ldap` | 4 | LDAP integration config, sync |

### System

| Module | Prefix | Endpoints | Key Features |
|---|---|---|---|
| `audit` | `/api/audit` | 4 | Audit trail query, hash-chain verification |
| `backup` | `/api/backup` | 3 | Database export/restore (JSON, SQL, CSV, BAK) |
| `system-health` | `/api/system-health` | 1 | System metrics |
| `deployment-check` | `/api/deployment-check` | 1 | Deployment validation |
| `dashboards` | `/api/dashboards` | 13 | Dashboard CRUD, widget management |
| `debug-traces` | `/api/debug/traces` | 2 | Audited-action traces for the Debug UI (repointed onto `audit_trail` in Phase 7) |
| `sync` | `/api/sync` | 4 | Offline queue sync / batch replay |

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
| `idempotency.ts` | **Offline replay dedup** — checks `x-client-op-id` header against `FilterEvent.attributes.clientOpId`; returns cached state for duplicate replays so retries never produce duplicate cycles, double advances, or repeat checklist submissions. |

## Plugins (apps/api/src/plugins/)

| Plugin | Purpose |
|---|---|
| `auth.ts` | JWT verification, user lookup from DB, attach `req.user`; maintains `PUBLIC_GET_PATHS` allowlist for unauthenticated endpoints (`/api/health`, `/api/auth/login`, `/api/admin-requests/user-lookup`, `/api/config/password-policy/current`, `/api/config/report-settings/current`, `/api/roles/active`, etc.) |
| `rbac.ts` | `requirePermission(perm)` — single perm check; `requireAnyPermission(...perms)` — accepts any of the listed perms (used for granular toggle fallbacks like `FCP_* OR CHECKLIST_*`); `enforceReauth(action, req, reply)` accepts `string \| string[]` and reauths if any configured for role. |
| `audit-logger.ts` | Auto-log mutations with before/after values; SHA-256 hash-chained per-org. |

## Workers

Three graphile-worker task handlers (the `transport/` layer + the ingestion/maintenance workers were all removed in the Phase 7 tear-out):

| Worker | Task | Schedule |
|---|---|---|
| `notification.worker.ts` | `notification` | On-demand (enqueued by app events) |
| `pm-overdue.worker.ts` | `pm_overdue_check` | Daily cron (~08:30) — flags overdue PM deviations |
| `session-sweep.worker.ts` | `session_sweep` | Cron — expires stale sessions |

## Assets module (`apps/api/src/modules/assets/`)

The largest single module — split into per-domain layers:

```
assets/
├── routes/              4 route files (identifier, instance, relationship, template)
├── services/            5 services (identifier, instance, relationship, template, bulk-upload-filter)
├── repositories/        4 Prisma access layers (identifier, instance, relationship, template)
├── helpers/             Shared helpers
└── index.ts             Registration barrel
```

`bulk-upload-filter.service.ts` handles the dynamic CSV bulk upload that reads the Filter template's `attributeSchema` to decide columns + validation.

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
| `auth.test.ts` | Login, logout, session, JWT refresh |
| `users.test.ts` | User CRUD, enable/disable/unlock |
| `roles.test.ts` | Role CRUD, permission assignment |
| `entities.test.ts` | Asset templates + instances + relationships |
| `audit.test.ts` | Audit trail hash-chain integrity |
| `checklist-submission.test.ts` | Checklist field validation, sig flow |
| `checklist-templates.test.ts` | Checklist profile + question CRUD |
| `config.test.ts` | Config defs, registry, partial update |
| `health.test.ts` | `/api/health` endpoint |
| `help-articles.test.ts` | Help CRUD + versioning |
| `notifications.test.ts` | In-app notification flow |
| `system-health.test.ts` | System metrics |
| `test-helper.ts` | Shared bootstrapper (sets up + tears down test DB) |

**Note:** Phase 2/3/4/5 features (filter operations, RFID, offline replay, reports, block-change, PM My Tasks) do NOT yet have e2e tests. The archived `tests/manual-test-cases/` only covered Phase 1 — those remain a gap (logged in `PHASE_5_RECENT_WORK.md` § 11).

## Database Schema (61 models, 23 enums)

> `apps/api/prisma/schema.prisma` is authoritative. The lists below are grouped highlights (deleted Phase 6/7 models — `Organization`, `DeviceCredential`, `RuleChain*`, `Alarm`, `ConnectivityStatus`, `DataStream`, `LatestTelemetry`, `DeadLetterQueue`, `IngestionSystemConfig`, `QrCode`, `UnsMapping` — removed; newer typed-hierarchy sidecars `Block`/`Area`/`Ahu`/`Filter` + `FilterDetails` not all listed).

### Core Models
`User`, `Role`, `Session`, `PasswordHistory`, `PasswordResetRequest`, `SystemConfig`, `FieldIdConfig`, `RoleConfig`, `UserConfig`

### Asset Models
`AssetTemplate`, `AssetTemplateVersion`, `AssetInstance`, `AssetRelationship`, `AssetIdentifier`, `TemplateAssignment`, `EntityAssignment`, `FilterDetails` (Step 6 sidecar), typed `Block`/`Area`/`Ahu`/`Filter` (Wave 1)

### Filter Operation Models
`FilterCleaningProfile`, `FilterPipelineStage`, `FilterPipelineConnection`, `FilterProfile`, `FilterProfileVersion` (Phase A.3 sidecar), `FilterProfileApplicableTemplate` (Step 4 join table), `CleaningCycle`, `FilterEvent`, `ChecklistProfile`, `ChecklistQuestion`, `ChecklistProfileVersion` (Phase A.1 sidecar), `ChecklistReview`, `ElectronicSignature`, `EquipmentGroup`, `EquipmentGroupInstrument`, `EquipmentGroupVersion` (Phase A.4 composite sidecar)

### Scheduling Models
`PmSchedule`, `PmScheduleEntry`, `PmExecution`, `EquipmentGroup`, `EquipmentGroupInstrument`, `BlockChangeRequest`

### Report Models
`ReportReview` (ad-hoc review/approval workflow). *(ReportTemplate, ReportTemplateVersion, ReportInstance, ReportSignature dropped 2026-07-04 with the orphaned reports generate/sign module.)*

### Notification Models
`Notification`, `NotificationLog`, `NotificationTemplate`, `NotificationRule`, `NotificationRuleRecipient`, `UserGroup`, `UserGroupMember`

### System Models
`AuditTrail`, `Dashboard`, `DashboardWidget`, `DashboardAssignment`, `HelpArticle`, `HelpArticleVersion`, `AdminRequest`

## Environment Variables

```env
# PostgreSQL
DATABASE_URL=postgresql://digilog:password@localhost:5432/digilog_db?schema=public

# (Phase 7 removed TimescaleDB (TSDB_*), MQTT/Mosquitto (MQTT_*/MOSQUITTO_*/EMQX_*)
# env vars. Phase 4 had retired Redis (REDIS_*); the in-process EventEmitter bus
# that replaced it was itself removed 2026-07-03 as dead code. None are read now.)

# JWT
JWT_SECRET=random-64-char-string
VERIFICATION_TOKEN_SECRET=different-random-64-char-string
JWT_EXPIRES_IN=8h

# Server
NODE_ENV=production
API_PORT=3000
API_HTTPS=true

# CORS
CORS_ORIGIN=https://192.168.1.100
ALLOWED_ORIGINS=https://192.168.1.100,capacitor://localhost

# Uploads
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=5242880
```

## Key Architectural Patterns

1. **Module pattern** — Each feature is a self-contained module with routes + service + repository
2. **Single-tenant** — As of MT removal (2026-04-30), there is no per-org scoping; every query operates against the full table.
3. **Permission-based RBAC** — `requirePermission('PERM')` on every protected route
4. **Re-authentication** — `enforceReauth('ACTION', req, reply)` for 81 sensitive operations
5. **Audit logging** — Every mutation auto-logged with SHA-256 hash chain
6. **Input sanitization** — All text fields stripped of HTML via `sanitize.ts`
7. **Config registry** — 35 config definitions auto-discovered at startup
8. **Versioning** — Two patterns: (a) **immutable-rowful** for `FilterCleaningProfile` (update archives the old row + inserts a new row with `version+1`; rows in the same lineage share `lineageId UUID`; cycles freeze `profileId` at start) and help articles; (b) **sidecar table** for `ChecklistProfile` (Phase A.1), `FilterProfile` (Phase A.3), and `EquipmentGroup` (Phase A.4 — composite snapshot of group + 3 instruments) — all three mutate in place; mutations snapshot the OUTGOING state into a `*Version` sidecar then bump `version`. **Cycle pinning:** ChecklistProfile via `cycle.checklistVersionPins JSONB` (A.1) and EquipmentGroup via `cycle.equipmentGroupVersionPin Int?` (P1, 2026-05-02) — reading validation reads operating-range from the pinned snapshot, not the live group. FilterProfile needs no cycle pin because cycles already pin `cleaning_cycles.profileId` to a FilterCleaningProfile row at start. Submitted instrument readings are also immutably snapshotted into `FilterEvent.attributes.instrumentReadings`. First version is created lazily — the live row IS v1 until first edit. Cleaning reasons (config def) are NOT versioned: `CleaningCycle.cleaningReasonKey` + `cleaningReasonLabel` columns written at cycle start act as the per-cycle pin. **Tablet/offline contract** for sending `expected<Entity>Version` and self-healing on 409 SCHEMA_DRIFT is documented in `future/offline-version-sync-contract.md` and bundled with the next APK build (Slice B).
9. **Immutable events** — Filter events stored with checksums, never modified (21 CFR Part 11)
10. **Error handling** — `AppError(statusCode, code, message)` → unified JSON error response
