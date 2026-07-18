# DigiLog — Project Architecture

> **Reconciled to current architecture 2026-07-04.** DigiLog is a Fastify API + PostgreSQL 18 (Prisma, single database — no TimescaleDB) + graphile-worker queue + React SPA + Capacitor APK + native RFID scanner. The data-ingestion pipeline, UNS, device connectivity, MQTT/Mosquitto broker, TimescaleDB, transport layer, rule-chain/alarm subsystems, and multi-tenancy were all removed (2026-04-30..2026-07-03). This doc describes only what remains. See root `CLAUDE.md` + `CHANGELOG.md` for the full removal history.

## System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        CLIENT DEVICES                            │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌──────────────┐  │
│  │  Desktop   │  │  Tablet   │  │  Mobile   │  │ RFID Scanner │  │
│  │  Browser   │  │  APK      │  │  PWA      │  │ (Kotlin app) │  │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └──────┬───────┘  │
└────────┼───────────────┼───────────────┼───────────────┼─────────┘
         │               │               │               │
         │  HTTPS :3000  │  HTTPS :3000  │  HTTPS :3000  │ HTTPS :3000
         ▼               ▼               ▼               ▼
┌──────────────────────────────────────────────────────────────────┐
│                      SERVER (Windows)                            │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐        │
│  │       Fastify API (:3000)                             │        │
│  │  Serves the static SPA (apps/web/dist) AND /api/*     │        │
│  │  routes directly over HTTPS (mkcert). A reverse       │        │
│  │  proxy (Nginx / IIS) is optional / customer-choice;   │        │
│  │  not bundled after Phase 4 of the                     │        │
│  │  windows-friendly-rewrite.                            │        │
│  │  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐    │        │
│  │  │ 35 Route │ │  Auth    │ │ RBAC   │ │ graphile │    │        │
│  │  │ Modules  │ │  Plugin  │ │ Plugin │ │ workers  │    │        │
│  │  └────┬─────┘ └──────────┘ └────────┘ └──────────┘    │        │
│  └───────┼──────────────────────────────────────────────┘        │
│          │                                                       │
│  ┌───────┼──────────────────────────────────────────────┐        │
│  │       ▼          DATA LAYER                          │        │
│  │  ┌────────────────────────────────┐                   │        │
│  │  │ PostgreSQL 18  :5432            │                   │        │
│  │  │ 61 Prisma models · 23 enums     │                   │        │
│  │  │ digilog_db (app + queue schema) │                   │        │
│  │  │ graphile-worker job queue       │                   │        │
│  │  └────────────────────────────────┘                   │        │
│  │  Single database. No TimescaleDB, no Redis, no MQTT    │        │
│  │  broker, no separate queue service.                   │        │
│  └──────────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────┘
```

> **Tech-stack swap (windows-friendly-rewrite Phases 2+3+4):**
> BullMQ on Redis/Memurai → graphile-worker on PostgreSQL (Phase 2);
> Puppeteer (bundled Chromium) + chartjs-node-canvas → puppeteer-core + Edge +
> @napi-rs/canvas (Phase 3). **Phase 4 (2026-05-01): Redis fully retired** —
> `ioredis` removed; the non-queue pub/sub consumers (WebSocket events,
> pipeline tracer, debug recorder) that briefly moved to an in-process
> EventEmitter bus were all torn out in Phase 6/7, and the orphaned bus
> (`lib/internal-bus.ts`) + `@fastify/websocket` were removed 2026-07-03 as
> dead code — **no pub/sub layer remains**. (The device-RPC correlation cache
> `lib/rpc-cache.ts` went 2026-07-01 with the Phase 7 data-ingestion tear-out.)
> **2026-07-04: the reports generate/sign PDF engine was removed** — `puppeteer-core`,
> `@napi-rs/canvas`, `chart.js`, `chartjs-adapter-date-fns`, and `dayjs` uninstalled with it;
> no server-side PDF/Chromium stack remains (the surviving cleaning-record / filter-lifecycle
> export renders client-side).

## Monorepo Package Architecture

```
21cfrlogbook-DigitalFMS/          (Turborepo root)
│
├── apps/api/                      (Fastify backend)
│   ├── src/
│   │   ├── app.ts                 Entry point — registers all plugins, routes, handlers
│   │   ├── modules/               33 feature modules (routes.ts + *.service.ts)
│   │   ├── plugins/               auth.ts, rbac.ts, audit-logger.ts
│   │   ├── workers/               notification.worker.ts, pm-overdue.worker.ts, session-sweep.worker.ts (graphile-worker tasks)
│   │   ├── lib/                   Shared utilities (audit, jwt, sanitize, prisma, etc.)
│   │   └── types/                 TypeScript type definitions
│   └── prisma/
│       ├── schema.prisma          61 models, 23 enums
│       └── seed.ts                Default roles, superadmin, configs
│
├── apps/web/                      (React SPA)
│   └── src/
│       ├── main.tsx               Route definitions (77 routes), lazy loading, error boundaries
│       ├── routes/                23 route module dirs
│       ├── components/            Layout (sidebar, header), UI primitives, dialogs
│       ├── hooks/                 26 custom hooks (auth, session, branding, offline, etc.)
│       └── lib/                   API client, SWR config, themes, offline store, sync engine
│
├── apps/android/                  (Capacitor Android wrapper)
│   ├── capacitor.config.ts        Server URL, plugins config
│   └── android/
│       └── app/src/main/java/com/digilog/filtermanagement/
│           ├── MainActivity.java   Capacitor BridgeActivity entry
│           └── RfidPlugin.java     Native Capacitor plugin wrapping Reader_Usb.jar — opens USB device, emits "tag" events to JS via plugin bridge (paired with apps/web/src/lib/rfid-bridge.ts)
│
├── packages/shared/               (Shared types & schemas)
│   └── src/
│       ├── schemas/               Zod validation schemas
│       └── types/                 Permissions (102), privileges (83), reauth (92), sidebar items (26)
│
└── packages/queue/                (Job queue)
    ├── crontab.txt                graphile-worker cron file (pm_overdue_check, session_sweep)
    └── src/
        ├── index.ts               getProducer() + getRunner() over graphile-worker on Postgres (Phase 2 of windows-friendly-rewrite swapped from BullMQ + ioredis; commit `7832af1`)
        ├── schemas.ts             Zod schemas for job payloads
        └── priorities.ts          Job priority levels (1-8)
```

## Build / test infrastructure

| File | Purpose |
|---|---|
| `turbo.json` | Turborepo task graph — build/test pipelines for all workspaces |
| `vitest.workspace.ts` | Vitest workspace config — discovers tests across `apps/*` and `packages/*` |
| `test-engine.mjs` (root) | Standalone `node:vm`-sandbox script runner — used to debug an isolated snippet |
| `package.json` (root) | Workspace root, holds turbo + dev tools (NOT app deps — those live in workspaces; bloat audit P3.1 cleanup done) |
| Per-workspace `vitest.config.ts` | `apps/api` and `packages/shared` each carry their own Vitest config; `packages/queue` has no test config. |
| `apps/web/vite.config.ts` | Vite + PWA plugin + Tailwind + path aliases |
| `apps/web/eslint.config.js` | ESLint flat config — `typescript-eslint` + `no-explicit-any: warn`; max-warnings cap 10000 (bloat audit P0.3) |
| `apps/web/index.html` | Vite SPA entry HTML — root `<div id="root">`, theme `<meta>` |
| `apps/web/tsconfig.json` + `tsconfig.tsbuildinfo` | TS project + incremental cache |
| `apps/web/generate-apk.md` | APK build walkthrough (web build → `cap copy` → `gradlew assembleDebug`) |

## CI / GitHub

| Path | Purpose |
|---|---|
| `.github/workflows/ci.yml` | GitHub Actions CI — runs on push/PR; build + lint + tests |
| `.github/ISSUE_TEMPLATE/bug_report.md` | Bug report template |

## Database migrations + uploads

| Path | Purpose |
|---|---|
| `apps/api/prisma/schema.prisma` | 61 models, 23 enums |
| `apps/api/prisma/seed.ts` | Default roles, super-admin user, system configs |
| `apps/api/prisma/migrations/` | Versioned Prisma migrations — `00000000000000_baseline` (squashed schema) + `20260701071802_drop_qrcode_latesttelemetry`, plus `migration_lock.toml` |
| `apps/api/prisma/sql/extensions.sql` | Hand-written SQL — installs PostgreSQL extensions (e.g. `pg_trgm`, `uuid-ossp`) used by Prisma |
| `apps/api/prisma/schema.prisma.bak` | **Stray backup file** — clean up |
| `apps/api/uploads/photos/` | User-uploaded profile photos + checklist photos (served at `/uploads/`) |
| `apps/api/uploads/reports/` | **Legacy/orphaned** — was written by the reports generate/sign module (removed 2026-07-04); nothing writes here now (the surviving PDF export is client-side) |

## Frontend public assets (`apps/web/public/`)

| File | Purpose |
|---|---|
| `favicon.svg` | Site favicon |
| `logo.jpg` | Default org logo (overridable via Branding config) |
| `apple-touch-icon.png` | iOS home-screen icon |
| `pwa-192x192.{png,svg}`, `pwa-512x512.{png,svg}`, `pwa-icon.svg` | PWA manifest icons (used by `vite-plugin-pwa`) |
| `sw.js` (built into `dist/`) | Service worker — offline queue background sync hook |

## Repo-level Infrastructure

```
21cfrlogbook-DigitalFMS/
├── certs/                         (mkcert-generated TLS — for HTTPS API)
│   ├── rootCA.pem                 Install on tablet system cert store for APK trust
│   ├── rootCA.key                 mkcert root key
│   ├── server.crt / server.key    Localhost cert pair used by API_HTTPS=true
│   └── ssl.conf                   OpenSSL config for cert generation
│
├── scripts/                       (Setup.exe installer automation — M0–M8; see tasks/EXE-PACKAGING-PLAN.md)
│   ├── build-bundle.ps1            Compiles the single-process backend+SPA bundle (no Vite)
│   ├── build-installer.ps1         Full pipeline → DigiLog-Setup-<ver>.exe (bundle + clean-room deps + portable Postgres + WinSW + Inno ISCC)
│   ├── stage-runtime.ps1           Assembles the self-contained runtime/ folder the installer ships
│   ├── provision-db.ps1            Init the bundled private Postgres cluster + extensions + migrate + seed
│   ├── apply-schema.ps1            Shared migrate deploy + seed (used by both fresh install and upgrade — no drift)
│   ├── register-services.ps1       Register DigiLogDB (pg_ctl) + DigiLogAPI (WinSW) auto-start services
│   ├── install.ps1 / upgrade.ps1   Fresh-install / data-safe upgrade orchestrators (run by the Inno installer)
│   ├── uninstall.ps1 / unregister-services.ps1  Uninstall (preserves C:\ProgramData\DigiLog data)
│   ├── verify-windows-deployment.ps1  Post-install smoke-check (API /health + graphile-worker schema)
│   ├── verify-migrations.ps1       Drift guard: scratch DB from migrations must diff empty vs dev DB
│   └── reset-cwh-cycles.sql        Emergency SQL to terminate IN_PROGRESS cycles bound to obsolete profile (used 04-25 for 7 stuck CWH cycles)
│
├── rfid_scan_app/                 (Standalone Kotlin app — predates RFID SDK plugin in DigiLog APK)
│   ├── app/                        Kotlin sources, AndroidManifest, layout XMLs
│   ├── build.gradle.kts            Root Gradle config
│   ├── gradle.properties / settings.gradle.kts / gradlew[.bat]  Gradle wrapper
│   ├── rfid-key.jks                **SENSITIVE** signing keystore (should not be committed — see Working-tree noise)
│   └── RFID_Scanner_User_Manual.html  End-user manual for the standalone scanner
├── start-digilog.bat / stop-digilog.bat  Local Windows service launchers
└── DigiLog-FilterOps.apk          Built APK at repo root after gradlew assembleDebug
```

## Working-tree noise (cleanup candidates)

Items present in the working tree that are NOT canonical — these should be `.gitignored` or removed:

| Path | Status | Action |
|---|---|---|
| `RFID/` (top-level dir) | Stray Gradle build cache for an older standalone Kotlin project, separate from `rfid_scan_app/` | Add `RFID/` to `.gitignore` or delete |
| `rootCA.pem` (top-level file) | Duplicate of `certs/rootCA.pem` | Use only the `certs/` copy |
| `apps/android/apps/web/public/sw.js` | Stray nested service-worker file (misplaced relative path during a build) | Compare with `apps/web/public/sw.js`; remove the nested duplicate |
| `rfid_scan_app/rfid-key.jks` | Android signing keystore — **sensitive, should NOT be committed** | Move to operator-only secrets store; add `*.jks` to `.gitignore`; rotate key if already pushed |
| `rfid_scan_app/local.properties` | Per-machine SDK paths | Already gitignored normally; verify |
| `packages/shared/src/schemas/config.ts.patch` | Stray patch file in source tree | Apply or delete |
| `.playwright-mcp/*.yml` (when present) | Per-session Playwright MCP traces | Add `.playwright-mcp/` to `.gitignore` (bloat audit P3.2 still open) |
| `apps/api/prisma/schema.prisma.bak` | Backup of an older schema | Delete — git history is authoritative |
| `apps/api/dist/`, `apps/web/dist/`, `packages/*/dist/` | Compiled outputs | Should be gitignored; verify |
| `apps/api/tsconfig.tsbuildinfo`, `apps/web/tsconfig.tsbuildinfo`, `packages/shared/tsconfig.tsbuildinfo` | TS incremental cache | Should be gitignored |

## Backend Architecture (apps/api/)

### Request Flow

```
HTTPS Request → Fastify (:3000, mkcert TLS, serves SPA + /api/*)
      → Helmet (security headers)
      → CORS (origin validation)
      → Rate Limiter (500 req/min)
      → Auth Plugin (JWT verification, user lookup)
      → RBAC Plugin (permission check)
      → Route Handler (business logic)
        → Service Layer (data processing)
          → Prisma (PostgreSQL)
          → graphile-worker (async jobs on Postgres)
        → Audit Logger (SHA-256 hash chain)
      → Response (JSON)
```

> Reverse proxy (Nginx / IIS) is optional and customer-choice, not bundled after Phase 4 of the windows-friendly-rewrite. Direct Fastify-on-3000 is the default install path.

### Module Structure

Each of the 33 modules follows this pattern:

```
modules/
└── <module-name>/
    ├── routes.ts              HTTP route definitions + Fastify schema validation
    ├── <module>.service.ts    Business logic, data processing
    ├── <module>.repository.ts Data access layer (Prisma queries)
    └── __tests__/             Vitest unit tests
```

### 35 API Modules

> **MT removal 2026-04-30:** `org-admin` and `tenant-admin` modules deleted; DigiLog is single-tenant. **Phase 6/7 (2026-05-17..06-17):** `rule-chain`, `data-ingestion`, `queries`, `uns`, `connectivity`, `qr-code` modules deleted with their subsystems.

| Category | Modules |
|---|---|
| **Auth & Users** | auth, users, roles, user-groups, guest |
| **Admin** | super-admin (org CRUD endpoints removed in MT removal) |
| **Assets** | assets (templates/instances/relationships/identifiers), hierarchy |
| **Filter Operations** | filter-operations, filter-profiles, cleaning-profiles, checklist-profiles, stage-approvals |
| **Scheduling** | pm-schedules, equipment-groups, replacement-schedule |
| **Approvals** | block-change-requests, admin-requests |
| **Reports** | report-reviews (ad-hoc submit/review/approve workflow). *(The `report-templates` designer + `reports` generate/sign engine were removed 2026-07-04.)* |
| **Notifications** | notifications, notification-rules, notification-delivery |
| **Config** | config (35 definitions with auto-discovery; monolith split into `static-routes/` per surface) |
| **Support** | uploads, help, ldap |
| **System** | audit, backup, system-health, deployment-check, dashboards, debug-traces, sync |

### Authentication Architecture

```
Login Flow:
  POST /api/auth/login → validate credentials → create Session → return JWT (8h)

JWT Payload:
  { sub: userId, username, role, sessionId, scope }
  (scope is always 'GLOBAL' post-MT-removal 2026-04-30)

Token Refresh:
  POST /api/auth/refresh → extend JWT (every 30 min)

Re-authentication:
  POST /api/auth/verify → password check → 5-min verification token
  (required for 102 sensitive operations)

Session Management:
  - Single active session per user (force login terminates existing)
  - Session stored in DB with IP, user agent, last active time
  - Auto-expired by configurable idle timeout
```

### Job Queue Architecture (graphile-worker on Postgres)

Phase 2 of the windows-friendly-rewrite swapped from BullMQ + Redis/Memurai to graphile-worker against `digilog_db` (uses `LISTEN/NOTIFY` for instant dispatch, `SELECT … FOR UPDATE SKIP LOCKED` for concurrency, `pg_advisory_lock` for cron leader election). No separate queue service. Three worker tasks remain after the Phase 6/7 tear-out:

| Task | Purpose | Trigger |
|---|---|---|
| `notification` | Email + in-app notification delivery | enqueued by event hooks |
| `pm_overdue_check` | Opens/closes PM overdue deviations | cron 03:00 (`packages/queue/crontab.txt`) |
| `session_sweep` | Terminates idle/expired sessions + records LOGOUT audit | cron every 5 min |

## Frontend Architecture (apps/web/)

### Component Hierarchy

```
<BrowserRouter>
  <SWRConfig>
    <ToastProvider>
      <RootErrorBoundary>
        ├── Public Routes (no auth)
        │   ├── /login → LoginPage
        │   ├── /forgot-password → ForgotPasswordPage
        │   ├── /change-password → ChangePasswordPage
        │   └── /contact-admin → ContactAdminPage
        │
        ├── Mobile Routes (standalone layout)
        │   ├── /m/login → MobileLoginPage
        │   └── /m → MobileOperationsPage
        │
        └── Protected Routes
            └── <AppLayout> (sidebar + header + session management)
                ├── useAuth() → fetch /api/auth/me, check login
                ├── useSingleTab() → duplicate tab detection
                ├── useSession() → idle timeout
                ├── useBranding() → theme application
                ├── useRfidGuard() → RFID keyboard blocking
                └── <RequireRole> (permission gate)
                    └── <Page /> (route content)
```

### State Management

| Concern | Solution |
|---|---|
| Server state | SWR (auto-revalidation, dedup, cache) |
| Auth state | React Context via `useAuth()` hook |
| UI state | React `useState` / `useReducer` (local) |
| Offline queue | IndexedDB via `offline-store.ts` |
| Theme | CSS custom properties via `applyTheme()` |
| Session | sessionStorage (token) + localStorage (backup, single-tab) |

### Styling Architecture

- **Tailwind CSS 4.0** — utility-first, no component library
- **Light theme only** — bg-white cards, bg-slate-50 sections, border-slate-200
- **10 color presets** — CSS custom properties (--theme-primary, --theme-gradient-from/to)
- **Responsive** — sidebar collapses to hamburger on `<lg` screens
- **No dark theme** — unified light appearance across all pages

### Code Splitting

Heavy pages are lazy-loaded for performance:
- Cleaning-profile / filter-pipeline editor (STAGE / CHECKLIST nodes on a hand-rolled canvas — not ReactFlow)
- Filter Management (all 10+ pages)
- Config pages (34 pages)
- Reports (template editor, generator, detail)
- Mobile routes

## Database Architecture

### PostgreSQL (digilog_db) — 67 Models

```
Core:
  User → Role → Session → PasswordHistory

Assets:
  AssetTemplate → AssetTemplateVersion
  AssetInstance → AssetRelationship, AssetIdentifier
  TemplateAssignment, EntityAssignment

Filter Operations:
  FilterCleaningProfile (lineageId-grouped versions; Phase A.2) → FilterPipelineStage → FilterPipelineConnection
  FilterProfile (snapshot-then-bump versioning; Phase A.3) → FilterDetails → AssetInstance
  FilterProfileVersion (Phase A.3 — immutable snapshot sidecar)
  CleaningCycle (frozen profileId + checklistVersionPins JSONB) → FilterEvent (immutable, checksummed)

Scheduling:
  PmSchedule → PmScheduleEntry → PmExecution
  EquipmentGroup → EquipmentGroupInstrument
  ChecklistProfile → ChecklistQuestion
  ChecklistProfileVersion (Phase A.1 — immutable snapshot table)

Reports:
  ReportReview (ad-hoc submit/review/approve; plain signer columns + audit_trail)
  (ReportTemplate/ReportTemplateVersion/ReportInstance/ReportSignature removed 2026-07-04)

Notifications:
  Notification, NotificationLog, NotificationTemplate
  NotificationRule → NotificationRuleRecipient

System:
  SystemConfig, FieldIdConfig, RoleConfig, UserConfig
  AuditTrail (SHA-256 hash chain — previous_checksum + chain_position)
  Dashboard → DashboardWidget → DashboardAssignment
  HelpArticle → HelpArticleVersion
  BlockChangeRequest, AdminRequest
```

> **No TimescaleDB.** The `digilog_tsdb` database and its hypertables were dropped in Phase 7 (2026-06-11) with the data-ingestion tear-out. `digilog_db` (app + graphile-worker queue schema) plus `digilog_test_db` (test isolation) are the only databases.

### No Redis (retired Phase 4, 2026-05-01)

DigiLog runs with no Redis-protocol service. `ioredis` is not in `package.json`. Job queues run on graphile-worker over Postgres (Phase 2, commit `7832af1`); the brief in-process EventEmitter pub/sub that replaced Redis pub/sub was itself torn out in Phase 6/7 — there is no pub/sub layer now. The re-auth token cache is an in-memory `Map` in `apps/api/src/lib/reauth-check.ts`; session validation hits Postgres directly.

## Security Architecture

```
┌─────────────────────────────────────────────────────┐
│                 SECURITY LAYERS                      │
│                                                     │
│  Layer 1: HTTPS (TLS)                               │
│    └── All traffic encrypted (Fastify TLS via mkcert; reverse proxy optional) │
│                                                     │
│  Layer 2: Authentication                            │
│    └── JWT (8h expiry, 30-min refresh)              │
│    └── Single active session per user               │
│                                                     │
│  Layer 3: Authorization                             │
│    └── RBAC (102 permissions, role-based)            │
│    └── Re-authentication (102 sensitive actions)     │
│                                                     │
│  Layer 4: Input Validation                          │
│    └── HTML sanitization (all text inputs)           │
│    └── Zod schema validation (request bodies)        │
│    └── Rate limiting (500 req/min)                   │
│                                                     │
│  Layer 5: Audit & Compliance                        │
│    └── SHA-256 hash-chain audit trail                │
│    └── Immutable filter events with checksums        │
│    └── Electronic signatures for critical operations │
│    └── Session tracking (IP, user agent, timestamps) │
└─────────────────────────────────────────────────────┘
```

## Communication Protocols

| Protocol | Port | Purpose | Authentication |
|---|---|---|---|
| HTTPS | 3000 | Web UI + API (Fastify direct; reverse proxy optional) | JWT token |
| PostgreSQL | 5432 | Database connections (also hosts the graphile-worker queue schema) | Username/password |

> No MQTT/WebSocket/Redis ports. The MQTT broker (1883), WebSocket `/ws`, and Redis (6379) were all removed (Phase 4–7). HTTPS on 3000 is the only inbound service.
