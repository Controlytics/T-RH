# DigiLog API — CLAUDE.md

## Overview
Fastify backend serving the DigiLog REST API on port 3000. Runs locally on Windows via `tsx watch` in dev, or as a compiled Node service in production-style local builds. The repo currently has no live remote deployment.

## Build & Deploy
```bash
# Windows Local Development (auto-reload)
cd apps/api && npx tsx watch src/app.ts

# Production-style local build
npx tsc -p apps/api/tsconfig.json   # Compile to apps/api/dist/
node apps/api/dist/app.js
```

## Key Paths
- Source: `apps/api/src/`
- Compiled: `apps/api/dist/`
- Entry: `apps/api/src/app.ts`
- Prisma schema: `apps/api/prisma/schema.prisma` (**61 models, 23 enums** — verified 2026-07-06). Step 1 added the `TemplateKind` lookup model; MT removal (2026-04-30) dropped `Organization` + 11 `organizationId` columns + 2 `orgId` columns; **Step 6 (2026-05-01)** split filter-specific cycle state (`filterProfileId`, `currentLifecycleState`, `currentCycleId`, `filterSet`) off `AssetInstance` into a 1:1 `FilterDetails` sidecar; **Phase A.3 (2026-05-01)** added the `FilterProfileVersion` sidecar; **Phase A.4 (2026-05-02)** added the `EquipmentGroupVersion` sidecar; **Step 4 (2026-05-02)** replaced `FilterProfile.applicableTemplates Json` with the `FilterProfileApplicableTemplate` join table; **2026-05-17 dropped 5 models** (`RuleChain`, `RuleChainVersion`, `RuleNode`, `RuleNodeConnection`, `Alarm`); **2026-06-11..2026-06-17 dropped 6 models** (`DeviceCredential`, `UnsMapping`, `ConnectivityStatus`, `DataStream`, `DeadLetterQueue`, `IngestionSystemConfig`) with the data-ingestion tear-out; **2026-07-01 dropped 2 orphaned tables** (`QrCode`, `LatestTelemetry` — both 0 rows; QR module gone 2026-06-06, telemetry pipeline gone Phase 7; migration `20260701071802_drop_qrcode_latesttelemetry`); **2026-07-04 dropped 2 orphaned tables** (`ChecklistReview`, `ElectronicSignature` — both 0 rows, 0 code refs; migration `20260704062157_drop_checklistreview_electronicsignature`); **2026-07-04 dropped 4 models** (`ReportTemplate`, `ReportTemplateVersion`, `ReportInstance`, `ReportSignature`) + 2 enums (`ReportTemplateStatus`, `ReportStatus`) with the reports generate/sign tear-out (migration `20260704121326_drop_reports_generate_sign`; `ReportReview` survives).
- Config definitions: `apps/api/src/modules/config/defs/` (**36 files** — `uns.def` + `retention.def` removed 2026-06-17; `ahu-completion-process.def` added 2026-07-01; `export-limit.def` added 2026-07-14)
- Route modules: `apps/api/src/modules/` (**33 modules**, verified `ls` 2026-07-06 — `org-admin`/`tenant-admin` deleted in MT removal; `rule-chain` deleted 2026-05-17; `qr-code` deleted 2026-06-06; **`data-ingestion`, `uns`, `connectivity`, `queries` deleted 2026-06-11..2026-06-17** with the ingestion tear-out; **`reports`, `report-templates` deleted 2026-07-04** with the reports generate/sign tear-out (`report-reviews` survives); `debug-traces` re-added 2026-06-12 reading from `audit_trail` instead of dropped `ts_pipeline_traces`)
- Config routes: monolith split into `apps/api/src/modules/config/static-routes/<surface>.routes.ts` per tab; top-level `routes.ts` is just a registration loop (~170 LOC, was 1003)

## Architecture
- 32 route modules registered via `apps/api/src/modules/*/routes.ts`
- Config auto-discovery at startup via `lib/config-discovery.ts`
- Config registry pattern via `lib/config-registry.ts` (self-registering config modules)
- Input sanitization: `lib/sanitize.ts` (HTML stripping on all text inputs)
- JWT auth with 30-min refresh, session management, re-auth for sensitive ops
- Permission-based RBAC via `requirePermission()` on all protected routes

## 33 API Modules (verified `ls` 2026-07-04)
admin-requests, assets, audit, auth, backup, block-change-requests, checklist-profiles, cleaning-profiles, config (36 auto-discovered definitions), dashboards, debug-traces, deployment-check, equipment-groups, filter-operations, filter-profiles, guest, help, hierarchy, ldap, notification-delivery, notification-rules, notifications, pm-schedules, replacement-schedule, report-reviews, roles, stage-approvals, super-admin, sync, system-health, uploads, user-groups, users.

