# DigiLog — CLAUDE.md

## Project
DigiLog (21cfrlogbook) — IoT data logging platform with 21 CFR Part 11 compliance and an integrated Digital Filter Management System for pharmaceutical cleanrooms.

## Repository
- **Remote:** github.com/pankajexa/21cfrlogbook.git
- **Active branch:** `RFID` (feature work) → merges to `DigitalFMS` → `main`

## Monorepo Structure
```
apps/api/         — Fastify backend (TypeScript, port 3000)
apps/web/         — React SPA (Vite, port 5175 dev)
apps/android/     — Capacitor Android wrapper (DigiLog-FilterOps.apk)
rfid_scan_app/    — Native Kotlin RFID scanner (KC-series UHF readers)
packages/shared/  — Permissions (102), privileges (83), reauth (92), sidebar items (26), zod schemas
packages/queue/   — graphile-worker job queue (Postgres-backed)
docs/             — Project docs (current)
old/              — Archived superseded docs and tasks
future/           — Forward-looking design notes
```

## Local Dev Environment (Windows)
The app runs ONLY on local Windows for development. There is no live EC2 / Linux production environment to push to.

- Node.js 20+, PostgreSQL 18
- **No Redis dependency.** Phase 2 of windows-friendly-rewrite moved the job
  queue to graphile-worker on Postgres. Phase 4 (2026-05-01) retired Redis
  for pub/sub too (in-process EventEmitter bus); `ioredis` is no longer in
  package.json. Those pub/sub consumers (WebSocket events, pipeline tracing,
  debug recorder) were all torn out in Phase 6/7, and the now-orphaned bus
  (`lib/internal-bus.ts`) + the `@fastify/websocket` plugin were removed
  2026-07-03 as dead code — there is no pub/sub layer anymore.
  (The device-RPC correlation cache `lib/rpc-cache.ts` was removed 2026-07-01
  as dead code — its only consumer, the data-ingestion MQTT RPC handler, went
  in the Phase 7 tear-out.)
- **No TimescaleDB or MQTT dependency** (removed 2026-06-11..2026-06-17 — see
  Phase 7 below). `digilog_tsdb` database dropped, `packages/db` workspace
  deleted, `mqtt` + `aedes` + `@types/pg` deps uninstalled, Mosquitto Windows
  service removed. 47 transitive npm packages dropped with the cleanup.
- Convenience: `start-digilog.bat` / `stop-digilog.bat`
- API runs via `tsx watch` in dev (no PM2 locally), Vite serves frontend
- See `LOCAL_SETUP_WINDOWS.md` and `DEPLOY-WINDOWS.md` for full details

## Build Commands
```bash
# Backend (dev — auto-reload)
cd apps/api && npx tsx watch src/app.ts

# Backend (prod-style local build)
npx tsc -p apps/api/tsconfig.json && node apps/api/dist/app.js

# Frontend (dev)
cd apps/web && npx vite --host

# Frontend (build)
cd apps/web && npx vite build

# Shared packages
npm run build -w @digilog/shared && npm run build -w @digilog/queue

# APK
cd apps/android && npx cap copy android && cd android && ./gradlew assembleDebug
```

## Default Login
- **Username:** `superadmin`
- **Password:** `Admin@123` (forced change on first login)

## Key Local URLs
- App: http://localhost:5175 (Vite dev)
- API: https://localhost:3000 — `API_HTTPS=true` in `apps/api/.env` (mkcert certs at `certs/server.{key,crt}` rooted by `certs/rootCA.pem`)
- Swagger: https://localhost:3000/docs

