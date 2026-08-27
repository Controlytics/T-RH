# compliance-core — CLAUDE.md

## Project
A 21 CFR Part 11 administration platform: users, roles, a hash-chained audit
trail, e-signature re-auth, notifications, and instrument monitoring
(MQTT ingest, telemetry, alarms, functional locations, floorplans).

**⚠ Much of THIS FILE is inherited from upstream DigiLog and still describes
things this fork does not have.** `docs/recreation/` is the verified inventory;
re-derive any count from live code before repeating it.

## Repository
- **Remote:** github.com/sivamunnangi1211/TRH_GGP.git (`git remote -v`, 2026-08-20).
  The `pankajexa/21cfrlogbook` remote recorded here was upstream DigiLog's.
- **Active branch:** `data-injection`. There is no `main`; `final-user-management`
  is a FROZEN backup — do not commit to it.

## Monorepo Structure
```
apps/api/         — Fastify backend (TypeScript, port 3001)
apps/web/         — React SPA (Vite, port 5176 dev)
packages/shared/  — Permissions (42), reauth actions (48), sidebar items (12),
                    permission tree, zod schemas
packages/queue/   — graphile-worker job queue (Postgres-backed)
docs/             — Project docs; `docs/recreation/` is the verified inventory
future/           — Forward-looking design notes
```
There is **no** `apps/android`, `rfid_scan_app` or `packages/db` in this fork —
verified `ls` 2026-08-20. There is no mobile app, RFID, offline sync or
Capacitor build; requests assuming them are describing upstream DigiLog.

## Local Dev Environment (Windows)
The app runs ONLY on local Windows for development. There is no live EC2 / Linux production environment to push to.