**Removed in 2026 cleanups**: `org-admin` + `tenant-admin` (MT removal, 2026-04-30), `rule-chain` (alarm tear-out, 2026-05-17), `qr-code` (placeholder, 2026-06-06), **`data-ingestion` + `uns` + `connectivity` + `queries` (ingestion tear-out, 2026-06-11..2026-06-17)**, **`reports` + `report-templates` (reports generate/sign tear-out, 2026-07-04 — `report-reviews` survives)**.

## Databases
- **digilog_db** (PostgreSQL 18 via Prisma) — application data (**61 models, 23 enums**)
- ~~`digilog_tsdb`~~ — **DROPPED 2026-06-11** with the data-ingestion tear-out. All 6 hypertables removed (`ts_telemetry`, `ts_attributes`, `ts_checklist_responses`, `ts_device_events`, `ts_binary_data`, `ts_pipeline_traces`).
- `digilog_test_db` — **the vitest suite runs entirely against this DB** (since 2026-07-02). `vitest.env.ts` forces `DATABASE_URL` onto it before Prisma connects, so e2e/integration writes never pollute `digilog_db`'s immutable, hash-chained `audit_trail` (21 CFR §11). Same schema as `digilog_db` (migration-driven); seed it once with `DATABASE_URL=…/digilog_test_db INITIAL_ADMIN_PASSWORD=Admin@123 npx tsx prisma/seed.ts`.

## Database Migrations — READ BEFORE ANY SCHEMA CHANGE

**The schema is migration-driven (since commit `5141131`, 2026-06-25). `prisma db push` and `prisma migrate dev` auto-generation are FORBIDDEN against any populated DB — they can silently drop customer audit data (21 CFR §11).** Full rationale + the customer-install/upgrade design: `tasks/EXE-PACKAGING-PLAN.md` §2.

- **Baseline = a `pg_dump`, never regenerate it.** `prisma/migrations/00000000000000_baseline/migration.sql` is a full schema dump that includes triggers, functions, manual sequences (`deviation_number_seq`, `qnn_seq`, `audit_trail_chain_position_seq`) and a partial unique index that `schema.prisma` **cannot** express. Regenerating it from the datamodel would silently delete those. Prior incremental history is archived in `prisma/migrations_archive_20260624/`; raw objects live in `prisma/sql/{extensions,invariants}.sql`.
- **Applying schema** (fresh install or upgrade): extensions first, then `migrate deploy`.
  1. `CREATE EXTENSION IF NOT EXISTS ltree; CREATE EXTENSION IF NOT EXISTS pgcrypto;` (i.e. apply `prisma/sql/extensions.sql`) — **required**; the baseline uses these but doesn't create them, so `migrate deploy` fails on a bare DB without it.
  2. `npx prisma migrate deploy` (root: `npm run db:migrate`).
  3. Seed with `INITIAL_ADMIN_PASSWORD` set (the seed throws without it). The seed is all `upsert` and never overwrites the admin password → upgrade-safe.
- **Authoring a NEW migration** (the auto-gen `migrate dev` flow is unreliable here because the pg_dump baseline always reads as "drift" vs the datamodel):
  1. Edit `schema.prisma`.
  2. `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` → review, strip the out-of-band noise (triggers/functions/sequences managed in `prisma/sql/*`).
  3. Hand-author the reviewed SQL into `prisma/migrations/<UTC-timestamp>_<name>/migration.sql` (pattern: see archived `20260530_filter_reverse_mirror`). Keep `prisma/sql/*` in sync for any new raw objects.
  4. `npm run db:verify-migrations` — the drift guard: builds a scratch DB from migrations and asserts it diffs empty against your dev DB. **Must PASS before commit.**
  5. `npx prisma migrate resolve --applied <name>` on existing populated DBs (dev/test) so they don't re-run it.

## Key Libs (`apps/api/src/lib/`)
- `audit.ts` — hash-chained audit logger. Unkeyed SHA-256 by default (V1/V2); when
  `AUDIT_CHAIN_KEY` is set it writes a keyed HMAC-SHA256 (V3, `audit_trail.checksum_version=3`)
  so a DB-level actor can't forge the chain. Verifier requires the key for v3 rows; legacy rows
  keep the unkeyed fallback. See `lib/hash-chain.ts`.
- `sanitize.ts` — HTML stripping on all text inputs
- `config-discovery.ts` — Auto-discover config definitions at startup
- `config-registry.ts` — Self-registering config module pattern
- `jwt.ts` — JWT token management
- `reauth-check.ts` — Re-authentication enforcement with 10s in-memory cache

