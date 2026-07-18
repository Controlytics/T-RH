# DigiLog — 21 CFR Part 11 Compliant Digital Logbook

DigiLog is a **21 CFR Part 11** compliant **Digital Filter Management System (FMS)** for pharmaceutical cleanroom HEPA filter lifecycle tracking: filter cleaning cycles, preventive maintenance, equipment status, electronic-signature checklists, and tamper-proof audit trails.

The platform is monorepo-based (Turborepo) with a Fastify backend, a React/Vite SPA, a Capacitor Android wrapper for tablets, and a native Kotlin RFID scanner companion app.

---

## What's in this repo

| Path | Contents |
|---|---|
| `apps/api/` | Fastify 5 backend — 33 modules, 200+ endpoints |
| `apps/web/` | React 19 SPA — 77 routes, Tailwind CSS |
| `apps/android/` | Capacitor Android wrapper that ships the SPA as `DigiLog-FilterOps.apk` |
| `rfid_scan_app/` | Native Kotlin app for KC-series UHF RFID readers (USB) |
| `packages/shared/` | Permissions, privileges, reauth actions, Zod schemas |
| `packages/queue/` | graphile-worker queue producer + runner (Postgres-backed; Phase 2 of windows-friendly-rewrite swapped from BullMQ + ioredis) |
| `docs/` | Active project documentation |
| `old/` | Archived superseded docs (kept for reference) |
| `future/` | Forward-looking design notes |
| `scripts/` | Windows PowerShell deployment scripts |
| `start-digilog.bat` / `stop-digilog.bat` | Local Windows service launchers |

For end-to-end details, start with `PROJECT_SUMMARY.md` (overview), `PROJECT_ARCHITECTURE.md` (system architecture), `BACKEND_GUIDE.md` (API), `FRONTEND_GUIDE.md` (web), and `OFFLINE_SYNC_ARCHITECTURE.md` (tablet/offline).

---

## Features

### Phase 1 — Core Platform
- **Entity management** — Hierarchical asset modeling, identifiers (RFID / NFC / Barcode)
- **Digital checklists** — 10+ field types, photo capture, 3-step approval workflow
- **Audit trail** — Tamper-evident SHA-256 hash-chain log with before/after snapshots
- **Notifications** — In-app + email (SMTP/OAuth2) + SMS (AWS SNS / Twilio) + Telegram + Slack
- **Backup/restore** — Full DB export covering all tables (`pg_tables` + `jsonb_populate_recordset`), SHA-256 integrity verification
- **RBAC** — 6 hierarchical roles, **102 permissions**, **83 feature toggles**, **92 reauthentication actions** across 16 categories, **26 sidebar items** (single-tenant since 2026-04-30)
- **Help articles** — 40+ versioned in-app docs across 8 categories
- **LDAP integration** — Active Directory / OpenLDAP with group→role mapping

### Phase 2 — Digital Filter Management System (FMS)
- **Filter operations** — Multi-stage cleaning lifecycle with QR/RFID scan
- **Cleaning profiles** — Visual pipeline editor (custom hand-rolled canvas) with drag-and-drop nodes, CHECKLIST gates, BYPASS mode
- **Checklist profiles** — Reusable question templates wired into pipeline checklist nodes
- **Filter profiles** — Block restrictions, max-cycle limits, profile-to-filter assignment
- **Cleaning cycles** — Full audit trail with timestamps, performer, remarks, checklist answers
- **PM schedules** — Preventive maintenance per AHU with tolerance windows + QA approval
- **Equipment groups** — AHU dashboard, dual-set filter management (Set A / Set B)
- **Filter traceability** — Per-filter event log + cycle timeline + deviation tracking
- **Bulk upload** — Dynamic CSV columns generated from filter template `attributeSchema`
- **Retirement & replacement** — End-of-life tracking

### Phase 3 — RFID & Offline Operations
- **RFID Scanner Android app** for KC-series UHF readers via USB-C (`rfid_scan_app/`)
- **RFID SDK plugin** bundled into DigiLog APK (`Reader_Usb.jar` via `RfidPlugin.java`) — works in SDK and UKB modes
- **Web-side RFID guard** — global keyboard interceptor blocks tag bursts in non-`data-rfid` fields
- **Offline cleaning operations** — IndexedDB queue + sync engine, FIFO replay on reconnect
- **Cached master data** — filters, templates, cleaning reasons, identifier→filter map
- **"Data Synced" indicator** in mobile header
- **Responsive layout** — sidebar collapses to hamburger on `<lg` screens
- **Modal error popups** replacing inline banners

