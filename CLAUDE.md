# compliance-core — CLAUDE.md

## Project
A 21 CFR Part 11 administration platform: users, roles, a hash-chained audit
trail, e-signature re-auth, notifications, and instrument monitoring
(MQTT ingest, telemetry, alarms, functional locations, floorplans).

**⚠ Much of THIS FILE is inherited from upstream DigiLog and still describes
things this fork does not have.** `docs/recreation/` was verified on 2026-07-25
at `cbcb913` and is superseded by the System Stats below for every count;
re-derive any count from live code before repeating it.

## Repository
- **Remote:** github.com/Controlytics/T-RH.git, remote name `trh` — **the ONLY push target since 2026-10-06** (operator: "from now on push to the new repo only"). `origin` = github.com/sivamunnangi1211/TRH_GGP.git is the OLD remote, frozen at that date. The AWS server's clone was repointed to T-RH on 2026-10-07 (its own deploy key `id_ed25519_trh`), `scripts/aws/provision-ubuntu.sh` `REPO_SSH` defaults to T-RH, and `deploy-to-aws.bat` checks `trh` (2026-10-12). `remote.pushDefault = trh` and `data-layer` tracks `trh/data-layer` in this checkout.
  The `pankajexa/21cfrlogbook` remote recorded here was upstream DigiLog's.
- **Active branch:** `data-layer` (this line said `data-injection` until 2026-10-06 — stale since 2026-08-29). There is no `main`; `final-user-management`
  is a FROZEN backup — do not commit to it.

## Monorepo Structure
```
apps/api/         — Fastify backend (TypeScript, port 3001)
apps/web/         — React SPA (Vite, port 5176 dev)
packages/shared/  — Permissions (44), reauth actions (55), sidebar items (14),
                    permission tree, zod schemas
packages/queue/   — graphile-worker job queue (Postgres-backed)
docs/             — Project docs; `docs/recreation/` is a 2026-07-25 snapshot (see above)
future/           — Forward-looking design notes
```
There is **no** `apps/android`, `rfid_scan_app` or `packages/db` in this fork —
verified `ls` 2026-08-20. There is no mobile app, RFID, offline sync or
Capacitor build; requests assuming them are describing upstream DigiLog.

## Local Dev Environment (Windows)
The app runs ONLY on local Windows for development. There is no live EC2 / Linux production environment to push to.
**Customer installers exist for BOTH platforms (2026-09-09):** Windows `Setup.exe`
(`scripts/build-installer.ps1`, Inno Setup) and an Ubuntu/Debian `.deb`
(`scripts/linux/build-deb.sh`, built by `.github/workflows/build-deb.yml` on a
GitHub runner because this laptop cannot build Linux native modules — no WSL, no
Docker, virtualization off). Both bundle Node, PostgreSQL 18 and EMQX 5.3.2 and
render the broker config from the ONE template set in `scripts/emqx/`. The .deb
is meant to be smoke-installed on the runner by the workflow — **but no `build-deb` run had ever succeeded before 2026-10-12** (tsc ran before `prisma generate`; fixed `b1730c2`, first green run not yet confirmed); the `Setup.exe` has never had
a CI install. `docs/deployment-methods/method-c-ubuntu-deb.md` is the runbook.