## Testing

```bash
cd apps/api && npm test    # Stable single-fork run (see below for why)
```

### Single-fork requirement (read before running the suite)

The full `apps/api` test suite **must run in a single fork** to produce a
stable pass/fail count. The verified stable invocation is:

```bash
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true
```

`npm test` is wired to this exact command so operators don't have to
remember the flags. If you invoke `npx vitest run` directly with the
default pool, you will see flaky failures that are NOT real bugs.

**Why** — two contention sources, neither introduced by any single test:

1. **Shared `admin` test user race.** `vitest.global-setup.ts` provisions
   one `admin` / `Admin@123` user (SUPER_ADMIN) and one `RB0001` /
   `Test@1234` user (OPERATOR) in `digilog_test_db` (was `digilog_db` until
   2026-07-02 — see DB-isolation note below). Most e2e/integration
   suites log in as `admin`. When vitest runs multiple worker forks in
   parallel, two files can hold concurrent sessions for the same user;
   one calling `POST /api/auth/logout` invalidates the session row the
   other is mid-request against, and the second worker sees a 401 it
   doesn't expect. `vitest.config.ts` already sets
   `fileParallelism: false`, but with the default `forks` pool that
   only serialises files *within* a worker — multiple worker processes
   can still be spawned. `singleFork: true` collapses everything into
   one process, which removes the race.

2. **Local dev server contention.** ~~If `tsx watch src/app.ts` is running
   on `:3000` against the same `digilog_db`, a test logout invalidates
   the dev server's session too.~~ **Largely resolved 2026-07-02** by the
   DB isolation below: the suite now runs against `digilog_test_db`, so a
   dev server on `digilog_db` no longer shares the `user_sessions` table
   with the tests. (A test-only flake can still occur within the suite
   from source #1; single-fork handles that.)

The flakiness was *surfaced*, not introduced, by the new e2e files in
commit `859492e3` (Phase 8.7 / Wave 8a verification). Those files just
added more concurrent admin logins, exposing a pre-existing infra
limitation.

### DB isolation — the suite runs against `digilog_test_db` (2026-07-02)

The suite previously ran against the live dev DB `digilog_db`. Every audited
e2e action (logins, filter cycles, RFID identifier assign/delete, config
edits) wrote **permanent, immutable, hash-chained** rows into the real
`audit_trail` (21 CFR §11) — e.g. `phase3-rfid-offline.test.ts` created RFID
`RFID-p3-<ts>-A/B` tags and then deleted their filters, leaving orphaned
`ASSET_IDENTIFIER_*` rows with blank filter names that surfaced in the live
Audit Trail UI. `vitest.env.ts` now rewrites `DATABASE_URL` (`digilog_db` →
`digilog_test_db`) before any `lib/prisma` import, so all test writes land in
the throwaway test DB. `vitest.setup.ts` (per worker) and
`vitest.global-setup.ts` (main process) both import it for its side effects.
Two suite tests that had implicitly relied on `digilog_db`'s accumulated data
were fixed to assert contracts instead of ambient counts
(`entities.test.ts` instance-list). `config.test.ts`'s datetime/current test
has a **pre-existing intermittent flake** (unrelated to this change — passes
in isolation and in most full runs; absent `[Config] Validation failed`
warning rules out data corruption); single-fork masks it in practice.

**Verified baseline** (2026-07-15, single-fork mode):
**1173 passing, 0 failed, 12 skipped (113 files).** Web: **573/573 (44 files)**.
If your single-fork run shows materially different numbers, investigate before
assuming your change broke something.

> **Measure serially or not at all.** Concurrent agents editing this tree while
> sharing `digilog_test_db` make the count meaningless — 2026-07-15 saw runs of the
> *same* tree fail in different files (19, 32, 37 failures) purely from the shared
> `admin` login race, all green once the agents settled. If several agents are live,
> run only your own touched files and leave the baseline to a serial pass afterwards.
> (Prior baseline: 829/80 files @ 2026-07-02.)

> The prior "1231 passing / 2 failed" (Wave 8a) baseline went **stale** — by
> 2026-07-02 the branch carried **83 pre-existing failures** across 14 files
> (all test debt, not product bugs: prisma-mock drift, auth security-hardening
> that unified login errors + added an audit-userId guard + stricter body
> schemas, a `validateUserId` config mismatch, and dead e2e tests for the
> `POST /api/assets/templates` route removed in Phase 1). Cleared 2026-07-02:
> 82 stale/dead tests fixed-or-removed + **1 real bug fixed** — `authService.logout`
> didn't call `invalidateSessionAuthCache`, leaving a logged-out session valid
> in the 30s cache (commit `3e87785`). **15 skipped** includes 7 instance-CRUD
> e2e tests `it.skip`'d in `entities.test.ts` — a real coverage gap: they need
> an asset template, which can now only come from seed (rewrite pending).

**Per-file authoring tip.** If you're adding a new e2e/integration test
file, follow the pattern from agent AD's recent commits: provision a
*unique* SUPER_ADMIN user inside the file's `beforeAll` (e.g. username
based on the test file name) instead of logging in as the shared
`admin`. That keeps your file safe under both single-fork and
multi-fork runs and makes it cheaper to debug in isolation. The
shared-`admin` pattern is grandfathered-in for older files but should
not be repeated.

