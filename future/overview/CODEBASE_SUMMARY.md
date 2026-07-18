# Codebase Summary

## What this product is

**DigiLog** (package name: `digilog`, also referred to as `21cfrlogbook`) is a multi-tenant IoT data-logging and digital-filter-management platform built to be **21 CFR Part 11 compliant**. It started as a generic IoT logger (Phases 1–2) and grew a pharma-focused digital Filter Management System (FMS) with RFID, offline tablet operations, PM scheduling, and a full reports module (Phases 3–5).

**Primary users:** pharmaceutical-plant engineers, QA, supervisors, and super-admins managing HVAC filters and AHUs with regulatory audit requirements.

## Monorepo layout

```
/ (repo root)
├── apps/
│   ├── api/              Fastify 5 + TypeScript backend (tsx in dev, compiled JS in prod)
│   ├── web/              React 19 + Vite 6 SPA
│   └── android/          Capacitor 8 wrapper that packages the web app into an APK
├── packages/
│   ├── shared/           Zod schemas, role / permission / privilege / sidebar / audit constants
│   ├── db/               (REMOVED 2026-06-17 — `packages/db/` workspace deleted with the TimescaleDB tear-out; was Prisma wrapper + TimescaleDB pg Pool + telemetry batcher)
│   └── queue/            graphile-worker producer + runner over Postgres (Phase 2 of windows-friendly-rewrite swapped from BullMQ + ioredis)
├── rfid_scan_app/        Standalone native Kotlin app for KC-series UHF RFID readers
├── tsdb-migration/       (REMOVED 2026-06-17 — TimescaleDB hypertable migration helpers deleted with the TimescaleDB tear-out)
├── docs/                 In-repo documentation tree (administration, compliance, user-guide, deployment-methods, etc.)
├── scripts/              Windows production deployment scripts (package, install, reset-cwh-cycles)
├── certs/                mkcert TLS infrastructure (rootCA.pem, server.{crt,key}, ssl.conf) for `API_HTTPS=true`
├── future/               This onboarding pack
├── old/                  Archived / superseded reference material
├── PROJECT_HANDOVER/     APPLICATION_FLOW.md + .docx + Mermaid diagrams
├── tasks/                Audit log (todo.md)
├── tests/e2e-scripts/    Bash + curl e2e smoke scripts
├── init-tsdb.sql         (REMOVED 2026-06-17 — TimescaleDB bootstrap SQL deleted with the TimescaleDB tear-out)
├── docker-compose.yml    Optional Docker dev stack
├── start-digilog.bat / stop-digilog.bat   Windows local-dev launchers
├── DigiLog-FilterOps.apk Built APK (after `gradlew assembleDebug`)
├── turbo.json            Turborepo pipeline
└── vitest.workspace.ts   Vitest workspace spanning apps/api and packages/{db,shared}
```

## Tech stack (verified against `package.json` files, 2026-04-29)

### Backend (`apps/api`, Node 22, `type: module`, root `packageManager: npm@11.6.2`)
- **Framework:** Fastify 5.2 (`@fastify/cors`, `helmet`, `rate-limit`, `multipart`, `static`, `swagger`, `swagger-ui`; the `@fastify/websocket` plugin was removed 2026-07-03 with the pub/sub tear-out)
- **Auth:** JWT via `jose` 6, bcrypt for passwords
- **DB:** Prisma 6.3 (PostgreSQL 18, single `digilog_db`, vanilla). *(The raw `pg` pool for TimescaleDB telemetry was removed 2026-06-17 with the TimescaleDB tear-out.)*
- **Queue:** `graphile-worker` on PostgreSQL (Phase 2 of windows-friendly-rewrite swapped from BullMQ + ioredis). Uses PG `LISTEN/NOTIFY`, `SELECT … FOR UPDATE SKIP LOCKED`, `pg_advisory_lock` for cron leader election, JSONB payloads.
- ~~**Transport:** `mqtt` (Mosquitto 2.0), native WebSocket via `@fastify/websocket`~~ *(REMOVED 2026-06-17..2026-07-03 — MQTT broker + WebSocket transport torn out; no broker or WS layer anymore.)*
- **LDAP:** `ldapts` 8.1
- **Mail:** `nodemailer`
- **Docs / export:** `qrcode`, `xlsx`, `csv-parse`, `adm-zip`. *(The server-side reports PDF/chart stack — `handlebars`, `puppeteer-core`, `chart.js`, `@napi-rs/canvas`, `chartjs-adapter-date-fns`, `dayjs` — was uninstalled 2026-07-04 with the reports generate/sign removal. PDF export is now client-side via `apps/web` `lib/pdf-report.ts` (jsPDF).)*
- **Validation:** `zod` (shared with frontend via `@digilog/shared`)
- **Idempotency:** custom `idempotency.ts` for offline-replay dedup via `x-client-op-id`
- **Dev:** `tsx watch` for hot reload; `tsc -p` to compile for prod-style local builds