- Node.js **24.x** (pinned in root `package.json` `engines` + `.nvmrc` since 2026-10-05 — the `.deb` build refuses any other major and the Windows installer's Node zip must match the native-module ABI), PostgreSQL 18
- **No Redis dependency.** Phase 2 of windows-friendly-rewrite moved the job
  queue to graphile-worker on Postgres. Phase 4 (2026-05-01) retired Redis
  for pub/sub too (in-process EventEmitter bus); `ioredis` is no longer in
  package.json. Those pub/sub consumers (WebSocket events, pipeline tracing,
  debug recorder) were all torn out in Phase 6/7 — **but the `debug-traces`
  MODULE survives** (`apps/api/src/app.ts` imports `modules/debug-traces/routes.js`;
  `debug-traces` is a sidebar item): re-added 2026-06-12, it reads from
  `audit_trail`, not from a recorder — and the now-orphaned bus
  (`lib/internal-bus.ts`) was removed 2026-07-03 as dead code — there is no
  pub/sub layer anymore.
  **`@fastify/websocket` was NOT removed, or came back — this file said it was
  until 2026-08-24.** Verified against live code that day:
  `apps/api/package.json` has `"@fastify/websocket": "^11.3.0"`,
  `apps/api/src/app.ts:8` imports it and line 172 registers it
  (`maxPayload: 1MB`); it serves the instrument-ingest WebSocket at
  `/api/ingest/v1/ws`. Same failure mode as the `mqtt` claim below: a
  tear-out was recorded, later reversed, and the doc never re-synced. **Do not
  delete either as dead code on this file's say-so — grep `app.ts` first.**
  (The device-RPC correlation cache `lib/rpc-cache.ts` was removed 2026-07-01
  as dead code — its only consumer, the data-ingestion MQTT RPC handler, went
  in the Phase 7 tear-out.)
- **No TimescaleDB** (removed 2026-06-11..2026-06-17 — see Phase 7 below).
  `digilog_tsdb` database dropped, `packages/db` workspace deleted, `aedes` +
  `@types/pg` deps uninstalled, Mosquitto Windows service removed. 47
  transitive npm packages dropped with the cleanup. Both remain true —
  verified `ls packages/` (only `queue`, `shared`) and `grep aedes
  apps/api/package.json` (0 hits), 2026-08-24.
- **MQTT IS LIVE AGAIN — this file claimed the opposite until 2026-08-24.**
  The Phase 7 line above used to read "No TimescaleDB **or MQTT** dependency …
  `mqtt` + `aedes` … uninstalled". The `mqtt` half was reversed afterwards and
  the doc was never re-synced. Verified against live code 2026-08-24:
  `apps/api/package.json` carries `"mqtt": "^5.15.2"`; `apps/api/src/app.ts`
  registers `ingestRoutes` and `wsIngestRoutes` at `/api/ingest/v1` and imports
  `modules/instruments/mqtt-auth-routes.js`. The broker is EMQX 5.3.2 (see the
  EMQX memory entry), not Mosquitto.
  **`docs/recreation/06-api/endpoints.md` is CORRECT about the ingest surface**
  (`/api/ingest/v1/telemetry`, `/api/ingest/v1/mqtt-auth`, the TCP listener and
  the outbound broker subscription) — it was this file that was stale, not the
  dossier. Re-derive from `app.ts` before trusting either.
- Convenience: **`start-app.bat`** / **`stop-app.bat`** (wrappers around
  `scripts/start-app.ps1` / `stop-app.ps1`, which verify every dependency and
  are idempotent). This file said `start-digilog.bat` / `stop-digilog.bat`
  until 2026-08-24 — **those files do not exist** (`ls` → no such file); they
  were removed and renamed, and `docs/deployment-methods/method-a-native-windows.md`
  already records that. Fifth stale claim found in this file on 2026-08-24.
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
```

## Default Login
- **Username:** `superadmin`
- **Password:** on THIS machine it is `Admin@123` — verified 2026-08-24 by
  POSTing it to `/api/auth/login`, which returned **409 SESSION_CONFLICT**
  (credentials accepted; refused only because a session was already open).
  (`apps/api/scripts/demo-live-scenario.ts` used to hardcode the same value; it and three
  sibling probe scripts called `prisma.alarmRule`, removed 2026-08-31, and were deleted
  2026-10-05 — audit DOCS-3. `apps/api/scripts/` is type-checked by `npm run lint` now.)
  **But it is not a repo default** — it is whatever `INITIAL_ADMIN_PASSWORD`
  was set to when this database was seeded, and a fresh seed elsewhere will
  have a different one. **There is NO forced change on first login**; that half
  of the old line was simply wrong. Verified against
  `apps/api/prisma/seed.ts` (and the bundled `seed.mjs`, which matches):
  - `const defaultPassword = process.env.INITIAL_ADMIN_PASSWORD;` and, if it is
    unset, seeding **throws** — `FATAL: INITIAL_ADMIN_PASSWORD env var must be
    set for seeding. Cannot use hardcoded default.` So a seed can never have
    produced `Admin@123` unless someone passed it deliberately.
  - `forcePasswordChange: false` on both seeded users (seed.ts:85, :95).
  If you don't know the password for an existing database, reset it rather than
  guessing from this file.

## Key Local URLs
**Corrected 2026-08-24 — this section said 5175 / 3000 and contradicted line 20
of this same file, which says 3001.** `apps/api/.env` is the authority:
`PORT=3001`, `API_HTTPS=true`.
- App: **https://localhost:5176** — and only if `WEB_PORT=5176` is set.
  `apps/web/vite.config.ts` defaults to **5175** and proxies `/api` to
  **https://localhost:3000**, which is the *sibling DigiLog checkout's* backend.
  A bare `npx vite` here therefore serves an app that looks fine while reading
  the wrong database. Set `WEB_PORT=5176 API_PROXY_TARGET=https://localhost:3001`,
  or use `start-app.bat`, which sets both.
- API: **https://localhost:3001** — `API_HTTPS=true` in `apps/api/.env` (mkcert certs at `certs/server.{key,crt}`)
- **`certs/server.crt` is NOT signed by `certs/rootCA.pem`.** This file claimed it was until 2026-08-06, and that false line cost two agents an investigation each into a "broken chain" that was never broken. Verified:
  - `certs/server.crt` issuer → `O=mkcert development CA` — the CA to trust is **`%LOCALAPPDATA%\mkcert\rootCA.pem`**, and `openssl verify -CAfile` against it returns OK.
  - `certs/rootCA.pem` is a separate hand-rolled `CN=DigiLog Root CA` that signs nothing currently in use. `openssl verify` against it fails with `error 20 … unable to get local issuer certificate`.
  - Second red herring: `curl` on Windows uses Schannel and rejects valid local chains with `exit 60` / "revocation status is unknown" unless given `--ssl-revoke-best-effort`. An exit 60 here is not evidence of a bad chain.
- Swagger: https://localhost:3001/docs

### TLS notes
- *(An "APK requires HTTPS" bullet stood here until 2026-10-05. There is no Capacitor build, APK or tablet in this fork — `ls apps/` is `api`, `web` — so it was deleted as a self-contradiction; `apps/web/.env.production` is still tracked blank and still only matters to a build that bakes `VITE_API_URL`.)*
- **Browser dev** — `http://localhost:5176 → https://localhost:3001` is fine (browser allows it; no mixed-content issue for fetch).
- **Verify TLS up** — `curl -sk --ssl-revoke-best-effort -o /dev/null -w "%{http_code}" https://localhost:3001/api/system-health` should return a code (401 is a pass — TLS terminated and the route rejected an unauthenticated call). **CORRECTED 2026-08-29: `/api/health` DOES exist and is load-bearing.** This file said "There is no `/health` route" on the evidence of `grep "get('/health'"` → 0 hits. That pattern could never have matched: the route is registered at `app.ts:297` as `app.get('/api/health', ...)`, top level, with no prefix. It is the deploy and installer health probe (`scripts/aws/deploy-on-ubuntu.sh`, `scripts/install.ps1`, `scripts/upgrade.ps1`, `scripts/linux/digilog-lib.sh`, `.github/workflows/build-deb.yml`), and `app.ts` deliberately returns 200 even when the job runner is down — and its `PUBLIC_PATHS` entry is REQUIRED. (It was also the tablet liveness probe via `apps/web/src/lib/connectivity.ts probeServer`; that file was deleted in `a92ca5d`, 2026-07-18, and this line said otherwise until 2026-10-12.) The 2026-08-29 audit repeated this claim as finding L1 and an agent began removing the allowlist entry before catching it. **A 0-hit grep is evidence only if the pattern could have matched.**

## System Stats (re-derived 2026-08-27 — every number below came from the command beside it)
- **Backend:** **25** API modules under `apps/api/src/modules/` (`ls | wc -l`).
  24 → 25 (2026-09-07): `report-reviews`, the report review workflow.
  23 → 24 (2026-08-27): `alarm-webhooks`, the alarm annunciator.
- **Database:** **37 Prisma models, 13 enums** (36/13 → 37/13 on 2026-09-22: `FloorplanRoomLink`, migration `20260922120000_floorplan_polygons_links`; the link `kind` is a validated string, NOT an enum — see the Layout Designer note) (35/12 → 36/13 on 2026-09-07: `ReportReview` + `ReportReviewStatus`, migration `20260907120000_report_reviews`) (36/13 → 35/12 on 2026-08-31: `AlarmRule` + `AlarmComparison` removed with the alarm-rules feature) (`grep -cE "^model " / "^enum "`).
  34 → 36 (2026-08-27): `AlarmWebhookTarget` + `AlarmWebhookDelivery`
  (migration `20260827120000_alarm_webhooks`). **The enum count did NOT move** —
  that target's `method`, `event` and `status` are validated strings, the same
  deliberate precedent as `FloorplanRoom.grade` below, so the vocabulary can
  grow without a migration. Do not go looking for a new Postgres enum.
  Earlier: unchanged by the 2026-08-24 doors/grade work — both landed as nullable
  columns on the existing `FloorplanRoom` model (`doors Json?`, `grade
  String?`; migrations `20260824100000_floorplan_room_doors` and
  `20260824140000_floorplan_room_grade`), not new models. `grade` is
  deliberately a plain validated string, not a Postgres enum, so the
  vocabulary (`A|B|C|D|CIRCULATION|UTILITY`) can grow without a migration —
  the enum count stays at 13 on purpose.
  Only `compliance_core_db` + `compliance_core_db_test` exist — **no TimescaleDB,
  no `digilog_tsdb`**. The test database is migrated **separately**; a migration
  applied to only one of them makes every instrument-touching e2e 500.
- **Permissions:** **44** constants, **55** reauth actions in **8** categories,
  **14** sidebar items (`grep -cE` against `permissions.ts` / `reauth-actions.ts`
  / `sidebar-items.ts`). 50 → 55 reauth actions (2026-10-05, audit SEC-7):
  `CREATE_INSTRUMENT` / `UPDATE_INSTRUMENT` / `DELETE_INSTRUMENT` /
  `UPDATE_INSTRUMENT_PROFILE` / `DELETE_INSTRUMENT_PROFILE` under the EXISTING
  `Configuration` category, gating the five registry mutations; ships OFF like
  every entry. 15 → 14 sidebar items (2026-09-19): `home`, the Module
  Guide, removed with its page and its API route — see the Home removal note.
  Earlier 14 → 15 sidebar items (2026-09-08): `settings`, every
  instrument's details and attributes in one table — see the Settings note; no
  permission or reauth action moved. 42 → 44 permissions (`REPORT_REVIEW_READ`,
  `REPORT_REVIEW_APPROVE`), 48 → 50 reauth actions (`APPROVE_REPORT`,
  `REJECT_REPORT`, existing `Reports` category) and 13 → 14 sidebar items
  (`reports`) on 2026-09-07 with the report review workflow — see that note. 12 → 13 sidebar items (2026-09-07): `data-report`, the
  Instrument History widget's own page — see the Data Report note below; no
  permission or reauth action moved. 47 → 48 (2026-08-27): `MANAGE_ALARM_WEBHOOK` added under
  the EXISTING `Configuration` category (categories stay at 8). **No permission
  and no sidebar item was added** — the alarm webhooks surface reuses
  `ALARM_RULE_READ` / `ALARM_RULE_MANAGE` and lives under Config.
  Earlier: 46 → 47 (2026-08-24): `DOWNLOAD_REPORT` added under a
  new `Reports` category (7 → 8 categories) to govern report/audit-export
  downloads; no permission or sidebar item was added for it.
  The "102 / 83 / 92 / 26" this file carried for months was upstream DigiLog's and
  was never true here.
- **Audit registries:** **89** audit actions, **102** audit templates in **7**
  categories (106 → 89 / 100 → 102 on 2026-10-05, audit DATA-10: the 11 actions
  written but never registered — `AUDIT_RECORD_REDACTED`,
  `AUDIT_RECORDS_BULK_REDACTED`, `ROLE_CREATED/UPDATED/DELETED`,
  `ADMIN_REQUEST_SUBMITTED`, `LDAP_CONFIG_UPDATED`,
  `SUPER_ADMIN_API_ACCESS_CHANGED`, `UPDATE_EMAIL_CONFIG`, `UPDATE_SMS_CONFIG`,
  `DASHBOARD_CREATED` — were added and the 28 registered but never written by
  any code in the tree were removed, `RETENTION_EXECUTED` kept because the
  retention task now writes it; templates lost the two of those 28 that had
  one (`ALARM_CLEARED`, `DATA_EXPORTED`) and gained the three
  `INSTRUMENT_PROFILE_*` plus `RETENTION_EXECUTED`; a unit test in
  `apps/api/src/lib/__tests__/audit-actions-registry.test.ts` now pins every
  `action: '…'` literal under `apps/api/src` to the registry, and
  `packages/shared/src/types/audit-actions.test.ts` pins every registry key to
  a template; categories unchanged). Earlier: **106** / **100** in **7**
  categories (103 → 106 / 97 → 100 on 2026-09-22: `FLOORPLAN_LINK_CREATED` /
  `UPDATED` / `DELETED`, the Layout Designer's room links; categories
  unchanged). Earlier: **103** / **97** in **7**
  categories (102 → 103 / 96 → 97 on 2026-09-21: `ALARMS_PURGED`, written only by
  `apps/api/scripts/purge-alarms.ts`; categories unchanged). Earlier: **102** / **96** in **7**
  categories (98 → 102 / 92 → 96 on 2026-09-07: `REPORT_REVIEW_REQUESTED` /
  `APPROVED` / `REJECTED`, `REPORT_DOWNLOADED`; categories unchanged). Earlier: **98** / **92** in **7**
  categories (97 → 98 / 91 → 92 on 2026-09-05: `INSTRUMENT_ATTRIBUTE_REPORTED`,
  a SYSTEM action — no user — for an attribute a DEVICE wrote over MQTT;
  re-derived by the two greps in the verification block). Earlier: **97** / **91** in **7**
  categories. 93 → 97 / 87 → 91 (2026-08-27): create / update / delete / test
  for alarm webhook targets; categories unchanged.
- **Config:** **35** definitions (`config/defs/*.def.ts`) + auto-discovery (34 → 35 on
  2026-10-05: `telemetry-retention.def.ts` — the partition schedule the worker
  had read for months with NO def behind it (audit DATA-9); SUPER_ADMIN card,
  dynamic page, page count unchanged. 33 → 34 on
  2026-10-01: `sensor-offsets.def.ts` — the per-instrument reading correction;
  SUPER_ADMIN card, dynamic page. 32 → 33 on
  2026-10-01: `report-downloads.def.ts` — per report type Direct / Request, remarks
  and password; SUPER_ADMIN card, dynamic page, page count unchanged. 31 → 32 on
  2026-09-16: `attribute-labels.def.ts` — what each instrument attribute KEY is CALLED
  on screen; NO page of its own — edited as a column on the Instrument Attributes
  page, see the Attribute Display Names note. 30 → 31 on
  2026-09-07: `report-approvers.def.ts` — which roles may APPROVE a report; renders
  through the dynamic config page with a `superAdminCards` card, so the page count
  did NOT move; first def to use `dynamicOptionsSource`. 29 → 30 on
  2026-09-01: `trend-widgets.def.ts` — what every widget on the instrument trend
  page is CALLED, and how each prints a date and a time. Rendered by the dynamic
  config page, so the page count did NOT move; it also gets a hardcoded
  `superAdminCards` card, which is a card, not a file under `routes/config/`.
  28 → 29 on 2026-08-31: `alarm-type-names.def.ts`; 27 → 28 on
  2026-08-31: `sensor-range-alarms.def.ts`, the fifth alarm source; 26 → 27 on
  2026-08-31: `rs485-alarms.def.ts`, the fourth alarm source; 25 → 26 the same day:
  `inactivity-alarms.def.ts`),
  **22** pages under `apps/web/src/routes/config/` (23 → 22 on 2026-10-05: `alarm-rule-dialog.tsx` DELETED — dead since the 2026-08-31 alarm-rules removal and never a page, but `ls *.tsx` counted it; audit WEB-8; 22 → 23 on 2026-10-01: `report-settings.tsx`, Report Approvers + Report Downloads on one page; 23 → 22 on 2026-09-22: `floorplans.tsx`
  DELETED, replaced by the `layout-designer/` FOLDER at the same route — `ls *.tsx`
  counts files, so the count moved while the `<Route` count did not; an `attribute-labels.tsx` existed
  for a few hours on 2026-09-16 and was folded into `instrument-attributes.tsx` at
  the operator's direction — the count did NOT move; 24 -> 23 on 2026-08-31 with the
  alarm-rules removal — **this line and the duplicate at "Config:" below both still
  read 24 on 2026-09-01 and were corrected then. They were ALREADY STALE; the
  severity removal that day moved no count.** Earlier 25 -> 24 on 2026-08-28:
  `dashboard-cards.tsx` deleted with the panel-assignment work; that surface is
  now a tab inside `role-access.tsx`). 24 → 25 (2026-08-27):
  `alarm-webhooks.tsx`. **The def count did NOT move** — alarm webhooks are a
  real CRUD module with their own tables, not a `system_config` row, so there
  is no `*.def.ts` for them.
- **Frontend:** **53** `<Route`s in `main.tsx` (52 → 53, 2026-10-01: `/config/report-settings`; 53 → 52, 2026-09-19: `/home`, the
  Module Guide, removed with the `home` sidebar item; a `/config/attribute-labels` route existed for a few hours on 2026-09-16 and was removed the same day — unchanged; 52 → 53, 2026-09-08: `/settings`; 51 → 52, 2026-09-07: `/reports`; 50 → 51 the same day: `/data-report`) (51 → 50, 2026-08-31: `/config/alarm-rules` removed with the rule feature) (50 → 51, 2026-08-29: `/config/export-options`, a page that had a config def and a dashboard card but no route, so it was unreachable. Earlier 49 → 50, 2026-08-27:
  `/config/alarm-webhooks`).
- **Queue backend:** graphile-worker (Postgres-backed), **6** tasks.
- **Tenancy:** single-tenant, single-site. JWT `scope` always stamps `GLOBAL`.
- **Themes:** 10 preset colour themes.

Per-removal history has been moved out of this section — it is history, not an
inventory, and the two long paragraphs that used to live here were inherited
from upstream DigiLog and disagreed with the tree. `CHANGELOG.md` holds the
history; `docs/recreation/` holds the inventory.

## Feature notes — MOVED to `docs/feature-notes.md`

The per-feature decision notes (and the Key API Endpoints block) that used to fill this file
were moved verbatim to [`docs/feature-notes.md`](docs/feature-notes.md) on 2026-10-07 because
this file exceeded the 150k-char load limit. **Before changing any of the areas below, read its
note there** — most record an operator decision or a trap that is not visible in the code.
Add NEW feature notes there, not here; keep this file to project-wide rules and live counts.

Topics: Instrument VISIBILITY · LAYOUT DESIGNER · The MQTT client id and topic segment are the instrument CODE · A SUPER_ADMIN can DELETE a functional location WITH everything in it · Instrument grouping — THREE concepts, one job each · Config · Display precision · Instrument ATTRIBUTE ACCESS · Themes · Frontend · Queue backend · Tenancy · Inactivity alarms — a THIRD alarm source · RS485 sensor-failure alarms — a FOURTH alarm source · Alarm RULES were REMOVED · A QUOTED number is a reading · Alarm type NAMES are administered in one place · Instrument-limit bounds honour a per-bound ENABLE attribute · Sensor RANGE alarms — a FIFTH alarm source · Trend page widget wording is ADMINISTERED, and editable in place · The browser TAB is named and iconned from config · Boolean config settings render as an on/off TOGGLE, not a checkbox · Alarms page: the counts were window-limited, and are not any more · Dashboard: the readings table shows Area and Location — there is NO Ro · REPORT REVIEW WORKFLOW · Which roles may APPROVE a report is ADMINISTERED · REPORT DOWNLOADS ARE CONFIGURED PER TYPE, APPROVERS ARE CONFIGURED, AN · SENSOR OFFSETS · ATTRIBUTE DISPLAY NAMES · The New Instrument form's Instrument ID field carries NO pattern, hint · The HOME sidebar item and the Module Guide page are GONE · SETTINGS: one instrument picker, one square widget of its identity, · The Instrument ID · The Instrument History widget is the DATA REPORT PAGE, not a dashboard · The dashboard's selection alarms panel is the SHARED alarm table · On `PUT /api/floorplans/:id/rooms/:roomId`, an omitted `doors` key lea · Room doors · Per-instrument tiles · Cleanroom grade · The QC floor is TRACED, not generated · MEAN KINETIC TEMPERATURE on the Data Report, per instrument · The Time Series widget's download is the DATA REPORT · Instrument trend page · Governed report downloads · Fixed a pre-existing security gap · Alarm webhook annunciator · Trend page: wide ranges are SAMPLED, and the range figures are true


## Important Notes
- One Prisma database per install, and no TimescaleDB (`digilog_tsdb` was dropped 2026-06-11 with the data-ingestion tear-out). On THIS checkout it is `compliance_core_db` (+ `compliance_core_db_test` for vitest) — see Key Local URLs; the customer installer provisions it as `digilog_db` (`scripts/provision-db.ps1` `$AppDb` default), which is the name the deployment docs use. This line said "Only one database now: `digilog_db`" until 2026-10-05 and contradicted the Key Local URLs section.
- Input sanitization strips HTML on all text fields (`apps/api/src/lib/sanitize.ts`)
- Light theme only — `bg-white`, `bg-slate-50`, `border-slate-200`, gradient dialog headers OK
- **Sidebar RBAC redesign (2026-06-30):** `packages/shared/src/types/permission-tree.ts`
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
- Approval/decision flows require remarks


## Filter domain — REMOVED

The DigiLog cleanroom domain (filters, AHUs, assets, cleaning cycles,
checklists, PM/replacement schedules, RFID, equipment groups) does not exist in
this fork. Its modules, models and pages went in the Phase 0 strip
(2026-07-18); its remaining vocabulary — shared types, config lists, audit
registries, two Postgres enums — went 2026-08-20. See `CHANGELOG.md`.

A request that assumes any of it is describing *DigiLog*, not this repo. Restore
points: tags `pre-domain-strip` and `pre-filter-domain-strip`.

## Documentation Sync Rule

**Hard rule:** every numerical claim in any doc must be backed by a `grep`/`ls` against live code at the moment the doc is touched. Don't trust prior docs — verify.

**Active doc set** (kept current together):
- Root: `README`, `CLAUDE`, `AGENTS`, `CHANGELOG`, `PROJECT_SUMMARY`, `PROJECT_ARCHITECTURE`, `BACKEND_GUIDE`, `FRONTEND_GUIDE`, `DEPLOY-WINDOWS`, `LOCAL_SETUP_WINDOWS`, `windowsIssues` (`API_REFERENCE.md` is a POINTER since 2026-10-05 — the live Swagger UI and `docs/recreation/06-api/endpoints.md` are the reference; the old hand-written file is `docs/archive/API_REFERENCE-2026-08-24.md`)
  (**`PROJECT_ARCHITECTURE.md` and `PROJECT_SUMMARY.md` were REWRITTEN 2026-08-29** — audit finding M6. The previous versions are `docs/archive/PROJECT_{ARCHITECTURE,SUMMARY}-2026-07-04.md`. Between them they documented an `apps/android/` Capacitor wrapper, an `rfid_scan_app/` Kotlin scanner and a committed `rfid-key.jks` signing keystore, none of which exist here — the keystore line in particular manufactured a security incident for anyone who read it. Both carried drift-warning banners, and `PROJECT_SUMMARY.md` contradicted its own banner forty lines later by listing `rfid_scan_app/` in its directory tree. A banner over false content is not a fix. `bloat.md` was archived the same day for the same reason: an optimisation audit of `routes/mobile/`, a folder that does not exist, sitting at the repository root.)
  (`OFFLINE_SYNC_ARCHITECTURE.md` moved to `docs/archive/` the same day — it described an
  IndexedDB offline queue, a Capacitor APK and `cleaning_cycles`/`filter_events`, none of
  which exist here; it was read first and held no unique knowledge worth extracting.
  `PHASE_5_RECENT_WORK.md` moved to `docs/archive/PHASE_5_RECENT_WORK.md` — it described
  the removed filter/RFID/reports domain end to end; its three still-useful lessons were
  extracted into `apps/api/src/modules/backup/backup.repository.ts`, `apps/api/CLAUDE.md`,
  and this file's "Never" section before the move)
- Per-package: `apps/{api,web}/{CLAUDE,DECISIONS}.md`, `packages/shared/CLAUDE.md`
- `docs/feature-notes.md` — the per-feature decision notes moved out of this file 2026-10-07
- Reference: `docs/`, `future/`, `tasks/todo.md`, `PROJECT_HANDOVER/`
- **NOT current, kept for the record:** `docs/archive/` — see its README. Archived rather
  than deleted because CONTRIBUTING's receipts show a bulk delete of `future/` was reverted
  twice. Never cite anything in there as evidence about today's system.

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

**Always-update on any feature change:** `CHANGELOG.md`, memory after corrections, `tasks/todo.md` audit-log entry for non-trivial doc work.

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
- Never reconstruct server-side decision logic in the client. This fork's
  offline-cache rewrite (rescued from the now-archived `PHASE_5_RECENT_WORK.md`)
  hit this the hard way: the client walked the pipeline-state graph itself to
  figure out "what's next" and missed chained nodes the server would have
  caught, causing drift bugs between what the UI showed and what the server
  actually allowed. The fix was to cache the server's own response verbatim
  and replay it, never re-derive it. The current codebase follows the same
  principle deliberately — e.g. instrument display-decimal precision and
  attribute-edit permission are resolved once server-side
  (`@digilog/shared/telemetry-decimals`, `modules/instruments/attribute-access.ts`)
  and ride on the API payload; nothing in the browser re-derives either. If a
  UI needs a policy decision (what's allowed, what's next, how to format a
  §11 record), fetch or cache the server's answer — don't recompute it.

## Correctness
- before editing the code fnd and list all the touch point this code change will effect, after code change, test all touch points, if you find a bug, fix it even if it not in your scope, only then consider the task done.
- Find root causes. No temporary fixes, no swallowing symptoms.
-be brutally honest

## Multi-session work
- For tasks spanning multiple sessions or 5+ steps, maintain `tasks/todo.md` 
  with checkable items. Skip this for smaller tasks.