**Trade-off accepted.** Single-fork is slower (no cross-file
parallelism) but reliable. Until each test file owns its own login
fixture, this is the right default.

## Environment
- API_PORT=3000
- PostgreSQL: localhost:5432 (only database now — also hosts the graphile-worker job queue)
- ~~Mosquitto~~ — removed 2026-06-17 with data-ingestion tear-out (service uninstalled + `mqtt`/`aedes` deps gone)
- ~~TimescaleDB~~ — `digilog_tsdb` database dropped 2026-06-11

## Phase 2: Digital Filter Management System

### Phase 2 Modules
- `modules/cleaning-profiles/` — Pipeline profile CRUD with versioning, visual editor support, graph validation
- `modules/filter-profiles/` — Filter-to-cleaning-profile assignment with org scoping
- `modules/filter-operations/` — Core operations: cycle start/advance/bypass/checklist/events
- `modules/pm-schedules/` — Preventive maintenance scheduling with monthly entries and tolerance windows
- `modules/checklist-profiles/` — Checklist template and question management with usage checks. Phase A.1 (2026-05-01): every mutation is snapshot-then-bump into `ChecklistProfileVersion`; cycles pin the version at start so submissions resolve against the exact schema the operator saw. New endpoints: `GET /:id/versions` and `GET /:id/versions/:versionNumber`.
- `modules/equipment-groups/` — Equipment group management (AHU dashboard)
- `modules/entity-assignments/` — Entity-to-group assignments
- `modules/config/defs/filter-*.def.ts` — Config definitions for filter lifecycle, cleaning reasons

### Key Phase 2 API Endpoints
```
POST /api/filters/:id/start-cycle    — Start cleaning cycle
POST /api/filters/:id/advance        — Advance to next stage
POST /api/filters/:id/submit-checklist — Submit checklist answers
POST /api/filters/:id/bypass         — Bypass stage (deviation)
POST /api/filters/bulk-operate       — Batch advance / start-and-advance / submit-checklist in ONE request (partial success; reuses the single-op service methods per item)
GET  /api/filters/:id/current-state  — Get filter state + next actions
GET  /api/filters/cycles             — List cleaning cycles (events-routes.ts mounts /cycles + /events under the shared /api/filters prefix)
GET  /api/filters/events             — List filter events
GET  /api/filter-cleaning-profiles                       — List cleaning profiles (latest version per lineage)
GET  /api/filter-cleaning-profiles/:id/versions          — Phase A.2: list all versions in lineage
GET  /api/filter-cleaning-profiles/:id/versions/:n       — Phase A.2: fetch frozen snapshot at version n
GET  /api/filter-profiles            — List filter profiles
GET  /api/filter-profiles/:id/versions             — Phase A.3: list archived FilterProfile versions
GET  /api/filter-profiles/:id/versions/:n          — Phase A.3: frozen FilterProfile snapshot at version n
GET  /api/equipment-groups            — List equipment groups
GET  /api/equipment-groups/:id/versions            — Phase A.4: list archived EquipmentGroup versions (composite)
GET  /api/equipment-groups/:id/versions/:n         — Phase A.4: frozen EquipmentGroup composite snapshot at version n
GET  /api/pm-schedules               — List PM schedules
GET  /api/checklist-profiles                       — List checklist profiles
GET  /api/checklist-profiles/:id/versions          — Phase A.1: list archived versions
GET  /api/checklist-profiles/:id/versions/:n       — Phase A.1: fetch frozen snapshot at version n
GET  /api/equipment-groups           — List equipment groups
```

