# Current Status — 2026-04-29

## Active branch

- **`RFID`** (derived from `main`, not yet merged)
- Recent ship-worthy commits since the prior CURRENT_STATUS snapshot (2026-04-20):
  - `3c99973` — offline overhaul foundation (TTLs, idempotency, tombstones, LRU, JWT refresh)
  - `0c8de53` — in-code offline overhaul (idempotency, stale-profile guard, pre-cache, stage lookup)
  - `b8e003e` — Capacitor Network plugin + Service Worker hook + APK rebuild
  - `39ccd1c` — RFID SDK plugin (`Reader_Usb.jar`) integrated into DigiLog APK
  - `5eb9db8` — offline-checklist `?expand=questions` + chained CHECKLIST `stageLookup` walker
  - Plus extensive documentation reconciliation through 2026-04-29

## What's shipped and stable (verified in code)

### Identity, access, and audit
- JWT auth via `jose` 6 with refresh tokens, beacon logout, reauth verification for sensitive actions (`apps/api/src/modules/auth/routes.ts`)
- **102 permission constants**, **83 feature privileges**, **92 reauth actions** across 16 categories, **26 sidebar items** (see `packages/shared/src/types/*`)
- Feature-privilege → permission mapping drives both frontend visibility AND backend route protection (`FEATURE_TO_PERMISSION_MAP`)
- `requireAnyPermission(...perms)` decorator (`plugins/rbac.ts`) for granular toggle fallbacks (e.g. equipment-groups accepts `ASSET_*` OR `EG_*`)
- `enforceReauth(action, req, reply)` extended to accept `string | string[]`
- Role CRUD with hierarchy + creatable-role matrix
- LDAP integration (`ldapts` 8.1) — test/connect/config endpoints
- Audit trail with hash-chain integrity (`apps/api/src/lib/hash-chain.ts`)
- Audit-template UUID hiding via `packages/shared/src/types/audit-templates.ts`
- Session singleton enforcement on the frontend (`use-single-tab.ts`)

### Multi-tenant + super-admin
- Organizations CRUD + per-org detail endpoints (users, entities, templates, assignments, visible-entities)
- **Filter Data Management console at `/config/filter-data-management`** — 9 tabs each mirroring its user-facing page (cycles, events, PM, audit, notifications, admin requests, block changes, retirements, replacements). **SUPER_ADMIN-only escape hatch with ZERO audit trail** — bypasses 21 CFR Part 11 audit chain by design for emergency data fixes. *(The alarms tab was removed 2026-05-17 with the alarm tear-out.)*
- **Tablet access matrix** at `/config/access-matrix` — SUPER_ADMIN-only per-module role allowlist
- **Dynamic backup/restore** covering **all 64 tables** via `pg_tables` + `jsonb_populate_recordset` (non-superuser compatible, two-pass self-ref fixup)

### IoT platform — *mostly REMOVED (rule-chain 2026-05-17; ingestion / queries / UNS / connectivity + TimescaleDB + MQTT 2026-06-17). Only Dashboards survive.*
- ~~**Ingestion** (`apps/api/src/modules/data-ingestion/`)~~ *(removed 2026-06-17 with the data-ingestion tear-out)*
- ~~**Rule chain engine** (`apps/api/src/modules/rule-chain/`)~~ *(removed 2026-05-17 with the rule-chain tear-out; the cleaning-profile pipeline editor now uses a custom canvas, not reactflow)*
- ~~**Queries** (`apps/api/src/modules/queries/`)~~ *(removed 2026-06-17)*
- ~~**UNS:** tree view, search, entity CRUD + move~~ *(removed 2026-06-17)*
- ~~**Connectivity panel:** per-entity token mgmt + snippets + history~~ *(removed 2026-06-17)*
- **Dashboards:** widgets + layouts + assignments + data adapters *(survives; the `timeseries_chart` widget returns `[]` cleanly post-TimescaleDB removal)*