- Node.js 20+, PostgreSQL 18
- **No Redis dependency.** Phase 2 of windows-friendly-rewrite moved the job
  queue to graphile-worker on Postgres. Phase 4 (2026-05-01) retired Redis
  for pub/sub too (in-process EventEmitter bus); `ioredis` is no longer in
  package.json. Those pub/sub consumers (WebSocket events, pipeline tracing,
  debug recorder) were all torn out in Phase 6/7, and the now-orphaned bus
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
  `apps/api/scripts/demo-live-scenario.ts` hardcodes the same value.
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
- **APK requires HTTPS** — plain HTTP causes a Capacitor TLS parse error on login. Tablet must trust `rootCA.pem` (Settings → Security → Install certificate). `apps/web/.env.production` is **`skip-worktree` and tracked blank** on purpose (no dev's IP in the repo); it is set locally only (currently `https://192.168.1.53:3000`, = this PC's static IP). **The baked value only affects a FRESH install** — `getApiBase()` (`apps/web/src/lib/api-base.ts`) reads `localStorage['digilog.serverUrl']` FIRST, so a tablet with an existing Server Address keeps using it across APK updates; change it on-device. See the network IP-change runbook in memory.
- **Browser dev** — `http://localhost:5176 → https://localhost:3001` is fine (browser allows it; no mixed-content issue for fetch).
- **Verify TLS up** — `curl -sk --ssl-revoke-best-effort -o /dev/null -w "%{http_code}" https://localhost:3001/api/system-health` should return a code (401 is a pass — TLS terminated and the route rejected an unauthenticated call). **There is no `/health` route** (`grep "get('/health'" apps/api/src` → 0 hits); this line pointed at one until 2026-08-24, so a 404 was being read as evidence of anything at all.
- **Don't use HTTPS with self-signed in Capacitor *dev* mode** — WebView's `fetch()` rejects self-signed certs (Capacitor's `BridgeActivity` overrides the WebViewClient after `onCreate`). Keep dev cleartext if testing in-WebView, or install root CA on the device.

## System Stats (re-derived 2026-08-27 — every number below came from the command beside it)
- **Backend:** **24** API modules under `apps/api/src/modules/` (`ls | wc -l`).
  23 → 24 (2026-08-27): `alarm-webhooks`, the alarm annunciator.
- **Database:** **36 Prisma models, 13 enums** (`grep -cE "^model " / "^enum "`).
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
- **Permissions:** **42** constants, **48** reauth actions in **8** categories,
  **12** sidebar items (`grep -cE` against `permissions.ts` / `reauth-actions.ts`
  / `sidebar-items.ts`). 47 → 48 (2026-08-27): `MANAGE_ALARM_WEBHOOK` added under
  the EXISTING `Configuration` category (categories stay at 8). **No permission
  and no sidebar item was added** — the alarm webhooks surface reuses
  `ALARM_RULE_READ` / `ALARM_RULE_MANAGE` and lives under Config.
  Earlier: 46 → 47 (2026-08-24): `DOWNLOAD_REPORT` added under a
  new `Reports` category (7 → 8 categories) to govern report/audit-export
  downloads; no permission or sidebar item was added for it.
  The "102 / 83 / 92 / 26" this file carried for months was upstream DigiLog's and
  was never true here.
- **Audit registries:** **97** audit actions, **91** audit templates in **7**
  categories. 93 → 97 / 87 → 91 (2026-08-27): create / update / delete / test
  for alarm webhook targets; categories unchanged.
- **Config:** **25** definitions (`config/defs/*.def.ts`) + auto-discovery,
  **25** pages under `apps/web/src/routes/config/`. 24 → 25 (2026-08-27):
  `alarm-webhooks.tsx`. **The def count did NOT move** — alarm webhooks are a
  real CRUD module with their own tables, not a `system_config` row, so there
  is no `*.def.ts` for them.
- **Frontend:** **50** `<Route`s in `main.tsx` (49 → 50, 2026-08-27:
  `/config/alarm-webhooks`).
- **Queue backend:** graphile-worker (Postgres-backed), **6** tasks.
- **Tenancy:** single-tenant, single-site. JWT `scope` always stamps `GLOBAL`.
- **Themes:** 10 preset colour themes.

Per-removal history has been moved out of this section — it is history, not an
inventory, and the two long paragraphs that used to live here were inherited
from upstream DigiLog and disagreed with the tree. `CHANGELOG.md` holds the
history; `docs/recreation/` holds the inventory.

- **Instrument VISIBILITY (2026-08-13, project D).** `instrument_scope` JSONB on **both** `role_configs` and `user_configs`. **`NULL` = inherit (user → role → unrestricted); `[]` = SEE NOTHING; `[ids]` = those functional locations, Blocks expanding to their Areas.** Resolved once in `modules/instruments/visibility.ts`; a user scope REPLACES the role's and can widen it. Enforced **on the query** — the list merges it into the same `where` the count uses, `GET /:id` applies it in the lookup and 404s (never 403, which would confirm existence), and the overview ANDs selection with visibility. Unassigned instruments are invisible to any active scope. Writing a NULL needs `Prisma.DbNull`, never `JsonNull`. Admin surface: Config → Roles & Access → Instrument Scope. Prove behaviour with `apps/api/scripts/probe-visibility.ts`.
- **Instrument grouping — THREE concepts, one job each (2026-08-13).** Do not confuse them: **`FunctionalLocation`** (Block > Area tree, `Instrument.functionalLocationId`) is the AUTHORITATIVE logical grouping; **`roomId`** → `FloorplanRoom` is geometry on a drawn plan and drives the graphical view; **`profileId`** is device type. The free-text `Instrument.block` / `.area` columns are SUPERSEDED — no longer read for grouping, kept only so the migration stays comparable. A Block's instruments are its own PLUS its Areas', resolved by `functional-locations/tree.ts:resolveLocationIds()`; querying `functionalLocationId = :id` directly silently omits the Areas.
- **Config:** **25 definitions** (`apps/api/src/modules/config/defs/*.def.ts`) + auto-discovery, **25** corresponding pages (defs verified `ls` 2026-08-27, unchanged; pages 24 → 25 on 2026-08-27 — `routes/config/alarm-webhooks.tsx`, which has no def of its own because alarm webhooks are a CRUD module, not a `system_config` row. Earlier: pages 25 → 24 the same day — `routes/config/role-assignments.tsx` deleted as dead code: its 7 config defs went in the Phase 0 strip and `system_config` held 0 rows for them, so every section read an unregistered `/api/config/dynamic/<key>` route. Earlier counts VERIFIED by `ls` 2026-08-17 — `alarm-limits.def.ts` added 2026-08-17: super-admin config for the instrument-limit alarm work — an ordered alias list of attribute keys per bound (High/Low Temperature/Humidity Limit), since this install's keys have already drifted; plus severity, a master switch, and four status wordings. Renders through the dynamic config page, so no `routes/config/*.tsx` of its own — the page count stays 25. The "23 corresponding pages" recorded here 2026-08-11 was already stale before this change (the live page count was 25, per `apps/web/CLAUDE.md`'s 2026-08-14 verification); it was never re-synced here until now. Earlier: `telemetry-slots.def.ts` added 2026-08-11: which telemetry keys the dashboard reads as temperature and humidity, since ingest stores whatever key a device sends. Renders through the dynamic config page, so no `routes/config/*.tsx` of its own; the Floorplans placement editor IS a page. Earlier counts VERIFIED by `ls` 2026-08-07 — the previous "36 / 34" was inherited from DigiLog and was never true in this fork; `instrument-attributes.def.ts` added 2026-08-07 — the attribute keys the New Instrument form asks for, renders via the dynamic config page so no new `routes/config/*.tsx`)
- **Display precision (2026-08-19):** decimal places for temperature/humidity come from each
  INSTRUMENT's own attributes — `temp_decimals` / `humid_decimals`, `0` meaning whole numbers —
  NOT from a site-wide setting. The two numbers left in `telemetry-slots` are only the fallback
  for an instrument declaring neither; the two alias lists beside them name the attribute keys.
  Resolution is server-side (`@digilog/shared/telemetry-decimals` + `modules/instruments/decimals.ts`)
  and rides on the telemetry payloads, so nothing in the browser re-derives it. Alarms FREEZE the
  precision onto `ruleSnapshot.decimals` at raise time — a §11 record must read back the way it was
  seen. Counts unchanged: no new def (25), page (25), module (23), model (34) or enum (13).
