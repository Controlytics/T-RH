# Phase 2 — Project Inventory

*Every count below is followed by the command that produced it, run 2026-07-25.
Counts marked "2026-08-01" were re-verified after the Data Injection (P1)
foundation landed — see §11. Counts marked "2026-08-03" were re-verified
after Data Injection P3 (alarms & instrument liveness) landed — see §12.*

---

## 1. Repository structure

```
compliance-core/
├── apps/
│   ├── api/                  Fastify 5 backend (TypeScript, ESM)
│   │   ├── prisma/           schema.prisma, migrations/, seed.ts, default-roles.ts
│   │   └── src/
│   │       ├── app.ts        composition root — plugin + route registration
│   │       ├── modules/      18 feature modules (routes/service/schema per module)
│   │       ├── lib/          22 cross-cutting libraries (audit, jwt, hash-chain…)
│   │       ├── plugins/      auth.ts, rbac.ts (Fastify plugins)
│   │       ├── workers/      3 graphile-worker task handlers
│   │       └── e2e/          end-to-end test suites
│   └── web/                  React 19 + Vite 6 SPA
│       └── src/
│           ├── main.tsx      router — 38 <Route> definitions
│           ├── routes/       11 route groups
│           ├── components/   layout, UI primitives, dialogs
│           ├── hooks/        17 custom hooks
│           └── lib/          20 client libraries
├── packages/
│   ├── shared/               Zod schemas + PERMISSION_TREE (source of truth)
│   └── queue/                graphile-worker wrapper
├── scripts/                  16 PowerShell install/ops scripts
├── certs/                    mkcert TLS certs for local HTTPS
└── docs/recreation/          ← this dossier
```

**No `apps/android`, no `rfid_scan_app`, no `packages/db`.** See
[`absent-subsystems.md`](absent-subsystems.md).

```bash
ls apps/        # → api web
ls packages/    # → queue shared
```

## 2. Headline counts (verified 2026-07-25; re-verified 2026-08-01 after P1; re-verified 2026-08-03 after P3 — see §11, §12)

