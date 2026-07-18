# DigiLog — Codex Code Review Instructions

## Project Context
DigiLog (21cfrlogbook) — IoT data logging platform with 21 CFR Part 11 compliance.
Monorepo: Fastify API (apps/api), React SPA (apps/web), shared packages.
Branch: RFID (active development) → merges to DigitalFMS → main.

## Current Module Count (verified 2026-07-06)
- **Backend:** 33 API modules
- **Frontend:** 76 routes in `apps/web/src/main.tsx`
- **Database:** 61 Prisma models, 23 enums (single database `digilog_db`; TimescaleDB `digilog_tsdb` dropped 2026-06-11)
- **Permissions:** 102 constants, 83 feature privileges, 92 reauth actions across 16 categories, 26 sidebar items

> Many modules/models were removed across 2026 tear-outs: multi-tenancy (`org-admin`/`tenant-admin` + org scoping, 2026-04-30), rule-chain + alarms (2026-05-17), data-ingestion + UNS + connectivity + queries + TimescaleDB (2026-06-11..17), qr-code (2026-06-06), and the reports generate/sign + report-templates engine (2026-07-04). See `CLAUDE.md` System Stats + `CHANGELOG.md`.

## Backend Modules (33)
admin-requests, assets (templates, instances, identifiers), audit, auth, backup, block-change-requests, checklist-profiles, cleaning-profiles, config (35 auto-discovered defs), dashboards, debug-traces, deployment-check, equipment-groups, filter-operations, filter-profiles, guest, help, hierarchy, ldap, notification-delivery, notification-rules, notifications, pm-schedules, replacement-schedule, report-reviews, roles, stage-approvals, super-admin, sync, system-health, uploads, user-groups, users.

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