### Phase 4 — Permissions, Themes, Reports
- **18 granular feature toggles** — Filters (6), Checklists (4), Cleaning Profiles (4), Equipment (4), PM (4)
- **10 color themes** — CSS variables (`--theme-primary`, `--theme-gradient-from/to`)
- ~~**Report template designer** — visual editor + PDF generation engine + digital signatures~~ *(removed 2026-07-04 — orphaned generate/sign engine torn out; the ad-hoc report-reviews workflow + client-side cleaning-record/lifecycle PDF export remain)*
- **Configurable report page titles / labels / signatories** — `/config/report-config`
- **Dynamic bulk upload** — CSV columns from template `attributeSchema`
- **92 reauthentication actions** across 16 categories
- **Block change request/approval** workflow with single-use consumption

### Phase 5 — April 15–29, 2026 (live on `RFID` branch)
Detailed in `PHASE_5_RECENT_WORK.md`:

- ~~**Reports module — phases A–F**~~ — **REMOVED 2026-07-04** as dead code (the report generate/sign template designer + PDF engine was orphaned). The `reports`/`report-templates` modules, their 4 Prisma models, and the puppeteer-core/@napi-rs/canvas render stack are gone. The active `report-reviews` workflow + report-config (page titles / labels / signatories) chrome survive; cleaning-record and lifecycle PDF export remain.
- **Offline hardening (14-issue overhaul)** — TTL cache, idempotency keys, tombstones, LRU eviction, JWT refresh on replay, server-side `stageLookup` walker for chained CHECKLIST nodes, Capacitor Network plugin + Service Worker hook
- **RFID SDK plugin baked into DigiLog APK** — `Reader_Usb.jar` via `RfidPlugin.java` — KC-series readers work in SDK and UKB modes
- **Filter Data Management console** — 10 tabs each mirroring its user-facing page (cycles, events, PM, audit, notifications, admin requests, block changes, etc.) with Edit modals
- **DRY_IN two-step flow** — SET_DURATION → SUBMIT_READINGS, "Currently Drying" countdown panel persisted across navigation/offline
- **Dynamic backup/restore** — covers all tables via `pg_tables` + `jsonb_populate_recordset`, non-superuser compatible
- **Admin requests approval execution** — approvals now actually create/unlock/reset/modify users
- **Bloat audit follow-up** — 12/14 items resolved (SPIS submit-path parity, dependency cleanup, config monolith split, inline-style codemod, EC2 assets removed, lint rule for `as any`)
- **Decision-tape proposal** — future architecture to eliminate client/server pipeline drift (proposed, not yet implemented)

---

## Tech Stack

| Component | Technology |
|---|---|
| Backend | Fastify 5 (Node.js / TypeScript, port 3000) |
| Frontend | React 19 + Vite 6 (TypeScript, Tailwind CSS 4, port 5175 dev) |
| Database | PostgreSQL 18 + Prisma ORM (single DB `digilog_db`) |
| Job queue | graphile-worker on PostgreSQL (LISTEN/NOTIFY + SKIP LOCKED + advisory locks) |
| Pub/sub (non-queue) | None — Phase 4 retired Redis; the in-process EventEmitter bus was later removed with its last WS/trace/debug consumer (Phase 6/7) |
| Mobile | Capacitor Android APK + native Kotlin RFID app |
| Reverse proxy | Optional / customer-choice (no longer bundled — Fastify on `:3000` direct is the default). The `DigiLog-Setup.exe` installer registers `DigiLogDB` + `DigiLogAPI` as auto-start Windows services; see `docs/PHARMA_DEPLOYMENT_21CFR.md` |

---

## Quick Start (Windows local dev)

**Prerequisites:** Node.js 20+, PostgreSQL 18. **No Redis dependency** — Phase 4 (2026-05-01) retired it.

```bash
# Clone
git clone https://github.com/pankajexa/21cfrlogbook.git
cd 21cfrlogbook
git checkout DigitalFMS
npm install

# Build shared packages
npm run build -w @digilog/shared && npm run build -w @digilog/queue

# Initialize the database
createdb digilog_db
npx prisma migrate deploy --schema=apps/api/prisma/schema.prisma
npx prisma db seed --schema=apps/api/prisma/schema.prisma

# Run API and web in two terminals (or use start-digilog.bat)
cd apps/api && npx tsx watch src/app.ts       # API on :3000
cd apps/web && npx vite --host                # Web on :5175
```

