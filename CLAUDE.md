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
packages/shared/  — Permissions (44), reauth actions (50), sidebar items (15),
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
**Customer installers exist for BOTH platforms (2026-09-09):** Windows `Setup.exe`
(`scripts/build-installer.ps1`, Inno Setup) and an Ubuntu/Debian `.deb`
(`scripts/linux/build-deb.sh`, built by `.github/workflows/build-deb.yml` on a
GitHub runner because this laptop cannot build Linux native modules — no WSL, no
Docker, virtualization off). Both bundle Node, PostgreSQL 18 and EMQX 5.3.2 and
render the broker config from the ONE template set in `scripts/emqx/`. The .deb
is smoke-installed on the runner by the workflow; the `Setup.exe` has never had
a CI install. `docs/deployment-methods/method-c-ubuntu-deb.md` is the runbook.

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
- **Verify TLS up** — `curl -sk --ssl-revoke-best-effort -o /dev/null -w "%{http_code}" https://localhost:3001/api/system-health` should return a code (401 is a pass — TLS terminated and the route rejected an unauthenticated call). **CORRECTED 2026-08-29: `/api/health` DOES exist and is load-bearing.** This file said "There is no `/health` route" on the evidence of `grep "get('/health'"` → 0 hits. That pattern could never have matched: the route is registered at `app.ts:297` as `app.get('/api/health', ...)`, top level, with no prefix. It is the tablet's liveness probe — `apps/web/src/lib/connectivity.ts probeServer` treats any non-2xx as "server unreachable", and `app.ts` deliberately returns 200 even when the job runner is down so a background-job fault cannot flip every tablet offline — and its `PUBLIC_PATHS` entry is REQUIRED. The 2026-08-29 audit repeated this claim as finding L1 and an agent began removing the allowlist entry before catching it. **A 0-hit grep is evidence only if the pattern could have matched.**
- **Don't use HTTPS with self-signed in Capacitor *dev* mode** — WebView's `fetch()` rejects self-signed certs (Capacitor's `BridgeActivity` overrides the WebViewClient after `onCreate`). Keep dev cleartext if testing in-WebView, or install root CA on the device.

## System Stats (re-derived 2026-08-27 — every number below came from the command beside it)
- **Backend:** **25** API modules under `apps/api/src/modules/` (`ls | wc -l`).
  24 → 25 (2026-09-07): `report-reviews`, the report review workflow.
  23 → 24 (2026-08-27): `alarm-webhooks`, the alarm annunciator.
- **Database:** **36 Prisma models, 13 enums** (35/12 → 36/13 on 2026-09-07: `ReportReview` + `ReportReviewStatus`, migration `20260907120000_report_reviews`) (36/13 → 35/12 on 2026-08-31: `AlarmRule` + `AlarmComparison` removed with the alarm-rules feature) (`grep -cE "^model " / "^enum "`).
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
- **Permissions:** **44** constants, **50** reauth actions in **8** categories,
  **15** sidebar items (`grep -cE` against `permissions.ts` / `reauth-actions.ts`
  / `sidebar-items.ts`). 14 → 15 sidebar items (2026-09-08): `settings`, every
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
- **Audit registries:** **102** audit actions, **96** audit templates in **7**
  categories (98 → 102 / 92 → 96 on 2026-09-07: `REPORT_REVIEW_REQUESTED` /
  `APPROVED` / `REJECTED`, `REPORT_DOWNLOADED`; categories unchanged). Earlier: **98** / **92** in **7**
  categories (97 → 98 / 91 → 92 on 2026-09-05: `INSTRUMENT_ATTRIBUTE_REPORTED`,
  a SYSTEM action — no user — for an attribute a DEVICE wrote over MQTT;
  re-derived by the two greps in the verification block). Earlier: **97** / **91** in **7**
  categories. 93 → 97 / 87 → 91 (2026-08-27): create / update / delete / test
  for alarm webhook targets; categories unchanged.
- **Config:** **32** definitions (`config/defs/*.def.ts`) + auto-discovery (31 → 32 on
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
  **23** pages under `apps/web/src/routes/config/` (an `attribute-labels.tsx` existed
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
- **Frontend:** **53** `<Route`s in `main.tsx` (a `/config/attribute-labels` route existed for a few hours on 2026-09-16 and was removed the same day — unchanged; 52 → 53, 2026-09-08: `/settings`; 51 → 52, 2026-09-07: `/reports`; 50 → 51 the same day: `/data-report`) (51 → 50, 2026-08-31: `/config/alarm-rules` removed with the rule feature) (50 → 51, 2026-08-29: `/config/export-options`, a page that had a config def and a dashboard card but no route, so it was unreachable. Earlier 49 → 50, 2026-08-27:
  `/config/alarm-webhooks`).
- **Queue backend:** graphile-worker (Postgres-backed), **6** tasks.
- **Tenancy:** single-tenant, single-site. JWT `scope` always stamps `GLOBAL`.
- **Themes:** 10 preset colour themes.

Per-removal history has been moved out of this section — it is history, not an
inventory, and the two long paragraphs that used to live here were inherited
from upstream DigiLog and disagreed with the tree. `CHANGELOG.md` holds the
history; `docs/recreation/` holds the inventory.

- **Instrument VISIBILITY (2026-08-13, project D; extended 2026-08-28).** `instrument_scope` JSONB on **both** `role_configs` and `user_configs`. **`NULL` = inherit (user → role → unrestricted); an empty selection = SEE NOTHING; otherwise = those functional locations (Blocks expanding to their Areas) UNIONED with those explicitly named instruments.** **TWO SHAPES live in that column, permanently:** rows written before 2026-08-28 are a bare `string[]` of location ids; rows since are `{locationIds, instrumentIds}`. Legacy rows are deliberately NEVER migrated, so `normalizeScope()` in `modules/instruments/visibility.ts` is the ONE reader of both — a second `Array.isArray` test anywhere reads a legacy restricted row as "nothing stored", which means UNRESTRICTED. Resolved once in that same module; a user scope REPLACES the role's and can widen it. Enforced **on the query** — the list merges it into the same `where` the count uses, `GET /:id`, `/:id/telemetry`, `/:id/telemetry-keys` and `/:id/dead-letters` apply it in the lookup and 404 (never 403, which would confirm existence), the overview ANDs selection with visibility, and `GET /api/floorplans/:id/rooms/:roomId/history` filters the room's MEMBERSHIP query. `scopeToWhere` emits `{OR: [{functionalLocationId:{in}}, {id:{in}}]}` with **both branches always present** — `{OR: []}` matches nothing in Prisma while `{}` matches everything. **Unassigned instruments are invisible to the LOCATION branch but ARE reachable by being named outright** (changed 2026-08-28 — assigning a freshly commissioned device must not silently do nothing). Writing a NULL needs `Prisma.DbNull`, never `JsonNull`. Admin surface: Config → Roles & Access → Instrument Scope, whose instrument picker reads the deliberately UNSCOPED `GET /api/roles/instrument-scope/instruments` (ROLE_MANAGE) — a scoped picker would let a restricted admin build a scope silently omitting the rest of the plant. `GET /api/floorplans/:id` is knowingly unscoped: it lists instrument identity per room and is fetched ONLY by the Config → Floorplans editor (verified 2026-08-28), not by the dashboard, which uses `GET /api/floorplans` (rooms only). Prove behaviour with `apps/api/scripts/probe-visibility.ts` and `src/e2e/instrument-scope-selection.test.ts`.

- **The MQTT client id and topic segment are the instrument CODE (2026-09-04).**
  Operator: "35dd00b3-… this is CWH/RDU/001-00 instrument mqtt client id, i want
  client id as CWH/RDU/001-00". It was the code until 2026-08-07, the UUID from
  then until this change, and the code again now. **No count moved** — no model,
  enum, migration, permission, reauth action, config def, page or route.
  - **`/` is allowed in a code and appears in 100 of 101.** The broker
    substitutes `${clientid}` literally, so `instruments/CWH/RDU/001-00/telemetry`
    is that instrument's exact topic. The bridge therefore subscribes
    `instruments/#` (`+` is exactly one level) and `parseTelemetryTopic` matches a
    FIXED prefix and suffix instead of counting segments. It also receives its
    own retained downlinks and drops them SILENTLY (`isDownlinkTopic`).
  - **The hole the UUID interlude closed is closed at REGISTRATION instead.**
    `instrumentCodeTopicViolation()` in `@digilog/shared` refuses `+`, `#`, NUL,
    and a LAST segment of `telemetry`/`attributes`/`children` — the reserved word
    matters because the bridge reads the topic KIND from the last segment, and a
    child coded `X/telemetry` would have its downlink parsed as telemetry from
    `<gw>/attributes/X`. Applied by the zod schema, `bulk-csv.ts` and the create
    form (which otherwise shows a generic "Could not create" on a 400 whose body
    is a zod flatten). **Do not relax it** — the 2026-08-08 memory's `+` test is
    still the regression test, and it was re-proven live on 2026-09-04.
  - **One identity, no UUID fallback**, by the operator's choice: a device still
    configured with its UUID is refused at CONNECT (`Not authorized`), where the
    failure is visible, rather than admitted and denied topic by topic.
  - **The auth hook ALSO admits the ingest BRIDGE (2026-09-08)** by
    `MQTT_USERNAME` / `MQTT_PASSWORD` (constant-time compare over SHA-256
    digests; the bridge NAME with a wrong password is a deny, never a
    fall-through to the token path). Why: the `Setup.exe` installer now
    BUNDLES EMQX 5.3.2 (`scripts/build-installer.ps1 -EmqxZip`,
    `scripts/provision-emqx.ps1`, templates in `scripts/emqx/`) and configures
    ONE authenticator, so no dashboard user or API key has to be created on a
    customer machine. The dev box still has its built-in-database user ahead of
    the hook; both work. Pinned by `e2e/mqtt-auth.test.ts`. The installer's
    third service is `emqx` (erlsrv via `emqx.cmd install`); the API does not
    depend on it. `docs/PHARMA_DEPLOYMENT_21CFR.md` §4a is the runbook.
  - **Downlink and roster slots are keyed on codes** (`attributeDownlinkTopic`,
    `childRosterTopic`; the routes resolve the gateway's code). The 102 retained
    UUID-keyed slots on the local broker were cleared and republished code-keyed
    by `scripts/migrate-mqtt-topics-to-code.ts` (dry run by default) — a stranded
    retained slot reads as current state to anyone looking at the broker.
  - **The gateway batch accepts a LIST (2026-09-05):**
    `{"devices":[{"devN":"<code>",…},…]}` beside the code-keyed object.
    `parsePayload` folds the list onto `dev1..devN`; `fanoutDevices` takes a
    string `devN` as the code and strips it from the readings; same child-map
    authorisation, dead-lettered by code. "Instrument id" = the CODE, never the
    UUID. **And a GATEWAY's FLAT payload carrying a string `devN` is a
    one-block batch routed to that child** (`ingest-core.ts`) — the plant
    firmware's one-child-per-message form, found in the data: 110 such
    messages had landed on IOTGW01 itself before this. Keys on the wire are
    `t` / `h` (already in the alias lists).
  - **A THIRD topic per gateway (2026-09-05): the child attribute CHANGE
    EVENT**, `instruments/<gw>/children/attributes` — published only when a
    child's attribute changes (app or device report), NOT retained, carrying
    ONLY the changed key under the child's `devN`
    (`{"gateway","devices":[{"devN","<key>":"<value>"}]}`, `null` =
    removed). Reshaped twice in a day at the operator's direction (whole-set
    retained bundle → changed child's full set → the key alone). Membership
    publishes nothing there; the per-child slots stay retained for state. ACL
    subscribe line widened (boot-only — restarted here, AWS needs the same).
    `LOCAL_SETUP_WINDOWS.md` §9C.1.
  - **RTC sync (2026-09-05):** device publishes `{"method":"getTime"}` on
    `instruments/<code>/rtc-request`; the platform publishes
    `{"unix":<epoch-ms NUMBER, 13 digits>}` — the only key — on the GLOBAL `digilog/rtc/time` — at
    once on a request and every 10 minutes on the boundary (`RTC_TICK_MS`; `startRtcTicker` in
    `app.ts`). Outside `instruments/` on purpose (no bridge echo, one ACL
    grant). `rtc-request` reserved. Three ACL edits; AWS needs them.
  - **`emqx-5.3.2/etc/acl.conf` changed and the broker was restarted**: bridge
    subscribe/publish → `instruments/#`; the 2026-09-03 TEMPORARY TEST GRANT for
    client id `35dd00b3-…` removed. **The AWS broker needs the same edit and
    restart when this deploys, and the one live device (CWH/RDU/001-00, direct
    MQTT) must be reconfigured to its code.** Proven live 2026-09-04: connect as
    code accepted, reading lands, UUID refused, foreign token/code refused,
    foreign topic publish and subscribe refused.
- **Instrument grouping — THREE concepts, one job each (2026-08-13).** Do not confuse them: **`FunctionalLocation`** (Block > Area tree, `Instrument.functionalLocationId`) is the AUTHORITATIVE logical grouping; **`roomId`** → `FloorplanRoom` is geometry on a drawn plan and drives the graphical view; **`profileId`** is device type. The free-text `Instrument.block` / `.area` columns are SUPERSEDED — no longer read for grouping, kept only so the migration stays comparable. A Block's instruments are its own PLUS its Areas', resolved by `functional-locations/tree.ts:resolveLocationIds()`; querying `functionalLocationId = :id` directly silently omits the Areas.
- **Config:** **32 definitions** (`apps/api/src/modules/config/defs/*.def.ts`) + auto-discovery, **23** corresponding pages (both re-derived `ls | wc -l` 2026-09-16: defs 31 → 32 with `attribute-labels.def.ts`, which adds NO page — its Display name column lives on `instrument-attributes.tsx`; earlier defs re-derived 2026-09-07, 30 → 31 with `report-approvers.def.ts`; both re-derived 2026-09-01; defs 29 → 30 that day with `trend-widgets.def.ts`, which adds no page — it renders through the dynamic config page; the page count read 24 here and in System Stats above until then and was **stale, not moved** — `alarm-rules.tsx` went with the 2026-08-31 rule removal and neither line was re-synced. This is the THIRD time this bullet has drifted from the one above it; the duplication itself is the defect it keeps warning about). **This bullet's def count went stale TWICE while the System Stats section above was current — 25 here against 26 then 27 there.** It is the same self-contradiction the 2026-08-29 audit raised as finding M8 for the page count, in the same bullet, and re-syncing only the half that was wrong that day is why it came back. Two live inventory lines for one number is the actual defect; re-derive both from `ls` whenever either moves. Defs 25 → 26 → 27 on 2026-08-31 (`inactivity-alarms.def.ts`, then `rs485-alarms.def.ts` — both render through the dynamic config page, so the page count did not move). Earlier note, still true: the 25 predated `dashboard-cards.tsx` being deleted on 2026-08-28. Defs verified `ls` 2026-08-27, unchanged at 25 — the def and page counts are NOT equal and should not be expected to be: `alarm-webhooks.tsx` is a page with no def (a CRUD module, not a `system_config` row), and several defs render through the dynamic config page with no file of their own. Earlier: pages 25 → 24 the same day — `routes/config/role-assignments.tsx` deleted as dead code: its 7 config defs went in the Phase 0 strip and `system_config` held 0 rows for them, so every section read an unregistered `/api/config/dynamic/<key>` route. Earlier counts VERIFIED by `ls` 2026-08-17 — `alarm-limits.def.ts` added 2026-08-17: super-admin config for the instrument-limit alarm work — an ordered alias list of attribute keys per bound (High/Low Temperature/Humidity Limit), since this install's keys have already drifted; plus a master switch and four status wordings. (It also carried a `severity`
  select until 2026-09-01, when severity stopped being administered anywhere; the
  def count did not move — a setting was removed, not a def.) Renders through the dynamic config page, so no `routes/config/*.tsx` of its own — the page count stays 25. The "23 corresponding pages" recorded here 2026-08-11 was already stale before this change (the live page count was 25, per `apps/web/CLAUDE.md`'s 2026-08-14 verification); it was never re-synced here until now. Earlier: `telemetry-slots.def.ts` added 2026-08-11: which telemetry keys the dashboard reads as temperature and humidity, since ingest stores whatever key a device sends. Renders through the dynamic config page, so no `routes/config/*.tsx` of its own; the Floorplans placement editor IS a page. Earlier counts VERIFIED by `ls` 2026-08-07 — the previous "36 / 34" was inherited from DigiLog and was never true in this fork; `instrument-attributes.def.ts` added 2026-08-07 — the attribute keys the New Instrument form asks for, renders via the dynamic config page so no new `routes/config/*.tsx`)
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
- **Frontend:** **53** Routes in `main.tsx` (unchanged on 2026-09-16 — a `/config/attribute-labels` route lived for a few hours and went the same day; 52 → 53 on 2026-09-08: `/settings`, the Settings page; 51 → 52 on 2026-09-07: `/reports`, the report review workflow; 50 → 51 the same day: `/data-report`, the Instrument History widget's own page; re-derived `grep -cE "<Route"` that day. Earlier, re-derived 2026-09-03 — this line read **51** and was ALREADY STALE: the 2026-08-31 alarm-rules removal took it 51 → 50 and re-synced only the System Stats copy above, which is the same duplicate-inventory defect this file keeps warning about. Earlier verified 2026-08-29 — 50 → 51: `/config/export-options` registered, having never been reachable. Earlier verified 2026-08-27 — 49 → 50: new `/config/alarm-webhooks` page; earlier 48 → 49 on 2026-08-24: the `/instruments/:id/trend` page; the "77" was inherited from upstream DigiLog and was never true in this fork; `/config/role-assignments` removed 2026-08-19 as dead code, 49 → 48), **23** custom hooks (22 → 23 on 2026-09-16: `use-attribute-labels.ts`, the ONE browser reader of the attribute display names; earlier 20 → 22, re-derived `ls apps/web/src/hooks/ | wc -l` 2026-09-03 — ALREADY STALE, nothing on 2026-09-03 added a hook; earlier 18 → 20 on 2026-08-29, audit finding M8), **20** lib modules (19 → 20 on 2026-09-03: `lib/document-identity.ts`, the browser-tab applier) (`ls apps/web/src/hooks/ | wc -l` / `ls apps/web/src/lib/ | wc -l`, each including its own `__tests__` subfolder as one entry — lib 18 → 19 corrected 2026-08-27: `lib/background-style.ts` landed with the wallpaper work (`764fff5`) and this line was never re-synced; the 2026-08-27 trend-sampling work added NO lib module — the "26 / 30" this file carried for months was never true against the live tree and was never re-verified until now)
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
GET  /api/instruments/telemetry-overview        — every instrument's current temp + RH, one request.
                                                  Carries THREE placement facts per row and they are
                                                  three DIFFERENT things (2026-09-01):
                                                  `functionalLocationName` (the authoritative Block >
                                                  Area grouping — the dashboard's **Area** column),
                                                  `locationAttribute` (the instrument's own `Location`
                                                  ATTRIBUTE, **not** the superseded `Instrument.location`
                                                  COLUMN of the same name — the **Location** column),
                                                  and `room` (geometry on a drawn plan — **Room**, and
                                                  the visible source of the SET POINT columns).
                                                  Both new fields are DECLARED in the 200 block; a
                                                  field the builder returns and the schema omits is
                                                  stripped silently, which has bitten this endpoint
                                                  five times now.
GET  /api/instruments/telemetry-history?instrumentIds=a,b&from=&to=&limit=&offset=
                                                — (2026-09-05) the merged, paged readings of SEVERAL
                                                  instruments, newest first: the Data Report page's
                                                  history widget. One row per (instrument, instant),
                                                  pivoted in SQL so a page cannot split an instant's
                                                  temperature from its humidity; `values` RAW — the
                                                  slot keys, limits and precision come from
                                                  `telemetry-overview`. Visibility is applied to the
                                                  ID SET (out of scope = absent, never 403). `values`
                                                  is declared `additionalProperties: true` — an object
                                                  schema without it is stripped to `{}` silently.
GET  /api/alarms?search=&from=&to=&type=&status=&severity=&page=&pageSize=&sort=&dir=
                                                — the Alarms page. Filters, counts, sorts and pages
                                                  SERVER-side (2026-08-31); returns `data`, `total`
                                                  and `counts` (the four state counts). `total` is
                                                  DERIVED by summing `counts`, never counted
                                                  separately, and the `status` filter is excluded
                                                  from the count query alone so choosing a box does
                                                  not zero the other three. A bad date or reversed
                                                  range is a 400 by field; an unknown `sort` falls
                                                  back. Legacy `state`/`acknowledged`/`instrumentId`/
                                                  `functionalLocationId`/`limit` still work — `limit`
                                                  is an alias for `pageSize` (ceiling 500) and the
                                                  dashboard panel + trend widget still send it.
                                                  Filter algebra: `modules/alarms/list-query.ts`.
                                                  Rows carry BOTH `locationAttribute` (the
                                                  instrument's own `Location` ATTRIBUTE, which the
                                                  Location column PRINTS since 2026-09-01) and
                                                  `locationName` (the FUNCTIONAL location, which it
                                                  falls back to). Both are SEARCHABLE — a column
                                                  that displays one and searches the other reads as
                                                  a broken search box.
                                                  NOT `roomLabel` — dropped 2026-08-31
                                                  with the column's room line, because every room
                                                  was then coded with its instrument's own code.
                                                  The room CODE is still SEARCHABLE.
                                                  **That premise no longer holds for QC** (see the
                                                  traced-QC-floor note below): its rooms are coded
                                                  `CWH-I/216`..`/233` and labelled with the room
                                                  name, so searching an instrument code no longer
                                                  matches its room there, and a room line WOULD now
                                                  carry information on that floor. Not restored —
                                                  it would be blank on the seven generated plans.
GET  /api/instruments/:id/telemetry?from=&to=&offset=  — per-instrument history, paged (offset added 2026-08-24)
GET  /api/instruments/:id/telemetry?from=&to=&points=N — the CHART path (added 2026-08-27): every
                                                  reading in the range, LTTB-downsampled to N per key
                                                  (1..5000, out of range = 400, never a silent clamp),
                                                  plus `historyTotal` (the TRUE count in range),
                                                  `historySampled`, and `summaries[key]`
                                                  {count, numericCount, min, max, avg, first, last,
                                                   below/above/outOfSpecCount, limitMin, limitMax}
                                                  computed in SQL over EVERY reading in the range.
                                                  `points` omitted = the old paged table path, unchanged.
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
POST   /api/report-reviews                      — raise a report REQUEST (every PDF download is one, 2026-09-07):
                                                    reportType, title, requestMeta, dataSnapshot (the frozen
                                                    document), remarks, assigneeUserId | assigneeRole;
                                                    REPORT_REVIEW_READ + DOWNLOAD_REPORT reauth; audited
GET    /api/report-reviews?list=queue|mine|approved&page&pageSize — the three lists, party-scoped server-side
GET    /api/report-reviews/:id                  — the full row with its snapshot; 404 (never 403) for a non-party
POST   /api/report-reviews/:id/approve | reject — assignee only, never the requester — EXCEPT SUPER_ADMIN,
                                                    who may decide ANY pending request, their own included (2026-09-08);
                                                    REPORT_REVIEW_APPROVE + APPROVE_REPORT / REJECT_REPORT reauth;
                                                    one decision (409 on a second); audited; requester notified
POST   /api/report-reviews/:id/download-log     — a party downloading the APPROVED copy; written BEFORE save
GET    /api/config/report-approvers/current     — the administered approver roles (2026-09-07), every
                                                    authenticated user; the SEVENTH narrow-slice route.
                                                    `{approverRoles: string[]}`, already coerced (never
                                                    SUPER_ADMIN); EMPTY = no report can be requested
```

- **Inactivity alarms — a THIRD alarm source (2026-08-31).** `AlarmSource` gains
  `INACTIVITY` (a new enum VALUE — models stay 36, enums stay 13). Raised
  automatically when an instrument stops reporting, cleared when it starts again,
  with NO rule row: `AlarmRule` can already do `metric: 'OFFLINE'`, but a
  location-targeted rule cannot reach an instrument with no functional location,
  and there is one. Config def `inactivity-alarms` (25 → 26 defs), rendered by the
  dynamic config page so the page count stays 24.
  - **It ships OFF, unlike `alarm-limits`.** `loadInactivityConfig` reads
    `enabled === true` where `loadLimitConfig` reads `enabled !== false`.
    Deliberate and not a style difference: this one failing OPEN raises one alarm
    per silent instrument, which on this installation is 101 in a single pass,
    each with a notification and a webhook fire.
  - **The clear signal is PRESENCE — the INVERSE of the instrument-limit rule**,
    where a missing reading HOLDS an alarm open because absence cannot prove
    recovery. Here absence IS the alarm. A pass copied from the limit pass's shape
    strands every inactivity alarm ACTIVE for good. `inactivity-decide.ts` is
    separate for exactly this reason.
  - The effective raise threshold is the **LATER** of `graceMinutes` and
    `instrument-activity`'s `activeWindowMinutes` — the pass needs both
    conditions, so a grace shorter than the window changes nothing.
  - Never raises for an instrument that has NEVER reported (it was not active) or
    a decommissioned one; an alarm already open on a decommissioned instrument
    still clears if it reports.
  - **The three VALUE columns are administered wordings, added the same day.**
    Generated Value (`No data`) and Cleared Value (`Data resumed`) are cells that
    can hold no number — this alarm is raised by the absence of a reading and
    cleared by the return of telemetry, not by a reading crossing a bound — so
    they carry a word rather than a dash. The **Limit** wording is NOT in the same
    category: it states the threshold the alarm fired against, so it is a template
    with a REQUIRED `{minutes}` token filled from the FROZEN snapshot, and a
    configured string without the token is refused in favour of the default, on
    the server and in the browser both. Cleared Value renders only once
    `clearedAt` is set. Served to all authenticated users by
    `GET /api/config/inactivity-alarms/display-texts`, the same narrow-slice
    pattern as `/alarm-limits/status-texts` and deliberately not folded into it;
    read live, like the four status wordings, while the threshold under them stays
    frozen. Adds no def, page, route, permission or enum.
  - Two hand-authored migrations, SEPARATE because Postgres refuses to use a new
    enum value in the transaction that added it. The second adds
    `alarms_active_inactivity_unique`, a partial unique index Prisma cannot
    express and will propose dropping — do not accept that.
- **RS485 sensor-failure alarms — a FOURTH alarm source (2026-08-31).**
  `AlarmSource` gains `RS485_FAILURE` (a new enum VALUE — models stay 36, enums
  stay 13). Raised when a sensor reports a NON-NUMERIC value on a temperature or
  humidity slot key, cleared when it reports a number again. Config def
  `rs485-alarms` (26 → 27 defs), rendered by the dynamic config page so the page
  count stays 24. Spec:
  `docs/superpowers/specs/2026-08-31-rs485-sensor-failure-alarms-design.md`.
  - **It is the ONLY source that can see this fault.** A failed RS485 probe leaves
    the logger talking, so INACTIVITY sees a reporting instrument, INSTRUMENT_LIMIT
    sees `null` (`toSlot()` discards a non-numeric value and a null is not a
    breach), and the dashboard shows a blank cell. Nothing fired anywhere.
  - **It ships ON, the opposite of `inactivity-alarms`, and the reason is a
    measurement**: every one of the 226,570 retained readings on a slot key in the
    LOCAL database is numeric, so enabling it raises nothing. `loadRs485Config`
    reads `enabled !== false`. **Only `compliance_core_db` was probed — the AWS
    database was not.** Re-derive there before deploying; the query is recorded
    beside `RS485_ALARMS_DEFAULT` in `@digilog/shared`.
  - **Detection is by TYPE, never by parsing — `"23.5"` IS a failure.** The
    dashboard already refuses to plot a quoted number and the limit evaluator
    already treats it as no reading; one definition of "a reading", or the screen
    and the alarm beside it disagree.
  - **The clear signal is a NUMBER and SILENCE HOLDS THE ALARM OPEN** — the
    `limit-decide` rule, and the exact inverse of the inactivity source. A pass
    copied from that one clears every RS485 alarm the moment the broken device
    falls quiet. `rs485-decide.ts` is separate for exactly this reason.
  - **Two alarms, deliberately.** The partial unique index
    `alarms_active_rs485_unique` is on `(instrument_id, metric)`, NOT the
    instrument alone as the inactivity one is — two probes fail independently.
    Two hand-authored migrations again (enum value, then index).
  - **The value columns show ONE administered word, `failureText` (default
    `Error`), NOT the raw text the sensor sent.** The raw-text design lasted a few
    hours on 2026-08-31 and was reversed: the raw text is almost always `NA`, and
    `NA` is what the dashboard already shows for a slot with NO reading, so a dead
    probe and an unwired instrument read identically. **No evidence was lost** —
    the raw value is still frozen on `ruleSnapshot.rawValue` and still named in
    the condition, which every notification and webhook prints beside the value.
    The word appears on the Alarms page, the acknowledge dialog, the trend widget,
    the signed PDF, the dashboard table and tiles, the trend raw table, and the
    `${value}` of every notification and webhook. Served by
    `GET /api/config/rs485-alarms/display-text`; **never default it to a literal
    in browser code** — the only fallback is the shared constant.
  - **Absent readings still say `NA`.** A broken probe and an instrument nobody
    wired up are different faults; that distinction is the point of the word.
  - `OverviewRow.sensorError` (declared in the response schema) is how the
    dashboard knows: both cases leave the numeric slot null, and the browser must
    not re-derive which is which.
  - The Limit column shows the constant `numeric`; Cleared Value is a real
    reading, because this source clears on an actual measurement.
  - `buildTelemetryOverview()` gained `rawSlots` — the slot reading BEFORE the
    numeric filter — so slot resolution happens ONCE and the alarm cannot name a
    different key than the dashboard. Not exposed by the endpoint.
- **Alarm RULES were REMOVED (2026-08-31, operator).** `AlarmRule`,
  `AlarmComparison`, `Alarm.ruleId`, the `/api/alarms/rules` endpoints,
  `alarms/decide.ts`, the rule evaluation pass and the Alarm Rules config page are
  gone. Migration `20260831200000_remove_alarm_rules`, run against **0 rules and
  0 RULE alarms** — verified first, and recorded in the migration, because an
  alarm is a §11 record and is never dropped to tidy a schema.
  - **`ALARM_RULE_READ` / `ALARM_RULE_MANAGE` SURVIVE** — they gate
    `modules/alarm-webhooks`, which has always reused them. Do not remove them as
    dead code; the names are stale, the permissions are not.
  - **`AlarmSource.RULE` survives too** — Postgres cannot drop an enum value
    without recreating a type the `alarms` table depends on. Nothing writes it.
  - Counts: models 36 → **35**, enums 13 → **12**, config pages 24 → **23**,
    routes 51 → **50**.
- **A QUOTED number is a reading (2026-08-31, operator).** `coerceReading()` in
  `@digilog/shared` is the ONE definition of "is this stored value a reading" —
  the dashboard, the limit evaluator, the range check, the trend chart and table,
  and the SQL range summaries all use it. `"23.5"` is 23.5; an empty string,
  `NA`, `25 C`, booleans and objects are not. **This reverses the earlier
  judge-by-type rule, and changing it in fewer places would have been worse than
  either rule alone** — the value would render blank AND raise no alarm.
- **Alarm type NAMES are administered in one place (2026-08-31).** Config def
  `alarm-type-names` (28 → 29 defs), served to all authenticated users by
  `GET /api/config/alarm-type-names/current`. A rename reaches the Type column,
  the Type filter, the trend widget, the signed PDF and `${ruleName}` in every
  notification and webhook — those were four hardcoded lists, and the notification
  one said `TEMPERATURE HIGH limit` where the table said `High Temperature`.
  - **`alarmTypeKeyFor()` in `@digilog/shared` is the ONE mapping** from source +
    metric + limitKind to a type key. The browser and the worker both use it, so a
    row and the email about it cannot disagree.
  - **Read LIVE, not frozen** — a rename re-labels history, which is the point.
    The limit, span, reading and precision stay frozen as always.
  - **A rule alarm keeps its own rule's name**; only the filter's collective
    wording is configurable. `ALARM_TYPE_OPTIONS` is now derived from
    `alarmTypeOptions(names)` — a module-level constant would never see a rename.
- **Instrument-limit bounds honour a per-bound ENABLE attribute (2026-08-31).**
  `Enable_Temp_NMT` / `Enable_Temp_NLT` / `Enable_Humid_NMT` / `Enable_Humid_NLT`
  gate the four bounds — NMT is the HIGH bound, NLT the LOW one (the plant's
  vocabulary; mapping them the wrong way round silently disables the opposite
  bound). Four alias-list settings on the existing `alarm-limits` def; no count
  moved, no migration.
  - **Why a bound needs a switch separate from its value:** an instrument here
    carries `High Humidity Limit = 0` meaning "not judged", and **a 0 is a real
    bound** — 17 CRITICAL alarms were open at 44-50 %RH against it when this was
    written, on the 16 instruments whose own `Enable_Humid_NMT = 0` already said
    the bound was not in force.
  - **Absent, blank or unreadable = ENABLED.** The safety default: a typo must
    never silence a bound, and one instrument carries no flag. Both `0`/`1` and
    `True`/`False` are accepted — the live data holds both.
  - **A disabled bound is WITHHELD from `telemetry-overview`, not merely
    unenforced (2026-08-31).** `limits` carries `null` for it, so
    `computeInstrumentStatus`, the dashboard table, the floor tiles, the trend
    card and its chart's limit line all stop drawing a bound that can never
    raise — leaving it in painted OUT_OF_SPEC against a bound the evaluator
    ignores. The row also carries `limitEnabled`, which says WHY a bound is
    absent (switched off vs never administered) and must NEVER gate display,
    since `limits` already withholds it; and `limitSource` goes null once no
    bound survives. Pinned by `src/e2e/telemetry-overview.e2e.test.ts`, both
    mapping directions separately.
  - **Switching a bound off also CLEARS an alarm open on it**, which is a
    deliberate departure from "a config change never closes a regulated record".
    Those alarms can never clear on their own (humidity below 0 cannot occur), and
    a permanently red row asserts an excursion that is not real. `raisedAt` and
    `triggeredValue` survive; the acknowledgement is untouched.
- **Sensor RANGE alarms — a FIFTH alarm source (2026-08-31).** `AlarmSource`
  gains `SENSOR_RANGE` (enum VALUE — models stay 36, enums stay 13). Config def
  `sensor-range-alarms` (27 → 28 defs). Raised when a reading falls outside the
  probe's own `High/Low Temperature Range` / `High/Low Humidity Range`
  attributes; Type reads `Temperature Failure` / `Humidity Failure`.
  - **RANGE IS NOT A LIMIT.** Every instrument here carries both:
    `High Temperature Limit` = 25 is the product SPEC, `High Temperature Range`
    = 50 is the hardware's span. Confusing them is the mistake the whole feature
    is written to prevent.
  - **An out-of-range reading is treated as NO READING** (operator, 2026-08-31):
    it raises this alarm, raises NO limit alarm, and **cannot clear an open one**
    — the second follows necessarily from `limit-decide.ts`'s rule that absence
    never proves recovery. A genuine excursion INSIDE the span still raises a
    normal limit alarm; that is separately pinned.
  - **The withholding happens in ONE place** — `telemetry-overview.ts`, where a
    stored value becomes "a reading": `rangeError` is set and the numeric slot is
    nulled. Put the test anywhere else and some consumer will trust a number the
    others rejected.
  - **`OL` is its own configurable word**, separate from RS485's `Error`: a
    saturated probe and a probe sending nonsense need different checks. Served by
    `GET /api/config/sensor-range-alarms/display-text`.
  - Bounds resolve through the SAME `parseLimitKeys`/`resolveLimit` machinery as
    limits — no second resolver to drift. The snapshot freezes the reading, the
    span AND the attribute key each bound came from.
  - `alarms_active_sensor_range_unique` on `(instrument_id, metric)`, two
    hand-authored migrations as always (Postgres refuses a new enum value in the
    transaction that added it).
- **Trend page widget wording is ADMINISTERED, and editable in place
  (2026-09-01).** Config def `trend-widgets` (29 → 30 defs) holds every title,
  subtitle and column heading on `/instruments/:id/trend`, plus a per-widget
  date/time FORMAT override. Served to all authenticated users by
  `GET /api/config/trend-widgets/current`, the **SIXTH** narrow-slice route
  (`/alarm-limits/status-texts`, `/inactivity-alarms/display-texts`,
  `/rs485-alarms/display-text`, `/sensor-range-alarms/display-text`,
  `/alarm-type-names/current`). No migration, no model, no enum, no permission,
  no reauth action, no route, and NO config page — it renders through the dynamic
  config page and gets a `superAdminCards` card, which is not a file under
  `routes/config/`. Pages stay 23.
  - **A pencil in each widget's header edits just that widget**, SUPER_ADMIN only
    (`user?.role === 'SUPER_ADMIN'`, the same check `routes/config/index.tsx`
    makes — not `useCan`, since the gate is the def's own `requiredRole`). Hiding
    it is presentation; the server refusing the PUT is the control, and that is
    tested separately.
  - **The dialog PUTs the WHOLE row, merged.** `/api/config/dynamic/:key`
    REPLACES `configValue` — it does not patch it — so a PUT of one widget's
    fields alone erases the other five. Pinned by a test, and mutation-checked.
  - **`TREND_WIDGET_FIELDS` in `@digilog/shared` is the ONE widget → fields
    mapping.** The def's 31 settings are BUILT from it and the dialog renders from
    it, so a key cannot exist in one and not the other. A test asserts it accounts
    for every label key exactly once.
  - **Blank falls back to the SHIPPED wording, never an empty heading** — the same
    rule as `alarmTypeName()`. No component may default a label to a literal; the
    only fallback is the shared constant. `coerceTrendWidgetTexts()` applies it to
    a malformed RESPONSE too, so a stale server cannot white-screen the trend page
    over a column heading.
  - **Format overrides default to INHERIT, and the TIMEZONE is not overridable.**
    A per-widget zone would let two widgets name different instants for the same
    stored reading — a §11 falsehood, not a display choice. `useDatetimeFormat`
    gained an optional override and `makeDatetimeFormatters` was extracted from
    it; there is still ONE formatter. **An unrecognised format INHERITS rather
    than being passed on**, because `formatDateValue`'s `default:` branch prints
    en-GB, so a stale override would silently render DD/MM/YYYY on a site set to
    MM/DD/YYYY.
  - The format vocabulary is LIFTED from `datetime.def.ts`, not invented — if a
    format is added there, add it to `TREND_WIDGET_DATE_FORMATS` in the same
    commit.
  - The alarms table's **unit legends (`(°C / %RH)`, `(H/m)`) and the H/m tooltip
    are NOT renameable** and survive a rename: they explain the cells, not the
    column's name.
- **The browser TAB is named and iconned from config (2026-09-03).** Two settings
  on the EXISTING `branding` def — `tabTitle` (default `T&RH-Monitoring`) and
  `faviconUrl` — plus `POST /api/uploads/branding-favicon`. **No count moved**: no
  migration, model, enum, permission, reauth action, config def, page or route; the
  same precedent as the four `alarm-limits` enable-attribute settings. The one that
  did move is `apps/web/src/lib/` 19 → 20 (`document-identity.ts`).
  - **`tabTitle` is NOT `appName` and must not be folded into it.** They have always
    been different strings, and `appName` is what the sidebar, header and login card
    print. Note this install had ALREADY set `appName` to `T&RH-Monitoring` while the
    tab still read "Compliance Core" — which is what prompted the request.
  - Applied by `apps/web/src/lib/document-identity.ts`, called from `useBranding()`
    beside the theme effect — the ONE place branding is resolved, and it runs on the
    login page too, so the tab is right before anyone signs in. **A blank value
    leaves the SHIPPED default from `index.html`**, never an empty tab or a
    broken-image icon.
  - **Both `<link>`s are rewritten and the `type` hint with them.** A stale
    `type="image/png"` over an uploaded `.ico` is the mismatch that reads as "I
    uploaded my icon and nothing happened".
  - **The `<link>` is REPLACED, never mutated** — a browser does not reliably
    repaint the tab from an `href` rewrite. A "simplification" back to
    `setAttribute('href', …)` leaves the config saving correctly while the tab keeps
    the old icon, with nothing on screen to explain it. The test asserts element
    IDENTITY, not the attribute, because the attribute assertion passes for the
    version that does not work. `apple-mobile-web-app-title` follows the title too
    — it is a `<meta>`, so "baked at build time" does not cover it.
  - **The card's client-side file check is deliberately LOOSER than the server's.**
    A `.ico` often arrives with an EMPTY `file.type`, so `!file.type.startsWith(...)`
    rejects the exact format the route exists for before the request is made. Only a
    positively-identified non-image is refused; magic bytes are the boundary.
  - **`BRANDING_TAB_TITLE_DEFAULT` in `@digilog/shared` is the ONE default.** No
    component may default the label to a literal (the `alarmTypeName()` precedent);
    `index.html`'s static `<title>` is the one unavoidable hand-kept copy, and it is
    HTML-escaped (`T&amp;RH-Monitoring`) while the config value is not.
  - **The favicon is a PATH, never a data URI** — `backgroundUrl`'s rule and its
    reason: a branding change is audited, and an inlined image lands twice in a §11
    before/after record. Do not raise the 512 cap to `logoUrl`'s 3,000,000.
  - **Its own upload route, deliberately.** `/branding-background` writes to the same
    directory and would have worked; the two differ in what they ACCEPT, and `.ico`
    belongs to favicons alone. `readValidatedImage` gained an `allowed` parameter
    rather than being forked, so the four upload routes cannot drift.
  - **SVG IS REFUSED AND MUST STAY REFUSED** — `/uploads/branding/` is in
    `PUBLIC_GET_PATHS` on the API's own origin, so an SVG favicon would be
    same-origin script execution for anyone holding `CONFIG_UPDATE`. A `.cur`
    renamed `.ico` is refused too (all four ICONDIR magic bytes are matched).
  - **The PWA manifest is NOT driven from config and cannot be** — `vite-plugin-pwa`
    bakes `name`/`short_name`/icons at build time. The INSTALLED app still reads
    DigiLog; only the browser tab is administered.
- **Boolean config settings render as an on/off TOGGLE, not a checkbox
  (2026-08-31, operator).** `components/ui/toggle.tsx`, swapped in at
  `dynamic-config.tsx`'s boolean branch, so it changes EVERY dynamic config page
  — one control style everywhere. `Checkbox` stays for selecting items from a
  list, which the same page still does for dynamic option sets.
- **Alarms page: the counts were window-limited, and are not any more
  (2026-08-31).** The page filtered and counted IN THE BROWSER over
  `?limit=500`, so the four state boxes described the newest 500 alarms while
  reading as plant-wide totals — the same defect shape as the 2026-08-27
  telemetry truncation, a `limit` and a range meeting in one query. All of it
  moved server-side. **Do not reintroduce a client-side count**;
  `filterByQuadrant()` / `quadrantCounts()` were deleted and a comment stands
  where they were. Deliberate departures from the supplied mock (no sparkline or
  "from yesterday" — nothing stores alarm-state history; no row kebab; canonical
  `<Pagination>`; theme-primary table banner rather than hardcoded indigo;
  cleared-unacknowledged stays AMBER, never neutral) are recorded in
  `CHANGELOG.md` with their reasons. Also fixed: the status pill was keyed off
  `severity`, so every pill rendered red on an installation where every alarm is
  CRITICAL.
- **Dashboard: the readings table shows Area and Location — there is NO Room
  column (2026-09-01).** It briefly had all three, and the Room one was removed
  the same day by the operator as a DUPLICATE. The measurement, not the eye:
  the cell's primary text was the instrument's `name`, and `name` WAS
  byte-identical to the `Location` attribute on **100 of the 100** instruments
  that carry one (true when measured; **since 2026-09-04 `name` = `code` on
  every instrument** — operator instruction, applied by
  `scripts/rename-instruments-to-code.ts` with 100 audit rows, so the room now
  lives ONLY in the `Location` attribute); its secondary line was blank on 88 of 101 rows, and on the 12
  traced QC rooms printed the room LABEL — the same room shouted. The room
  NUMBER never rendered at all, because `label` won whenever it existed.
  - **The justification it was kept under had already expired**, which is why it
    survived a redesign: "the SET POINT columns come FROM the room, so without it
    18.0-27.0 has no visible source". Provenance is the `setPointSource()`
    TOOLTIP, and limits resolve from the instrument's own attributes first with
    `limitSource` naming which. **Re-read a column's stated reason before quoting
    it — this one had been false for weeks.**
  - The room stays SEARCHABLE, the same call the Alarms page made: matching more
    than is shown can only return rows the caller could already see. The drawn
    room remains the graphical view's whole subject — it is the COLUMN that went,
    not the concept, which is still one of the three named above.
  - The freed 11% went mostly to Location (13% → 20%), which holds the longest
    text on the row.
  Both fields are resolved SERVER-side and the browser re-derives
  neither: the `Location` attribute comes off the attribute rows the query
  already selects for the limits, so no second query was added. Column widths are
  hand-balanced to 100% and pinned by `columnWidthTotal()`; the `<colgroup>` is
  generated from `COLUMN_GROUPS` so it cannot drift, but the percentages can.
  Empty states are worded APART — "Unassigned" for no functional location (the
  same word the Alarms page uses), "Not set" for an absent attribute. No CSS was
  added: both columns take the existing `tv-h-loc` hue, because the `.tv-*` block
  is deliberately UNLAYERED and a new rule there is not a free edit.
- **REPORT REVIEW WORKFLOW (2026-09-07, operator: "when ever user click on
  download then directly pdf should not download, as per requested time period
  data should go per review once review completed and approved then user and
  approved user can get that approved data in side bar new option there user can
  download reports, who ever requested and approved users electronic signatues
  should come if report was downlaoded").** Spec
  `docs/superpowers/specs/2026-09-07-report-review-workflow-design.md`, plan
  `docs/superpowers/plans/2026-09-07-report-review-workflow.md`. Every PDF
  download in the product (Data Report page card; trend page header, Time
  Series card, both chart cards, alarms widget; Alarms page; Audit Trail PDF)
  now renders the report as before and POSTS it as a REQUEST — the dialog gains
  **Send to** (a user or a role, never SUPER_ADMIN) and its button reads
  *Request approval*; the `DOWNLOAD_REPORT` re-auth is the request's signature.
  Nothing saves. An approver opens the **DRAFT** (watermarked, unsigned) on the
  new **Reports** sidebar page (`/reports`, three lists: For my approval, My
  requests, Approved) and approves or rejects with remarks + password; the
  requester, the approver and SUPER_ADMIN then download the approved copy with
  **Requested By / Approved By** lines (name, user ID, date-time). The Audit
  page's Excel export is not a PDF and stays direct.
  - **The snapshot is the record.** `ReportSnapshot` v2 (`lib/pdf-report.ts`)
    records EVERY drawing call — tables with bold and spans, pairs, titles,
    notes, chart rasters, page breaks — plus the chrome (legend, typography,
    app-name line). The DRAFT and the approved download are both replays
    through the one renderer, so what was reviewed is byte-for-byte what is
    downloaded apart from the watermark and the signature block. Rebuilding
    from parameters after approval could pick up late telemetry or a renamed
    alarm type and produce a document nobody signed. `normaliseSnapshot`
    refuses anything but v2 (no v1 rows exist; that table was dropped in the
    2026-07-18 strip).
  - **Party scoping and one decision** live in `modules/report-reviews/
    service.ts`: `isParty` / `isAssignee` are pure and unit-tested; a non-party
    gets 404; the requester can never decide their own request — the
    two-person control — **EXCEPT SUPER_ADMIN (2026-09-08, operator: "super
    admin should be able to approve own requests or other requests")**.
    `isSelfDecision` is the ONE rule, mirrored by the page's `mayDecide`; the
    consequence, stated when asked for, is that a super admin's own report
    carries the same name on both signature lines. It shipped the other way
    round for one day. The decision is a conditional UPDATE
    on `status = PENDING`, so two approvers cannot both sign (409). Nothing
    deletes a row. Mutation-checked both ways.
  - **Counts:** models 35 → **36**, enums 12 → **13**, modules 24 → **25**,
    permissions 42 → **44**, reauth 48 → **50** (categories 8), audit actions
    98 → **102**, templates 92 → **96** (categories 7), sidebar 13 → **14**,
    routes 51 → **52**, tree groups 12 → **13**, nodes 53 → **55**, feature
    privileges 41 → **43**. No config def, no page under `routes/config/`, no
    worker task. In-app notifications only (the three `REPORT_REVIEW_*`
    `NotificationType` values that survived the strip); email/SMS rules do not
    cover report events.
  - This REPLACES the module removed on 2026-07-18 (tag `pre-domain-strip`),
    without its second review stage. The flag-disabled `SendForReviewButton` on
    the Audit page — retained UI for that removed backend — went with it.
- **Which roles may APPROVE a report is ADMINISTERED (2026-09-07, operator:
  "that approval role should be configurable which role user should be approved
  that role will set by super admin in configurations").** Config def
  `report-approvers` (30 → 31 defs; SUPER_ADMIN-only; renders through the
  dynamic config page, `superAdminCards` card, page count unchanged): one
  `multiselect` of active roles loaded live through `dynamicOptionsSource`
  (`/api/roles/active`) — the mechanism existed and no def used it until now.
  - **`coerceApproverRoles()` in `@digilog/shared` is the ONE reader** of the
    stored row: the server's request check (`report-reviews/service.ts`), the
    narrow-slice route `GET /api/config/report-approvers/current`, and the
    Send-to picker. SUPER_ADMIN is stripped wherever it is read.
  - **Enforced on the REQUEST, server-side.** `POST /api/report-reviews` refuses
    a role outside the list (`ROLE_NOT_APPROVER`), a user whose role is outside
    it (`USER_NOT_APPROVER`), and — with the list EMPTY — every request
    (`NO_APPROVER_ROLE`, message naming the fix). The picker offers only the
    configured roles and the enabled users holding one, and with none configured
    shows the same message and no control; it is presentation, the 400 is the
    control. Mutation-checked (dropping the user-role check fails the e2e).
  - **Ships EMPTY and FAILS CLOSED**, like `inactivity-alarms` and for the same
    kind of reason: a report must not reach an approver nobody appointed.
    Consequence, stated plainly: after deploy NO PDF can be requested until a
    super admin ticks a role once under Configuration → Report Approvers.
  - Approving still needs `REPORT_REVIEW_APPROVE` and the request assigned to
    you or your role; the list governs who a request may be SENT to. A pending
    request survives a later config change — it is a record.
  - No migration, model, enum, permission, reauth action, page or sidebar item.
    Not seeded; the e2e pins its own row and restores it first in `afterAll`.
- **ATTRIBUTE DISPLAY NAMES (2026-09-16, operator: "for attributes key i need
  key is one thing and that key display name should be configurable").** An
  attribute KEY is the stored identity — what a device writes over MQTT, what
  the CSV importer reads, what an audit row names, what the alarm-limits alias
  lists match on. None of that moved. What moved is the word a PERSON reads
  beside the value. Config def `attribute-labels` (31 → **32** defs;
  SUPER_ADMIN-only; ONE `json` setting `labels: {key: name}`; a `zodSchema`
  refuses a non-map body or an over-long name). **Edited as a Display name
  column beside each key on Configuration → Instrument Attributes** — a
  separate card and page lived for a few hours and went on the operator's
  "dont give as seperate configuration add in instrument attributes
  configuration"; pages stay **23**, routes stay **53**. Served to EVERY
  authenticated user by `GET /api/config/attribute-labels/current` (the EIGHTH
  narrow-slice route), read in the browser by ONE hook,
  `hooks/use-attribute-labels.ts` (22 → **23** hooks). No migration, model,
  enum, permission, reauth action, module or sidebar item.
  - **GLOBAL map, edited per profile.** A key means the same thing wherever it
    appears, so one `attribute-labels` row holds every name; the Instrument
    Attributes page shows and edits the names of the SELECTED profile's keys.
    `mergeLabels()` (exported from `routes/config/instrument-attributes.tsx`,
    pure) writes this profile's rows over the stored map, clears a name on
    blank, carries a name across a key RENAME, and drops the name of a key that
    left this profile unless another profile still lists it. Save PUTs the
    WHOLE map (the dynamic PUT replaces the row) and only when names or keys
    changed; the profile is rewritten only when keys changed.
  - **`coerceAttributeLabels()` / `attributeLabel()` in `@digilog/shared` are
    the ONE reader and the ONE lookup.** Blank falls back to the KEY, never to
    an empty heading (the `alarmTypeName()` rule); lookup folds case, as
    `parseInstrumentAttributeKeys` and the Attributes panel already do. No
    component may default a label to a literal.
  - **Where the name shows — and ONLY the name** (operator: "in instruments
    page or settings page only attributes display names should be display"):
    the New Instrument form's field labels, the Attributes panel (detail page
    and the Settings Edit dialog), the Settings widget tiles, the Attribute
    Access key picker, and the BULK UPLOAD TEMPLATE's column headings. The key
    is not printed beside the name anywhere; it rides in a `title` tooltip on
    the panel and picker labels. **Where the KEY stays:** MQTT payloads, audit
    rows, `Delete <key>` button names and the fill input's `aria-label`, the
    alarm-limits alias lists, and the Add-attribute dialog, which still asks
    for the key because the key is what is stored.
  - **The bulk-upload template carries the profile's ATTRIBUTES, headed by
    display names (2026-09-16, operator: "in bulk upload template only
    attributes display names should come").** Until then the template carried
    NO attribute columns at all (`name,code,instrumentType,…`) and the importer
    read none. Now: the template is built per chosen profile — an `Instrument
    ID` column (the create form's words; operator: "in bulk option in template
    Instrument ID field and Instrument Profile selection dropdown"), then one
    column per key the profile asks for, headed `labelFor(key)`; the Download
    button is disabled until a profile is chosen. The parser normalises an
    `Instrument ID` heading to `code` and still accepts `code` for files
    operators already have. `parseInstrumentCsv(csv,
    attributeColumns)` maps a heading back to the KEY by display name OR by key,
    case-folded, so a file headed by keys still imports; a heading that is
    neither is ignored with ONE whole-file warning (a typo must not become an
    attribute). The route resolves the columns (`bulkAttributeColumns`) and,
    after each instrument's own transaction, `writeInitialAttributes` upserts
    the filled cells with one `INSTRUMENT_ATTRIBUTE_SET` audit row per key (a
    first fill, no remark) and announces each to the device — the single form's
    per-attribute POSTs, without the HTTP. **`name` is no longer a required
    column**: blank or absent = the code, as the create form has filled it since
    2026-08-07; a `name` column given is still honoured. The parser stays pure —
    its tests take the columns as an argument.
  - **`hasCustomPage` is FALSE on the def** — `true` would skip the generic
    `/dynamic/attribute-labels` GET/PUT, which is the endpoint that validates
    against `zodSchema`, enforces `requiredRole` and writes the `CONFIG_CHANGED`
    audit row. `customPagePath` points at `/config/instrument-attributes`, and
    `config/index.tsx` names `attribute-labels` in its hardcoded-key exclusion
    set so the auto-discovered section never offers a second door.
  - Pinned by 11 shared unit tests, 6 API e2e (`attribute-labels.e2e.test.ts`,
    non-admin reads / SUPER_ADMIN-only writes / COERCED read-back asserted key
    by key over HTTP), 7 parser cases + 1 bulk e2e (`bulk-attributes.e2e.test.ts`:
    display-name headings land as attributes stored and audited BY KEY, blank
    cells not written, unknown heading warns once), 5 hook, 4 Instrument
    Attributes page cases (incl. the rename carry-over), 5 bulk-template cases,
    and one case each on the form, panel, Settings and Attribute Access tests.
    Mutation-checked: the case-fold, the response schema's `additionalProperties`,
    and the merge's left-this-profile rule.
- **The New Instrument form's Instrument ID field carries NO pattern, hint or
  placeholder (2026-09-16, operator: "dont put any instructions, user will
  enter different Instrument ids format so it should not restricted").** The
  browser pattern it carried since the trim (`[A-Za-z0-9._-]`) refused `/`,
  which 100 of 101 codes here carry — so `CWH/RDU/002-00` could not be created
  through the form at all, only by CSV. **The server rule is UNCHANGED and is
  the only limit**: `instrumentCodeTopicViolation()` still refuses `+`, `#`,
  NUL and a reserved last segment, and the form still states that reason in a
  toast. Do not put the pattern back; do not relax the server rule (see the
  MQTT client-id note). Pinned by `create.test.tsx` (no `pattern`/`title`/
  `placeholder`; a slash code is sent unchanged).
- **SETTINGS: one instrument picker, one square widget of its identity,
  placement and attributes (2026-09-08, operator: "in side bar add settings,
  in that page show the instrument details and attributes, there selected user
  role should edit details, view details", then "in a square widget i need
  Instrument ID and value, Area and Value, Building, and all the attribute keys
  and attributes values, these common settings on top user will select
  instrument … what ever instruments assigned to that user, only that
  instruments should come in selection").** `routes/settings/index.tsx` at `/settings`,
  sidebar item `settings`, permission-tree group `settings` with TWO
  configurable nodes — `settings.view` (gate `INSTRUMENT_READ`) and
  `settings.edit` (gate `INSTRUMENT_UPDATE`) — so who may view and who may edit
  is a Roles & Access → Sidebar toggle per role. **No new permission**: it
  shows and changes instruments, so it is governed by the permissions that
  already do. Counts: sidebar items 14 → **15**, routes 52 → **53**, tree
  groups 13 → **14**, nodes 55 → **57**, feature privileges 43 → **45**; no
  permission, reauth action, model, enum, config def, migration or API change.
  - **A Common settings bar with ONE instrument picker, then ONE full-width widget** (square for an hour, then "remove the square shape, make widget full width")
    of key / value rows: Instrument ID, then every attribute (the server's
    `display` form where given). "Assigned to that user" is the instrument
    scope, applied by the SERVER on `GET /api/instruments`; the picker offers
    exactly what came back. **Building and Area are ATTRIBUTES here (100 of
    100 instruments carry both) and print once, as attributes.** A cut that
    also synthesised them from the functional location drew "why area and
    building coming 2 times"; do not add placement rows beside the attributes.
  - **The widget is read-only; Edit opens the existing `AttributesPanel` in a
    dialog for THIS instrument** (operator's choice over per-row pencils). The
    panel carries the whole §11 flow wherever it is mounted (Attribute Access
    rule, mandatory remarks, re-auth) and shares the widget's SWR key, so a save
    is on the widget when the dialog closes. Identity and placement are not
    editable here; details still change on the Instruments detail page.
    `settings.edit` shows the button — presentation; the attribute routes are
    the control.
  - **The first cut was a TABLE of every instrument with expandable rows and an
    inline details form (`bee0363`, one commit)** and was replaced the same day
    on the operator's restatement. Do not bring the table back as a "second
    view" — the operator wants the widget.
  - The Instruments sidebar item and its pages are untouched. Nothing is
    granted by default — Roles & Access must grant `View Settings` /
    `Edit Settings`.
- **The Instrument History widget is the DATA REPORT PAGE, not a dashboard
  panel (2026-09-07, operator: "in dashboard Instruments history widget was
  there that widget removed there and add one side bar option Data Report, in
  that it should come").** `routes/data-report/index.tsx` mounts
  `routes/instruments/history-widget.tsx` under a page header at `/data-report`;
  sidebar item `data-report` and permission-tree group `data-report` (one node,
  `data_report.view`, gated on the EXISTING `INSTRUMENT_READ` — it shows
  instrument readings) make it a Roles & Access → Sidebar toggle. Counts:
  sidebar items 12 → **13**, routes 50 → **51**, tree groups 11 → **12**, tree
  nodes 52 → **53**, feature privileges 40 → **41**; no permission, reauth
  action, model, enum, config def or migration. The panel key
  `dashboard_history` is OUT of `PANELS` / `DEFAULT_DASHBOARD_LAYOUT` /
  `AUTO_HEIGHT_PANELS` — which is what takes it off the dashboard and off
  Roles & Access → Panels, the `dashboard_trend` precedent; **0 stored layouts
  named it** (role_configs / user_configs / system_config, measured before
  removal). The widget's `embedded` prop and header portal went with the panel
  as dead code; it prints NO title of its own (the page header does). The
  download's dialog name, file name and audit `reportType` read **`Data
  Report`**; rows logged 2026-09-05..07 read `Instrument History` and, being
  §11 records, were not rewritten. The Export Options surface KEY stays
  `instrument-history` (stored per role in `system_config`); only its label
  follows the page.
  **Later the same day:** the download moved OUT of the widget into a
  **Generate Data Report card** above it (`routes/data-report/
  generate-report-card.tsx`, text + one icon, the page's only trigger); the
  selection moved into the page hook `use-history-scope.ts` shared by card and
  widget; and the document lost its cover block — `renderDataReports` prints
  one Data Report page per selected instrument, each identical to the trend
  page's Time Series download, audit `reportType` **`Instrument Time Series`**
  (operator: "report should be same report of time series widget"). **And the
  trend page's HEADER "Export as PDF" is now that same Data Report** with the
  interval dialog, not the combined charts document ("in that report trends
  also coming remove those and add interval feature"); `TrendSlot` lost `both`.
  **And an extreme prints only for a bound IN FORCE** ("if Enable_Humid_NLT is
  disabled then dont show RH min in report, if nmt is disabled then dont show
  max … in all data reports"): `extremesCells` in `data-report.ts` follows the
  bound the server resolved (`limits`, already null for a disabled bound), so
  NMT-only instruments print `Temp. Max : 22.9` alone — a deliberate departure
  from `Data Report.pdf`. Never-administered reads as switched off;
  `limitEnabled` still never gates display. **And no report table ever has an
  empty cell** ("if value was not there dont show that boxes", "same for alarm
  report also"): `addTable` body cells may span columns (`SpanCell` in
  `lib/pdf-report.ts`) — the Data Report's lone Max / Min pair and its
  `Interval :` row span the row, a row with nothing to print is omitted; the
  Alarms page's report prints `''` for a switched-off bound (`BOUND_NOT_SHOWN`,
  not a dash; `N/A` unchanged) and DROPS a limit column no row can fill
  (`hiddenLimitColumns`). An `unboxEmpty` flag that hid the empty cell's border
  lasted one commit (`91511e8`) — it left tables with open corners ("table was
  not forming properly"); do not bring it back. **The Trend report's period
  summary follows the same rule** ("same in trends page also"): `Minimum` /
  `Maximum` only for a bound in force, the below / above line only for the
  assessed side(s).
  No count moved. See `apps/web/CLAUDE.md`.
- **The dashboard's selection alarms panel is the SHARED alarm table
  (2026-09-01).** `routes/dashboard/selection-alarms.tsx` was a bespoke `<ul>`;
  it now renders the cells from `routes/alarms/alarm-table.tsx`, the same ones
  the Alarms page and the trend widget use — a THIRD copy would have drifted the
  way the trend widget's copy did. It shows EIGHT columns plus an action cell,
  not twelve: its query is `state=ACTIVE`, so Cleared, Cleared Value and Duration
  would be structurally blank. **Acknowledging IS available and carries the whole
  §11 flow** — the `alarms.acknowledge` gate, the re-auth dialog, `postWithReauth`
  and a revalidation. It shipped without the button earlier the same day,
  correctly, because it had none of those; if one is ever stripped, strip the
  button with it. **Its action column is NOT sticky, and the column count argued
  the other way** — what decides it is that a sticky cell needs an opaque
  background, and this panel is deliberately transparent so the operator's
  PanelCard tint shows.
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
- **The QC floor is TRACED, not generated (2026-08-31).** Every other plan comes
  out of `scripts/draw-cwh-floorplan.ts`'s guillotine split, which invents a
  plausible floor from a room count. QC is the one floor we have a drawing of
  (`QC Layout.png`), so its rooms are authored as literal measured coordinates
  in `apps/api/src/modules/floorplans/qc-layout.ts` and the generator is
  bypassed for that area alone. **No count moved** — no model, enum, migration,
  permission, module, config def or route; 23 rows in `floorplan_rooms` changed.
  - **Room codes on this plan are ROOM numbers (`CWH-I/216`..`/233`), not
    instrument codes**, and `label` carries the room name. That reverses the
    premise recorded against `GET /api/alarms` above — see it for what follows.
  - Wall positions were MEASURED off the PNG (dark-pixel run scan, clustered),
    not eyeballed; doors came from the wall gaps cross-checked against the
    orange swing arcs, isolated by colour. The pixel coordinates are kept in the
    table rather than pre-divided decimals so the next person can re-measure
    against the same image and compare like with like.
  - **Every edge is quoted from one canonical grid, and a test enforces it.**
    The generator got exact tessellation for free — a guillotine cut cannot
    overlap or leave a gap. A hand-traced table only gets it by discipline, so
    `__tests__/qc-layout.test.ts` asserts no two rooms overlap, every edge is
    on the measured grid, coverage is above 95% (0.9694 as written), no door
    overruns its wall, and
    each of the 12 instruments lands in the room `CWH.xlsx` names. Mutation-
    checked: overlapping two rooms fails 2 of them.
  - **Two rooms are knowingly approximate**, because a room is ONE rectangle.
    SAMPLE PREPARATION (`CWH-I/222`) is an L and is stored as its bounding box,
    losing one internal partition — splitting it would have to invent a wall,
    and a false wall says a space is closed when it is open. CORRIDOR-08 IS
    split, into `CWH-I/217` and `CWH-I/217 (2)`, since its two legs read as two
    runs and the drawing dimensions them separately; the `(2)` suffix is the
    precedent already used for SERVICE CORRIDOR.
  - **HPLC ROOM is drawn with NO door** — all four of its walls scan continuous
    in the drawing. Reproduced rather than corrected: inventing a door on a GMP
    plan is inventing a means of escape. Fix the drawing first.
  - **Grades still come from the instrument's own limits**, exactly as the
    generated plans do, so the whole floor reads grade C. The drawing's colours
    encode room FUNCTION, which is not a cleanroom classification — painting an
    office blue to match would make the on-screen "grade" legend lie.
  - **Bypassing `canvasFor(roomCount)` costs nothing here, but check it if the
    room count moves.** That function keeps a ROOM the same size across plans so
    the set reads as one building; the traced plan has to use the building's own
    proportions instead. They happen to agree — `canvasFor(23)` gives a viewBox
    height of 958, the building gives 901.
  - `--only <area>` was added to the script so redrawing one floor does not
    delete and recreate every room on all eight plans; each room is a §11 record
    and re-signing a hundred nobody touched makes the audit trail describe work
    that did not happen.
  - **The rest of the drawing landed the same day** (operator reaffirmed three
    times that they wanted the plan exactly as drawn, not the rooms alone).
    Migration `20260831220000_floorplan_annotations` adds TWO NULLABLE JSONB
    COLUMNS and nothing else — `floorplan_rooms.meta` `{fill, fch, dims}` and
    `floorplans.annotations` `{equipment, hvac, water, airflow, labels}`. Same
    shape as the `doors`/`grade` additions, and for the same reason: a drawing's
    vocabulary grows, and a migration per annotation kind is a tax on
    transcribing one. **Models stay 35, enums stay 12.** NULL on every generated
    plan, which renders exactly as before.
    - **`meta.fill` OVERRIDES the grade hue, and that is safe only because the
      grade legend and tab were both removed on 2026-08-24/27.** The
      draughtsman's colours say what a room is FOR; `grade` says how it is
      classified. Both are stored, and `grade` is still returned and still
      correct. **If a grade legend ever comes back, it must not key off the
      fill** — on this plan they disagree by design.
    - **`fch` and `dims` are transcribed STRINGS, never computed.** The drawing
      is schematic and not to scale, so deriving a size from `w`/`h` would print
      a number the plan does not carry.
    - **Nothing in the annotation layer ever takes a status colour.** An HVAC
      symbol is where a unit is DRAWN; nothing in this install senses one, and
      colouring it would assert a health nobody measured. The whole layer is
      `pointerEvents="none"` so a symbol cannot swallow a click meant for the
      room under it.
    - `tileLayout()` gained a `headerH` parameter. A traced room prints four
      caption lines where a generated one prints one, and the tile grid is sized
      from the leftover — a view that drew four lines into the old 14px header
      would lay the first row of READINGS on top of them.
    - **Three things in the PNG are still deliberately absent.** The `EXHAUST`
      arrows and the two `W` circles are drawn OUTSIDE the building wall (to
      x=1190, past the wall at 1108) and the renderer strokes the viewBox border
      as that wall, so anything beyond it is clipped: the water points were moved
      onto the east wall where they connect, and the external exhaust arrows are
      omitted. `DRAFT COPY` / `EXISTING LAYOUT` are drawing-status stamps, and a
      live monitoring screen captioned DRAFT COPY would be actively misleading
      about the readings on it. And the `2900 x 7240` partition inside SAMPLE
      PREPARATION, as above.
    - Pinned by `src/e2e/floorplan-annotations.e2e.test.ts` — which asserts on
      the JSON that actually LEAVES the route, inner keys individually, because
      Fastify strips undeclared response properties silently and this repo has
      been bitten by that twice. Mutation-checked: dropping `labels[].text` from
      the schema fails it.
- **The Time Series widget's download is the DATA REPORT (2026-09-04)** — built
  to `Data Report.pdf` at the repo root, the way the Alarm Report was built to
  `Alarm Report.pdf`. Pure layout in `routes/instruments/data-report.ts`,
  rendered by `renderDataReport`. Interval rows are a SCHEDULE anchored on the
  FIRST READING, one slot per interval to the period end, each the FIRST STORED
  READING in it or `NA`, printed NEWEST FIRST (2026-09-05; until then buckets
  were aligned to the period start, oldest first, gaps omitted). Limit crossings
  and the `Error`/`OL` words print bold; the interval is chosen in the download
  dialog. `pdf-report.ts` gained per-report typography (`ReportConfig.typography`,
  `showAppName`, `addTable.bold`) — the Data Report opts up, every other report
  prints as before. Max/Min come from the server's whole-range `summaries`, never
  the printed rows; Block/Area resolve by id through `/api/functional-locations`,
  Location is the attribute. Audit type stays `Instrument Time Series`. See
  `CHANGELOG.md`.
- **Instrument trend page (2026-08-24):** new route `/instruments/:id/trend`
  — period + interval header, latest-value cards, limit-lined charts (reusing
  `TimeSeriesChart`), a raw paged time-series, an alarms widget, per-user
  extra telemetry keys in `localStorage`. New shared module
  `packages/shared/src/types/telemetry-period.ts` (period presets, interval
  specs, range resolution). Aggregation is an explicit OPT-IN and defaults to
  `raw`: when an interval IS selected the chart averages client-side and says
  so on screen ("Averaged over 5 minutes — the table below shows every
  reading") — a derived point must never look like a stored reading. Wide
  ranges are handled by SELECTION instead, not by averaging — see the
  2026-08-27 note below.
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

- **Trend page: wide ranges are SAMPLED, and the range figures are true
  (2026-08-27).** No count moved — no model, enum, permission, reauth action,
  config def, module or route was added. Spec:
  `docs/superpowers/specs/2026-08-27-instrument-trend-page-design.md`.
  - **The bug this fixed.** `GET /:id/telemetry` silently capped at the newest
    1000 readings (`Math.min(limit, 1000)` with `ORDER BY ts DESC`) for ANY
    range. A 7-day or 30-day chart therefore plotted roughly the last DAY while
    the axis claimed a week, and every figure derived from it described that
    slice. The PDF report's own fetch had the same defect. Nothing on screen
    said so — this is the shape of defect to look for whenever a "limit" and a
    "range" meet in one query.
  - **Downsampling is by SELECTION, never by averaging.** `lttb()` in
    `@digilog/shared` (`types/telemetry-downsample.ts`,
    Largest-Triangle-Three-Buckets) returns a subset of the input array —
    every plotted point is a STORED reading at its STORED timestamp, and the
    unit tests assert reference equality (`toBe`) so a refactor that builds new
    objects fails. First and last readings are always kept, or the chart's
    x-extent would disagree with the range asked for. Averaging is a separate,
    opt-in, labelled control and is off by default.
  - **When a chart is showing a subset it SAYS SO on screen** —
    `sampled-note.tsx`: "Showing 2,000 of 28,431 readings." `shown` is the RAW
    READING COUNT, not the number of points after any client-side bucketing;
    quoting the bucket count would understate what the range was read from.
  - **Out-of-limit counts and the readings count come from SQL over the WHOLE
    range** (`telemetry.repository.ts:getRangeSummary`), never from the plotted
    subset, so a sampled chart cannot understate an excursion. Which figures
    the signed PDF swaps for the server's and which stay row-derived is decided
    in ONE place — `routes/instruments/trend-summary.ts:withServerSummary` —
    and the reasoning is written beside it. Read it there, not from here.
  - **Zoom REFETCHES; it does not magnify.** Drag-selecting a span sets a
    custom range and requests it fresh, so zooming into a sampled 30-day view
    reveals the true raw readings for the narrower window. Magnifying the
    subset already in hand would draw bigger dots and claim a resolution the
    client does not have.
  - **The signed PDF's banner was REWORDED, because fixing the truncation
    turned a true disclosure into a false one.** It used to say the report
    covered "the most recent portion" of the period — true under `ORDER BY ts
    DESC`, false once the rows are spread across the whole range by sampling. A
    disclosure is a §11 claim and goes stale when the thing it discloses is
    fixed; check the wording whenever the data path under it changes.

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
  (**`PROJECT_ARCHITECTURE.md` and `PROJECT_SUMMARY.md` were REWRITTEN 2026-08-29** — audit finding M6. The previous versions are `docs/archive/PROJECT_{ARCHITECTURE,SUMMARY}-2026-07-04.md`. Between them they documented an `apps/android/` Capacitor wrapper, an `rfid_scan_app/` Kotlin scanner and a committed `rfid-key.jks` signing keystore, none of which exist here — the keystore line in particular manufactured a security incident for anyone who read it. Both carried drift-warning banners, and `PROJECT_SUMMARY.md` contradicted its own banner forty lines later by listing `rfid_scan_app/` in its directory tree. A banner over false content is not a fix. `bloat.md` was archived the same day for the same reason: an optimisation audit of `routes/mobile/`, a folder that does not exist, sitting at the repository root.)
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