### Frontend (`apps/web`, `type: module`)
- **Framework:** React 19 + Vite 6
- **Routing:** React Router 7 (**76 `<Route>` definitions** in `main.tsx`)
- **State / data:** SWR 2
- **Forms:** `react-hook-form` + `@hookform/resolvers` + `zod`
- **UI primitives:** hand-rolled under `components/ui/` — no off-the-shelf library
- **Styling:** TailwindCSS 4 (`@tailwindcss/vite`) + theme utility classes (`.text-theme-primary`, `.bg-theme-gradient`, etc.)
- **Drag-and-drop:** `@dnd-kit/*` (dashboard layouts). *(The rule-chain builder was removed 2026-05-17 and the report template designer 2026-07-04.)*
- ~~**Graph editor:** `reactflow` 11 (rule-chain + cleaning-profile pipeline editor)~~ *(removed 2026-05-17 with the rule-chain tear-out; the cleaning-profile pipeline editor now uses a custom canvas, not reactflow)*
- **Charts:** `recharts`
- ~~**Monaco code editor:** `@monaco-editor/react` (rule-chain script nodes)~~ *(removed 2026-05-17 with the rule-chain tear-out)*
- **Signatures:** `signature_pad` (21 CFR Part 11 e-sig)
- **QR:** `qrcode.react`
- **PWA:** `vite-plugin-pwa`
- **Connectivity:** `lib/connectivity.ts` fans out Capacitor Network plugin + `navigator.onLine` + `/api/health` probe
- **RFID native bridge:** `lib/rfid-bridge.ts` wraps the Capacitor `RfidPlugin`

### Android wrapper (`apps/android`)
- Capacitor 8.3 (`@capacitor/core`, `@capacitor/android`, `@capacitor/cli`)
- `@capacitor/network` 8.0 for reliable online detection
- `appId: com.digilog.filtermanagement`
- `CapacitorHttp` plugin enabled (bypasses WebView fetch TLS issues on self-signed certs)
- **Native Java plugin** at `apps/android/android/app/src/main/java/com/digilog/filtermanagement/RfidPlugin.java` wraps `Reader_Usb.jar` SDK and emits `tag` events to JS
- Final build lives in repo root as `DigiLog-FilterOps.apk`

### Infrastructure (Windows-local-only; see `DEPLOY-WINDOWS.md`)
- **Platform target:** Windows local install (PostgreSQL 18 vanilla, optional Nginx as reverse proxy). *(No TimescaleDB, no Mosquitto/MQTT broker, no Memurai/Redis — all removed 2026-05 / 2026-06.)*
- **Databases:** PostgreSQL 18 — single `digilog_db` (app + `graphile_worker` schema for queue). *(The `digilog_tsdb` telemetry DB + TimescaleDB were dropped 2026-06-17.)*
- ~~**Broker:** Mosquitto 2.0 (MQTT 1883)~~ *(removed 2026-06-17 — no MQTT broker anymore)*
- **Job queue:** graphile-worker on PostgreSQL (no separate queue service)
- ~~**Cache / pub-sub:** Memurai ≥5 / Redis~~ *(removed 2026-05-01 — pub/sub is now in-process; queue is on Postgres)*
- **Production deployment:** the `DigiLog-Setup-<ver>.exe` installer (built by `scripts/build-installer.ps1`; runs `install.ps1`→`provision-db.ps1`+`register-services.ps1`). *(The old `package-for-production.ps1` / `install-on-target.ps1` scripts were removed 2026-07-04 — see `docs/PHARMA_DEPLOYMENT_21CFR.md`.)*
- **Optional:** `docker-compose.yml` for a containerized dev stack

> **EC2 / Linux / PM2 are no longer in scope.** All EC2-related assets were removed in commit `251be95` (session 04-21). Older docs may still reference them — those references are stale.

## Major feature areas (verified by directory inspection)

### Core platform (Phases 1–2)
- Auth, users, roles
- **102 permission constants** in `packages/shared/src/types/permissions.ts`
- **83 feature privileges** + `FEATURE_TO_PERMISSION_MAP` (each maps to BOTH frontend visibility perm AND backend route perm)
- **92 reauth actions** across 16 categories
- **26 sidebar items** with privilege binding via `sidebar-privilege-map.ts`
- Audit trail with hash-chain integrity (`apps/api/src/lib/hash-chain.ts`)
- 21 CFR Part 11 e-signatures + reauth checks (`apps/api/src/lib/reauth-check.ts`)
- Config system: **35 config definitions** (`apps/api/src/modules/config/defs/`) auto-discovered via `config-discovery.ts`; **34 corresponding pages** under `apps/web/src/routes/config/`; routes split per-tab in `config/static-routes/`
- Audit-template UUID hiding (per-action templates registered in `packages/shared/src/types/audit-templates.ts`)
- Branding + theme system (10 preset themes, CSS variables)
- Multi-tenant super-admin
- LDAP integration