See `LOCAL_SETUP_WINDOWS.md` for the full step-by-step setup, and `DEPLOY-WINDOWS.md` for production-style deployment paths.

---

## Default Login
- **Username:** `superadmin`
- **Password:** `Admin@123` (forced change on first login)

## Local URLs
| Service | URL |
|---|---|
| Web (Vite dev) | http://localhost:5175 |
| API | https://localhost:3000 |
| Swagger docs | https://localhost:3000/docs |

---

## Database

### PostgreSQL (`digilog_db` — Prisma)
**61 models, 23 enums** covering users, roles, sessions, entities, templates, relationships (Step 2 enum), identifiers, audit, notifications, configs, help articles, filter cleaning profiles (Phase A.2 added `lineageId UUID` for rowful version history — same row count, no new model), filter profiles + FilterProfileVersion immutable history (Phase A.3) + FilterProfileApplicableTemplate join table (Step 4), cleaning cycles, filter events, FilterDetails 1:1 sidecar (Step 6), PM schedules + entries + executions, checklist profiles + questions + ChecklistProfileVersion immutable history (Phase 5b A.1), equipment groups + instruments + EquipmentGroupVersion composite-snapshot history (Phase A.4), report reviews, block-change requests, admin requests, dashboards + widgets + assignments, password history + reset requests.

The vitest suite runs against a separate `digilog_test_db`.

---

## Documentation Map

| File | Purpose |
|---|---|
| `PROJECT_SUMMARY.md` | 30-second project overview |
| `PROJECT_ARCHITECTURE.md` | System architecture, request flow, data layers |
| `API_REFERENCE.md` | Full API surface (200+ endpoints) |
| `BACKEND_GUIDE.md` | Backend dev guide — module patterns, plugins, auth |
| `FRONTEND_GUIDE.md` | Frontend dev guide — routes, hooks, state |
| `OFFLINE_SYNC_ARCHITECTURE.md` | Tablet APK + offline IndexedDB queue + sync engine |
| `PHASE_5_RECENT_WORK.md` | Post-Phase-4 architecture changes (Apr 15–29) — reports, offline hardening, RFID SDK, decision tape |
| `CHANGELOG.md` | Full chronological history |
| `future/README.md` | Onboarding pack — overview + reading order |
| `future/overview/CODEBASE_SUMMARY.md` | Most-comprehensive single-file tech stack with version pins (React 19 / Vite 6 / Fastify 5 / Prisma 6 / Capacitor 8 / `jose` / `ldapts`), feature areas verified by directory inspection, "How to find things" cookbook |
| `future/overview/CURRENT_STATUS.md` | Snapshot @ 2026-04-29 + **KNOWN GOTCHAS** taxonomy (Capacitor WebView fetch, Fastify schema stripping, roles after DB restore, cycle profile_id frozen, idempotency-key required for replay) |
| `future/overview/API_LIST.md` | Compact 394-endpoint index with `*` public markers |
| `future/backend/{README,MODULES,API_ENDPOINTS,ENV_SETUP}.md` | Backend onboarding — directory map, request lifecycle + PUBLIC_PATHS taxonomy, per-module verified endpoint counts, full canonical endpoint table, env-setup walkthrough |
| `future/frontend/{README,KEY_FILES,PATTERNS}.md` | Frontend onboarding — directory map, annotated file index ("why it matters"), conventions for routes / SWR / forms / offline-safe mutations / dynamic attribute forms |
| `future/qa/{README,FEATURE_CHECKLIST,ACCEPTANCE_CRITERIA,KNOWN_ISSUES}.md` | QA pack — user personas (Engineer / Supervisor / QA / Admin / Super-admin), per-feature verification steps, "done-when" bullets, gotchas grouped by env / frontend / offline / permissions |
| `future/testing/{README,MANUAL_TEST_GUIDE,TEST_INVENTORY}.md` | 4 test surfaces breakdown, 12 golden-path scripts, every `*.test.ts` enumerated by surface |
| `CLAUDE.md` | Instructions for AI coding assistants |
| `AGENTS.md` | Agent-mode instructions |
| `DEPLOY-WINDOWS.md` | Windows deployment options |
| `LOCAL_SETUP_WINDOWS.md` | Windows local dev setup |
| `windowsIssues.md` | Windows Server difficulty audit — 18 dependency / runtime issues with severity + mitigation |
| `docs/` | User guides, admin guides, compliance, deployment methods |
| `old/` | Archived superseded docs (read-only history) |

---

## License
Proprietary — Pankaj Exa Technologies