### Digital Filter Management System
- Asset templates with dynamic attribute schemas (validated via `ATTRIBUTE_DATA_TYPES` in shared)
- Filter instances with bulk upload (dynamic CSV from template `attributeSchema`), lifecycle states, status toggles
- Block → Area → AHU → Filter hierarchy builder (visual tree) with create / connect / **edit / delete**
- 5 new permissions: `FILTER_CREATE`, `FILTER_EDIT`, `FILTER_DELETE`, `FILTER_HIERARCHY_EDIT`, `FILTER_HIERARCHY_DELETE`
- Cleaning profiles: pipeline editor with stages, checklist nodes, bypass rules; profile validation
- Filter operations: start / advance / bypass / retire / replace / terminate cycle with server-enforced state machine; cycle `profile_id` locked at start (reassigning a block's profile does NOT migrate in-progress cycles)
- **Block change requests:** cross-block approval popup (desktop + mobile); single-use consumption (`APPROVED → EXPIRED` on cycle start); `BLOCK_CHANGE_REQUIRED` 409 with structured `details` payload; `api-client.ts` line 58 maps `err.details ?? err.connectionInfo`
- PM schedules: CSV template, upload, approvals (approve/reject/resubmit/edit), due list, AHU configs, entry history
- **PM QA Approval Workflow:** `PmEntryApprovalStatus` enum + 11 columns; `PM_APPROVE` permission; `getDueTasks` filters APPROVED only
- **PM My Tasks** at `/my-tasks` — past-date validation, per-AHU filter-set mode (BOTH / SET_A / SET_B / DISABLED), PM auto-reason on mobile (`isPmDue` + `pmReasonKey`)
- Equipment groups with per-block scoping
- ~~**Reports module (generate/sign engine)**~~ — **REMOVED 2026-07-04** (orphaned dead code; 2 backend modules, 4 Prisma models, 7 perms, 5 npm deps incl. puppeteer-core/@napi-rs/canvas gone). Live report surface: **report-reviews** (submit/review/approve) + report-config defs + client-side PDF export (`lib/pdf-report.ts`, jsPDF)

### RFID + mobile
- **Native RFID SDK plugin in DigiLog APK** — `RfidPlugin.java` (at `apps/android/android/app/src/main/java/com/digilog/filtermanagement/`) wraps `Reader_Usb.jar`, paired with `apps/web/src/lib/rfid-bridge.ts`; supports SDK mode AND UKB mode
- **Standalone native Kotlin scanner app** (`rfid_scan_app/`) for KC-series UHF readers (predates the bundled plugin)
- RFID keyboard guard (`apps/web/src/hooks/use-rfid-guard.ts`) — global keydown interceptor blocks UKB tag bursts from leaking into non-`data-rfid="true"` fields
- 300 ms debounce + dedup for repeated scans in dialogs
- One-identifier-per-entity enforcement in `identifier.service.ts`
- Filter + parent-AHU lookup at scan time
- RFID Tag Management slide panel on filters page (view / unassign / scan-or-type / assign)
- Forgot-password flow + show/hide password + lockout-progress UI on tablet (`mobile-forgot-password.tsx`)

### Offline operations (Phase 5 architecture)
- IndexedDB store (`apps/web/src/lib/offline-store.ts`) holds operations queue, cache, filters
- Sync engine (`apps/web/src/lib/sync-engine.ts`): auto-sync on reconnect, FIFO, skip conflicts, idempotency-key-aware, JWT refresh during replay, emits `interrupted` event on network drop
- `useOffline` hook exposes `executeOrQueue()` for offline-safe calls
- `offline-sync-service.ts` centralises 9-data-type login hydration (filters, templates, cleaning reasons, identifiers, profile pipelines, equipment groups + instruments, approved block changes, branding, field IDs)
- `lib/connectivity.ts` — single source of truth for online state; fans out Capacitor Network plugin + `navigator.onLine` + `/api/health` probe every 15 s + on `visibilitychange`
- `x-offline-replay` header + `offlinePerformedAt` timestamps + `x-client-op-id` idempotency keys (server dedup via `apps/api/src/lib/idempotency.ts`)
- "Data Synced" indicator in mobile header when cache + queue both clear
- **TTL-based cache invalidation** (24 h for filter-state, 7 d for compaction); LRU eviction on overflow; tombstones for offline-deleted entities
- **Server-side `stageLookup`** in `/current-state` — pre-computes `{nextStages, pendingChecklistProfileIds, leadsToEnd}` per stage, fixing chained-CHECKLIST resolution bugs
- **Stale-profile guard** with yellow banner UX when `cycle.profile_id != live block-assignment`
- **Capacitor Network plugin + Service Worker hook** (commit `b8e003e`) — replaces unreliable `navigator.onLine` on Android WebView
- **Offline pipeline enforcement** (2026-04-20): cycle state transitions, bypass, checklist validation all run against cached pipeline graph before queuing
- **Checklist-as-stage** (2026-04-20): checklist nodes now participate in the stage machine rather than sitting in a side-channel dialog
- **Skip Block removed** for `needsBlock: true` stages (compliance fix — was bypassing block-change approval)

### Governance / approval flows
- Admin requests: create-user / unlock / reset-password / modify-user approvals that actually execute the action server-side; requester Employee ID required and audited; UUIDs hidden via audit-templates
- Block change requests: cross-block approvals with remarks mandatory, single-use consumption, desktop + mobile popups
- Remarks mandatory on every approval/decision UI except filter cleaning stages

### Configuration surface
- Sidebar, permissions, reauth are deliberately independent — no auto-sync between config tabs (memory `feedback_no_auto_sync_config`)
- **35 config definitions** in `apps/api/src/modules/config/defs/*.def.ts` auto-discovered via `config-discovery.ts`
- **34 corresponding pages** in `apps/web/src/routes/config/*.tsx`
- Routes split per-tab in `apps/api/src/modules/config/static-routes/` (11 files; bloat audit P2.3 done) — top-level `routes.ts` is now ~170 LOC (was 1003)
- Config partial updates: each tab sends only its own fields; backend preserves the rest
- **10 preset color themes** with CSS variable swap (`applyTheme()` on `:root`)
- Report settings: configurable header/footer/records-per-page/compact mode driving `ReportPageWrapper`
- Notification ownership check on mark-read / unread / delete (`assertNotificationVisible()`)
- 4 dead config defs cleaned up (offline-sync, rfid-scanner, role-privileges, sidebar-config) via `cleanupDeadConfigKeys()` migration

## What's likely still in motion

- Modified `apps/api/src/modules/filter-operations/filter-operations.service.ts`, `apps/web/src/routes/filter-management/filter-operations.tsx`, `apps/web/src/routes/mobile/mobile-operations.tsx` on the working tree (uncommitted)
- Modified `.claude/settings.local.json` — local AI-tool settings drift
- Working-tree noise: stray `RFID/` Gradle cache directory, `apps/android/apps/web/public/sw.js` misplaced, `rfid_scan_app/rfid-key.jks` (sensitive), `packages/shared/src/schemas/config.ts.patch` — all flagged in `PROJECT_ARCHITECTURE.md` "Working-tree noise (cleanup candidates)"

## Known constraints / gotchas (verified in memory + code)

### Environment / infrastructure
- ~~**TimescaleDB name:** the telemetry DB is `digilog_tsdb`~~ *(REMOVED 2026-06-17 — `digilog_tsdb` + TimescaleDB dropped with the data-ingestion tear-out; only `digilog_db` remains, and it's vanilla Postgres with no TimescaleDB extension.)*
- ~~**Redis is now optional…**~~ *(REMOVED 2026-05-01 — Redis/Memurai is gone entirely; the job queue is graphile-worker on Postgres and pub/sub is in-process (EventEmitter bus). `ioredis` was uninstalled and the pub/sub consumers torn out in Phase 6/7.)*
- ~~**MQTT broker is Mosquitto 2.0**~~ *(REMOVED 2026-06-17 — MQTT broker (Mosquitto/EMQX) + `install-mosquitto.ps1` gone with the data-ingestion tear-out; no broker anymore.)*
- **No server-side PDF/chart pipeline** — the `puppeteer-core` + Edge + `@napi-rs/canvas` reports engine was removed 2026-07-04. PDF export of the cleaning-record / filter-lifecycle pages is now client-side via `apps/web` `lib/pdf-report.ts` (jsPDF); no Chromium/Edge dependency.
- **`API_HTTPS=true`:** without `certs/server.{key,crt}` (mkcert-generated, rooted by `certs/rootCA.pem`), the API crashes on startup.
- **`tsx watch` for dev**, `tsc -p` then `node dist/app.js` for prod-style local builds. PM2 / EC2 are no longer used.

### Backend
- **Fastify schema stripping:** Fastify strips response fields that aren't declared in the schema. If a property "disappears" on the wire, the schema is the suspect.
- **Role permissions go stale after a DB restore.** The `roles` table is rewritten — either reseed from `seed.ts` or `UPDATE` directly.
- **Cycle `profile_id` is frozen at start.** Reassigning a block's profile does NOT migrate in-progress cycles.

### Frontend + APK
- **`navigator.onLine` is unreliable on Android WebViews.** `lib/connectivity.ts` solves this by polling `/api/health` every 15 s + listening for `visibilitychange` + subscribing to the Capacitor Network plugin.
- **Capacitor WebView ignores `network_security_config` for `fetch()`.** The APK uses `CapacitorHttp` plugin to bypass; tablets must trust `rootCA.pem` via Settings → Security → Install certificate.
- **The APK bakes in `https://192.168.1.22:3000`** at build time. Different host → rebuild APK (`apps/android` → `cap sync` → `gradlew assembleDebug`).
- **No frontend unit tests.** Manual QA + Playwright traces only.
- **Browser dev** (`http://localhost:5173 → https://localhost:3000`) works fine — browsers allow `http → https` fetches.

### Offline model
- **Offline cycles replay FIFO and skip conflicts.** If server state has diverged (e.g., another operator already advanced), the replay is skipped and the UI surfaces it. Don't assume every queued op lands.
- **Cached auth survives tablet reload.** Rotating the JWT secret invalidates cached auth — users see a login screen on the next action.
- **Pipeline graph is cached, but only the active version.** If admin swaps cleaning profile while tablet is offline, stale-profile yellow banner surfaces on next sync.
- **Idempotency keys are mandatory** for offline-replayed mutations — every mutation writer must persist `clientOpId` inside `FilterEvent.attributes`.

### Permissions + config
- **Config tabs are independent.** Sidebar, permissions, reauth — all separate. Don't auto-sync.
- **SUPER_ADMIN bypasses frontend permission checks** (`isSuperAdmin || perms.includes`). Use roles for hard hides.
- **Feature toggles need BOTH frontend visibility perm AND backend route perm** in `FEATURE_TO_PERMISSION_MAP`.
- **New config defs need import in `config-discovery.ts` AND a card in `config/index.tsx`**.

## Open questions for product / ops

- Phase 2/3/4/5 manual test cases — `tests/manual-test-cases/` was deleted in cleanup (Phase 1 only). Closest current coverage is `apps/api/src/e2e/` (also Phase 1 only). Need fresh cases for filter operations, RFID, offline replay, reports, block-change approval, PM My Tasks, admin requests.
- Decision tape proposal — design + prototype if pipeline drift recurs (currently mitigated by `stageLookup`)
- Monster-file split outstanding (bloat audit P0.2): `filter-list.tsx` 2433 LOC, ~~`rule-chains/editor.tsx` 2140 LOC~~ *(removed 2026-05-17 with the rule-chain tear-out)*, `filter-operations.tsx` 1928 LOC, `filter-operations.service.ts` 1617 LOC, `pm-schedule.service.ts` 1042 LOC, `assets/templates.tsx` 1090 LOC, `template-form-editor.tsx` 1070 LOC, `debug/index.tsx` 1145 LOC, `checklist-form/index.tsx` 1561 LOC
- Multi-filter batch checklist dialog opens for first item only (session 04-20 known follow-up)
- Cleaning-profile version pinning in offline cache (currently surfaces as sync error rather than pre-validated)

## Where to look next

- `future/backend/README.md` — backend module-by-module walkthrough
- `future/frontend/README.md` — frontend patterns (offline, permissions, themes)
- `future/qa/FEATURE_CHECKLIST.md` — what to verify, with how-to-verify steps
- Root `PHASE_5_RECENT_WORK.md` — full architectural breakdown of 2026-04-15..29 work
- Root `CHANGELOG.md` — release history through `[2.5.0]` 2026-04-25