### IoT data platform (Phase 2) — *mostly REMOVED (rule-chain 2026-05-17; data-ingestion / UNS / queries / connectivity + TimescaleDB + MQTT 2026-06-17). Only Dashboards survive.*
- ~~**Data ingestion** (`apps/api/src/modules/data-ingestion/`)~~ *(removed 2026-06-17 with the data-ingestion tear-out)*
- ~~**Rule chain engine** (`apps/api/src/modules/rule-chain/`)~~ *(removed 2026-05-17 with the rule-chain tear-out)*
- ~~**Queries** (`apps/api/src/modules/queries/`)~~ *(removed 2026-06-17)*
- ~~**UNS tree:** Unified namespace~~ *(removed 2026-06-17)*
- ~~**Alarms:** severity, acknowledge, clear, configurable columns~~ *(removed 2026-05-17 with the alarm tear-out)*
- **Dashboards:** widget-based layouts with data adapters *(survives; the `timeseries_chart` widget returns `[]` cleanly post-TimescaleDB removal)*

### Digital Filter Management System (Phase 3 / 4)
- **Asset templates + instances:** dynamic attribute schemas with validation; `assets/` is the largest module (sub-folders: `routes/`, `services/`, `repositories/`, `helpers/`)
- **Filter hierarchy:** Block → Area → AHU → Filter visual builder with create / connect / edit / delete
- **Cleaning profiles:** pipeline-based workflow with stages, checklists, bypass logic
- **Filter operations:** start / advance / bypass / retire / replace / terminate cycle; state machine on server
- **PM schedules:** CSV upload template, approve / reject / resubmit, due tasks; `PmEntryApprovalStatus` enum + 11 columns; `PM_APPROVE` permission
- **PM My Tasks:** `/my-tasks`, per-AHU filter-set mode (BOTH / SET_A / SET_B / DISABLED), PM auto-reason on mobile
- **Equipment groups, checklist profiles, filter profiles**
- ~~**Reports module (generate/sign engine)**~~ — **REMOVED 2026-07-04** (orphaned dead code: 2 backend modules, 4 Prisma models, 7 perms, 5 npm deps incl. puppeteer-core + @napi-rs/canvas). Live report surface: **report-reviews** (submit/review/approve) + report-config defs + client-side PDF export (`lib/pdf-report.ts`, jsPDF)

### Phase 5: RFID + offline operations (April 15–29 work on `RFID` branch)
- **Native RFID SDK plugin in DigiLog APK** — `RfidPlugin.java` wraps `Reader_Usb.jar`, paired with `apps/web/src/lib/rfid-bridge.ts`
- **Standalone native Kotlin scanner app** (`rfid_scan_app/`) for KC-series UHF readers via USB-C
- **Keyboard-burst RFID guard** (`apps/web/src/hooks/use-rfid-guard.ts`) blocks UKB tag input leaking into non-`data-rfid="true"` fields
- **Offline overhaul** (commits `3c99973`, `0c8de53`, `b8e003e`):
  - TTL-based cache invalidation, idempotency keys (`x-client-op-id` + `clientOpId` body field), tombstones, LRU eviction, JWT refresh on replay
  - **Server-side `stageLookup`** pre-computes `{nextStages, pendingChecklistProfileIds, leadsToEnd}` per stage, fixing chained-CHECKLIST resolution bugs
  - Stale-profile guard with yellow banner UX
  - **Capacitor Network plugin + Service Worker hook** for reliable Android online detection (replaces unreliable `navigator.onLine`)
  - Filter-state cache TTL raised 30 min → 24 h
- **Offline store** (IndexedDB) with operations queue + cached filters / templates / reasons / identifiers / pipeline graphs / equipment groups
- **`useOffline` hook** with `executeOrQueue()` pattern and `x-offline-replay` header
- **"Data Synced" indicator** in mobile header
- **DRY_IN two-step flow** — SET_DURATION → SUBMIT_READINGS, "Currently Drying" countdown panel persisted across navigation/offline
- **Skip Block removal** for `needsBlock: true` stages (compliance fix)
- **Filter Data Management console** — 9 tabs each mirroring its user-facing page (cycles, events, PM, audit, notifications, admin requests, block changes, retirements, replacements). **SUPER_ADMIN escape hatch with ZERO audit trail** — bypasses 21 CFR Part 11 audit chain on purpose. *(The alarms tab was removed 2026-05-17 with the alarm tear-out.)*
- **Decision-tape proposal** — future architecture to eliminate client/server pipeline drift (proposed, not yet implemented)

