# DigiLog Documentation

A 21 CFR Part 11–compliant digital logbook + IoT data platform with an integrated **Digital Filter Management System** for pharmaceutical cleanrooms.

## Platform stats (current — 2026-07-04, verified against live code)
- **33 API modules**, **200+ endpoints**, **61 Prisma models**, **23 enums**
- **35 config definitions** with auto-discovery, **34 config pages**
- **102 permissions**, **83 feature toggles**, **92 reauth actions**, **26 sidebar items**
- **10 color themes**, configurable report layout, multi-channel notifications
- Single PostgreSQL database (`digilog_db`); Postgres-backed **graphile-worker** job queue (no Redis)

## Where to start

For a top-down view, prefer the docs at the repo root:
- [`PROJECT_SUMMARY.md`](../PROJECT_SUMMARY.md) — 30-second overview
- [`PROJECT_ARCHITECTURE.md`](../PROJECT_ARCHITECTURE.md) — full system architecture
- [`API_REFERENCE.md`](../API_REFERENCE.md) — complete API reference (200+ endpoints)
- [`BACKEND_GUIDE.md`](../BACKEND_GUIDE.md) — backend dev guide
- [`FRONTEND_GUIDE.md`](../FRONTEND_GUIDE.md) — frontend dev guide
- [`OFFLINE_SYNC_ARCHITECTURE.md`](../OFFLINE_SYNC_ARCHITECTURE.md) — tablet + offline architecture
- [`PHASE_5_RECENT_WORK.md`](../PHASE_5_RECENT_WORK.md) — post-Phase-4 work (Apr 15–29) including reports, offline hardening, RFID SDK, decision-tape proposal
- [`CHANGELOG.md`](../CHANGELOG.md) — chronological history

## Getting Started
- [What is DigiLog?](getting-started/what-is-digilog.md)
- [System Requirements](getting-started/system-requirements.md)
- [Hello World](getting-started/hello-world.md)

## User Guide
- [Entities & Hierarchy](user-guide/entities/entities-and-hierarchy.md)
- [Asset Templates](user-guide/templates/asset-templates.md)
- [Checklists](user-guide/checklists/checklists.md)

> The IoT-ingestion subsystems (Device Connectivity, MQTT, Telemetry, Rule Engine,
> Alarms, UNS, Data Export) were removed in Phases 6–7 (2026-05..2026-06). Their user
> guides are archived under `old/docs-superseded/removed-user-guides/`.

## Administration
- [User Management](administration/users/user-management.md)
- [Roles & Permissions](administration/roles/roles-and-permissions.md)
- [System Configuration](administration/configuration/system-configuration.md)
- [Audit Trail](administration/audit/audit-trail.md)
- [Email Integration](administration/notifications/email-integration.md)
- [SMS Integration](administration/notifications/sms-integration.md)
- [Security](administration/security/security.md)

## Deployment
- [Deployment Methods Overview](deployment-methods/README.md)
- [Method A — Native Windows](deployment-methods/method-a-native-windows.md)
- [Method B — Docker Compose](deployment-methods/method-b-docker-compose.md)
- [Method D — Hybrid](deployment-methods/method-d-hybrid.md)
- [Method E — IIS](deployment-methods/method-e-iis.md)
- [Comparison](deployment-methods/comparison.md)

## Compliance
- [21 CFR Part 11](compliance/21-cfr-part-11.md)

## Digital Filter Management System (Phase 2+)

Comprehensive system for tracking the cleaning lifecycle of pharmaceutical cleanroom HEPA filters.

**Modules**
- **Cleaning Profiles** — Visual pipeline editor (custom hand-rolled canvas) with STAGE / CHECKLIST / BYPASS / END nodes
- **Filter Profiles** — Block restrictions, max cycles, profile assignment
- **Filter Operations** — Cycle start, advance, bypass, terminate, checklist submission
- **PM Schedules** — Per-AHU preventive maintenance with tolerance windows + QA approval
- **Checklist Profiles** — Reusable question templates for pipeline checklist nodes
- **Equipment Groups** — AHU dashboard, dual-set (SET_A / SET_B) management