- **Instrument ATTRIBUTE ACCESS (2026-08-19).** `role_configs.attribute_access` JSONB, nullable.
  **NULL = inherit = the pre-2026-08-19 behaviour (editable iff the role holds `INSTRUMENT_UPDATE`);
  `ALL_EDIT`; `ALL_VIEW`; `SELECTED` + `keys[]`.** Plus `requireReauth` per role. The rule NARROWS
  `INSTRUMENT_UPDATE` and never widens it — a role without it is read-only whatever is stored.
  Editable covers change, add and delete; SELECTED still permits ADDING a new key (it cannot
  overwrite a protected one). Decisions live in `@digilog/shared/attribute-access` and are enforced
  by ONE gate (`modules/instruments/attribute-access.ts`) shared by POST/PUT/DELETE; the panel only
  renders what that allows. **Changing or deleting an attribute now REQUIRES a `reason`** (audit
  `reason` column; a first fill does not). Admin surface: Config → Roles & Access → Attribute Access.
  Migration `20260819120000_role_attribute_access`, drift guard PASS, applied to both databases.
- **Themes:** 10 preset color themes (Ocean / Sapphire / Emerald / Amethyst / Sunset / Slate / Ruby / Forest / Midnight / Coral)
- **Frontend:** **50** Routes in `main.tsx` (verified `grep -cE "<Route"` 2026-08-27 — 49 → 50: new `/config/alarm-webhooks` page; earlier 48 → 49 on 2026-08-24: the `/instruments/:id/trend` page; the "77" was inherited from upstream DigiLog and was never true in this fork; `/config/role-assignments` removed 2026-08-19 as dead code, 49 → 48), **18** custom hooks, **18** lib modules (`ls apps/web/src/hooks/ | wc -l` / `ls apps/web/src/lib/ | wc -l`, each including its own `__tests__` subfolder as one entry — the "26 / 30" this file carried for months was never true against the live tree and was never re-verified until now)
- **Queue backend:** graphile-worker (Postgres-backed); **6** worker tasks —
  `notification`, `password_expiry_check`, `session_sweep`,
  `telemetry_partition_maintenance`, `alarm_evaluation`, `alarm_webhook`
  (verified 2026-08-27 against the `taskList` in `apps/api/src/app.ts:458-489`;
  5 → 6 that day). `alarm_webhook` is **event-driven and deliberately has NO
  `crontab.txt` entry** — a scheduled buzz would announce an excursion that has
  already gone. A task identifier with no handler leaks jobs forever, so if you
  ever remove the handler, remove the enqueue with it. This file listed
  "3 tasks (`notification`, `pm_overdue_check`, `session_sweep`)" until then;
  **`pm_overdue_check` does not exist anywhere in the tree** (`grep -r
  pm_overdue_check apps/api/src packages/` → 0 hits) — it was the filter
  domain's PM scheduler and went with that strip. Re-derive from the
  `taskList` literal, never from this line.