### Admin / governance
- **Admin requests flow:** create user / unlock / reset / modify requests with approver execution and audit; requester Employee ID required; UUIDs hidden via audit-templates
- **Block change requests:** cross-block approval with remarks mandatory; single-use consumption (`APPROVED → EXPIRED` on cycle start); `BLOCK_CHANGE_REQUIRED` 409 with structured `details` payload
- **Dynamic backup/restore:** **all 64 tables** via `pg_tables` + `jsonb_populate_recordset`; non-superuser compatible; two-pass self-ref fixup
- **Tablet access matrix:** SUPER_ADMIN-only `/config/access-matrix` per-module role allowlist; `/config/tablet-access` with `rfid_assign` feature; mobile-login enforces feature list
- **Hierarchy builder UI:** tree view with create / connect / edit / delete on Block / Area / AHU nodes
- **Filter CRUD + hierarchy edit/delete** — 5 new permissions (`FILTER_CREATE/EDIT/DELETE/HIERARCHY_EDIT/HIERARCHY_DELETE`) + matching reauth actions

## Active branch & latest commit

- **Current branch:** `RFID`
- **Main branch:** `main`
- **CHANGELOG:** through `[2.5.0]` 2026-04-25 — offline hardening, RFID SDK plugin, Filter Data Mgmt console
- **Latest doc state:** documentation reconciliation pass through 2026-04-29 (multiple cleanup commits)

See `overview/CURRENT_STATUS.md` for the running punch list.

## How to run it locally (short version)

1. Install prerequisites: Node 22, npm 11, PostgreSQL 18 (vanilla — no TimescaleDB), JDK 21 + Android SDK (only if building APK). *(No TimescaleDB/MQTT-broker/Redis/Edge needed anymore — TimescaleDB + Mosquitto removed 2026-06, Redis 2026-05, and the Edge-driven server-side PDF engine 2026-07-04.)*
2. `npm install` at the repo root.
3. Copy `.env.example` → `.env`, adjust DB URLs and secrets. Set `API_HTTPS=true` if connecting from APK.
4. ~~`psql -f init-tsdb.sql` on the TimescaleDB DB; or run `tsdb-migration/init-hypertables.sql`.~~ *(step removed 2026-06-17 — no TimescaleDB DB to bootstrap.)*
5. `npm run db:migrate` then `npm run db:seed` (runs Prisma against `apps/api`).
6. Use `start-digilog.bat` (Windows) or run services individually:
   - API: `cd apps/api && npm run dev`
   - Web: `cd apps/web && npm run dev`
7. Login with `superadmin` / `Admin@123`.

Full detail: `LOCAL_SETUP_WINDOWS.md` at root.

## How to find things

- HTTP endpoint → `future/overview/API_LIST.md` (compact catalog) or `future/backend/API_ENDPOINTS.md` (full table) or live Swagger at `https://localhost:3000/docs`
- Frontend route → `apps/web/src/main.tsx` (76 `<Route>` definitions)
- Permission → `packages/shared/src/types/permissions.ts` (109 entries)
- Feature privilege → `packages/shared/src/types/feature-privileges.ts` (91 entries; FEATURE_TO_PERMISSION_MAP at the bottom)
- Reauth action → `packages/shared/src/types/reauth-actions.ts` (81 entries)
- Sidebar item → `packages/shared/src/types/sidebar-items.ts` (26 entries)
- Audit action → `packages/shared/src/types/audit-actions.ts`
- Audit-template (UUID-hiding) → `packages/shared/src/types/audit-templates.ts`
- ~~Alarm column metadata → `packages/shared/src/types/alarm-columns.ts`~~ *(removed 2026-05-17 with the alarm tear-out)*
- DB schema → `apps/api/prisma/schema.prisma` (61 models, 23 enums)
- Migrations → `apps/api/prisma/migrations/`
- Config def → `apps/api/src/modules/config/defs/<name>.def.ts` (30 files)
- Config page → `apps/web/src/routes/config/<name>.tsx` (26 files)
- Config route → `apps/api/src/modules/config/static-routes/<name>.routes.ts` (11 files; bloat audit P2.3 split done)
- Backend module → `apps/api/src/modules/<name>/` (33 modules)
- Frontend hook → `apps/web/src/hooks/<name>.ts` (27 hooks)
- Frontend lib helper → `apps/web/src/lib/<name>.ts` (15 modules)
- Shared Zod schema → `packages/shared/src/schemas/<name>.ts` (8 schemas)