### Phase 2 Patterns
- Organization scoping via `orgWhere(ctx)` on all filter queries
- Pipeline graph validation (connectivity, stateKeys, checklist profiles)
- Transaction wrapping for cycle start and profile versioning
- Server-side checklist enforcement in `advance()`
- Input sanitization on user-provided text fields
- Events as immutable log with SHA-256 checksums for 21 CFR Part 11 compliance
- **FilterCleaningProfile versioning** — immutable-rowful via `lineageId` UUID set at first create; updates archive the old row and insert a new row with `version+1` carrying the same lineageId. Cycles freeze `profileId` at start, so audit replay reads the exact archived row that was active at cycle start. Phase A.2 (2026-05-01) introduced `lineageId` (replacing `name`-based grouping) and exposed version history endpoints.
- **FilterProfile versioning** — Phase A.3 (2026-05-01). Sidecar pattern (mirrors A.1 ChecklistProfile): `FilterProfile.version` is a monotonic counter on the live row; `FilterProfileVersion` is a snapshot-then-bump sidecar capturing the OUTGOING state on every `update()`. First version is created lazily — live row IS v1 until first edit. No cycle pinning needed because cycles already pin `cleaning_cycles.profileId` to a FilterCleaningProfile row at start; FilterProfile drift cannot reach a running cycle. Per-block override is explicitly out of scope (FilterProfile uniform across all blocks).
- **EquipmentGroup composite versioning** — Phase A.4 (2026-05-02). Composite sidecar pattern (mirrors A.1 ChecklistProfile + questions): `EquipmentGroup.version` is the live counter, `EquipmentGroupVersion` snapshots the WHOLE composite (group + 3 instruments ordered by sortOrder) inside the same transaction as the live mutation. **P1 (2026-05-02)** added cycle-side pinning via `cleaning_cycles.equipmentGroupVersionPin Int?`. Reading validation reads `operatingMin/Max` from the pinned `EquipmentGroupVersion.snapshot.instruments[]`, with fallback to the live row when pin is NULL (legacy cycles). `FilterEvent.attributes.instrumentReadings` continues to immutably snapshot the submitted values — that's the audit-trail layer, P1 is the validation-rule layer. **Cleaning reasons are NOT versioned** — already drift-resistant via `CleaningCycle.cleaningReasonKey` + `cleaningReasonLabel` columns set at cycle start.
- Auto-complete on last stage (STAGE leads to END node)

### Pipeline Flow
CHECKLIST nodes between STAGE nodes trigger automatic question dialogs.
Server-side enforcement: advance() blocks if pending checklist not completed.
Cycle auto-completes when last STAGE leads to END node.
Stage types: WASH_IN, WASH_OUT, DRY_IN, DRY_OUT, STORAGE_IN, STORAGE_OUT

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

---

## Phase 4 Update (2026-04-14) — in-app permissions/themes/reports phase

> Note: a separate "Phase 4" appears in the windows-friendly-rewrite plan (tooling cleanup of `install-on-target.ps1` + `package-for-production.ps1`). The two are unrelated.

**New Config Definitions:**
- `report-page-titles.def.ts` — report identity (company name + application name) shown in every report header + footer (blank → Branding). **Replaced `report-settings.def.ts` on 2026-06-29** (the old show/hide-toggle + layout config was removed; report-page page size now comes from Pagination Settings). The configurable common labels were also removed 2026-06-29 — the chrome uses fixed defaults.
- Public endpoint: `GET /api/config/report-page-titles/current` (all authenticated users)
- Public endpoint: `GET /api/config/password-policy/current`

**Permissions Updates (snapshot at release; current totals are higher — see live counts in root `CLAUDE.md`):**
- ~95 permission constants at release (now 102 — verify with `grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts`)
- 87 reauth actions at that point (now 92 — verify with `grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts`); the 2026-05-04 audit-linkage fixes added `UPDATE_PROFILE` (H1) + `RETIRE_FILTER` / `REPLACE_FILTER` / `BULK_UPLOAD_FILTERS` (C2) + `APPROVE_ADMIN_REQUEST` (M1) + `UPDATE_FILTER_LIFECYCLE` (M2) (`tasks/AUDIT-2026-05-04-linkage-review.md`); later net-changed by the UNS + reports tear-outs
- FEATURE_TO_PERMISSION_MAP entries include both frontend + backend permissions
- Block change requests GET endpoint accepts BLOCK_CHANGE_REQUEST OR BLOCK_CHANGE_APPROVE
- Backup export uses CONFIG_UPDATE (removed hardcoded SUPER_ADMIN check)
- ~~Org-admin routes changed from requireRole to requirePermission(ORG_VIEW)~~ (org-admin module deleted in MT removal 2026-04-30)

**Backend Fixes:**
- Backup restore: SQL/CSV formats now include password_hash
- enforceReauth added to: retention PUT, retention execute POST, submit-checklist POST