- **Tenancy:** **single-tenant, single-site, single-company.** Multi-tenancy was removed 2026-04-30 (`Organization` model + `organizationId` columns + `org-admin`/`tenant-admin` modules dropped). JWT `scope` always stamps `GLOBAL`. The `RoleScope` enum and `AssigneeType` enum are retained but trimmed to one/two values respectively.

## Important Notes
- Only one database now: `digilog_db` (Prisma). TimescaleDB (`digilog_tsdb`) was dropped 2026-06-11 with the data-ingestion tear-out.
- Input sanitization strips HTML on all text fields (`apps/api/src/lib/sanitize.ts`)
- Capacitor APK uses **HTTPS** baked at build via `VITE_API_URL` (cert install required on tablet)
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

## Key API Endpoints (instrument dashboard — updated 2026-08-27)
```
GET  /api/instruments/telemetry-overview        — every instrument's current temp + RH, one request
GET  /api/instruments/:id/telemetry?from=&to=&offset=  — per-instrument history, paged (offset added 2026-08-24)
GET  /api/instruments/:id/telemetry-keys        — distinct telemetry keys this instrument has sent (added 2026-08-24)
GET  /api/floorplans                            — plans + their rooms (rooms now carry `doors` + `grade`, 2026-08-24)
GET  /api/floorplans/:id                        — one plan, rooms, and the instruments in each
POST/PUT/DELETE /api/floorplans[/:id]           — plan CRUD (CONFIG_UPDATE + reauth, audited)
POST/PUT/DELETE /api/floorplans/:id/rooms[/:roomId]  — room CRUD, geometry + limits + `doors`/`grade` validated
PUT  /api/floorplans/:id/rooms/:roomId/instruments   — set room membership wholesale
GET  /api/floorplans/:id/rooms/:roomId/history?window=15m|1h|6h|24h|7d  — bucketed above 6h
POST /api/uploads/floorplan                     — plan image (CONFIG_UPDATE)
POST /api/audit/report-export-log               — governed report-download log; requires `remarks` +
                                                    `DOWNLOAD_REPORT` reauth (2026-08-24); reuses the
                                                    existing `REPORT_GENERATED` audit action, no new one added
GET    /api/alarm-webhooks                      — targets + the instrument count each currently resolves to
POST   /api/alarm-webhooks                      — create target (ALARM_RULE_MANAGE + MANAGE_ALARM_WEBHOOK reauth, audited)
GET    /api/alarm-webhooks/:id                  — one target
PUT    /api/alarm-webhooks/:id                  — update target (reauth, audited)
DELETE /api/alarm-webhooks/:id                  — delete target (reauth, audited; REFUSED while deliveries reference it)
POST   /api/alarm-webhooks/:id/test             — test fire (reauth, audited — it makes a real buzzer sound)
GET    /api/alarm-webhooks/:id/deliveries?status= — paged §11 delivery log, filtered server-side
```

- **On `PUT /api/floorplans/:id/rooms/:roomId`, an omitted `doors` key leaves the
  column unchanged; only an explicit `null`/`[]` clears it.** Deliberate §11
  data-loss guard so a client that predates doors can't silently wipe them.
- **Room doors (2026-08-24):** `floorplan_rooms.doors` JSONB, nullable — an
  array of `{wall, offset, width, kind}` normalized against the wall so a door
  stays attached when the room moves. Drawn as real gaps with a swing arc in
  Config → Floorplans; rides the existing `UPDATE_FLOORPLAN_ROOM` reauth/audit
  path — no new permission or reauth action. New pure module
  `apps/web/src/routes/dashboard/room-geometry.ts` does wall splitting, door
  placement and tile layout.