**Key behaviors**
- CHECKLIST nodes between STAGE nodes trigger automatic question dialogs
- Server-side enforcement: `advance()` blocks until pending checklists are completed
- Cycle auto-completes when the last STAGE leads to an END node
- Stage chain may include multiple consecutive CHECKLIST nodes — server uses `stageLookup` to walk them
- Cycle `profile_id` is locked at start; reassigning a block's profile does NOT migrate in-progress cycles

**Phase 2 endpoints**
```
POST /api/filters/:id/start-cycle       — Start cleaning cycle
POST /api/filters/:id/advance           — Advance to next stage
POST /api/filters/:id/submit-checklist  — Submit checklist answers
POST /api/filters/:id/bypass            — Bypass stage (deviation)
POST /api/filters/:id/terminate         — Terminate cycle
GET  /api/filters/:id/current-state     — Filter state + next actions
GET  /api/filters/cycles                — List cleaning cycles
GET  /api/filters/events                — List filter events
GET  /api/cleaning-profiles             — List cleaning profiles
GET  /api/filter-profiles               — List filter profiles
GET  /api/pm-schedules                  — List PM schedules
GET  /api/checklist-profiles?expand=questions — List checklist profiles (offline cache)
GET  /api/equipment-groups              — List equipment groups
```

All filter operations are recorded as immutable events with SHA-256 checksums, electronic signatures, and deviation tracking per 21 CFR Part 11.

## Phase 3 — RFID & Offline (2026-04-07)
- RFID Scanner Android app for KC-series UHF readers
- RFID SDK plugin bundled into DigiLog APK
- Web RFID keyboard guard
- Offline cleaning operations via IndexedDB queue + sync engine
- Cached identifier→filter map for offline RFID lookup
- "Data Synced" indicator in mobile header

## Phase 4 — Permissions, Themes, Reports (2026-04-14)
- 18 granular feature toggles across Filters / Checklists / Cleaning Profiles / Equipment / PM
- 10 preset color themes via CSS variables
- ~~Report template designer + PDF generation engine + digital signatures~~ *(removed 2026-07-04 — orphaned generate/sign engine torn out; the ad-hoc report-reviews workflow + client-side cleaning-record/lifecycle PDF export remain)*
- Configurable report header/footer/layout
- Dynamic CSV bulk upload from template attributeSchema
- 87 reauth actions

## Phase 5 — Reports, Offline Hardening, RFID SDK, Filter Data Console (Apr 15–29, 2026)
- Reports module phases A–F complete (template designer + generation engine + signatures) — *the generate/sign engine + template designer were removed 2026-07-04 (orphaned dead code); report-reviews + report-config survive*
- Offline overhaul: TTLs, idempotency keys, tombstones, LRU, JWT refresh on replay, server-side `stageLookup`, Capacitor Network plugin + Service Worker hook
- RFID SDK plugin baked into DigiLog APK (KC-series via `Reader_Usb.jar`)
- Filter Data Mgmt console — 10 tabs mirroring user-facing pages
- DRY_IN two-step flow with persisted countdown panel
- Dynamic backup/restore covering all app tables
- EC2 / PM2 production assets removed; Windows-local-only
- Bloat audit (12/14 items resolved)
- Decision-tape proposal (future architecture)

See `PHASE_5_RECENT_WORK.md` for the full architectural breakdown and `CHANGELOG.md` for the release-note view.

## Historical design specs (archived but live features)
Implementation plans + design specs for several Phase 4/5 features that contain problem statements, data models, and validation logic NOT duplicated in code:
- Block change approval — `old/docs-superseded/superpowers-{plans,specs}/2026-04-10-*`
- PM "My Tasks" system — `old/docs-superseded/superpowers-specs/2026-04-11-*`
- Report template designer + generation engine — `old/docs-superseded/superpowers-plans/2026-04-15-*`
- DRY_IN state persistence — `old/docs-superseded/superpowers-plans/2026-04-17-*`
- Bloat audit — `old/docs-superseded/bloat.md`