| Metric | Count (2026-07-25) | Count (2026-08-01, P1) | Count (2026-08-03, P3) | Command |
|---|---|---|---|---|
| API modules | 18 | 22 | **24** | `ls apps/api/src/modules/ \| wc -l` |
| API paths (OpenAPI) | 139 | 153 | **166** | `curl -sk https://localhost:3001/docs/json \| jq '.paths \| length'` |
| Prisma models | 23 | 30 | **36** | `grep -cE '^model ' apps/api/prisma/schema.prisma` |
| Prisma enums | 6 | 8 | **12** | `grep -cE '^enum ' apps/api/prisma/schema.prisma` |
| DB triggers | 1 | 1 (unchanged — P1 adds no trigger) | 1 (unchanged — P3 adds no trigger; the two P3 partial unique indexes are indexes, not triggers) | `pg_trigger` where not internal |
| DB custom functions | 1 | 1 (unchanged) | 1 (unchanged) | `block_audit_trail_delete` (rest are pgcrypto) |
| DB views | 0 | 0 | 0 | — |
| DB sequences | 1 | 1 (unchanged) | 1 (unchanged) | `audit_trail_chain_position_seq` |
| Frontend routes | 38 | 44 | **46** (45 after P2 added the instrument-detail route) | `grep -cE '<Route' apps/web/src/main.tsx` |
| Frontend route groups | 11 | 12 | 12 (unchanged — the P3 alarm queue is a route inside the existing `data-injection` group, not a new group) | `ls apps/web/src/routes/` |
| Config pages | 21 | 21 (unchanged — P1 has no config page; see `uns-settings` note in §11) | 21 (unchanged — P3's `liveness` def also renders through the dynamic config path) | `ls apps/web/src/routes/config/*.tsx` |
| Config definitions | 21 | 22 | **24** (23 after P2's `telemetry-retention`; P3 adds `liveness`) | `ls apps/api/src/modules/config/defs/*.def.ts` |
| Custom hooks | 17 | 17 (unchanged) | 17 (unchanged) | `ls apps/web/src/hooks/*.ts` |
| Client libs | 20 | 20 (unchanged) | 20 (unchanged) | `ls apps/web/src/lib/*.ts` |
| API libs | 22 | 22 (unchanged) | 22 (unchanged) | `ls apps/api/src/lib/` (excl. tests) |
| Permission constants | 30 | 46 | **49** | `grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts` |
| Reauth actions | 39 | 51 | **53** | `grep -cE '^\s+[A-Z_]+:' packages/shared/src/types/reauth-actions.ts` |
| Feature privileges | 26 | 34 | **38** | executed built `PERMISSION_TREE` — `configurable: true` node count (see `../04-roles-permissions/README.md`) |
| Sidebar permission groups | 8 | 9 | 9 (unchanged — alarms/thresholds hang off the existing `data-injection` group, no new sidebar item) | `PERMISSION_TREE` groups |
| Sidebar items (configurable) | 9 | 10 | 10 (unchanged) | `sidebar-items.ts` |
| Roles (seeded) | 6 | 6 (unchanged) | 6 (unchanged) | `select count(*) from roles` |
| Background job tasks | 3 | 3 (unchanged) | **4** (`instrument_liveness_sweep` added) | `notification`, `password_expiry_check`, `session_sweep`, `instrument_liveness_sweep` |
| Color themes | 10 | 10 (unchanged) | 10 (unchanged) | `apps/web/src/lib/themes.ts` |

**Note on Feature privileges (38) and Reauth actions (53):** the P1-era
derivation walkthrough directly below (26→34, resolved 2026-08-01) predates
P3 and has not been re-verified against a rebuilt `PERMISSION_TREE`/reauth
category list; 38 and 53 are the flat counts team-lead measured against the
current `packages/shared` source on 2026-08-03. The detailed category/node
breakdown in `../04-roles-permissions/README.md` was **not** updated as part
of this doc-sync pass — it still describes the P1 state (46 permissions / 51
reauth / 9 groups / 54 nodes) and needs its own pass.

**Feature-privilege count, resolved 2026-08-01.** The initial pass here
flagged the "26" baseline as unreconcilable against a source-grep of
`configurable: true` (which read 45 across the whole tree, not "26 + 16").
That was a source-derivation artifact, not a real discrepancy: executing the
*built* `PERMISSION_TREE` (`node -e "require('./dist/...')..."`, with the
branch settled and `packages/shared` freshly rebuilt) gave **42 configurable
nodes** — exactly 26 + the 16 new Data Injection nodes, all of which were
configurable at that point.

**Revised same day, final whole-branch review (finding I4).** 8 of those 16
Data Injection nodes — `gateways.create/.edit/.delete`,
`instruments.edit/.delete`, `comm_profiles.create/.edit/.delete` — advertised
a role-config toggle with no UI behind it (`gateways.tsx`, `profiles.tsx` and
`instruments.tsx` are read-only tables; only `hierarchy.tsx` has full CRUD
and `instrument-wizard.tsx` has Create). They were switched to
`configurable: false` — routes stay enforced, only the picker toggle is
hidden. **34 is the current verified figure**; see
`../04-roles-permissions/README.md` for the full derivation.

## 3. The 24 API modules (18 pre-P1 + 4 added by Data Injection P1 + 1 by P2 + 1 by P3)

> **P2 (2026-08-02)** added `data-injection` — the MQTT adapter, topic router,
> payload parser, fan-out, telemetry repository, connection manager and ingestion
> service. Verified `ls apps/api/src/modules/ | wc -l` = 23.
>
> **P3 (2026-08-03)** added `alarms` — alarm list/get/acknowledge, threshold
> CRUD, and the resolved-thresholds-per-instrument read. Verified
> `ls apps/api/src/modules/ | wc -l` = 24.

| Module | Paths | Responsibility |
|---|---|---|
| `config` | 35 | 21 config surfaces + dynamic config registry |
| `notification-delivery` | 14 | templates, logs, email/SMS delivery settings |
| `users` | 12 | user CRUD, lock/unlock, password reset, stats |
| `notifications` | 9 | per-user notification inbox |
| `dashboards` | 9 | dashboard definitions, widgets, assignment |
| `auth` | 9 | login, logout, refresh, me, change-password |
| `super-admin` | 7 | API lock, data console, unretire |
| `audit` | 7 | query, export, verify-chain, redact, delete |
| `roles` | 6 | role CRUD, access matrix, active roles |
| `notification-rules` | 5 | event → recipient rules |
| `debug-traces` | 5 | audit-backed pipeline trace viewer |
| `user-groups` | 4 | group CRUD + membership |
| `help` | 4 | help articles + versioning |
| `admin-requests` | 4 | request → approve/reject workflow |
| `ldap` | 3 | optional directory integration |
| `backup` | 3 | export / restore / schedule |
| `uploads` | 1 | file upload (multipart) |
| `system-health` | 1 | health metrics |
| *(root)* `health` | 1 | liveness probe |
| `hierarchy` | 3 unique paths (5 route defs) | **P1** — location tree CRUD + move (§11) |
| `gateways` | 3 unique paths (5 route defs) | **P1** — protocol gateway CRUD (§11) |
| `instruments` | 4 unique paths (6 route defs) | **P1** — instrument CRUD + resolved-topics endpoint (§11) |
| `communication-profiles` | 3 unique paths (5 route defs) | **P1** — broker/endpoint credential profiles + protocol registry (§11) |
| `alarms` | 6 unique paths (7 route defs: `/api/alarms` × 3, `/api/alarm-thresholds` × 3, plus `GET /api/instruments/:id/thresholds` mounted under the `instruments` prefix) | **P3** — alarm queue, §11.50 acknowledgement, threshold CRUD (§12) |

```bash
sed 's|^/api/||' be.txt | cut -d/ -f1 | sort | uniq -c | sort -rn
```

The "unique paths" figure is what the OpenAPI path count (§2) reflects; the
"route defs" figure counts `app.get/post/put/delete(...)` call sites, which is
higher wherever two HTTP methods share one path (e.g. `GET /` and `POST /`).

## 4. Cross-cutting libraries (`apps/api/src/lib/`)

Grouped by concern — these are the pieces a rebuild must reproduce faithfully:

**Compliance-critical**
- `audit.ts` — the audit writer; appends hash-chained rows
- `hash-chain.ts` — V1/V2 unkeyed SHA-256, V3 keyed HMAC-SHA256
- `audit-verify.ts` — chain-walk verification
- `audit-diff.ts` — before/after value diffing for audit detail
- `reauth-check.ts` — re-authentication enforcement (10s cache)

**Identity**
- `jwt.ts`, `password.ts`, `password-validator.ts`, `password-expiry.ts`,
  `user-id-validator.ts`, `super-admin-lock.ts`

**Infrastructure**
- `prisma.ts`, `config-discovery.ts`, `config-registry.ts`, `errors.ts`,
  `error-schemas.ts`, `build-context.ts`, `swagger.ts`, `uploads-dir.ts`,
  `format-datetime.ts`

**Security**
- `sanitize.ts` — HTML stripping on all text input
- `mask-secrets.ts` — redacts secrets from config responses/logs

## 5. Frontend structure

**Route groups** (`apps/web/src/routes/`): `admin-requests`, `audit`, `auth`,
`config`, `dashboard.tsx`, `debug`, `home`, `notifications`, `profile`,
`system-health`, `users`.

**Hooks** (17): `use-auth`, `use-branding`, `use-can`, `use-datetime-format`,
`use-drag-scroll`, `use-export-limit`, `use-export-options`, `use-field-labels`,
`use-pagination-config`, `use-reauth`, `use-report-labels`,
`use-report-page-titles`, `use-role-colors`, `use-session`, `use-single-tab`,
`use-super-admin-lock`, `use-toast`.

**Client libs** (20): `api-base`, `api-client`, `cn`, `datetime-input`,
`excel-export`, `export-surfaces`, `format-by-least-count`, `password-utils`,
`pdf-report`, `report-export-log`, `report-labels`, `report-review`,
`report-types`, `resolve-bulk-targets`, `server-contact`, `swr-config`,
`theme-styles`, `themes`, `timing-constants`, `url-utils`.

## 6. The 21 configuration definitions

Auto-discovered at boot by `lib/config-discovery.ts` and registered into
`lib/config-registry.ts`. Boot log confirms: `[config-registry] 21 modules registered`.

`access-matrix`, `action-reauth`, `audit-templates`, `backup`, `branding`,
`datetime`, `export-limit`, `export-options`, `field-ids`, `help`,
`login-security`, `notification-email`, `notification-logs`,
`notification-rules`, `notification-sms`, `pagination`, `password-policy`,
`report-page-titles`, `roles`, `session`, `user-id`.

**Adding a config def touches multiple files** — the def, the discovery import,
the config index card, and (unless it uses the dynamic renderer) a page. The
`export-limit` def is the reference example of the *dynamic* path: it renders
through `dynamic-config.tsx` with no bespoke page.

## 7. Background jobs

graphile-worker, backed by the same PostgreSQL database (no Redis). Boot log:
`Worker connected and looking for jobs... (task names: 'notification',
'password_expiry_check', 'session_sweep')`.

| Task | Handler | Purpose |
|---|---|---|
| `notification` | `workers/notification.worker.ts` | dispatch queued notifications |
| `password_expiry_check` | `workers/password-expiry.worker.ts` | flag/notify expiring passwords |
| `session_sweep` | `workers/session-sweep.worker.ts` | expire idle sessions |

## 8. Environment & configuration

`apps/api/.env` (gitignored). Keys that matter:

| Variable | Purpose | Note |
|---|---|---|
| `DATABASE_URL` | Postgres connection | |
| `PORT` | listen port | **`API_PORT` in .env is dead** — `app.ts:397` reads `PORT` |
| `API_HTTPS` | enable TLS | `true` locally; certs from `certs/` |
| `AUDIT_CHAIN_KEY` | HMAC key for v3 audit checksums | **must live outside the DB** |
| `INITIAL_ADMIN_PASSWORD` | seed admin password | seed **throws** if unset — deliberate |
| `ALLOWED_ORIGINS` | CORS allow-list | required in production |
| `JWT_SECRET` | token signing | |

`apps/web/.env.production` is tracked **blank** and marked `skip-worktree` on
purpose, so no developer's IP address enters the repository.

## 9. Deployment assets

`scripts/` (PowerShell, Windows): `install.ps1`, `uninstall.ps1`, `upgrade.ps1`,
`provision-db.ps1`, `apply-schema.ps1`, `backup-db.ps1`,
`register-backup-task.ps1`, `register-services.ps1`, `unregister-services.ps1`,
`install-services-phase5.ps1`, `uninstall-services-phase5.ps1`,
`stage-runtime.ps1`, `build-bundle.ps1`, `build-installer.ps1`,
`verify-migrations.ps1`, `verify-windows-deployment.ps1`.

`verify-migrations.ps1` is the **drift guard** — it builds a scratch database
from migrations and asserts it diffs empty against the dev database. It must
pass before any schema change is committed.

## 10. What is absent

See [`absent-subsystems.md`](absent-subsystems.md) for the full evidence table.

## 11. Data Injection (P1) — foundation, landed 2026-08-01

A location-hierarchy + gateway/instrument/communication-profile scaffold for
future device data ingestion. **This is configuration surface only — no
protocol adapter exists and nothing in this codebase talks to a device.**
Full detail is split across the other phase docs; this is the index.

**New API modules (4, verified `ls apps/api/src/modules/` 2026-08-01):**
`hierarchy`, `gateways`, `instruments`, `communication-profiles`. See §3 above.

**New frontend pages (6, verified `ls apps/web/src/routes/data-injection/*.tsx`):**
`index.tsx` (dashboard), `hierarchy.tsx`, `gateways.tsx`, `instruments.tsx`,
`instrument-wizard.tsx`, `profiles.tsx` — 6 new `<Route>` entries in
`main.tsx` under the existing `data-injection` route group (see
[`../07-ui/README.md`](../07-ui/README.md)).

**New sidebar item:** `data-injection` ("Data Injection"), 10th configurable
sidebar item, gated by a new 9th `PERMISSION_TREE` group with **16 nodes** (4
each for Hierarchy / Gateways / Instruments / Communication Profiles), all
`configurable: true`. Detail: [`../04-roles-permissions/README.md`](../04-roles-permissions/README.md).

**New Prisma models (7) + enums (2):** `HierarchyNode`, `Protocol`,
`CommunicationProfile`, `Gateway`, `Instrument`, `InstrumentSetting`,
`InstrumentTopic`; `HierarchyLevel`, `TopicCategory`. Detail:
[`../05-database/README.md`](../05-database/README.md).

**New config definition (22nd, `uns-settings.def.ts`):** the UNS topic prefix
/ separator / includeGateway settings consumed by the topic resolver. Renders
through the existing dynamic-config path — **no new frontend config page**,
which is why the "config pages" count in §2 stays at 21 while "config
definitions" goes to 22.

**Design decisions worth carrying into a rebuild:**
- **Topics are derived, not stored.** `resolveTopics()` in
  `apps/api/src/modules/instruments/topic-resolver.ts` is a pure function
  over hierarchy ancestry + gateway/instrument slugs + `uns-settings`;
  renaming a hierarchy node re-derives every descendant's topics with no
  backfill. Only explicit per-category overrides persist, in
  `instrument_topics`.
- **Audit boundary:** every hierarchy/gateway/instrument/communication-profile
  mutation is audited (12 new `AUDIT_ACTIONS` entries). Telemetry itself is
  **deliberately not audited** — it is process data, not a §11 electronic
  record. There is no telemetry yet to audit; this is a boundary decision for
  when a protocol adapter lands, not a current gap.
- **Protocol registry seeded with 18 protocols, all `is_enabled = false`.**
  Shipping any protocol "enabled" with no adapter behind it would be a lie in
  the UI. OPC-DA is deliberately absent (COM/DCOM, no viable Node
  implementation).
- **`ltree` is no longer a removal candidate** — the 2026-07-25 dossier
  (`../05-database/README.md` §5) flagged the `ltree` extension as a leftover
  with no live consumer. `HierarchyNode.path` (raw SQL column, not
  Prisma-modeled — see §11 of the database doc) now uses it for
  single-query ancestor/descendant lookups. That line has been corrected.

Full task-by-task build record: `.superpowers/sdd/2026-08-01-data-injection-p1-foundation/`.

## 12. Data Injection (P3) — alarms & instrument liveness, landed 2026-08-03

A latching alarm state machine over the P2 telemetry stream, plus a liveness
sweep that marks a silent instrument OFFLINE. Full detail:
[`../05-database/README.md`](../05-database/README.md) §13,
[`../06-api/README.md`](../06-api/README.md) §10,
[`../07-ui/README.md`](../07-ui/README.md) §13.

**New API module (1, verified `ls apps/api/src/modules/` 2026-08-03):**
`alarms`. See §3 above.

**New frontend surface:** an alarm queue + acknowledgement dialog +
threshold management, reached via a card on the existing Data Injection hub.
One new route, `/data-injection/alarms` — **no new sidebar item, no new
route group.** Threshold management (`instrument-thresholds.tsx`) is embedded
in the existing instrument detail page, not a standalone route.

**New Prisma models (3) + enums (4):** `AlarmThreshold`, `Alarm`,
`InstrumentLiveness`; `AlarmState`, `AlarmSeverity`, `ThresholdOperator`,
`LivenessState`. `Instrument.expectedIntervalSec` added (nullable — opt-in
per instrument).

**New config definition (24th, `liveness.def.ts`):** `expectedIntervalSec` /
`gracePeriodMultiplier` — the write path that makes liveness monitoring
enableable. Renders through the dynamic-config path, same as P2's
`telemetry-retention` — no new frontend config page.

**New background job (4th):** `instrument_liveness_sweep`, every 5 minutes.

**Design decisions worth carrying into a rebuild:**
- **Acknowledgement is the §11.50 signature, not an optional policy.** It
  uses `enforceReauthAlways`, bypassing the admin-configurable re-auth
  surface that every other reauth-gated action goes through — an
  administrator cannot switch off the challenge for this one action.
- **`CLOSED` is reachable only through acknowledgement.** A threshold
  returning to normal moves an already-acked alarm to `RESOLVED_UNACKED`,
  never straight to `CLOSED` — so a deviation cannot self-clear off the
  queue without a human seeing it.
- **Alarm evaluation runs strictly after the telemetry write completes** in
  the ingest flush loop, with its own `ALARM_EVALUATION_FAILED` dead-letter
  error path — a threshold is never evaluated against data that didn't
  durably land, and an evaluation failure doesn't silently vanish.
- **Two bugs predating P3 were found and fixed while building it** (not P3
  scope, but consequential): `REAUTH_ACTION_CATEGORIES` was missing `'Data
  Injection'`, hiding all 12 P1 reauth actions from both reauth editors; and
  a duplicate cron `?id=` in `packages/queue/crontab.txt` had been rejecting
  the entire crontab file since P2, silently taking every background job
  offline. See `CHANGELOG.md`.

Full task-by-task build record:
`.superpowers/sdd/2026-08-03-data-injection-p3-alarms-liveness/`.