### TLS notes
- **APK requires HTTPS** — plain HTTP causes a Capacitor TLS parse error on login. Tablet must trust `rootCA.pem` (Settings → Security → Install certificate). `apps/web/.env.production` is **`skip-worktree` and tracked blank** on purpose (no dev's IP in the repo); it is set locally only (currently `https://192.168.1.53:3000`, = this PC's static IP). **The baked value only affects a FRESH install** — `getApiBase()` (`apps/web/src/lib/api-base.ts`) reads `localStorage['digilog.serverUrl']` FIRST, so a tablet with an existing Server Address keeps using it across APK updates; change it on-device. See the network IP-change runbook in memory.
- **Browser dev** — `http://localhost:5175 → https://localhost:3000` is fine (browser allows it; no mixed-content issue for fetch).
- **Verify TLS up** — `curl -sk -o /dev/null -w "%{http_code}" https://localhost:3000/health` should return a code (even 401 means TLS is up).
- **Don't use HTTPS with self-signed in Capacitor *dev* mode** — WebView's `fetch()` rejects self-signed certs (Capacitor's `BridgeActivity` overrides the WebViewClient after `onCreate`). Keep dev cleartext if testing in-WebView, or install root CA on the device.

## System Stats (current — 2026-06-17, verified post data-ingestion + TimescaleDB removal)
- **Backend:** **33** API modules under `apps/api/src/modules/`, 200+ endpoints (verified `ls` 2026-07-04). 2026-06-11..2026-06-17 dropped 4 modules (`data-ingestion`, `uns`, `connectivity`, `queries`) and re-added `debug-traces` (now reads from `audit_trail` instead of dropped `ts_pipeline_traces`). **2026-07-04 dropped 2 modules** (`reports`, `report-templates`) as dead code — the orphaned report generate/sign engine; the active `report-reviews` module + the report-config defs (`report-page-titles`, `report-labels`, `report-signatories`) SURVIVE.
- **Database:** **61 Prisma models, 23 enums**; **TimescaleDB DROPPED entirely** (was 6 hypertables — `ts_telemetry`, `ts_attributes`, `ts_checklist_responses`, `ts_device_events`, `ts_binary_data`, `ts_pipeline_traces`). Only `digilog_db` (Prisma) + `digilog_test_db` remain. **2026-06-11..2026-06-17 dropped 6 models** (`DeviceCredential`, `UnsMapping`, `ConnectivityStatus`, `DataStream`, `DeadLetterQueue`, `IngestionSystemConfig`) and 33 rows of dead ingestion config. TemplateKind is a lookup table (admin-editable since Step 1); not an enum. Phase A.3 added `FilterProfileVersion` sidecar; Phase A.4 added `EquipmentGroupVersion` sidecar; Step 4 (2026-05-02) replaced `FilterProfile.applicableTemplates` JSONB array with the `FilterProfileApplicableTemplate` join table. Audit C3 (2026-05-04) added `audit_trail.previous_checksum` + `chain_position BIGSERIAL` for tamper-evident hash chain. **2026-05-17 dropped 5 models** (`RuleChain`, `RuleChainVersion`, `RuleNode`, `RuleNodeConnection`, `Alarm`). **2026-07-01 dropped 2 orphaned tables** (`QrCode`/`qr_codes`, `LatestTelemetry`/`latest_telemetry` — both 0 rows, no FKs; the QR module went 2026-06-06 and the telemetry pipeline went in Phase 7, but the model+table lingered). Migration `20260701071802_drop_qrcode_latesttelemetry`; drift guard PASS. **2026-07-04 dropped 2 more orphaned tables** (`ChecklistReview`/`checklist_reviews`, `ElectronicSignature`/`electronic_signatures` — both 0 rows, 0 code refs, no relations; introduced with the data-ingestion feature set and stranded by the Phase 6/7 tear-outs: ChecklistReview linked to the dropped `ts_checklist_responses` hypertable, ElectronicSignature keyed off the removed `Alarm.id`/`ChecklistReview.id`. Live e-signature surface uses `ReportReview` + the hash-chained `audit_trail`). Migration `20260704062157_drop_checklistreview_electronicsignature`; drift guard PASS. **2026-07-04 dropped 4 models** (`ReportTemplate`, `ReportTemplateVersion`, `ReportInstance`, `ReportSignature`) + 2 enums (`ReportTemplateStatus`, `ReportStatus`) with the reports generate/sign tear-out (`ReportSignature` was orphaned — only the deleted reports module wrote it; the active e-signature surface is `ReportReview`). Migration `20260704121326_drop_reports_generate_sign`.
- **Permissions:** **102** constants, **83** feature privileges, **92** reauth actions, **27** sidebar items. **2026-07-13 — Home sidebar item:** `home` (Module Guide) added to `SIDEBAR_ITEMS` (26→27) and its force-show in `sidebar.tsx` removed, so it is now a normal Roles-&-Access-managed sidebar item (toggleable per role/user on Config → Roles & Access → Sidebar; visible-to-all by permission since it has no `PERMISSION_TREE` group; SUPER_ADMIN bypasses). Existing role_configs backfilled with `home`. NOT added to the Permissions/Feature-Privileges tab (grants no capability). **2026-07-04 — reports generate/sign removal:** dropped 7 perms (`REPORT_TEMPLATE_{READ,CREATE,UPDATE,DELETE}`, `REPORT_VIEW`, `REPORT_SIGN`, `REPORT_DELETE`; 109→102), 7 reauth actions (`{CREATE,UPDATE,DELETE}_REPORT_TEMPLATE`, `GENERATE_REPORT`, `SIGN_REPORT`, `REJECT_REPORT`, `DELETE_REPORT`; 99→92), 9 feature-privilege tree nodes (90→83). The ACTIVE cleaning-record + lifecycle PDF export were re-gated by making `cleaning_record.export`/`lifecycle.export` configurable (kept `REPORT_EXPORT` + `REPORT_GENERATE` perms). `REPORT_REVIEW_SUBMIT/REVIEW/APPROVE` perms + `REVIEW_REPORT`/`APPROVE_REPORT` reauth actions SURVIVE (ad-hoc report-review workflow). **2026-07-02 — RFID picker re-added (regression fix):** `filters.rfid_manage` ("Assign / Unassign RFID Tags") made **configurable again** (89→90 FP), reversing the 2026-07-01 enforced-only removal. With the toggle gone, only SUPER_ADMIN (+ OPERATOR via a leftover `ASSET_IDENTIFIER_CREATE` grant) could assign RFID — every other role got a 403 on the tablet RFID-assign page with no UI way to grant it. Enabling the toggle grants `[FILTER_RFID_MANAGE, ASSET_IDENTIFIER_CREATE, ASSET_IDENTIFIER_DELETE, ASSET_READ]` (satisfies the `POST/DELETE /api/assets/identifiers` `requireAnyPermission` gate). Re-added to `CONFIGURABLE_PRIVILEGE_ORDER` + frozen snapshot (both count tests 89→90). **2026-07-01 — Audit hard-delete (compliance-affecting; operator-requested):** re-added the physical audit-record DELETE that was torn out in 2026-05 for 21 CFR §11.10(e). New `AUDIT_DELETE` perm (+1 constant), `audit.delete` picker toggle ("Delete Audit Record (permanent)", gate `['AUDIT_DELETE']`, grant-set `[AUDIT_DELETE, AUDIT_READ]`, FP 88→89), 2 reauth actions `DELETE_AUDIT_RECORD`/`BULK_DELETE_AUDIT_RECORDS` (100→102; **2026-07-04 removed 3 dead `*_TEMPLATE_KIND` reauth actions — theater, never enforced by any endpoint; 102→99**). Backend `DELETE /api/audit/:id` + `POST /api/audit/bulk-delete` (audit/routes.ts) require `AUDIT_DELETE` (SUPER_ADMIN bypasses) + reauth + a `reason`; each disables the `audit_trail_no_delete` immutability trigger for its transaction (query pg_trigger → `ALTER TABLE … DISABLE/ENABLE TRIGGER`, ACCESS-EXCLUSIVE lock closes the window), writes a meta-audit row (`AUDIT_RECORD_DELETED`/`AUDIT_RECORDS_BULK_DELETED`) recording who/what/why BEFORE the row is destroyed. **WARNING: physical deletion BREAKS the tamper-evident hash chain** — `GET /api/audit/verify-chain` reports the downstream chain invalid, permanently; verify-chain/`verifyAuditChecksum` were deliberately NOT taught to tolerate deletions (breakage stays loud). REDACT (`POST /:id/redact`, chain-preserving) remains the recommended path. Frontend audit page adds a distinct "Delete Permanently" affordance (`can('audit.delete')`) alongside the existing amber "Redact" (`can('audit.redact')`, SA-only); the shared confirm dialog is now mode-aware. Off by default (no role granted `AUDIT_DELETE`; grant per role via the picker). **2026-07-01 — Notifications picker:** `notifications.manage` ("Manage Notifications") made enforced-only (removed from picker; `NOTIFICATION_MANAGE` is enforced by no route). `notifications.delete` ("Delete Notifications") made a **real grantable perm** — its gate was `[]` (SUPER_ADMIN-only) so enabling the toggle did nothing; now gate `['NOTIFICATION_DELETE']` and the backend delete routes (`bulk-delete`, `DELETE /:id`) use `requirePermission('NOTIFICATION_DELETE')` instead of `requireSuperAdmin()` (reverses the 2026-06-30 M5 SA-only decision; SUPER_ADMIN still bypasses). FP 89→88. **2026-07-01 — Filters picker RFID→Export swap:** `filters.rfid_manage` ("Assign / Unassign RFID Tags") made enforced-only (removed from picker per user request; RFID still gated on `FILTER_RFID_MANAGE`, held only by SUPER_ADMIN so no practical impact). Added `filters.export` (`FILTER_LIST_EXPORT`, +1 constant, enforce:'c') gating the Filters page Export (PDF/Excel) menu (`can('filters.export')` in filter-list.tsx) — off by default (SUPER_ADMIN bypasses; enable per role to unhide), mirrors `retirement_list.export`. Net feature-privileges unchanged (89). **2026-07-01 — ASSET_* over-grant fix (privilege leak):** removed the broad `ASSET_CREATE/UPDATE/DELETE` from the grant-sets of `filters.status_update` / `filters.bulk_upload` / `filters.hierarchy_create` + `equipment_groups.create/edit/delete`. Those broad perms leaked edit/create/delete across the Filters page via `useCan` (granting "Update Filter Status" handed out `ASSET_UPDATE`, which satisfies the `filters.edit` / `filters.hierarchy_edit` gate → every edit control lit up; a real backend escalation too since the edit endpoints accept `ASSET_UPDATE`). `ASSET_*` now grants via **no** picker toggle → it LEFT `allMappedPerms` and is **manual-managed** (edit/create granted via the `FILTER_*` toggles; this reverses the 2026-06-30 "keep ASSET_* in grant-sets" decision). Perm constants KEPT; existing roles' `ASSET_*` preserved on re-save. **2026-07-01 — picker redundancy audit (92→89):** `checklists.toggle` (identical gate to `checklists.edit`), `cleaning_profiles.toggle` (redundant with `cleaning_profiles.edit`), and `checklists.submit` (same `FILTER_OPERATE` gate as `filters.operate`; `CHECKLIST_SUBMIT` never enforced) made **enforced-only** (dropped from picker; perms/nodes kept). Also re-tagged `notifications.view`/`notifications.manage` `enforce:'a'→'c'` — `NOTIFICATION_VIEW/MANAGE` are enforced by **no route** (notification endpoints are user-scoped/auth-only, delete is SUPER_ADMIN-only), so those toggles are visibility-only. **2026-07-01 — RFID/Relationships toggle de-dup:** `assets.identifiers.create`/`assets.identifiers.delete` (RFID assign/unassign) + `assets.relationships.create`/`assets.relationships.delete` made enforced-only (dropped from the picker; 96→92 FPs). RFID is fully covered by the single `filters.rfid_manage` toggle (both identifier endpoints accept `FILTER_RFID_MANAGE` via `requireAnyPermission`; `ASSET_IDENTIFIER_DELETE` added to its grant so the map stays complete). `ASSET_RELATIONSHIP_CREATE/DELETE` were grant-only perms never used as a route gate (real gate = `ASSET_UPDATE/FILTER_EDIT/FILTER_HIERARCHY_EDIT` on PUT-instance) — so their nodes **AND the perm constants were removed entirely** (constants 109→107; also stripped from default-roles + live DB SUPER_ADMIN; relationship writes go through the edit gate / `assets.edit`). RFID `ASSET_IDENTIFIER_*` constants KEPT (real gates). `assets.view` label renamed "View Assets"→"View Filters". Roles unchanged. **2026-06-30 — Filters/Assets toggle de-dup:** `assets.create`/`assets.edit`/`assets.delete` made enforced-only (dropped from the role-config picker; 99→96 FPs). They duplicated the filter-specific Create/Edit/Delete Filters + Block/Area/AHU toggles — same capability under different names (backend create/edit/delete endpoints accept `ASSET_*` OR `FILTER_*`/`FILTER_HIERARCHY_*` via `requireAnyPermission`). The `ASSET_CREATE`/`UPDATE`/`DELETE` **permission constants are KEPT** (still granted in roles + accepted as backend alternates); only the duplicate picker toggles were hidden, so roles are unchanged. See `tasks/ASSET-FILTER-PERM-CONSOLIDATION-PLAN.md`. The 2026-06-11..2026-06-17 tear-out removed 2 perms (`UNS_VIEW`, `UNS_MANAGE`), 2 privileges (`uns.view`, `uns.manage`), 6 reauth actions (`MANAGE_DEVICE_CREDENTIAL`, `OVERRIDE_UNS_PATH`, `DELETE_UNS_MAPPING`, `UPDATE_UNS_CONFIG`, `UPDATE_RETENTION_POLICY`, `EXECUTE_RETENTION`), and 2 reauth categories (`UNS`, `Retention`). Audit-action and audit-template registry entries for old subsystems (UNS, RETENTION, DEVICE_CREDENTIAL, RULE_CHAIN, ALARM) are **retained** per 21 CFR §11 (no longer emitted; inspector contract preserved).
- **Config:** **36 definitions** (`apps/api/src/modules/config/defs/*.def.ts`) + auto-discovery, **34** corresponding pages (`uns.def` + `retention.def` removed 2026-06-17; `ahu-completion-process.def.ts` added 2026-07-01; `export-limit.def.ts` added 2026-07-14 — configurable max export records + message, renders via the dynamic config page so no new `routes/config/*.tsx`)
- **Themes:** 10 preset color themes (Ocean / Sapphire / Emerald / Amethyst / Sunset / Slate / Ruby / Forest / Midnight / Coral)
- **Frontend:** **77 Routes** in `main.tsx`, **26** custom hooks, **30** lib modules
- **Queue backend:** graphile-worker (Postgres-backed); 3 worker tasks (`notification`, `pm_overdue_check`, `session_sweep`)
- **Tenancy:** **single-tenant, single-site, single-company.** Multi-tenancy was removed 2026-04-30 (`Organization` model + `organizationId` columns + `org-admin`/`tenant-admin` modules dropped). JWT `scope` always stamps `GLOBAL`. The `RoleScope` enum and `AssigneeType` enum are retained but trimmed to one/two values respectively.

## Important Notes
- Only one database now: `digilog_db` (Prisma). TimescaleDB (`digilog_tsdb`) was dropped 2026-06-11 with the data-ingestion tear-out.
- Input sanitization strips HTML on all text fields (`apps/api/src/lib/sanitize.ts`)
- Capacitor APK uses **HTTPS** baked at build via `VITE_API_URL` (cert install required on tablet)
- Light theme only — `bg-white`, `bg-slate-50`, `border-slate-200`, gradient dialog headers OK
- **Sidebar RBAC redesign (2026-06-30, branch RFID):** `packages/shared/src/types/permission-tree.ts`
  (`PERMISSION_TREE`) is the **single source of truth** — a Sidebar→Page→Action catalog. Each node
  carries `permissions` (grant-expansion set = the role-config toggle), `gate` (the *discriminating*
  backend permission `useCan()` checks — `[]` = SUPER_ADMIN-only), `reauthAction`, `enforce` (a/b/c),
  `configurable` (is it a role-toggle), and per-group `visibilityPrivilegeIds`. `FEATURE_PRIVILEGES`,
  `FEATURE_PRIVILEGE_CATEGORIES`, `FEATURE_TO_PERMISSION_MAP`, and `SIDEBAR_PRIVILEGE_MAP` are now
  **derived** from the tree (hand-maintained originals retired; frozen-snapshot test locks zero drift).
- SUPER_ADMIN bypasses frontend permission checks. **Button gating uses the `useCan('<node-id>')` hook**
  (`apps/web/src/hooks/use-can.ts`, ~19 pages) which gates on the node's `gate`; sidebar visibility uses
  `isSidebarItemVisible()` over the tree. The older inline `isSuperAdmin || perms.includes(...)` pattern
  remains only for non-button logic (PM workflow-role checks, data-layer queries). Grant set ≠ gate:
  never OR over `permissions`/`resolveNodePermissions` as an auth check (it includes read deps).
- Feature toggles need BOTH frontend visibility perm AND backend route perm — encoded in each tree node;
  `FEATURE_TO_PERMISSION_MAP` (derived) still drives the backend role→permissions expansion (`config.service.ts`).
- RBAC redesign analysis + phase plans: `tasks/RBAC-SIDEBAR-REDESIGN-ANALYSIS.md`, `docs/superpowers/plans/2026-06-30-rbac-sidebar-phase-{1..5}.md`. Phases 1–3 + 5 done; Phase 4 (per-page View) optional/not executed.
- New config defs must be imported in `config-discovery.ts` AND registered as a card in `config/index.tsx`
- Approval/decision flows require remarks; filter cleaning stage remarks stay optional
- Cycle `profile_id` is locked at start — reassigning a block's profile does NOT migrate in-progress cycles

## Phase Snapshots (history is in `CHANGELOG.md`)

### Phase 2 — Digital Filter Management
Cleaning profiles, filter operations (cycle start/advance/bypass/checklist), PM scheduling, equipment groups, checklist profiles, filter traceability.

### Phase 3 — RFID & Offline
RFID Scanner Android app (Reader_Usb.jar SDK), web RFID keyboard guard, offline IndexedDB queue + sync engine, cached identifier→filter map, "Data Synced" indicator, responsive collapsible sidebar.

### Phase 4 — Permissions, Themes, Reports
18 granular feature toggles introduced (Filters / Checklists / Cleaning Profiles / Equipment / PM) — total privileges grew to 91 over Phases 4 + 5 (later trimmed to 89 in MT removal 2026-04-30, then 90 after VERSION_HISTORY 2026-05-02); 10 color themes; configurable report header/footer/layout; dynamic bulk upload from template attributeSchema; reauth actions grew to 81 across 16 categories.

### Phase 6 — Subsystem Reduction (2026-05-17)
**Rule chain + alarm tear-out.** Deleted both subsystems wholesale: 5 Prisma models, 22 source files (`apps/api/src/modules/rule-chain/`), 12 web files (`apps/web/src/routes/{rule-chains,alarms}/`, `config/alarm-columns.tsx`), 7 perms / 7 privileges / 5 reauth actions / 2 sidebar items, 6 role permission arrays + 11 alarm field-IDs + 5 `rule_engine.*` configs + 7 help articles from seed, and stale runtime rows from `roles` / `role_configs` / `system_config`. Telemetry ingest pipeline lost Stages 7 + 8 (rule-chain execution + alarm dispatch); the cleaning-cycle pipeline is unrelated and survives. **Retained**: `audit-actions.ts` + `audit-templates.ts` entries for both subsystems (21 CFR §11 inspector contracts — no longer emitted, still rendered for historic rows). Hash chain unaffected; only 4 historic `audit_trail` JSON-detail UUIDs become orphans (accepted per user "hard delete" decision). Plan + execution: `tasks/REMOVE-RULECHAIN-ALARM-PLAN.md`. Pre-removal git tag: `pre-rulechain-alarm-drop`.

### Phase 7 — Data-Ingestion + TimescaleDB Removal (2026-06-11..2026-06-17)
**Complete tear-out of the dormant ingestion layer.** Pre-removal verification confirmed 5 of 6 hypertables were always empty and only 234 debug-trace rows in `ts_pipeline_traces` — the whole subsystem was carrying weight without serving traffic. Removed in 10 phases:
- **Phase 1** — 2 frontend route files (`config/uns.tsx`, `config/retention.tsx`) + their config cards + Route entries
- **Phase 2** — 55 backend files: `modules/{data-ingestion,uns,connectivity,queries}/`, `transport/`, `workers/ingestion.worker.ts`, `workers/maintenance-retention.ts`
- **Phase 3** — Wire-up cleanup: deleted `lib/operation-tracer.ts` + `workers/maintenance.worker.ts` + 6 other touchpoints (app.ts hooks, instance.service auto-provision block, deployment-check TSDB/MQTT checks, audit.ts dynamic import)
- **Phase 4** — Dropped 6 Prisma models (`DeviceCredential`, `UnsMapping`, `ConnectivityStatus`, `DataStream`, `DeadLetterQueue`, `IngestionSystemConfig`) — 33 rows of dead `ingestion_system_config` data dropped via `prisma db push --accept-data-loss`
- **Phase 5** — `DROP DATABASE digilog_tsdb` — all 6 hypertables gone
- **Phase 6** — Deleted `packages/db/` workspace; uninstalled `@digilog/db`, `mqtt`, `aedes`, `@types/pg` from `apps/api/package.json`; migrated `/api/health` to local `lib/prisma.js`; stubbed `dashboards/routes.ts` timeseries_chart widget + `reports/data-sources/telemetry-source.ts`; `npm install` removed **47 transitive packages**
- **Phase 7** — Cleaned `apps/api/.env` (TSDB_*, MQTT_*, EMQX_*, UNS_ROOT_PREFIX gone); deleted dead `lib/uns-path.ts`; uninstalled Mosquitto Windows service
- **Phase 8** — Fixed `e2e/test-helper.ts` (was importing 2 deleted route modules → broken until fixed); fixed `instance.service.test.ts` Prisma-client mock; deleted 2 orphan test files (`workers/__tests__/ingestion.worker.test.ts`, `e2e/connectivity.test.ts`)
- **Phase 9** — Deleted 2 dead config defs (`uns.def.ts`, `retention.def.ts`); removed 2 perms / 2 privileges / 6 reauth actions / 2 reauth categories from `packages/shared`; stripped DB rows in `roles.permissions` (1 row updated) + `system_config['action-reauth']` (5 stale keys removed)
- **Phase 10** — Doc sync (this update)

**Section 14 (Debug Traces repurpose)** — landed 2026-06-12 as commit `8619d24`: `/api/debug/traces` repointed onto `audit_trail` so the existing Debug Traces UI keeps working (each audited action → single-stage SUCCESS PipelineTrace). 9.8k records render. Limits: only successes (no error codes / durations).

**What survived**: cleaning-cycle pipeline, PM workflows, audit trail (hash chain unaffected), reports, dashboards (timeseries_chart returns `[]` cleanly), offline sync, RFID, all 35 active modules. Reports module's `{{ts.<slot>.<key>}}` template tags return `{value: null, error: "Telemetry data source has been removed."}` instead of crashing.

**Retained per 21 CFR §11**: `audit-actions.ts` registry entries for `UNS_*`, `RETENTION_*`, `DEVICE_CREDENTIAL_REGENERATED` — historic audit rows still render correctly in inspector UI even though new code never emits these.

Pre-removal git tag: `pre-ingestion-removal` (commit `ed88400`). Phases 1-6 landed as commit `a95f6eb` on `RFID` (82 files, -16736 LoC). Runbook: `~/Downloads/DigiLog-Data-Ingestion-Removal-Plan.docx`.

### Phase 5 — Reports, Offline Hardening, RFID SDK, Filter Data Console (Apr 15–29, 2026)
Reports module A–F complete (visual template designer + puppeteer-core/Edge / @napi-rs/canvas / Handlebars PDF engine + digital signatures — Phase 3 of windows-friendly-rewrite swapped from `puppeteer` + `chartjs-node-canvas` to eliminate the bundled Chromium download and the node-gyp/MSVC dependency), offline overhaul (TTL cache, idempotency keys, tombstones, LRU, JWT refresh, server-side `stageLookup`, Capacitor Network plugin + SW hook), RFID SDK plugin in DigiLog APK (`Reader_Usb.jar` via `RfidPlugin.java`), Filter Data Management console mirroring 10 user-facing pages, DRY_IN two-step flow with persisted countdown panel, dynamic backup/restore covering all 64 tables, bloat audit 12/14 resolved, EC2/PM2 production assets removed (local-Windows-only), decision-tape proposal for future client/server pipeline drift elimination. Full architectural detail in `PHASE_5_RECENT_WORK.md`.

**Phase 5 verification harness** (Apr 29–30, 2026) — closed the verification gap left by Phases 1–4:
- **5.1** — `tests/integration/windows-server-stack.test.ts` originally exercised aedes MQTT broker + 100 telemetry publishes → `ts_telemetry` → graphile-worker → puppeteer-core PDF render. **2026-07-15 (M39-batch audit, finding M05): the dead halves were REMOVED, not just noted stale.** The top-level `aedes`/`mqtt` imports failed module resolution — which `describe.skipIf` cannot prevent — so **every root-level `npx vitest run` died at collection**, gate or no gate. Dropped: the MQTT→`ts_telemetry` test (aedes/mqtt uninstalled; `transport/`, `workers/ingestion.worker.ts`, `packages/db/` deleted; `digilog_tsdb` dropped; the `Organization`/`UnsMapping`/`ConnectivityStatus`/`DeviceCredential` models its fixture needed are all gone). The PDF-render test was already removed 2026-07-04 with the reports generate/sign tear-out — so the pre-2026-07-15 claim here that "PDF assertions still valid" was itself stale. **KEPT and verified passing**: the API-boot/`/api/health` check + the graphile-worker `addJob` → task-dispatch check. The file + its `vitest.workspace.ts` entry survive; ungated it now registers 2 skipped tests and exits 0.
- **5.2** — `scripts/verify-windows-deployment.ps1`: operator-facing smoke check (health endpoint, graphile-worker schema via psql, real PDF render via login → reports/generate). **Mosquitto :1883 check stale post-Phase-7** (service uninstalled). PS 5.1 + 7+ compatible.

## Key API Endpoints (filter operations)
```
POST /api/filters/:id/start-cycle       — Start cleaning cycle
POST /api/filters/:id/advance           — Advance to next stage
POST /api/filters/:id/submit-checklist  — Submit checklist answers
POST /api/filters/:id/bypass            — Bypass stage (deviation)
POST /api/filters/:id/terminate         — Terminate cycle (with reason)
POST /api/filters/bulk-operate          — Batch advance / start-and-advance / submit-checklist in ONE request (partial success; per-item tx + audit; reauth once). Tablet 50–100 tag submit.
GET  /api/filters/:id/current-state     — Filter state + next actions (full server snapshot)
GET  /api/filters/cycles                — List cleaning cycles (mounted by filter-operations/events-routes.ts under the /api/filters prefix)
GET  /api/filters/events                — List filter events
GET  /api/filter-cleaning-profiles                       — List cleaning profiles (latest version per lineage)
GET  /api/filter-cleaning-profiles/:id/versions          — Phase A.2: list lineage version history
GET  /api/filter-cleaning-profiles/:id/versions/:n       — Phase A.2: frozen snapshot at version n
GET  /api/filter-profiles/:id/versions                   — Phase A.3: list archived FilterProfile versions
GET  /api/filter-profiles/:id/versions/:n                — Phase A.3: frozen FilterProfile snapshot at version n
GET  /api/equipment-groups/:id/versions                  — Phase A.4: list archived EquipmentGroup versions (group + 3 instruments composite)
GET  /api/equipment-groups/:id/versions/:n               — Phase A.4: frozen EquipmentGroup composite snapshot at version n
GET  /api/checklist-profiles?expand=questions — Used for offline cache
GET  /api/config/report-settings/current — Report layout config
GET  /api/config/password-policy/current — Password policy (public endpoint)
```

## Pipeline Flow
- CHECKLIST nodes between STAGE nodes trigger automatic question dialogs
- Server-side enforcement: `advance()` blocks if pending checklist not completed
- Cycle auto-completes when last STAGE leads to END node
- Stage chain may include multiple consecutive CHECKLIST nodes — server uses `stageLookup` to resolve

---


## Documentation Sync Rule

**Hard rule:** every numerical claim in any doc must be backed by a `grep`/`ls` against live code at the moment the doc is touched. Don't trust prior docs — verify.

**Active doc set** (kept current together):
- Root: `README`, `CLAUDE`, `AGENTS`, `CHANGELOG`, `PROJECT_SUMMARY`, `PROJECT_ARCHITECTURE`, `API_REFERENCE`, `BACKEND_GUIDE`, `FRONTEND_GUIDE`, `OFFLINE_SYNC_ARCHITECTURE`, `PHASE_5_RECENT_WORK`, `DEPLOY-WINDOWS`, `LOCAL_SETUP_WINDOWS`, `windowsIssues`
- Per-package: `apps/{api,web}/{CLAUDE,DECISIONS}.md`, `packages/shared/CLAUDE.md`
- Reference: `docs/`, `future/`, `tasks/todo.md`, `PROJECT_HANDOVER/`

**Per-change mapping:** see [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) "Change → Docs map" — read it before touching code that affects counts, modules, shared types, or any public surface. Same file holds the **12-touchpoint rule** for new config defs and the **pre-deletion rule** with receipts.

**Live-count verification (run before quoting any count):**

```bash
grep -cE "^model "                              apps/api/prisma/schema.prisma
grep -cE "^enum "                               apps/api/prisma/schema.prisma
grep -cE "^\s+[A-Z_]+:\s*'"                     packages/shared/src/types/permissions.ts
grep -cE "^\s+[A-Z_]+:"                         packages/shared/src/types/reauth-actions.ts
ls apps/api/src/modules/                        | wc -l
ls apps/api/src/modules/config/defs/*.def.ts    | wc -l
ls apps/web/src/routes/config/*.tsx             | wc -l
ls apps/web/src/hooks/ apps/web/src/lib/        | wc -l
grep -cE "<Route"                               apps/web/src/main.tsx
```

**Stale-stat sweep:** when changing any count, generate a regex from the *previous* numbers and grep across the active doc set; every match needs an update. Don't bake hardcoded numbers into the regex — derive them on the spot from the System Stats above.

**Always-update on any feature change:** `CHANGELOG.md`, `PHASE_5_RECENT_WORK.md` § 11 if closing an open gap, memory after corrections, `tasks/todo.md` audit-log entry for non-trivial doc work.

**Pre-deletion:** read each file's actual content for unique knowledge before deleting; when in doubt, restore. Receipts in `docs/CONTRIBUTING.md`.


## Defaults, not absolutes
If a rule below would produce a worse outcome in a specific case, say so 
and explain — don't silently comply with a rule that's misfiring.

## Never
- Don't swallow exceptions to silence errors.
- Don't hardcode values or comment out assertions to make tests pass.
- Don't invent APIs, function signatures, or config keys. If unsure, check or ask.
- Say "I don't know" when you don't know. Don't guess at fixes.
- Confirm before destructive actions (deleting files, dropping data, 
  rewriting git history).
- State assumptions explicitly in your response so I can correct them.
-while testing front end check for unlined Ui elements and consle logs that return unexpceted responses

## Correctness
- before editing the code fnd and list all the touch point this code change will effect, after code change, test all touch points, if you find a bug, fix it even if it not in your scope, only then consider the task done.
- Find root causes. No temporary fixes, no swallowing symptoms.
-be brutally honest

## Multi-session work
- For tasks spanning multiple sessions or 5+ steps, maintain `tasks/todo.md` 
  with checkable items. Skip this for smaller tasks.