- **Per-instrument tiles (2026-08-24):** each room box on the graphical floor
  view now renders ONE TILE PER INSTRUMENT (code, limits, decimals). This
  fixed a defect: the box previously rendered only `rows[0]`, hiding a room's
  second instrument, including when it was the one breaching a limit.
- **Cleanroom grade (2026-08-24):** `floorplan_rooms.grade` nullable TEXT
  (`A|B|C|D|CIRCULATION|UTILITY`), zod-validated, deliberately **not** a
  Postgres enum so the vocabulary can grow without a migration — the enum
  count stays at 13. Hue encodes grade, saturation encodes status; design spec
  `docs/superpowers/specs/2026-08-24-graphical-view-visual-design.md`.
- **Instrument trend page (2026-08-24):** new route `/instruments/:id/trend`
  — period + interval header, latest-value cards, limit-lined charts (reusing
  `TimeSeriesChart`), a raw paged time-series, an alarms widget, per-user
  extra telemetry keys in `localStorage`. New shared module
  `packages/shared/src/types/telemetry-period.ts` (period presets, interval
  specs, range resolution). When an interval is selected the chart averages
  client-side and says so on screen ("Averaged over 5 minutes — the table
  below shows every reading") — a derived point must never look like a
  stored reading.
- **Governed report downloads (2026-08-24):** new reauth action
  `DOWNLOAD_REPORT` under a new `Reports` category (46 → 47 reauth actions,
  7 → 8 categories). `POST /api/audit/report-export-log` now requires
  `remarks` and enforces `DOWNLOAD_REPORT` reauth; it reuses the existing
  `REPORT_GENERATED` audit action — no new audit action was added (93/87/7
  unchanged). The Audit Trail export moved onto the same dialog, so every
  report download in the product is now governed.
- **Fixed a pre-existing security gap (2026-08-24):** `GET /:id/telemetry`
  had no instrument-visibility scoping (a bare `findUnique`) while its
  sibling `GET /:id` did — telemetry was readable for instruments outside
  the caller's resolved scope (see the instrument VISIBILITY note above).
  Now scoped the same way: 404 (never 403) when out of scope; callers with
  unrestricted scope are unaffected.
- **Alarm webhook annunciator (2026-08-27).** Alarms now reach a *device* — an
  IP-addressable hooter — as well as a person. Two models,
  `AlarmWebhookTarget` (URL, method, headers, content type, body template,
  success regex, timeout, `fireOn{Raised,Cleared,Acknowledged}`, severities,
  cooldown, scope) and `AlarmWebhookDelivery` (the §11 receipt: ONE ROW PER
  ATTEMPT, success or failure, with the URL and rendered body actually sent).
  Migration `20260827120000_alarm_webhooks`, applied to both databases.
  **No new permission** (reuses `ALARM_RULE_READ` / `ALARM_RULE_MANAGE`) and
  **no new Prisma enum** (`method`/`event`/`status` are validated strings) —
  don't go looking for either.
  - **Keyed off the INSTRUMENT, never the alarm rule.** `Alarm.ruleId` is
    nullable and the `INSTRUMENT_LIMIT` alarms that actually fire here have no
    rule row, so a design hung off `AlarmRule` would annunciate nothing while
    looking correctly configured.
  - **Scope reuses the `instrument_scope` shape — no fourth grouping concept.**
    `scopeLocationIds` (functional locations, a Block expanding to its Areas via
    `resolveLocationIds()`) UNIONED with `scopeInstrumentIds`. Unlike
    `instrument_scope` both are `NOT NULL DEFAULT '[]'`, and **both empty
    matches NOTHING, never everything** — a silent target is a bug someone
    fixes; a plant-wide buzzer gets the feature switched off for good. Several
    targets may match one instrument and all of them fire (local panel plus
    control room) — that is intended.
  - **Cooldown throttles `RAISED` only.** `CLEARED` and `ACKNOWLEDGED` are
    silence signals; rate-limiting the off switch leaves a buzzer sounding for a
    condition that has gone. In-memory per-target map, same single-instance
    caveat as the dispatcher's.
  - **Body rendering is `alarm-webhooks/render-body.ts`, deliberately NOT
    `notification-delivery/template-engine.ts:resolveTemplate()`.** That one
    HTML-escapes `& < > "`, which corrupts a JSON payload — an instrument named
    `Chiller "A" & B` would ship `&quot;A&quot;` and the hooter would reject the
    request intermittently, looking like a network fault. Placeholders come from
    the exported `ALARM_WEBHOOK_VARIABLES`, which the config page's picker
    renders from, so the UI cannot advertise a variable the renderer won't
    produce.
  - **Worker `alarm_webhook`, enqueued `maxAttempts: 1`.** Retry is bounded
    inside the task (3 attempts, ~2s apart) so graphile-worker's exponential
    backoff cannot sound a buzzer twenty minutes after the excursion cleared.
    Event-driven — no `crontab.txt` entry on purpose.
  - The `/config` card is **SUPER_ADMIN-ONLY**, not default-deny — this
    file claimed the latter until 2026-08-27 and it was FALSE.
    `apps/web/src/routes/config/index.tsx` reads
    `const visibleSuperAdminCards = isSuperAdmin ? superAdminCards : []` (the
    delegation allow-list was removed 2026-08-19), and the Alarm Webhooks card
    is in `superAdminCards`. A non-SUPER_ADMIN therefore NEVER sees the card,
    and granting `alarm-webhooks` under Configuration Access will NOT surface
    it. They can still reach `/config/alarm-webhooks` by URL, where the route's
    `RequireRole permissions={[ALARM_RULE_READ]}` admits them. Alarm Rules sits
    in the same array, so the BEHAVIOUR is precedent-consistent — only the
    description was wrong.
  - Instrument-visibility scoping on `/api/alarm-webhooks` is **SPLIT**
    (corrected 2026-08-27; this file previously said the whole module was
    unscoped). The CONFIG routes (`GET /`, `GET /:id`, mutations) are
    deliberately NOT scoped, matching the alarm RULES routes — a half-scoped
    config surface is worse than an unscoped one, because an admin who could
    see only half the plant would build a target that silently omitted the rest
    and could not tell. `GET /:id/deliveries` **IS** scoped: it is not
    configuration, and it returns `requestBody` verbatim, which under the
    default template carries the instrument code and the reading for every
    excursion. Rows whose `alarmId` is NULL (TEST fires) are returned — they
    name no instrument.
  - Outbound stance, on the record: the URL is operator-typed and on their LAN,
    so there is **no allowlist**. The guards are a hard per-request timeout,
    `redirect: 'error'`, no cookies/credentials/session token, and the exact
    URL, body, status and response snippet in the delivery log for every
    attempt.
  - Design spec: `docs/superpowers/specs/2026-08-27-alarm-webhook-annunciator-design.md`.

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
- Root: `README`, `CLAUDE`, `AGENTS`, `CHANGELOG`, `PROJECT_SUMMARY`, `PROJECT_ARCHITECTURE`, `API_REFERENCE`, `BACKEND_GUIDE`, `FRONTEND_GUIDE`, `DEPLOY-WINDOWS`, `LOCAL_SETUP_WINDOWS`, `windowsIssues`
  (`OFFLINE_SYNC_ARCHITECTURE.md` moved to `docs/archive/` the same day — it described an
  IndexedDB offline queue, a Capacitor APK and `cleaning_cycles`/`filter_events`, none of
  which exist here; it was read first and held no unique knowledge worth extracting.
  `PHASE_5_RECENT_WORK.md` moved to `docs/archive/PHASE_5_RECENT_WORK.md` — it described
  the removed filter/RFID/reports domain end to end; its three still-useful lessons were
  extracted into `apps/api/src/modules/backup/backup.repository.ts`, `apps/api/CLAUDE.md`,
  and this file's "Never" section before the move)
- Per-package: `apps/{api,web}/{CLAUDE,DECISIONS}.md`, `packages/shared/CLAUDE.md`
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
