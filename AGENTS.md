# DigiLog — Codex Code Review Instructions

> ⚠ **Drift warning (re-verified 2026-08-27).** This file's module list, counts, and "Phase 2:
> Filter Management" / "Phase 3: RFID & Offline" review sections describe upstream DigiLog,
> not this fork. Live counts here: **24** backend modules (`ls apps/api/src/modules | wc -l`,
> not the 33 that section used to list — the removed ones are `assets`,
> `block-change-requests`, `checklist-profiles`, `cleaning-profiles`,
> `deployment-check`, `equipment-groups`, `filter-operations`, `filter-profiles`,
> `guest`, `hierarchy`, `pm-schedules`, `replacement-schedule`, `report-reviews`,
> `stage-approvals` and `sync`. **`admin-requests`, `debug-traces`, `system-health`
> and `user-groups` are LIVE** — this banner listed all four as removed until
> 2026-08-27, which was wrong; verified against `ls apps/api/src/modules/`),
> **56** frontend
> routes (not 76; 54 → 56 on 2026-10-29, `/dashboards` + `/dashboards/:id` — this line read 53, stale since 2026-10-24), **38 models / 13 enums** (not 61/23), **45 permissions / 57 reauth
> actions** (not 102/92; 56 → 57 on 2026-10-29, `UPDATE_DASHBOARD`), **100 audit actions / 113 audit templates** (re-derived 2026-10-27; 98 / 111 until the device-certificate pair), **15** sidebar items (14 → 15 on 2026-10-29, `dashboards`; 15 → 14 on 2026-09-19, `home` removed),
> **7** graphile-worker tasks. There is
> no `orgId` review note needed either way (still true: single-tenant). See `CLAUDE.md` for
> the accurate module/count inventory before using this file for review guidance.

## Project Context
DigiLog (21cfrlogbook) — IoT data logging platform with 21 CFR Part 11 compliance.
Monorepo: Fastify API (apps/api), React SPA (apps/web), shared packages.
Branch: RFID (active development) → merges to DigitalFMS → main.

## Current Module Count (re-derived 2026-08-27)
- **Backend:** **25** API modules (`ls apps/api/src/modules/ | wc -l`; 24 → 25 on 2026-09-07, `report-reviews`)
- **Frontend:** **56** `<Route`s in `apps/web/src/main.tsx` (`grep -cE "<Route"`; 54 → 56, 2026-10-29: `/dashboards`, `/dashboards/:id`; 53 → 54, 2026-10-24: `/config/attribute-access`; unchanged 2026-09-16; 52 → 53 on 2026-09-08, `/settings`; 51 → 52 on 2026-09-07, `/reports`; 50 → 51 the same day, `/data-report`)
- **Database:** **38** Prisma models, **13** enums (re-derived 2026-10-29 — this line read 36, stale since 2026-09-22; 37 → 38 on 2026-10-26: `MeasurementType`; 36 → 37 on 2026-09-22: `FloorplanRoomLink`; 35/12 → 36/13 on 2026-09-07: `ReportReview` + `ReportReviewStatus`; single database `compliance_core_db`, plus `compliance_core_db_test`; TimescaleDB `digilog_tsdb` dropped 2026-06-11)
- **Permissions:** **45** constants, **39** feature privileges, **57** reauth actions across **8** categories, **15** sidebar items (re-derived 2026-10-29: reauth 56 → 57 — `UPDATE_DASHBOARD`, `Configuration` — and sidebar items / tree groups 14 → 15 — `dashboards`, whose group reuses `dashboard.view`, so feature privileges stay 39; re-derived 2026-10-26: permissions 44 → 45 and feature privileges 38 → 39 — `REPORT_REVIEW_REJECT` / `reports.reject`, Approve and Reject Reports split into two toggles; 2026-10-24: feature privileges 45 → 38 — seven Permissions-tab toggles that could never take effect left the tab, see `docs/feature-notes.md` "Roles & Access → PERMISSIONS"; the reauth and sidebar numbers here had been stale since 2026-10-12 / 2026-09-19; 2026-09-08: sidebar 14 → 15 and feature privileges 43 → 45 with the Settings page, `settings.view` / `settings.edit`; 2026-09-07: permissions 42 → 44, reauth 48 → 50, feature privileges 41 → 43 and sidebar items 13 → 14 with the report review workflow; earlier that day 40 → 41 / 12 → 13 with `data-report`)
- **Audit registries:** **100** audit actions, **113** audit templates across **7** categories (re-derived 2026-10-29 — this line read 103 / 97, stale since 2026-09-22; see root `CLAUDE.md` System Stats for 103 → 106 → 89 → 98 → 100 and 97 → 100 → 102 → 111 → 113. Earlier 102 → 103 / 96 → 97 on 2026-09-21: `ALARMS_PURGED`; earlier 98 → 102 / 92 → 96 on 2026-09-07, report review)
- **Queue:** **6** graphile-worker tasks (`notification`, `password_expiry_check`, `session_sweep`, `telemetry_partition_maintenance`, `alarm_evaluation`, `alarm_webhook`)

> The figures this section carried until 2026-08-27 — "33 API modules, 76 routes,
> 61 models / 23 enums, 102 permissions / 83 privileges / 92 reauth actions across 16
> categories / 26 sidebar items", stamped "verified 2026-07-06" — were upstream
> DigiLog's and were never true in this fork. They are recorded here only so a reader
> who has seen them elsewhere knows they were checked and rejected, not overlooked.

> Many modules/models were removed across 2026 tear-outs: multi-tenancy (`org-admin`/`tenant-admin` + org scoping, 2026-04-30), rule-chain + alarms (2026-05-17), data-ingestion + UNS + connectivity + queries + TimescaleDB (2026-06-11..17), qr-code (2026-06-06), and the reports generate/sign + report-templates engine (2026-07-04). See `CLAUDE.md` System Stats + `CHANGELOG.md`.

## Backend Modules (24 — `ls apps/api/src/modules/`, 2026-08-27)
admin-requests, alarm-webhooks, alarms, audit, auth, backup, config (25 auto-discovered defs), dashboards, debug-traces, floorplans, functional-locations, help, instrument-profiles, instruments, ldap, notification-delivery, notification-rules, notifications, roles, super-admin, system-health, uploads, user-groups, users.

> The 33-module list this section carried until 2026-08-27 named `assets`,
> `block-change-requests`, `checklist-profiles`, `cleaning-profiles`,
> `equipment-groups`, `filter-operations`, `filter-profiles`, `guest`,
> `hierarchy`, `pm-schedules`, `replacement-schedule`, `report-reviews`,
> `stage-approvals`, `sync` and `deployment-check`. **None of them exist here** —
> they went with the multi-tenancy, rule-chain, data-ingestion, reports and
> filter-domain tear-outs. Do not review against them.

## Review Focus Areas

### Security (Critical — 21 CFR Part 11)
- All user input must be sanitized (lib/sanitize.ts strips HTML)
- SQL injection: only use Prisma parameterized queries, never raw string interpolation
- Authentication: JWT tokens with role-based access control
- Audit trail: all data mutations must create audit log entries
- No secrets or credentials in code
- Race conditions: use Prisma transactions for concurrent operations
- **Single-tenant:** multi-tenancy was removed 2026-04-30 — there is no `orgId`/`tenantId` scoping; do NOT flag its absence. JWT `scope` is always `GLOBAL`.

### Backend (apps/api — Fastify + TypeScript)
- Route handlers must validate input with Zod schemas
- Services should use proper error handling with Fastify error codes
- Database queries via Prisma ORM only against `digilog_db` (TimescaleDB / `digilog_tsdb` was dropped 2026-06-11 with the data-ingestion tear-out — see CHANGELOG Phase 7)
- graphile-worker jobs must handle failures gracefully (Phase 2 of windows-friendly-rewrite swapped from BullMQ + Redis to Postgres-backed queue)
- Filter operations must enforce checklist completion before stage advance
- Pipeline validation: check graph connectivity, stateKeys, checklist profile references

### Frontend (apps/web — React + Vite + Tailwind)
- Light theme only (bg-white, text-slate-800, bg-slate-50 sections)
- No dark mode classes or theme toggles
- Components should handle loading/error states
- API calls via the shared API client with proper error handling
- No inline styles — use Tailwind classes
- Permission guards on all protected routes

### Phase 2: Filter Management
- Cleaning profiles must validate pipeline graph (START->STAGE->...->END)
- Filter operations must enforce sequential stage advancement
- Checklist submission must be validated against question types
- Bypass operations must require BYPASS_ENABLED flow mode
- Events must be immutably recorded (no UPDATE/DELETE)
- Equipment groups must validate instrument references

### General
- TypeScript strict mode — no `any` types without justification
- No console.log in production code (use proper logger)
- Shared types go in packages/shared, not duplicated
- Follow existing patterns in the codebase
- Check for unused imports and dead code
- Input sanitization on all user-facing text fields

---

## Phase 3 Update (2026-04-07)

**RFID & Offline Operations:**
- RFID Scanner Android app (`rfid_scan_app/`) for KC-series UHF readers
- RFID keyboard guard prevents UKB tag input leaking into random fields
- Offline cleaning operations via IndexedDB queue + sync engine
- Cached identifier→filter map for offline RFID lookup
- "Data Synced" indicator in mobile header
- One identifier per entity (backend-enforced)
- Responsive layout with collapsible sidebar
- Error popups replace inline banners
- User creation auto-assigns org for admins
- `/api/roles/active` public endpoint for contact-admin page

See `CHANGELOG.md` for full details.
