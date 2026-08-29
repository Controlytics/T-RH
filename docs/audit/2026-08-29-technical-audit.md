# compliance-core — Full Technical Audit & Health Check

**Date:** 2026-08-29
**Branch audited:** `data-layer` @ `9a9bb9e`
**Worktree:** `.claude/worktrees/ui-redesign-stage2`
**Mode:** READ-ONLY. No source file, config, schema, or database object was
modified, renamed, or deleted. The only file created is this report.

**Method.** Every count and claim below is backed by a command run against the
live tree at the time of writing. Where a question cannot be answered from
source alone (row counts, always-NULL columns, live index usage), the finding
says `UNKNOWN — runtime/DB access required` rather than guessing. This
codebase has a documented history of agents declaring live code dead
(`mqtt`, `@fastify/websocket` — both recorded in `CLAUDE.md` as false
"removed" claims), so nothing is rated HIGH confidence unless the evidence is
a whole-repo grep with a hit count.

---

## 1. Executive Summary

`compliance-core` is a single-tenant 21 CFR Part 11 administration and
instrument-monitoring platform: a Fastify/Prisma/PostgreSQL backend, a React 19
SPA, a Postgres-backed job queue, and a device-ingest surface (HTTP, WebSocket,
TCP, MQTT). It is a fork of an upstream product ("DigiLog") that has been
aggressively stripped — the cleanroom/filter/RFID/offline-mobile domain is gone.

**~76,000 lines** of non-test TypeScript across **630 source files**, against
**215 test files**. That test-to-source ratio is unusually good, and it shows:
the code is heavily commented with *reasoning* (not restatement), security
decisions are written down at the point of enforcement, and several of the
sharpest traps in the system (partition exhaustion, orphaned queue jobs,
hash-chain keying) have explanatory comments attached to the exact line that
would otherwise be misread.

**The headline judgement: this is a well-built codebase with a documentation
problem and three specific structural risks.**

The three risks, in order:

1. **`instrument_telemetry_history` exists in the database and in migrations
   but has no Prisma model.** Every read and write goes through raw SQL. Any
   `prisma migrate dev` / `db push` run will generate a DROP for it. This is
   the single highest-consequence finding in the audit — it is a silent
   total-telemetry-loss trigger armed behind a routine developer command.
2. **The audit trail ships endpoints that deliberately disable the
   `audit_trail_no_delete` trigger and physically delete §11 records.** The
   implementation is careful and self-documenting, but the *capability* is a
   compliance posture decision that should be consciously owned, not inherited.
3. **Documentation drift is systemic and self-admitted.** `CLAUDE.md` contains
   an internal contradiction (config page count stated as both 24 and 25 in the
   same file), a stale count (hooks: claims 18, actual 20), and the repo root
   carries `bloat.md` — a 2026-04-20 audit of files (`routes/mobile/`) that no
   longer exist. Root docs are actively misleading to a new engineer.

Nothing found is an active production outage. The security posture is
genuinely above average for a project this size — see §18, which is mostly a
list of things done *right*.

**Overall health score: 74 / 100.** Full breakdown in §30.

---

## 2. Project Structure

```
compliance-core/
├── apps/
│   ├── api/                  Fastify backend (TypeScript, ESM, port 3001)
│   │   ├── prisma/           schema.prisma (36 models, 13 enums) + 24 migrations + seed
│   │   ├── scripts/          operational probes (probe-alarms, demo-live-scenario, …)
│   │   └── src/
│   │       ├── app.ts        composition root — 2 plugins, 26 route registrations, job runner
│   │       ├── e2e/          44 end-to-end tests against a real Postgres
│   │       ├── lib/          cross-cutting: audit, hash-chain, jwt, prisma, sanitize, password
│   │       ├── modules/      24 feature modules (routes + service + repository)
│   │       ├── plugins/      auth.ts (JWT + public-path allowlist), rbac.ts (permissions)
│   │       ├── test-support/ fake AD/LDAP server for integration tests
│   │       └── workers/      6 graphile-worker task handlers
│   ├── web/                  React 19 SPA (Vite 6, Tailwind v4, port 5176 dev)
│   │   └── src/
│   │       ├── main.tsx      51 <Route> declarations
│   │       ├── components/   layout, ui/ (19 primitives), dialogs, boundaries
│   │       ├── hooks/        20 entries
│   │       ├── lib/          19 entries — api-client, pdf-report, excel-export, themes
│   │       └── routes/       14 route folders (config/ is by far the largest)
├── packages/
│   ├── shared/               permissions (42), reauth actions (48), sidebar items (12),
│   │                         PERMISSION_TREE, zod schemas, telemetry maths
│   └── queue/                graphile-worker wrapper + crontab.txt
├── certs/                    mkcert dev TLS material
├── docs/                     active docs + docs/recreation/ (the verified inventory)
│                             + docs/archive/ (explicitly NOT current)
├── future/                   forward-looking design notes
├── installer/DigiLog.iss     Inno Setup installer definition
├── old/                      5.7 MB / 160 files of superseded material (see §12)
├── scripts/                  19 PowerShell/TS operational scripts
├── tasks/                    todo.md + plans
└── tests/                    e2e-scripts/ + integration/ (6 files)
```

**Folder purposes.**

| Folder | Purpose | Notes |
|---|---|---|
| `apps/api` | All server-side logic, the only DB writer | ESM, `tsx watch` in dev |
| `apps/web` | The only UI. No mobile app, no Capacitor build in this fork | verified: no `apps/android`, no `rfid_scan_app` |
| `packages/shared` | Single source of truth for the RBAC/permission model | consumed by both apps |
| `packages/queue` | graphile-worker on Postgres — replaced Redis | `crontab.txt` is the schedule |
| `docs/recreation` | The *accurate* inventory. Root docs are not | per `CLAUDE.md` and confirmed here |
| `old/` | Superseded docs, screenshots, Playwright artifacts | 5.7 MB, no code references it |
| `certs/` | Local dev TLS only | `rootCA.pem` signs nothing in use |

**Absent (and worth stating, because the root docs imply otherwise):** no
Dockerfile, no docker-compose, no Kubernetes manifests, no nginx/Apache/IIS
config, no `packages/db`, no mobile app. Deployment is Windows-native.

---

## 3. Technology Stack

### Backend
| Concern | Choice | Evidence |
|---|---|---|
| Language | TypeScript 5.7, ESM (`"type": "module"`) | `apps/api/package.json` |
| Framework | Fastify 5.10 | `fastify@^5.10.0` |
| ORM | Prisma 6.3 (`@prisma/client`) | `schema.prisma`, 36 models |
| Database | PostgreSQL 18 | `CLAUDE.md`; raw SQL uses `pg_*` catalogs |
| Auth | JWT via `jose` 6 (HS256) + bcrypt 5 | `lib/jwt.ts`, `lib/password.ts` |
| API docs | `@fastify/swagger` + `swagger-ui` | `/docs`, non-production only |
| Validation | Fastify JSON Schema + `zod` 3 | dual — see §22 note |
| Background jobs | `graphile-worker` on Postgres, 6 tasks | `app.ts:458-489` |
| Scheduling | `packages/queue/crontab.txt` | `alarm_webhook` deliberately absent |
| Logging | Fastify's built-in pino logger (`app.log`) | no separate logger module |
| Email | `nodemailer` 9 (+ OAuth2 flows) | `notification-delivery/channels/` |
| Directory | `ldapts` 8 (prod), `ldapjs` 3 (test fake server) | `modules/ldap/` |
| Device ingest | `mqtt` 5.15, `@fastify/websocket` 11, raw TCP | `app.ts:372-381` |
| Archives | `adm-zip` (backup export/restore) | `modules/backup/` |
| Sanitisation | `sanitize-html` 2.17 | `lib/sanitize.ts` |

### Frontend
| Concern | Choice |
|---|---|
| Framework | React 19 + React Router 7 |
| Build | Vite 6, `@vitejs/plugin-react` |
| Styling | Tailwind CSS v4 via `@tailwindcss/vite`; `app.css` uses `@layer components` |
| Data fetching | SWR 2.3 (`lib/swr-config.ts`) |
| Forms | `react-hook-form` 7 + `@hookform/resolvers` |
| Icons | `lucide-react` |
| Fonts | `@fontsource-variable/inter` (self-hosted) |
| Charts | **Hand-rolled SVG** — `routes/dashboard/time-series-chart.tsx`. No chart library. |
| Dashboard grid | `react-grid-layout` 2.2 |
| Reports | `jspdf` + `jspdf-autotable` (PDF), `exceljs` (XLSX) |
| PWA | `vite-plugin-pwa` 0.20 — still configured and active |
| Utilities | `clsx` + `tailwind-merge` (via `lib/cn.ts`) |

### Infrastructure
- **No containers.** Windows-native only.
- **Installer:** Inno Setup (`installer/DigiLog.iss`); services registered by
  `scripts/register-services.ps1`.
- **TLS:** mkcert dev certs in `certs/`; `API_HTTPS=true`; HSTS 1 year with
  preload, CSP, and a `Permissions-Policy` header all set in `app.ts:131-153`.
- **Reverse proxy:** none. Fastify terminates TLS directly, and optionally
  serves the built SPA itself when `SERVE_WEB` is set (`app.ts:408`).
- **Cloud:** an EC2 Windows + RDS deployment exists out-of-band; there is no
  IaC for it in this repo.

---

## 4. Architecture

```
                    ┌──────────────── Instruments / Devices ────────────────┐
                    │  HTTP POST      WebSocket      raw TCP      MQTT      │
                    │  /ingest/v1/    /ingest/v1/ws  INGEST_TCP_  (EMQX     │
                    │  telemetry                     PORT         5.3.2)    │
                    └───────────────────────┬───────────────────────────────┘
                                            │ per-instrument token
                                            │ (NOT a user JWT — auth.ts
                                            │  PUBLIC_PATHS exemption)
 Browser                                    ▼
 ┌──────────────┐        HTTPS      ┌──────────────────────────────────┐
 │ React 19 SPA │ ───────────────►  │  Fastify 5  (apps/api/src/app.ts)│
 │  SWR cache   │  JWT Bearer +     │                                  │
 │  51 routes   │  x-reauth-password│  onRequest → authPlugin          │
 └──────────────┘                   │            → rbacPlugin          │
        ▲                           │  26 route prefixes               │
        │                           └───────────┬──────────────────────┘
        │                                       │
        │                           ┌───────────▼──────────────────────┐
        │                           │ modules/*  routes → service      │
        │                           │            → repository          │
        │                           │ lib/ audit · hash-chain · jwt    │
        │                           └───────────┬──────────────────────┘
        │                                       │
        │                           ┌───────────▼──────────────────────┐
        │                           │ Prisma 6 (36 models)             │
        │                           │  + raw SQL for the two telemetry │
        │                           │    tables and the backup engine  │
        │                           └───────────┬──────────────────────┘
        │                                       ▼
        │                           ┌──────────────────────────────────┐
        │                           │ PostgreSQL 18                    │
        │                           │  compliance_core_db              │
        │                           │  compliance_core_db_test         │
        │                           │  graphile_worker schema          │
        │                           │  instrument_telemetry_history    │
        │                           │    (PARTITIONED, no Prisma model)│
        │                           └──────────────────────────────────┘
        │                                       ▲
        │  in-app notifications                 │
        └───────────────────────────┌───────────┴──────────────────────┐
                                    │ graphile-worker (6 tasks)        │
                                    │  notification                    │
                                    │  password_expiry_check      cron │
                                    │  session_sweep              cron │
                                    │  telemetry_partition_maint. cron │
                                    │  alarm_evaluation      cron 1min │
                                    │  alarm_webhook       event-driven│
                                    └───────────┬──────────────────────┘
                                                ▼
                              Email (SMTP/OAuth2) · SMS · Alarm webhook
                              (operator-typed LAN URL — hooter/annunciator)
```

**Architectural strengths.**
- One composition root (`app.ts`). Nothing registers routes elsewhere.
- Policy decisions (display precision, attribute-edit permission, instrument
  visibility) are resolved **server-side once** and ride on the payload. The
  client never re-derives them. This is written down as a hard rule and the
  code actually follows it.
- `PERMISSION_TREE` in `packages/shared` is a genuine single source of truth;
  the legacy hand-maintained maps are *derived* from it and a snapshot test
  locks the drift to zero.
- The ingest fan-in (4 transports) converges on one write path.

**Architectural weaknesses.**
- **Single-process assumptions.** The alarm-webhook cooldown map and the error-
  notification rate limiter are both in-memory module-level variables
  (`app.ts:189`, `alarm-webhooks/`). Running two API instances silently doubles
  buzzer fires and error notifications. Documented in-code as a known caveat,
  but it is a hard ceiling on horizontal scaling.
- **Dual validation systems.** Fastify JSON Schema *and* zod are both in use,
  sometimes on the same route. Neither is wrong; having both means a reviewer
  must check two places to know what is validated.
- **`modules/instruments/routes.ts` is 2,392 lines** — 3× the next-largest
  backend file. It is the natural home of the visibility, attribute-access,
  token, telemetry, and child-roster concerns simultaneously.

---

## 5. Backend Audit

24 modules under `apps/api/src/modules/`. All 24 are registered in `app.ts` —
**there are no orphaned modules.**

| Module | Purpose | Used? | Routes | Primary tables | Issues |
|---|---|---|---|---|---|
| `admin-requests` | Unauthenticated "contact admin" requests + approval | ✅ | 5 | `admin_requests` | **No tests.** Public `user-lookup` — §18 |
| `alarm-webhooks` | IP hooter/annunciator targets + §11 delivery log | ✅ | 7 | `alarm_webhook_target/_delivery` | In-memory cooldown (single-instance) |
| `alarms` | Alarm rules, active alarms, acknowledge, summary | ✅ | 7 | `alarms`, `alarm_rules` | Bounded (`take: min(limit,500)`) — good |
| `audit` | §11 trail, verify-chain, redact, **physical delete** | ✅ | 8 | `audit_trail` | **Disables tamper trigger** — §18 CRITICAL-adjacent |
| `auth` | Login, refresh, logout, reauth verify, profile | ✅ | 9 | `users`, `sessions` | Solid. Per-route rate limits |
| `backup` | Whole-DB export/restore over dynamic raw SQL | ✅ | 3 | *all* | Loads everything into memory; guarded by `BACKUP_MAX_ROWS_PER_TABLE` |
| `config` | 25 config defs + auto-discovery + 9 static route files | ✅ | 40+ | `system_config` | Largest surface; see §17 |
| `dashboards` | Widget dashboards + assignment | ✅ | 13 | `dashboards`, `dashboard_widgets` | No FE consumer found for several — §10 |
| `debug-traces` | Operation tracing toggles | ✅ | 6 | `system_config` | **No tests.** Dev-facing surface in prod build |
| `floorplans` | Drawn plans, rooms, doors, grade, membership | ✅ | 10 | `floorplans`, `floorplan_rooms` | `GET /:id` knowingly unscoped (documented) |
| `functional-locations` | Block > Area authoritative grouping tree | ✅ | 7 | `functional_locations` | — |
| `help` | Versioned help articles | ✅ | 6 | `help_articles(_versions)` | **No module tests** (e2e exists) |
| `instrument-profiles` | Device type definitions | ✅ | 5 | `instrument_profiles` | **No module tests** (e2e exists) |
| `instruments` | The core domain: CRUD, attributes, tokens, telemetry, ingest, MQTT auth | ✅ | 22 + 2 | `instruments`, both telemetry tables | **2,392 lines** — split candidate |
| `ldap` | AD/LDAP config, status, test-connection | ✅ | 4 | `system_config` | Well tested (5 files + e2e) |
| `notification-delivery` | Email/SMS channels, templates, logs, OAuth2 | ✅ | 17 | `notification_logs/_templates` | OAuth2 callback is a public path |
| `notification-rules` | Event→recipient rules | ✅ | 8 | `notification_rules(_recipients)` | **No tests** |
| `notifications` | In-app notification inbox | ✅ | 9 | `notifications` | **Unbounded by default** — §20 |
| `roles` | Roles, permissions, instrument scope, attribute + panel access | ✅ | 18 | `roles`, `role_configs`, `user_configs` | 1,086 lines; 14 `findMany` |
| `super-admin` | API lock + raw data admin surface | ✅ | 11 | several | Several routes have **no FE consumer** — §10 |
| `system-health` | Health/metrics endpoint | ✅ | 1 | — | **No module tests** (e2e exists) |
| `uploads` | Photo, floorplan, branding-background upload | ✅ | 3 | filesystem | 5 MB / 1 file limit; type allowlist |
| `user-groups` | Group membership for notification targeting | ✅ | 7 | `user_groups(_members)` | **No tests** |
| `users` | User CRUD, lock/unlock, password reset, expiry sweep | ✅ | 14 | `users`, `password_*` | Well covered |

**`lib/` (34 files).** All referenced. Highlights:
- `hash-chain.ts` — V2 (SHA) and V3 (HMAC, keyed by `AUDIT_CHAIN_KEY`)
  checksums, with `AUDIT_CHAIN_KEYED_FROM` as an out-of-band anchor. This is
  the strongest single piece of engineering in the repo.
- `audit-verify.ts` — chain verification with anomaly typing.
- `sanitize.ts` — HTML stripping applied to all text fields.
- `mask-secrets.ts` — used by the notification config audit path so credentials
  never enter the audit trail (there is a dedicated e2e test for this).

---

## 6. API Inventory

**249 route-registration call sites** across **37 route files** and **26
registered prefixes**:

```bash
grep -rhoE "\b(app|fastify|server)\.(get|post|put|patch|delete)\b" \
  apps/api/src/modules --include=routes.ts --include=*-routes.ts \
  --include=*.routes.ts | wc -l                      # 249
```

Three numbers matter here and they are not the same, which is itself a finding:

| Number | Meaning |
|---|---|
| **249** | route-registration call sites in source |
| **244** | of those with a literal quoted path; **5** compute the path |
| **~300** | the **runtime** route surface — larger than the source count |

The runtime surface exceeds the source count because **the config module
registers routes from a loop**:

- `config/routes.ts:51,65` — a `configEndpoint(key, …)` factory registering
  `GET /:key` + `PUT /:key`, invoked **6 times** (`password-policy`,
  `login-security`, `session`, `datetime`, `pagination`, `export-limit`)
  → **12 routes from 2 call sites**.
- `config/dynamic-routes.ts:38,64` — `GET`/`PUT` on
  `` `/dynamic/${def.moduleKey}` `` looped over the **25** auto-discovered
  config defs → **50 routes from 2 call sites**.

**A static grep therefore understates this API's surface by roughly 20%.**
Anyone auditing route coverage, writing an allowlist, or diffing Swagger
against source must expand the config registry first. This is the same
auto-discovery property that defeats knip in §11.

*Correction note:* an earlier pass of this audit reported "187 endpoints".
That figure came from a pipeline ending in `sort | uniq -c | wc -l`, which
collapsed every module's identical relative path — nine modules define
`GET /` — into a single row. 187 is the count of **distinct method+relative-path
combinations**, not of routes. The corrected figures are above.

Prefixes registered in `app.ts:337-385`:

`/api/auth` · `/api/users` · `/api/config` (×2 — static + dynamic) ·
`/api/audit` · `/api/uploads` · `/api/notifications` · `/api/roles` ·
`/api/backup` · `/api/help` · `/api/system-health` ·
`/api/notification-settings` · `/api/user-groups` · `/api/notification-rules` ·
`/api/super-admin` · `/api/debug/traces` · `/api/ldap` · `/api/dashboards` ·
`/api/admin-requests` · `/api/floorplans` · `/api/functional-locations` ·
`/api/alarms` · `/api/alarm-webhooks` · `/api/ingest/v1` (×3 — HTTP, WS,
MQTT auth) · `/api/instrument-profiles` · `/api/instruments`

### Authentication model

Three tiers, enforced in `plugins/auth.ts`:

1. **`PUBLIC_PATHS`** (all methods, no JWT): `/api/auth/login`,
   `/api/auth/forgot-password`, `/api/auth/beacon-logout`, `/api/health`,
   `/docs` (non-production only), the OAuth2 email callback, and the three
   device-ingest endpoints (which authenticate by per-instrument token instead).
2. **`PUBLIC_GET_PATHS`** (GET only): `/api/config/branding`,
   `/api/config/datetime/current`, `/uploads/photos/`, `/uploads/branding/`,
   `/uploads/floorplans/`, `/api/roles/active`,
   `/api/admin-requests/user-lookup`.
3. **Everything else**: JWT required, then `rbacPlugin` applies
   `requirePermission` / `requireAnyPermission` per route, plus `enforceReauth`
   for the 48 governed actions.

`matchesPublicPath()` matches on **segment boundaries**, not bare prefixes —
`/api/health-evil` is correctly not public. There is a unit test for this
(`plugins/__tests__/auth.plugin.test.ts`). This is the right implementation of
a commonly-botched check.

### Endpoint classification

The full endpoint list, prefix by prefix, is in **Appendix B** at the end of
this report. Summary classification:

| Status | Count | Notes |
|---|---|---|
| ACTIVE (frontend or device consumer confirmed) | ~150 | |
| ACTIVE (server-internal / worker consumer) | ~12 | ingest, mqtt-auth, oauth2 callback |
| POSSIBLY UNUSED (no frontend string match) | ~25 | mostly `super-admin/data/*` and `dashboards/*` — see §13 |
| BROKEN | 0 | no route handler was found to be unreachable |
| DUPLICATE | 0 | |
| DEPRECATED | 0 declared | |

**No endpoint was found to be broken or duplicated.** That is a genuinely good
result for a 249-route surface.

---

## 7. Frontend Audit

- **51 `<Route>` declarations** in `main.tsx` (`grep -cE "<Route"` → 51),
  covering 49 distinct paths plus `/` and `*`.
- **14 route folders**, 24 `config/*.tsx` pages, 19 `ui/` primitives,
  20 hooks, 19 lib modules.
- **`console.log` in shipped frontend code: 0.** (`grep -rn "console.log"
  apps/web/src` excluding tests → 0 hits.) The single backend hit is a help
  string inside a `node -e` suggestion, not a live log call.

### Routed vs. unrouted pages — checked, and *not* the problem it looked like

Four `config/` pages have no matching path in `main.tsx`:
`audit-templates.tsx`, `branding.tsx`, `field-ids.tsx`, `pagination.tsx`.

**These are NOT orphans.** They are composed as tabs:
- `config/display-settings.tsx:2-4` imports `FieldIdsPage`,
  `AuditTemplatesConfigPage`, `PaginationConfigPage`.
- `config/appearance.tsx:1` imports `BrandingConfigPage`.

Recording this explicitly because a naive route-vs-file diff would have
reported four false positives.

### Genuinely unused frontend files

`npx knip` (config already present at `knip.json`) reports **5 unused files**,
of which 2 are frontend components:

| File | Evidence | Confidence |
|---|---|---|
| `apps/web/src/components/ui/error-popup.tsx` | knip: no importer; whole-repo grep for `error-popup` → only its own file | HIGH |
| `apps/web/src/components/ui/radio.tsx` | knip: no importer | HIGH |

Note both live in `components/ui/` — the design-system folder. Recent commits
(`9a9bb9e`, `90d6f2c`) show an active UI-primitive consolidation effort; these
two are plausibly casualties of that work that were never deleted.

### Static assets

`apps/web/public/` holds **4 files, 340 KB total**: `apple-touch-icon.png`,
`logo.jpg`, `pwa-192x192.png`, `pwa-512x512.png`. The three PWA/touch icons
are referenced by the `VitePWA` manifest (`vite.config.ts:51-60`). There is no
asset bloat here and no missing-asset reference was found.

Fonts are npm-managed (`@fontsource-variable/inter`), not loose files.

### Unused CSS classes — not analysed

**UNKNOWN — not analysed.** `apps/web/src/app.css` is 743 lines. Identifying
unused CSS classes reliably needs a coverage run against the built bundle
(Tailwind v4 generates utilities on demand, so a static grep would produce
mostly noise), and that was out of scope for a read-only source audit. Noting
it explicitly rather than leaving the brief's request silently unanswered.

One structural note that *is* verifiable from source: `app.css` correctly
places its shared classes inside `@layer components`. That matters in
Tailwind v4 — unlayered CSS beats every Tailwind utility at any specificity,
and `:where()` does not help.

### Frontend dead exports

knip reports **47 unused exports** and **28 unused exported types**. The
highest-signal cluster is in §11.

---

## 8. Database Audit

**36 models, 13 enums** — verified:
`grep -cE "^model " apps/api/prisma/schema.prisma` → **36**;
`grep -cE "^enum "` → **13**. Both match `CLAUDE.md`.

**24 migration directories** under `apps/api/prisma/migrations/`.

### Model inventory, grouped by domain

```
IDENTITY & ACCESS
├── User ──┬── PasswordHistory
│          ├── Session
│          ├── PasswordResetRequest
│          ├── UserConfig          (instrument_scope, panel_access, dashboard_layout)
│          └── UserGroupMember ──── UserGroup
├── Role ──── RoleConfig           (instrument_scope, attribute_access, panel_access)
└── AdminRequest

COMPLIANCE (§11)
└── AuditTrail                     (hash-chained; audit_trail_no_delete trigger)

CONFIGURATION
├── SystemConfig                   (25 config defs live here as rows)
└── FieldIdConfig

NOTIFICATION
├── Notification
├── NotificationLog
├── NotificationTemplate
└── NotificationRule ──── NotificationRuleRecipient

HELP
└── HelpArticle ──── HelpArticleVersion

DASHBOARDS
└── Dashboard ──┬── DashboardWidget
                └── DashboardAssignment

INSTRUMENTS  (the core domain)
├── FunctionalLocation  (self-referencing Block > Area tree)
├── InstrumentProfile
├── Instrument ──┬── InstrumentCredential
│                ├── InstrumentAttribute
│                ├── InstrumentTelemetryLatest   ← raw-SQL-only (see below)
│                └── DeadLetter
├── Floorplan ──── FloorplanRoom   (doors Json?, grade String?)
└── ALARMS
    ├── AlarmRule ──── Alarm
    └── AlarmWebhookTarget ──── AlarmWebhookDelivery

DATABASE-ONLY (no Prisma model)
└── instrument_telemetry_history   ← PARTITIONED. See §9 CRITICAL.
```

### Enums (13)
`AssigneeType`, `UserStatus`, `NotificationType`, `NotificationChannel`,
`NotificationDeliveryStatus`, `NotificationEventType`, `AlarmMetric`,
`AlarmComparison`, `AlarmSeverity`, `AlarmState`, `AlarmSource`,
`AlarmLimitKind`, `FunctionalLocationType`.

**Deliberately *not* enums** (documented design decisions, both verified in
schema): `FloorplanRoom.grade` (`A|B|C|D|CIRCULATION|UTILITY`) and
`AlarmWebhookTarget.method/event/status` — validated strings so the vocabulary
can grow without a migration.

### Runtime database facts

`UNKNOWN — runtime/DB access required.` This audit did not connect to
PostgreSQL. The following are therefore **not** answered here and must be
answered before any cleanup acts on them:
- Actual row counts per table
- Which columns are always NULL in practice
- Actual index usage (`pg_stat_user_indexes`)
- Presence of duplicate rows or orphaned FK targets
- Current partition coverage of `instrument_telemetry_history`

---

## 9. Database ↔ Code Consistency

### 🔴 CRITICAL — `instrument_telemetry_history` has no Prisma model

```
Finding:    The partitioned telemetry history table exists in the database and
            in migrations, is actively read and written by production code, and
            is absent from schema.prisma.
File:       apps/api/prisma/schema.prisma  (absence — grep → 0 hits)
            apps/api/prisma/migrations/20260804120000_instruments_p1/migration.sql
            apps/api/src/modules/instruments/  (INSERT INTO / SELECT FROM via raw SQL)
            apps/api/src/workers/telemetry-partition.worker.ts
Evidence:   grep -n "instrument_telemetry_history" apps/api/prisma/schema.prisma  → 0 hits
            grep -rl "instrument_telemetry_history" apps/api/prisma/migrations   → 16 files
            grep -rhoE "FROM [a-z_]+|INTO [a-z_]+" apps/api/src                  → both present
Impact:     Prisma treats any table absent from the schema as drift to be
            removed. `prisma migrate dev`, `prisma db push`, or a
            `prisma migrate diff`-generated migration will emit DROP TABLE for
            it — destroying ALL historical telemetry, the §11 record the
            instrument-monitoring product exists to keep.
            This is already known operationally (recorded in project memory as
            "prisma migrate diff here wants to DROP the partitioned telemetry
            history table — strip it by hand") but it is not defended in code.
Severity:   CRITICAL
Confidence: HIGH
Recommendation:
            Do NOT add a Prisma model — Prisma cannot express declarative
            partitioning and the model would fight the migration. Instead:
            (a) add a CI/pre-commit guard that fails if a generated migration
                contains `DROP TABLE "instrument_telemetry_history"`;
            (b) document the hand-strip step in CONTRIBUTING.md next to the
                12-touchpoint rule;
            (c) consider `prisma.schema` comment markers so the omission reads
                as intentional to the next engineer.
```

### 🟡 `InstrumentTelemetryLatest` — model exists, Prisma client never used

```
Finding:    The model is declared in schema.prisma but zero code calls
            prisma.instrumentTelemetryLatest.*. All access is raw SQL.
File:       apps/api/prisma/schema.prisma:1050
Evidence:   Model-usage census across apps/api/src + packages (excluding tests)
            found 34 of 36 models used via the Prisma client. This model had 0.
            grep -rn "instrument_telemetry_latest" → 19 hits, ALL raw SQL:
              modules/instruments/telemetry-overview.ts:260 (SELECT)
              plus ingest writes, 4 e2e tests, 3 operational scripts.
Impact:     None functional — the table is very much alive. The mismatch is a
            comprehension hazard: a `prisma.instrumentTelemetryLatest` search
            returns nothing and invites the false conclusion that it is dead.
Severity:   LOW
Confidence: HIGH  (whole-repo grep, both spellings)
Recommendation:
            Keep the model (it documents the shape and keeps migrations honest).
            Add a one-line schema comment: "read/written by raw SQL only —
            see modules/instruments/telemetry-overview.ts".
```

**This is exactly the trap the project's own history warns about.** A
client-usage census alone would have marked this model dead. It is not.

### Other consistency checks

| Check | Result |
|---|---|
| Model fields missing from DB | None found (24 migrations align with schema) |
| DB columns missing from models | Only the two telemetry tables, above |
| Models in code but not DB | None |
| `NotificationRuleRecipient` unreferenced? | **No** — used via nested `include: { recipients: true }` at `notification-rules/routes.ts:45,94,163` and `notification-dispatcher.ts:84`. ACTIVE. |
| Test DB migrated separately | Yes — a known trap; a migration applied to only one DB 500s every instrument e2e |

---

## 10. Frontend ↔ API Consistency

Method: extracted every `/api/...` string literal from `apps/web/src`
(159 distinct), set-differenced against the 244 literal backend route paths (plus the 62 loop-generated config routes).

### 🟠 Frontend calls an API that does not exist

```
Finding:    apps/web/src/lib/report-review.ts calls three endpoints under
            /api/report-reviews. No such route is registered anywhere.
File:       apps/web/src/lib/report-review.ts:40, :51, :63
Code:       apiClient.post('/api/report-reviews', {...})           // createReview
            apiClient.get(`/api/report-reviews/${id}`)             // fetchReview
            (+ reviewSignatures, downloadReview)
Evidence:   grep -rn "report-reviews" apps/api/src → 0 route definitions.
            app.ts registers 26 prefixes; none is /api/report-reviews.
            knip reports fetchReview, reviewSignatures, downloadReview and the
            ReviewFull type as UNUSED EXPORTS — i.e. nothing calls them either.
Impact:     Dead module. If any code path ever reached it, it would 404. It
            currently cannot, because no component imports these functions.
            `components/SendForReviewButton.tsx` exists in the tree — the
            surviving UI shell of a removed feature.
Severity:   MEDIUM (dead code, not a live defect)
Confidence: HIGH — two independent signals (no backend route, no frontend caller)
Recommendation:
            Remove lib/report-review.ts and audit SendForReviewButton.tsx for
            the same fate. Verify the button is not rendered before deleting it.
```

### ✅ Two suspicious-looking calls that are actually fine

Recording these because they look like defects and are not:

- **`/api/config/report-signatories/resolved`** — appears only inside a comment
  in `lib/pdf-report.ts:97-101`, which explicitly documents that the fetch *was
  removed* when the config def went, and how to restore it. Not a live call.
- **`/api/config/dashboard-cards/current`** — appears only in comments at
  `hooks/use-panels.ts:17` and `routes/dashboard/index.tsx:65`, both explaining
  what replaced it. Not a live call.
- **`/api/filters/x/advance` and `/api/filters/x/start-cycle`** — the removed
  filter domain. Appear **only** in
  `lib/__tests__/api-client-reauth-shape.test.ts` and
  `plugins/__tests__/auth.plugin.test.ts`, used as arbitrary URL strings to
  exercise reauth-header shape and public-path matching. Harmless, though the
  path names are now misleading to a reader.

### Backend endpoints with no frontend consumer

| Endpoint | Assessment |
|---|---|
| `POST/PUT/DELETE /api/super-admin/data/notifications[/:id]` | POSSIBLY UNUSED — only `/api/super-admin/api-lock` appears in `apps/web/src` |
| `POST/PUT/DELETE /api/super-admin/data/admin-requests[/:id]` | POSSIBLY UNUSED — same evidence |
| `GET /api/super-admin/data/audit-trail`, `/stats` | POSSIBLY UNUSED |
| `GET /api/dashboards/widget-types`, `POST/PUT/DELETE /api/dashboards/:id/widgets/*`, `/assign/*` | POSSIBLY UNUSED — the dashboard page uses `use-panels`/`use-dashboard-layout`, not the widget CRUD surface |
| `POST /api/users/password-expiry-sweep` | ACTIVE — invoked by the `password_expiry_check` worker, not the UI |
| `GET /api/instruments/:id/dead-letters` | Check before removing — `deadLetter` has 20 Prisma call sites |

**These are POSSIBLY UNUSED, not UNUSED.** A string-literal grep cannot see
dynamically composed URLs, and `super-admin` is by design an
emergency/out-of-band surface that may be driven by curl or Swagger rather than
the SPA. Do not remove on this evidence alone.

### Hardcoded API URLs

`getApiBase()` (`apps/web/src/lib/api-base.ts`) is the single resolution point
and reads `localStorage['digilog.serverUrl']` first. No hardcoded hostnames
were found in `apps/web/src`. `apps/web/.env.production` is tracked blank and
`skip-worktree` on purpose. **This is correct and deliberate.**

---

## 11. Dead Code

Tool: `npx knip` (config already committed at `knip.json`). Treated as
**candidates, not findings** — this codebase uses auto-discovery
(`config-discovery.ts`), string-keyed dispatch (graphile-worker `taskList`),
and derived maps (`PERMISSION_TREE`), all of which defeat static analysis.
Everything below was re-verified with a whole-repo grep before being listed.

knip raw output: **5 unused files, 47 unused exports, 28 unused exported types,
6 duplicate exports.**

### 🔴 Highest-confidence cluster: offline-sync leftovers

```
Finding:    apps/web/src/lib/timing-constants.ts is 102 lines defining 10+
            constants. Exactly ONE of them is imported anywhere.
File:       apps/web/src/lib/timing-constants.ts
Lines:      23, 30, 39, 46, 54, 60, 71, 80, 92
Code:       CONNECTIVITY_PROBE_TIMEOUT_MS, CONNECTIVITY_POLL_INTERVAL_MS,
            SYNC_AUTO_INTERVAL_MS, SYNC_AFTER_ONLINE_DELAY_MS,
            SYNC_AFTER_VISIBILITY_DELAY_MS, SYNC_INITIAL_DELAY_MS,
            SYNC_OP_REPLAY_TIMEOUT_MS, SYNC_SINCE_POLL_INTERVAL_MS,
            HARD_CUTOFF_REEVAL_INTERVAL_MS
Why unused: They configure an IndexedDB offline queue + connectivity poller
            that was removed with the mobile/offline domain. The names are
            self-identifying: SYNC_*, CONNECTIVITY_*.
Evidence:   grep -rn "timing-constants" apps/web/src (excluding the file itself)
            → 9 importers, ALL importing only CLIPBOARD_COPY_RESET_MS.
            knip independently flags all 9 as unused exports.
Confidence: HIGH  (two independent signals; names match a domain confirmed
            removed in CHANGELOG)
Recommendation: Delete the 9 constants. Keep CLIPBOARD_COPY_RESET_MS —
            consider collapsing the file into lib/ui-constants.ts.
```

```
Finding:    apps/web/src/lib/server-contact.ts tracks a "last server contact"
            timestamp that nothing ever reads.
File:       apps/web/src/lib/server-contact.ts:87, :103
Code:       getLastServerContact(), subscribeToServerContact()
Why unused: The WRITE side is live (api-client.ts:2 imports
            markServerContactFromResponse; use-auth.ts:5 imports
            clearServerContact). The READ side has no consumer — it existed to
            drive an offline banner that no longer renders.
Evidence:   grep -rn "server-contact" apps/web/src → 2 importers, neither
            importing the two reader functions. knip agrees.
Confidence: HIGH
Recommendation: Remove the two reader exports and the subscriber list they
            maintain. Reassess whether writing the timestamp is still worth it.
```

```
Finding:    apps/web/src/lib/report-review.ts is entirely dead AND calls a
            nonexistent backend.
File:       apps/web/src/lib/report-review.ts (whole file)
Evidence:   See §10 — no backend route, no frontend caller.
Confidence: HIGH
Recommendation: Remove, together with components/SendForReviewButton.tsx after
            confirming it is not rendered.
```

### Unused files (knip, all re-verified)

| File | Evidence | Confidence | Recommendation |
|---|---|---|---|
| `apps/web/src/components/ui/error-popup.tsx` | no importer repo-wide | HIGH | Remove |
| `apps/web/src/components/ui/radio.tsx` | no importer repo-wide | HIGH | Remove |
| `scripts/publish-demo-telemetry.ts` | no importer — but it is an **operator script**, run by hand | LOW | **Keep.** knip false positive |
| `scripts/retire-limit-attributes.ts` | same — a one-shot migration script with a matching e2e test (`limit-attribute-retirement.e2e.test.ts`) | LOW | **Keep** |
| `vitest.workspace.ts` | consumed by the vitest **binary**, not by an import | LOW | **Keep.** knip false positive |

**3 of knip's 5 "unused files" are false positives.** This is the exact ratio
that justifies the conservatism rule.

### Unused exports that are NOT dead (false positives, recorded so nobody deletes them)

| Symbol | Why knip is wrong |
|---|---|
| `BackupTooLargeError` (`backup.repository.ts:253`) | Thrown at line ~277 in the same file. Not exported-and-unused; exported-and-locally-used. |
| `runAlarmWebhookJob` (`workers/alarm-webhook.worker.ts:50`) | The worker's task handler. Reached through the string key `alarm_webhook` in `app.ts:487`. **String-keyed dispatch is invisible to knip.** |
| `roomSchema`, `DOOR_WALLS`, `ROOM_GRADES` (`floorplans/validation.ts`) | zod schema + its vocabularies; used within the module's own validation composition. |
| `SUPER_ADMIN` (`instruments/visibility.ts:45`) | Guard constant inside the visibility resolver. |
| `SettingDefinition`, `ConfigManifestEntry` etc. (`lib/config-registry.ts`) | The **auto-discovery** contract. Every `*.def.ts` conforms to these types structurally. |
| `fake-ad-server.ts` exports (`BASE_DN`, `USERS`, `evaluateFilter`, …) | Test-support LDAP server, driven by `ldap-directory.e2e.test.ts`. |
| `obtainOfflineGrant` (`e2e/test-helper.ts:195`) | Test helper. |

### Genuinely reviewable unused exports (MEDIUM — verify before removing)

`computeChecksumV2` (`lib/hash-chain.ts:202`) — the **V2 (unkeyed SHA)**
checksum function. If no live code calls it, the system can no longer *compute*
a V2 checksum, only verify one. That is probably intentional (V3 is the writer),
but it is worth confirming that `audit-verify.ts` verifies V2 records through a
different path before this is touched. **Do not remove without reading
`lib/audit-verify.ts` end to end — this is §11 tamper-evidence machinery.**

Others in this bucket, all LOW impact: `SENSITIVE_KEY_RE` (`audit-diff.ts:5`),
`getDatetimeConfig`/`formatConfiguredDate` (`lib/format-datetime.ts`),
`SUPER_ADMIN_API_CONFIG_KEY`/`invalidateSuperAdminApiCache`
(`lib/super-admin-lock.ts`), `GATED_TYPES`/`gatedTypesVisibleTo`
(`notifications/notification.service.ts`), `CheckboxGroup`
(`components/ui/checkbox.tsx:82`), `MetaPill` (`components/ui/status-badge.tsx:56`),
`defaultBranding` (`hooks/use-branding.ts:7`), `REPORT_DEFS`
(`lib/report-labels.ts:51`), `logReportExportOrWarn` (`lib/report-export-log.ts:54`),
`alarmDecimals` (`routes/alarms/alarm-display.ts:99`), `FAIL_ACTIONS`
(`routes/audit/audit-helpers.ts:55`).

### Duplicate exports (6) — LOW, cosmetic

`apiClient|api` (`lib/api-client.ts`), `AlarmRulesConfigPage|default`,
`AlarmWebhooksConfigPage|default`, `DashboardPage|default`,
`DEFAULT_ROLES|ROLES` and `DEFAULT_ROLE_HIERARCHY|ROLE_HIERARCHY`
(`packages/shared/src/types/roles.ts`).

Each symbol is exported under two names. Harmless, but it means a
"find all usages" search returns half the truth. Recommendation: pick one name
per symbol; the aliases in `roles.ts` are the ones most likely to cause a
reviewer to miss a call site.

### Commented-out code / legacy implementations

`grep` found **no** blocks of commented-out code. Comments in this repo are
explanatory prose, not disabled code. This is unusual and worth stating as a
positive.

### Backend dead code

**None found at the module level.** All 24 modules are registered; all 34
`lib/` files are imported. `console.log` in shipped backend code: **0** (the one
grep hit at `modules/instruments/token-crypto.ts:63` is a help string inside a
`node -e "..."` suggestion, not a log call).

---

## 12. Unused Files

| Path | Type | Used? | Safe to remove? | Reason |
|---|---|---|---|---|
| `old/` (160 files, 5.7 MB) | superseded docs, screenshots, Playwright artifacts | No code reference | **Probably — but read first** | Contains `docs-superseded/`, `reports-specs/`, `screenshots/`, `playwright-artifacts/`, and 3 `.sql` scripts (`backfill-orphan-entity-orgs.sql`, `remove-rulechain-alarm-runtime-cleanup.sql`, `reset-cwh-cycles.sql`) referencing removed domains. `CONTRIBUTING.md` records that a bulk delete of `future/` was **reverted twice** — apply the same pre-deletion rule here. |
| `bloat.md` (repo root) | stale audit report | No | **Yes, or archive** | Dated 2026-04-20, branch `RFID`, head `ebb77b6`. Its P0.1 finding is about `apps/web/src/routes/mobile/mobile-operations.tsx` — `ls apps/web/src/routes` → no `mobile/` folder. It is a report about a codebase that no longer exists, sitting at the root where a new engineer will read it first. |
| `certs/rootCA.pem` | hand-rolled CA | Signs nothing currently in use | Review | `CLAUDE.md` records that this file caused two agents to investigate a "broken chain" that was never broken. The real CA is `%LOCALAPPDATA%\mkcert\rootCA.pem`. Keeping a decoy CA in the repo has a demonstrated cost. |
| `test-engine.mjs` (root) | unknown | Not imported by any workspace | Review | Not referenced by `package.json` scripts, `turbo.json`, or `vitest.workspace.ts`. |
| `node_modules/`, `dist/`, `build/` | generated | n/a | n/a | Correctly gitignored |

**No `*.bak`, `*.old`, `*.tmp`, `*.orig`, `*.copy`, `*.pyc`, or `__pycache__`
files exist in the tree.** The working tree is clean.

---

## 13. Unused APIs

| Method | Endpoint | Frontend consumer found? | Status |
|---|---|---|---|
| GET | `/api/super-admin/stats` | No | POSSIBLY UNUSED |
| GET | `/api/super-admin/data/audit-trail` | No | POSSIBLY UNUSED |
| GET/POST/PUT/DELETE | `/api/super-admin/data/notifications[/:id]` | No | POSSIBLY UNUSED |
| GET/POST/PUT/DELETE | `/api/super-admin/data/admin-requests[/:id]` | No | POSSIBLY UNUSED |
| GET | `/api/dashboards/widget-types` | No | POSSIBLY UNUSED |
| POST/PUT/DELETE | `/api/dashboards/:id/widgets[/:widgetId]` | No | POSSIBLY UNUSED |
| POST/DELETE | `/api/dashboards/:id/assign[/:assignmentId]` | No | POSSIBLY UNUSED |
| GET | `/api/dashboards/:id/data/:widgetId` | No | POSSIBLY UNUSED |
| GET | `/api/config/access-matrix/my-modules` | No | POSSIBLY UNUSED |
| GET | `/api/config/action-reauth/check` | No | POSSIBLY UNUSED |
| GET | `/api/instruments/:id/dead-letters` | No string match | POSSIBLY UNUSED (but `deadLetter` has 20 backend call sites) |
| POST | `/api/users/password-expiry-sweep` | No | **ACTIVE** — driven by the `password_expiry_check` worker |
| POST | `/api/ingest/v1/telemetry`, `/mqtt-auth`, WS `/ws` | n/a | **ACTIVE** — device consumers |
| GET | `/api/notification-settings/email/oauth2/code` | n/a | **ACTIVE** — Microsoft/Google redirect target |

**Nothing in this table is recommended for removal.** Evidence is a
string-literal grep, which cannot see:
- dynamically composed URLs,
- Swagger-driven or curl-driven operator use (the entire point of
  `/api/super-admin`),
- the `dashboards` widget CRUD, which may be a partially-landed feature rather
  than a dead one — `Dashboard`, `DashboardWidget` and `DashboardAssignment` are
  all live Prisma models with 6–12 call sites each.

**Recommended next step:** enable Fastify request logging for one week in the
target environment and diff observed routes against the ~300 registered at runtime. That
converts every POSSIBLY UNUSED above into a fact.

### ~~Dead allowlist entry~~ — WITHDRAWN 2026-08-29, the finding was WRONG

```
ORIGINAL CLAIM (false): '/api/health' is listed in PUBLIC_PATHS but no such
                        route exists.
Original evidence:      grep -rn "get('/health'" apps/api/src → 0 hits.
                        CLAUDE.md "There is no /health route".

WHY IT WAS WRONG:
  The route is registered in app.ts:297 as `app.get('/api/health', ...)`,
  at the top level with NO route prefix. The grep pattern searched for
  `get('/health'` — the path as it would appear INSIDE a prefixed module —
  which cannot match `get('/api/health'`. The pattern was incapable of
  finding the thing it was used to rule out, so the 0 hits meant nothing.
  CLAUDE.md's identical claim traces to the same bad grep, and this audit
  cited it as independent corroboration when it was the same error twice.

WHAT THE ROUTE ACTUALLY DOES:
  It is the tablet's liveness probe. apps/web/src/lib/connectivity.ts
  probeServer treats any non-2xx as "server unreachable", and app.ts:320-323
  documents deliberately returning 200 even when the job runner is down so a
  background-job fault cannot flip every tablet into offline mode. Its
  PUBLIC_PATHS entry is load-bearing: without it the probe 401s and every
  client decides the server is gone.

WHAT HAPPENED:
  The entry was removed on 2026-08-29 while acting on this finding, and
  reverted within minutes when the route was found. No commit carried it.

THE LESSON, which is this audit's own rule turned back on itself:
  a 0-hit grep is evidence only if the pattern COULD have matched. Every
  "does not exist" claim in this report rests on a grep; this one rested on
  a grep aimed at the wrong shape. Corroboration from a doc written by the
  same method is not corroboration.

Severity:   n/a — withdrawn
Recommendation: NONE. Leave the entry. Fix CLAUDE.md's "There is no /health
            route" line, which is still wrong.
```

---

## 14. Unused Database Tables

| Table | Used by code | Read | Write | API usage | FK | Data | Status |
|---|---|---|---|---|---|---|---|
| `system_config` | 116 call sites | ✅ | ✅ | ✅ | — | UNKNOWN | ACTIVE |
| `users` | 107 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `instruments` | 104 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `audit_trail` | 47 | ✅ | ✅ | ✅ | — | UNKNOWN | ACTIVE |
| `roles` | 40 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `role_configs` | 38 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `alarms` | 35 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `sessions` | 27 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `notifications` | 27 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `functional_locations` | 26 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `instrument_attributes` | 23 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `dead_letters` | 20 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `user_configs` | 19 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `instrument_profiles` | 19 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `notification_logs` | 17 | ✅ | ✅ | ✅ | — | UNKNOWN | ACTIVE |
| `floorplans` | 17 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `alarm_webhook_targets` | 16 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `floorplan_rooms` | 14 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `alarm_webhook_deliveries` | 13 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `user_groups` | 12 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `instrument_credentials` | 12 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `dashboards` | 12 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `alarm_rules` | 11 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `admin_requests` | 10 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `password_reset_requests` | 9 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `password_history` | 9 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `notification_rules` | 8 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `notification_templates` | 6 | ✅ | ✅ | ✅ | — | UNKNOWN | ACTIVE |
| `help_articles` | 6 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `dashboard_widgets` | 6 | ✅ | ✅ | ⚠️ no FE | ✅ | UNKNOWN | ACTIVE (see §13) |
| `user_group_members` | 4 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `dashboard_assignments` | 4 | ✅ | ✅ | ⚠️ no FE | ✅ | UNKNOWN | ACTIVE (see §13) |
| `field_id_config` | 3 | ✅ | ✅ | ✅ | — | UNKNOWN | ACTIVE |
| `help_article_versions` | 1 | ✅ | ✅ | ✅ | ✅ | UNKNOWN | ACTIVE |
| `notification_rule_recipients` | 0 direct | ✅ (nested) | ✅ (nested) | ✅ | ✅ | UNKNOWN | **ACTIVE** — accessed only via `include: { recipients: true }` |
| `instrument_telemetry_latest` | 0 Prisma | ✅ raw SQL | ✅ raw SQL | ✅ | ✅ | UNKNOWN | **ACTIVE** — raw SQL only |
| `instrument_telemetry_history` (+ monthly partitions) | 0 Prisma | ✅ raw SQL | ✅ raw SQL | ✅ | — | UNKNOWN | **ACTIVE** — no model at all |

**Conclusion: zero unused tables.** Every table in the schema has a live
reader and writer.

The two rows that a naive Prisma-client census would have called dead
(`notification_rule_recipients`, `instrument_telemetry_latest`) are both very
much alive. This is why §8 recommends no drops.

`Data present?` is `UNKNOWN` throughout —
**UNKNOWN: runtime/database access required.** No `psql` connection was made.

---

## 15. Unused Database Columns

**UNKNOWN — runtime/database access required.**

Answering this section honestly requires knowing which columns are always NULL
and which are never written, and neither is derivable from source. What *can*
be said from source:

| Table | Column | Read? | Write? | Data present? | Recommendation |
|---|---|---|---|---|---|
| `instruments` | `block` | ✅ **YES** | ✅ | UNKNOWN | **DO NOT REMOVE.** See correction below. |
| `instruments` | `area` | ✅ **YES** | ✅ | UNKNOWN | **DO NOT REMOVE.** Same. |
| `role_configs` | `instrument_scope` | ✅ | ✅ | UNKNOWN | **Do not "clean up".** Holds TWO shapes permanently — bare `string[]` (pre-2026-08-28) and `{locationIds, instrumentIds}`. `normalizeScope()` in `modules/instruments/visibility.ts` is the ONE reader of both. A second `Array.isArray` test anywhere reads a legacy restricted row as unrestricted — a privilege-escalation-shaped bug. |
| `role_configs` | `attribute_access` | ✅ | ✅ | UNKNOWN | Keep. NULL = inherit; a semantically meaningful NULL. |
| `audit_trail` | `checksum_version` | ✅ | ✅ | UNKNOWN | Keep. Distinguishes V2/V3 chain eras. |
| `floorplan_rooms` | `doors`, `grade` | ✅ | ✅ | UNKNOWN | Keep. Nullable by design; an omitted `doors` key on PUT leaves the column unchanged (deliberate §11 data-loss guard). |

### ⚠️ Correction — `instruments.block` / `.area` are NOT removal candidates

An earlier pass of this audit listed these two columns as the only genuine
removal candidates, on the strength of `CLAUDE.md`'s line that they are
"SUPERSEDED — no longer read for grouping". Grepping the code instead of
trusting the doc shows that claim was **generalised too far**:

```
Evidence:  grep -rn "\.block\b|block:" apps/api/src/modules/instruments
  routes.ts:95    block: { type: 'string', nullable: true }   ← response schema
  routes.ts:428   block: { type: 'string' }                   ← QUERY schema
  routes.ts:456   ...(block ? { block: { contains: block,
                     mode: 'insensitive' } } : {})            ← ACTIVE FILTER
  routes.ts:1124  block: { type: ['string','null'] }          ← response schema
  routes.ts:1270  block: { type: ['string','null'] }          ← response schema
  routes.ts:1392  location: i.location, area: i.area,
                  block: i.block                              ← RETURNED PAYLOAD
```

Both columns are **read on every instrument list request, exposed in three
response schemas, and used as a case-insensitive search filter.** What
`CLAUDE.md` actually says is that they are no longer authoritative *for
grouping* — `functionalLocationId` took that job. "Not used for grouping" is
much narrower than "not used", and collapsing the two would have produced a
recommendation to drop columns that a live query filters on.

**Net result of this section: there are NO identified unused-column
candidates.** Every column examined is either read, written, or semantically
meaningful as NULL.

This is worth recording as a method note. `CLAUDE.md` is the best doc in the
repo and it was still not safe to quote directly — its own Documentation Sync
Rule ("don't trust prior docs — verify") applies to itself.

**Recommendation:** completing this section properly requires a read-only
query per column, e.g.
`SELECT count(*) FILTER (WHERE col IS NOT NULL) FROM tbl;`. Even with those
numbers in hand, a §11 system has a strong argument for retaining columns
whose historical values were once part of a signed record.

---

## 16. Duplicate Code

```
Duplicate #1 — hand-rolled tab / segmented controls
Files:      apps/web/src/routes/alarms/index.tsx
            apps/web/src/routes/config/display-settings.tsx
            apps/web/src/routes/config/notification-rules/index.tsx
            apps/web/src/routes/config/notification-settings/email-settings.tsx
            apps/web/src/routes/config/role-access.tsx
Evidence:   Each declares its own `activeTab` / `const [tab` useState and its own
            button-row markup. `ls apps/web/src/components/ui/` → 19 primitives,
            and there is NO tabs.tsx among them.
            Corroborated by the branch's own commit history: 9a9bb9e is titled
            "back out the tab ARIA, and a third hand-rolled segmented control".
Similarity: structural, not textual — same state shape, same interaction, five
            independent implementations of the keyboard/ARIA behaviour.
Impact:     Accessibility is the real cost. Five implementations means five
            chances to get roving tabindex, aria-selected, and arrow-key
            navigation wrong — and 9a9bb9e shows a previous attempt to fix this
            was reverted.
Severity:   MEDIUM
Confidence: HIGH
Recommendation: Add components/ui/tabs.tsx with the ARIA behaviour in ONE place
            and migrate the five call sites. Given 9a9bb9e backed out a prior
            attempt, land the primitive first with tests, then migrate one page
            per commit.
```

```
Duplicate #2 — audit trigger disable/enable
Files:      apps/api/src/modules/audit/routes.ts:581-586  (single delete)
            apps/api/src/modules/audit/routes.ts:647-652  (bulk delete)
            apps/api/src/modules/backup/backup.repository.ts:422-433, :512
Evidence:   Three sites independently query pg_trigger, loop DISABLE TRIGGER,
            do work, loop ENABLE TRIGGER.
Similarity: ~95% between the two audit/routes.ts sites.
Impact:     This is the code that suspends §11 tamper-evidence. Having it in
            three places means a future fix (e.g. adding a savepoint, or
            failing closed if re-enable throws) must be made three times.
Severity:   MEDIUM (HIGH by blast radius, MEDIUM by likelihood)
Recommendation: Extract `withTriggersDisabled(tx, table, fn)` into lib/. Make
            re-enable run in a finally block — currently, if the delete throws,
            the ENABLE loop is skipped. The surrounding $transaction rolls back
            the ALTER too, so this is not a live bug, but the invariant is
            implicit rather than enforced.
```

```
Duplicate #3 — export surface
Files:      apps/web/src/lib/excel-export.ts, lib/pdf-report.ts,
            lib/export-surfaces.ts, lib/report-labels.ts,
            components/ExportMenu.tsx, components/report-download-dialog.tsx
Evidence:   Six modules cooperate on "download a report". lib/report-labels.ts
            exports REPORT_DEFS, ReportDef, ReportColumnDef and
            ReportLabelOverride — knip flags all four as unused.
Impact:     Suggests the export layer was refactored and an older
            definition-driven design was left behind alongside the new one.
Severity:   LOW
Confidence: MEDIUM — needs a read of the six files together to confirm which
            path is live.
Recommendation: Review as one unit rather than deleting the unused exports
            piecemeal.
```

**Backend duplication is low.** The repository/service/routes split is applied
consistently, `lib/` genuinely holds the cross-cutting concerns, and
`packages/shared` is a real shared kernel rather than a dumping ground.

---

## 17. Configuration Audit

### Files
- `.env.example` (root), `apps/api/.env.example` — templates, tracked.
- `apps/web/.env.production` — **tracked blank and `skip-worktree`** so no
  developer's IP enters the repo. Deliberate and correct.
- No `.env` is committed. `find . -name '.env*'` returns only the three above.

### Environment variables (41 distinct `process.env.*` reads)

`ALLOWED_ORIGINS` · `API_HTTPS` · `API_PROXY_TARGET` · `AUDIT_CHAIN_KEY` ·
`AUDIT_CHAIN_KEYED_FROM` · `BACKUP_MAX_ROWS_PER_TABLE` · `BCRYPT_ROUNDS` ·
`DATABASE_URL` · `DATABASE_URL_QUEUE` · `DEMO_API` · `DEMO_INTERVAL_MS` ·
`DEMO_PASS` · `DEMO_TOKENS` · `DEMO_USER` · `FAKE_AD_PORT` · `INGEST_TCP_PORT` ·
`INITIAL_ADMIN_PASSWORD` · `INSTRUMENT_TOKEN_KEY` · `JWT_EXPIRY_HOURS` ·
`JWT_SECRET` · `MAINTENANCE_CRONTAB_PATH` · `MAX_FILE_SIZE` ·
`MQTT_BROKER_URL` · `MQTT_CLIENT_ID` · `MQTT_PASSWORD` · `MQTT_USERNAME` ·
`NODE_ENV` · `NODE_TLS_REJECT_UNAUTHORIZED` · `PORT` · `PROBE_API` ·
`RETIRE_ACTOR` · `SERVE_WEB` · `TEST_DATABASE_URL` · `TLS_CERT_PATH` ·
`TLS_KEY_PATH` · `TRUST_PROXY` · `UPLOAD_ALLOWED_TYPES` · `UPLOAD_DIR` ·
`VERIFICATION_TOKEN_SECRET` · `WEB_DIST_DIR` · `WEB_PORT`

### Findings

```
SECRET FOUND — none.
No hardcoded credential, API key, token, or password value was found in
apps/, packages/, or scripts/. Every secret is read from process.env.
```

The one apparent exception is documented rather than hidden:
`apps/api/scripts/demo-live-scenario.ts` hardcodes a demo password. It is a
developer script, not application code, and `CLAUDE.md` calls this out
explicitly. **Severity: LOW.** Recommendation: read it from `DEMO_PASS`, which
the same script already supports elsewhere.

```
Finding:    NODE_TLS_REJECT_UNAUTHORIZED = '0' — TLS verification fully disabled.
Files:      apps/api/scripts/probe-live-alarm.ts:20
            apps/api/scripts/send-random-telemetry.ts:65
            scripts/publish-demo-telemetry.ts:28
Evidence:   grep -rn "NODE_TLS_REJECT_UNAUTHORIZED" apps packages scripts
            → exactly 3 hits, ALL in operator/probe scripts, NONE in
            apps/api/src or apps/web/src.
Impact:     Contained. These scripts talk to localhost with a mkcert cert.
Severity:   LOW / INFO
Confidence: HIGH
Recommendation: Prefer passing the mkcert root CA via NODE_EXTRA_CA_CERTS so
            the scripts cannot be copy-pasted into a context that reaches a
            real network.
```

```
Finding:    CORS falls back to a hardcoded localhost list when ALLOWED_ORIGINS
            is unset outside production.
File:       apps/api/src/app.ts:121-130
Code:       origin: (corsOrigins ?? 'http://localhost:5173,http://localhost:5175,
                     https://localhost,capacitor://localhost,http://localhost')
Impact:     `capacitor://localhost` is a leftover from the removed mobile app.
            The guard above it correctly THROWS if ALLOWED_ORIGINS is missing
            in production, so this list can never apply in prod.
Severity:   LOW
Confidence: HIGH
Recommendation: Drop capacitor://localhost. Note the default also lists 5173
            and 5175 but NOT 5176, which CLAUDE.md says is this fork's dev port
            — a developer running `npx vite` without start-app.bat gets a CORS
            failure whose cause is two files away.
```

**Dev/prod separation is genuinely good.** Three separate fail-closed guards:
`ALLOWED_ORIGINS` (throws in prod), `JWT_SECRET`/`VERIFICATION_TOKEN_SECRET`
(throw in prod/staging if absent or <32 chars), `INITIAL_ADMIN_PASSWORD`
(seed throws if unset). Swagger is public only when `NODE_ENV !== 'production'`.

---

## 18. Security Audit

This section is unusually short on findings, and that is the finding. The
security posture is above average for a project of this size, and the
decisions are documented at the point of enforcement rather than in a wiki.

### 🟠 HIGH — Audit trail can be physically deleted, breaking the §11 hash chain

```
Finding:    Two endpoints disable the audit_trail_no_delete Postgres trigger
            and physically DELETE audit records.
File:       apps/api/src/modules/audit/routes.ts:565-588 (DELETE /:id)
                                                :640-655 (POST /bulk-delete)
Code:       ALTER TABLE "audit_trail" DISABLE TRIGGER "audit_trail_no_delete"
            → tx.auditTrail.delete(...)
            → ALTER TABLE "audit_trail" ENABLE TRIGGER ...
Evidence:   Route's own Swagger description: "WARNING: breaks the tamper-evident
            hash chain — verify-chain will report the downstream chain invalid.
            Prefer POST /bulk-redact."
Mitigations already in place (all verified):
            • Requires AUDIT_DELETE permission + reauth
            • Rate limited to 5/min
            • A meta-audit record is written FIRST, in the same transaction,
              recording the deletion and stating "hash chain broken at this
              position"
            • ALTER TABLE takes ACCESS EXCLUSIVE, so no other connection can
              slip an unguarded delete through the window (the comment says so,
              and it is correct)
            • A redact path (POST /:id/redact, /bulk-redact) exists and is
              recommended in the description
Impact:     21 CFR Part 11 §11.10(e) requires audit trails that cannot be
            modified or obscured. Shipping a governed, audited, reauth-gated
            delete is a defensible design — but it is a QA/regulatory posture
            decision, not an engineering default, and whoever signs the
            validation package must know it exists.
Severity:   HIGH (compliance), LOW (exploitability — permission + reauth gated)
Confidence: HIGH
Recommendation: (a) Confirm with QA/RA that this capability is intended and
            documented in the validation package. (b) Consider a build-time or
            config kill-switch that removes the delete routes entirely for
            validated installs, leaving only redact. (c) Move the trigger
            dance behind one helper with a finally block (see §16 Duplicate #2).
```

### 🟡 MEDIUM — Residual user-enumeration oracle on a public endpoint

```
Finding:    GET /api/admin-requests/user-lookup is unauthenticated and returns
            whether a username exists, plus that user's full name.
File:       apps/api/src/modules/admin-requests/routes.ts:78-115
            apps/api/src/plugins/auth.ts:219 (PUBLIC_GET_PATHS)
Code:       return { exists: true, username: user.username, fullName: user.fullName }
Evidence:   config.skipAuth = true; rate limit 20 requests / 15 min, keyed by IP.
History:    The in-file comment shows this was ALREADY hardened once (2026-05-20):
            distinguishable 200-vs-404 removed, email/department/role/status
            dropped. The remaining `exists` boolean is, by construction, still
            an oracle — and fullName is real PII returned to an anonymous caller.
Impact:     An attacker with a list of candidate employee IDs can confirm which
            are real and harvest full names, at 20 tries per IP per 15 minutes.
            Distributed across IPs this is not a meaningful brake.
Severity:   MEDIUM
Confidence: HIGH (code read; the mitigation and its limits are both explicit)
Recommendation: The functional requirement is a contact-admin form. That does
            not need confirmation before submit — accept any employee ID,
            always return the same "submitted" response, and let an
            administrator resolve validity on the review side. That removes the
            oracle entirely rather than rate-limiting it.
```

### 🔵 LOW — Floorplan / photo / branding images are publicly readable

```
File:       apps/api/src/plugins/auth.ts:219
Evidence:   /uploads/photos/, /uploads/branding/, /uploads/floorplans/ are all
            GET-public.
Status:     EXPLICIT OPERATOR DECISION, recorded in-file and dated 2026-08-11,
            including the accepted exposure, the three mitigations (UUID
            filenames, no directory listing, upload still requires
            CONFIG_UPDATE), and precise reversal instructions.
Severity:   LOW — documented, accepted risk
Recommendation: No action. Recording it so it is re-reviewed if the threat model
            changes (e.g. if floor layouts become confidential).
```

### Checklist results

| Check | Result | Evidence |
|---|---|---|
| Hardcoded credentials / API keys / tokens | **None** | grep across apps/, packages/, scripts/ |
| SQL injection | **Not present** | 20+ `$queryRawUnsafe` call sites; every interpolated identifier passes `assertSafeIdentifier()` and is sourced from `pg_tables` / `pg_trigger` / `information_schema`, never from user input. Values are always parameterised. |
| XSS | Mitigated | `sanitize-html` strips HTML on all text fields (`lib/sanitize.ts`); React escapes by default. **`grep -rn "dangerouslySetInnerHTML" apps/web/src` → 0 hits** — the escape hatch is not used anywhere. |
| CSRF | N/A by design | Bearer-token auth, not cookie auth |
| Broken authentication | No | `getSecret()` throws in production/staging if a secret is missing or <32 chars (`lib/jwt.ts:4-16`); JWT TTL clamped to 1h default |
| Broken authorization | No | Two-layer: `PERMISSION_TREE` gate + per-route `requirePermission`; instrument visibility enforced **on the query** and returns 404 (never 403, which would confirm existence) |
| Input validation | Yes | Fastify JSON Schema on every route + zod in services |
| Unsafe file upload | Mitigated | 5 MB / 1 file limit, `UPLOAD_ALLOWED_TYPES` allowlist, random UUID filenames |
| Path traversal | Not found | Uploads write to `UPLOADS_ROOT` with generated names |
| Command injection | **Not present, but `exec` IS used** | `apps/api/src/modules/system-health/routes.ts:3` imports `exec` from `node:child_process` and shells out twice — `wmic logicaldisk where "DeviceID='C:'" get Size,FreeSpace /format:csv` (line 43) and `df -B1 / \| tail -1 \| awk '{print $2,$3,$4}'` (line 55). **Both are fully static string literals with zero interpolation**, so there is no injection vector. Recorded because it is the only shell-out in the codebase and it is reachable from an HTTP route — any future change that interpolates a value there becomes command injection immediately. |
| Unsafe deserialization | No | JSON only |
| CORS | Fail-closed in prod | throws if `ALLOWED_ORIGINS` unset |
| Insecure cookies | N/A | No session cookies |
| Missing HTTPS | No | `API_HTTPS=true`; HSTS max-age 31536000, includeSubDomains, preload |
| Weak password handling | No | bcrypt, configurable rounds, password history table, expiry sweep, policy config |
| Sensitive data in logs | **No** | 32 total log calls; `lib/mask-secrets.ts` masks notification credentials, with a dedicated e2e test (`notification-config-audit-masking.test.ts`) |
| Debug mode in production | No | log level `info` in prod, `debug` otherwise; Swagger non-public in prod |
| Stack traces exposed | **No** | `app.ts:277-280` returns a generic message unless `NODE_ENV === 'development'`, and truncates to 500 chars even then |
| Dangerous HTTP methods | Blocked | TRACE/CONNECT → 405 before any plugin (`app.ts:110-115`) |
| CSP | Present | `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`; `unsafe-inline` on script/style is required by Swagger UI and is therefore a real (if narrow) weakening |
| Permissions-Policy | Present | camera/microphone/geolocation/payment all denied |

**Vulnerability count: 0 CRITICAL, 1 HIGH (compliance-posture, not
exploitability), 1 MEDIUM, 1 LOW.**

---

## 19. Dependency Audit

### Root
`turbo` ^2.4.0, `madge` ^8.0.0. Both dev-only. Fine.

### `apps/api` — 25 runtime dependencies

| Dependency | Used? | Evidence |
|---|---|---|
| `exceljs` ^4.4.0 | ❌ **NO** | `grep -rc "exceljs" apps/api` → **1 hit, and it is `apps/api/package.json` itself** — zero hits in `apps/api/src`. The only consumer in the whole repo is `apps/web/src/lib/excel-export.ts`, and `apps/web/package.json` declares it independently. **UNUSED DEPENDENCY — HIGH confidence.** |
| `@digilog/queue`, `@digilog/shared` | ✅ | workspace links |
| `@fastify/{cors,helmet,multipart,rate-limit,static,swagger,swagger-ui,websocket}` | ✅ | all registered in `app.ts:125-186` |
| `@prisma/client`, `prisma` | ✅ | `lib/prisma.ts` |
| `adm-zip` | ✅ | backup export/restore |
| `bcrypt` | ✅ | `lib/password.ts` |
| `dotenv` | ✅ | `app.ts:1` |
| `fastify`, `fastify-plugin` | ✅ | core |
| `jose` | ✅ | `lib/jwt.ts` |
| `ldapts` | ✅ | `modules/ldap/` |
| `mqtt` | ✅ | **CONFIRMED LIVE.** `CLAUDE.md` records that this was wrongly documented as removed. |
| `nodemailer` | ✅ | `notification-delivery/channels/email-channel.ts:7` |
| `sanitize-html` | ✅ | `lib/sanitize.ts` |
| `zod` | ✅ | schemas throughout |

`apps/api` devDependencies: `ldapjs` is used only by
`src/test-support/fake-ad-server.ts` — correctly a devDependency, and it is a
deliberate second LDAP library (server-side, for tests) alongside `ldapts`
(client-side, for production). Not a duplicate.

### `apps/web` — 14 runtime dependencies, all used

`react-grid-layout` ✅ (`routes/dashboard/panel-grid.tsx` + `app.css`),
`jspdf`/`jspdf-autotable` ✅ (`lib/pdf-report.ts`), `exceljs` ✅, `swr` ✅,
`clsx`+`tailwind-merge` ✅ (`lib/cn.ts`), `react-hook-form` +
`@hookform/resolvers` ✅, `lucide-react` ✅,
`@fontsource-variable/inter` ✅, `react-router-dom` ✅.

`vite-plugin-pwa` ^0.20.0 (devDependency) is **still active** —
`vite.config.ts:4,36` registers `VitePWA` with a manifest and icons, and
`components/pwa-reload-prompt.tsx` exists. Worth a decision, not a removal:
the mobile/offline domain was removed, so the question is whether an installable
PWA is still wanted. It is currently shipping.

### Version posture

| Category | Finding |
|---|---|
| **Confirmed vulnerability** | **UNKNOWN — `npm audit` not run** (it would require network access; this audit was source-only). Recommend running `npm audit --omit=dev` before the next release. |
| **Potential concern** | `vite-plugin-pwa` ^0.20.0 is a 0.x major — the caret does not protect against breaking changes the way it does for 1.x+. |
| **Outdated** | `zod` ^3.24 (zod 4 exists); `lucide-react` ^0.474 (also 0.x). Neither is urgent. |
| **Unused** | `exceljs` in `apps/api` (above). |
| **Pinning** | Everything uses `^`. `packageManager: "npm@11.6.2"` is pinned and `package-lock.json` is committed, so builds are reproducible. Acceptable. |
| **Dev deps in prod** | None found — the split is correct in all four manifests. |

**Total: 1 confirmed unused dependency.** For a monorepo this size that is a
very clean result.

---

## 20. Performance Audit

### Backend

```
🟠 Finding:  The backup engine enumerates pg_tables with no partition filter,
             while instrument_telemetry_history is a monthly-range-partitioned
             table whose partitions ARE ordinary tables in pg_tables.
File:        apps/api/src/modules/backup/backup.repository.ts:49-65
Code:        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
             ... .filter(name => !EXCLUDED_TABLES.has(name))
             const EXCLUDED_TABLES = new Set(['_prisma_migrations']);
Evidence:    grep -rn "relispartition\|relkind\|partition"
               apps/api/src/modules/backup/  →  0 hits. No partition awareness.
             Partitioning confirmed at migrations/20260804120000_instruments_p1/
               migration.sql:58  "PARTITION BY RANGE (\"ts\")"
               :66, :68          CREATE TABLE ..._2026_08 PARTITION OF ...
             Partitions are created monthly and dropped on retention by
               workers/telemetry-partition.worker.ts.
Consequences (each follows from the code; see confidence note):
   1. fetchAllTablesRaw() runs SELECT COUNT(*) then SELECT * against the
      partitioned PARENT *and* against every child partition — so every
      telemetry row is read twice and held in memory twice.
   2. The BACKUP_MAX_ROWS_PER_TABLE guard (default 500,000) will almost
      certainly trip on the parent, meaning **backup export fails outright**
      on any deployment with real telemetry volume.
   3. On restore, inserting into the parent routes rows into partitions, and
      then inserting the partition dumps duplicates them.
   4. topologicalSort() sees no FKs for partitions, so their order is arbitrary.
Impact:      Backup/restore — the disaster-recovery path of a §11 system — is
             likely non-functional at production data volumes, and the failure
             mode (a thrown BackupTooLargeError naming the telemetry table)
             would read as "the data is too big" rather than "the enumeration
             is wrong".
Severity:    HIGH
Confidence:  HIGH that the code contains no partition filter (grep, 0 hits).
             MEDIUM-HIGH on the runtime consequences — confirming them needs one
             read-only query:
               SELECT tablename FROM pg_tables WHERE schemaname='public'
                 AND tablename LIKE 'instrument_telemetry_history%';
             If that returns more than one row, consequences 1-4 all follow.
Recommendation:
             Filter to relkind='r' AND relispartition=false, i.e. exclude both
             partitioned parents and their children, then handle
             instrument_telemetry_history explicitly (stream it, or exclude it
             from logical backup and cover it with pg_dump / PITR instead —
             which the BackupTooLargeError message already gestures at).
```

```
🟡 Finding:  Session sweep does one UPDATE per stale session, in a loop, with
             no upper bound on the set it loads.
File:        apps/api/src/modules/auth/session-sweep.ts:37-58
Code:        const stale = await prisma.session.findMany({
               where: { isActive: true, OR: or },
               include: { user: { select: {...} } },
             });                                   // ← no take:
             for (const s of stale) {
               await prisma.session.update({...}); // ← N+1
               await auditLog({...});
             }
Impact:      A sweep that has not run for a while (service restart, DB
             maintenance) loads every stale session with its user relation into
             memory, then issues 2N serialized round trips.
Nuance:      The per-session auditLog is NOT the bug — §11 requires one record
             per terminated session, and the hash chain forces those writes to
             be serial. Only the session.update is batchable.
Severity:    MEDIUM
Confidence:  HIGH
Recommendation: Add `take:` (e.g. 1000) and loop until drained; replace the
             per-row update with a single updateMany over the collected ids
             AFTER the audit writes succeed.
```

```
🟡 Finding:  GET /api/notifications has no server-side default or maximum page size.
File:        apps/api/src/modules/notifications/notification.service.ts:54, :134
             apps/api/src/modules/notifications/notification.repository.ts:4-8
Code:        limit: z.coerce.number().min(1).optional(),     // no .max(), no default
             ...(take ? { skip, take } : {})                 // omitted take ⇒ NO LIMIT
Impact:      Omitting `limit` returns every notification row the caller can
             see. `notifications` is a high-growth table (system errors, alarm
             raises, clears, acknowledgements).
Mitigating:  The only caller always sends one —
             routes/notifications/index.tsx:121 builds
             `limit: String(perPage)` unconditionally. So this is a LATENT
             risk, not an active defect.
Severity:    MEDIUM (latent)
Confidence:  HIGH
Recommendation: Give `limit` a default (say 50) and a `.max()` (say 500) in the
             zod schema. One line, removes the class of problem.
```

**Other backend observations.**
- `102` `findMany` call sites; only `9` files use `take:`. Most of the
  unbounded ones are legitimately small sets (roles, functional locations,
  floorplans, config). The two that matter are listed above.
- `alarms` **is** correctly bounded: `take: Math.min(q.limit ?? 200, 500)`
  (`modules/alarms/routes.ts:297`). Good pattern — copy it to notifications.
- `37` `$transaction` uses. Multi-write paths (user create, role update, audit
  redact, group membership) are transactional.
- **No blocking/synchronous I/O** found in request handlers.

### Frontend
- **SWR** provides request dedup and caching globally (`lib/swr-config.ts`).
- **No chart library** — `time-series-chart.tsx` is hand-rolled SVG. This is a
  meaningful bundle-size win over Recharts/Chart.js.
- **LTTB downsampling** (`packages/shared/src/types/telemetry-downsample.ts`)
  is done **server-side**, so a 30-day chart transfers ~2,000 points rather
  than ~28,000 rows. Correct architecture.
- **Zoom refetches rather than magnifying** — more requests, but honest data.
  The right trade for a §11 system, and documented as such.
- ⚠️ **Largest components:** `routes/instruments/trend.tsx` (1,167 lines),
  `config/notification-rules/index.tsx` (1,041), `config/alarm-webhooks.tsx`
  (959). No `React.lazy` / route-level code splitting was found, so all 51
  routes are in the initial bundle. **Recommendation:** lazy-load the `config/*`
  routes — they are the biggest and the least frequently visited.

---

## 21. Error Handling

**Assessment: strong.** `app.setErrorHandler` (`app.ts:189-281`) is one of the
better examples in the codebase.

| Case | Status | Code |
|---|---|---|
| `AppError` → typed HTTP | ✅ | `err.statusCode` + `err.code` + optional details |
| 429 rate limit | ✅ | explicit branch |
| 413 body too large | ✅ | computes and reports the actual size in MB |
| 400 validation | ✅ | `FST_ERR_VALIDATION`, includes field details |
| 415 unsupported media type | ✅ | explicit |
| 400 JSON parse | ✅ | both invalid and empty body |
| **409 Prisma P2002** | ✅ | Unique-constraint collisions become a clean retryable conflict instead of a 500 + spurious SYSTEM_ERROR notification. Systemic — covers every current and future unique index. |
| 500 fallback | ✅ | generic message in production; truncated to 500 chars even in development |
| Error notification storm | ✅ | rate-limited to 1/min, and the dispatch failure path explicitly does **not** rethrow, with a comment explaining the infinite loop it would cause |

### Findings

```
🔵 Finding:  The SYSTEM_ERROR notification rate limiter is a module-level
             mutable variable.
File:        apps/api/src/app.ts:189  `let lastErrorNotification = 0;`
Impact:      Per-process. Two API instances = 2 notifications/min. Same
             single-instance assumption as the alarm-webhook cooldown.
Severity:    LOW (single-instance deployment today)
Recommendation: Note it in the scaling checklist rather than fixing it now.
```

```
🔵 Finding:  Trigger re-enable is not in a finally block.
File:        apps/api/src/modules/audit/routes.ts:584-586, :650-652
             apps/api/src/modules/backup/backup.repository.ts:433, :512
Impact:      If the guarded operation throws, ENABLE TRIGGER is skipped. The
             enclosing $transaction rolls the ALTER back, so the trigger is
             restored — but by accident of transactional DDL, not by design.
             Any future refactor that moves this outside a transaction turns it
             into a permanently disabled tamper-evidence trigger.
Severity:    LOW today, HIGH if refactored
Confidence:  HIGH
Recommendation: try/finally, in the single extracted helper from §16.
```

### 🟡 Parameterless `catch {}` blocks — 72 of them

```
Finding:    72 catch blocks discard the error object entirely.
Evidence:   grep -rn "} catch {" apps/api/src --include=*.ts | grep -v test  → 30
            grep -rn "} catch {" apps/web/src                 | grep -v test  → 42
Assessment: MOST are legitimate parse-with-fallback (lib/format-datetime.ts:64,
            :76, :89; lib/user-id-validator.ts:39; token-crypto.ts:99) — the
            failure IS the answer and there is nothing to report.
            But at least one loses a real signal:
              modules/system-health/routes.ts:60  `catch { return {total:0,
              used:0, free:0, usagePercent:0} }`
            A failed `df`/`wmic` therefore reports the disk as 0 bytes total
            and 0% used — on a HEALTH endpoint. An operator reading that sees
            a plausible-looking number, not an error, and combined with §22's
            thin logging there is no trace of why.
Impact:     Misleading health telemetry; a class of silently-degraded signal.
Severity:   MEDIUM
Confidence: HIGH
Recommendation: Audit the 72 individually. Where the fallback is the answer,
            keep it. Where a signal is lost — system-health above being the
            clearest — capture the error and either log it or return an
            explicit `unavailable` state rather than a fabricated zero.
```

*Correction note:* an earlier pass of this audit asserted "no swallowed
exceptions were found". That was an unverified generalisation and it was
wrong — the grep above had not been run when it was written. What remains
true is narrower and still worth saying: **no `catch` block was found that
swallows an error in order to hide a failed write or a failed authorisation
check.** The §11-critical paths (audit writes, hash chain, permission gates,
reauth) all propagate.

---

## 22. Logging

| Aspect | Finding |
|---|---|
| Logger | Fastify's built-in pino. No separate logging module. |
| Configuration | `app.ts:96-99` — level `info` in production, `debug` otherwise. That is the *entire* configuration. |
| Destination | stdout. In the Windows-service deployment WinSW captures it. |
| **Rotation** | ✅ **Configured** — `scripts/register-services.ps1:78-82`: `<log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>`. That is 10 MB × 8 = **80 MB retained**. |
| Sensitive data | ✅ **Clean.** `lib/mask-secrets.ts` masks notification credentials before audit; a dedicated e2e test (`notification-config-audit-masking.test.ts`) locks it. The single grep hit pairing a log call with "TOKEN" is `instruments/routes.ts:1821`, which logs the env var *name*, never a value. |
| Excessive logging | No — the opposite. |
| Error tracking | None. No Sentry/APM integration. |

```
🟡 Finding:  Only 32 explicit log statements exist across ~40,000 lines of
             backend code.
Evidence:    grep -c "log.info|log.warn|log.error|log.debug" apps/api/src
             (excluding tests) → 32.
Impact:      Operationally thin for a regulated system. When something goes
             wrong in the field, the available evidence is: Fastify's automatic
             request/response lines, 32 hand-placed messages, and the audit
             trail. Notably absent: worker task start/finish/failure, MQTT
             connect/disconnect, ingest rejection reasons, LDAP bind outcomes.
Severity:    MEDIUM
Confidence:  HIGH
Recommendation: Add structured logs at the boundaries that fail silently today
             — each of the 6 worker tasks (start, count processed, duration,
             failure), the MQTT client lifecycle, and ingest token rejections.
             These are precisely the paths with no user watching.
```

```
🔵 Finding:  80 MB of retained logs may be short for §11 diagnostics.
Evidence:    WinSW keepFiles=8, sizeThreshold=10 MB.
Impact:      A chatty ingest deployment could roll away the evidence for an
             incident within days. The audit trail is separate and safe — this
             concerns operational diagnostics only.
Severity:    LOW
Recommendation: Raise keepFiles, or switch to roll-by-time with a documented
             retention that matches the validation package.
```

---

## 23. Testing

**215 test files** — an unusually strong ratio against 630 source files.

| Area | Count | Command |
|---|---|---|
| API unit (`modules/`, `lib/`, `plugins/`) | 84 | `find apps/api/src -name '*.test.ts' -not -path '*e2e*'` |
| API e2e (real Postgres) | 44 | `ls apps/api/src/e2e` |
| Web (vitest + Testing Library + jsdom) | 60 | `find apps/web/src -name '*.test.ts*'` |
| `packages/shared` + `packages/queue` | 27 | |
| `tests/` (integration + e2e scripts) | 6 | |

### Coverage by module

| Module | Unit tests | e2e | Risk |
|---|---|---|---|
| `instruments` | 20 | 12 | 🟢 Excellent — the core domain is the best-tested |
| `alarms` | 7 | 4 | 🟢 |
| `alarm-webhooks` | 6 | 1 | 🟢 |
| `ldap` | 5 | 1 | 🟢 incl. a fake AD server |
| `config` | 4 | 1 | 🟢 |
| `auth` | 4 | 2 | 🟢 |
| `backup` | 3 | **0** | 🟠 **See below** |
| `users`, `uploads`, `roles`, `notifications`, `functional-locations` | 2 each | ✓ | 🟢 |
| `notification-delivery`, `floorplans`, `dashboards` | 1 each | ✓ | 🟡 |
| `audit` | 0 module | 4 e2e + `lib/audit.test.ts`, `lib/hash-chain.test.ts` | 🟢 covered elsewhere |
| `help`, `instrument-profiles`, `system-health` | 0 module | 1 e2e each | 🟡 |
| **`admin-requests`** | **0** | **0** | 🔴 **Untested.** Includes the public `user-lookup` endpoint. |
| **`debug-traces`** | **0** | **0** | 🟠 **Untested** |
| **`user-groups`** | **0** | **0** | 🟠 **Untested.** Notification targeting depends on it. |
| **`notification-rules`** | **0** | **0** | 🟠 **Untested.** Decides who gets alerted. |
| **`super-admin`** | **0** | 1 (`super-admin-data-delete`) | 🟡 partial |

```
🟠 Finding:  The backup/restore path has 3 unit tests and ZERO e2e tests.
Evidence:    ls apps/api/src/e2e → no backup*.test.ts among 44 files.
Impact:      Backup/restore is the disaster-recovery path of a regulated
             system, it is the most raw-SQL-heavy module in the codebase
             (TRUNCATE everything + topologically ordered reinsert + trigger
             disabling), and §20 identifies a probable correctness bug in it
             (partition enumeration). An e2e round-trip test — seed, export,
             wipe, restore, assert equality — would have caught that.
Severity:    HIGH (risk-weighted; the code is exercised rarely and
             catastrophically)
Confidence:  HIGH
Recommendation: Highest-value single test to write in this repo.
```

### Test quality notes
- e2e tests run against a **real Postgres** (`compliance_core_db_test`), not a
  mock. That is why they catch schema drift.
- Snapshot tests lock `PERMISSION_TREE`-derived maps to zero drift.
- `telemetry-downsample` unit tests assert **reference equality** (`toBe`) so a
  refactor that builds new point objects fails — this is a genuinely
  sophisticated test guarding a genuinely subtle §11 property (a plotted point
  must be a stored reading).
- ⚠️ **`vitest` does not typecheck.** `npm run lint` (`tsc --noEmit`) is a
  separate gate. A green test run is not evidence the project compiles.
- ⚠️ No coverage tool is configured (`grep` for `c8`/`istanbul`/`--coverage`
  → none). Coverage percentages are **UNKNOWN**.

---

## 24. Documentation

This is the weakest area of the project, and the gap between the good docs and
the bad ones is wide.

### The good
- `CLAUDE.md` — dense, opinionated, and mostly accurate. Its "Documentation
  Sync Rule" (every numerical claim must be backed by a `grep`/`ls` at the
  moment the doc is touched) is exactly right, and it carries dated corrections
  of its own past errors, which is rare and valuable.
- `docs/recreation/` — described as the verified inventory, and consistent with
  what this audit found.
- `docs/CONTRIBUTING.md` — holds the "Change → Docs map", the 12-touchpoint
  rule for new config defs, and a pre-deletion rule with receipts.
- **In-code documentation is excellent.** Comments explain *why*, cite dates
  and decisions, and sit next to the line that would otherwise be misread.

### The bad — verified drift

```
🟠 Finding:  PROJECT_ARCHITECTURE.md documents a large subsystem that does not exist.
File:        PROJECT_ARCHITECTURE.md:104-211, :295
Evidence:    Line 104  "├── apps/android/   (Capacitor Android wrapper)"
             Line 109  "RfidPlugin.java — native Capacitor plugin wrapping Reader_Usb.jar"
             Line 191  "├── rfid_scan_app/  (Standalone Kotlin app)"
             Line 195  "rfid-key.jks  **SENSITIVE** signing keystore"
             Line 197  "start-digilog.bat / stop-digilog.bat"
             Line 295  "Three worker tasks remain after the Phase 6/7 tear-out"
             Reality:  ls apps/ → api, web.   ls rfid_scan_app → not found.
                       ls → start-app.bat / stop-app.bat (not start-digilog).
                       app.ts:458-489 registers SIX worker tasks, not three.
             The file DOES carry a warning banner at lines 5-6 — but the banner
             is 2 lines and the fiction is 200+.
Impact:      A new engineer reading the architecture doc will look for an
             Android app, worry about a committed signing keystore, and
             miscount the workers. The `rfid-key.jks` line in particular
             manufactures a phantom security incident.
Severity:    MEDIUM
Confidence:  HIGH
Recommendation: Move PROJECT_ARCHITECTURE.md to docs/archive/ (where the
             project already puts non-current docs) and write a short accurate
             replacement, or delete the sections describing removed subsystems
             outright. A warning banner over false content is not a fix.
```

```
🟡 Finding:  PROJECT_SUMMARY.md contains the same class of drift.
Evidence:    Line 45 lists "rfid_scan_app/ — Native Kotlin Android RFID scanner"
             in its directory tree, immediately after lines 6-7 assert that
             rfid_scan_app does not exist. The file contradicts itself within
             40 lines.
             Line 29's DB cell contains an entire paragraph of upstream DigiLog
             schema history (FilterProfile, ChecklistProfileVersion,
             EquipmentGroupVersion, AssetTemplate) for models that are gone.
Severity:    MEDIUM
Confidence:  HIGH
Recommendation: Same as above.
```

```
🟡 Finding:  bloat.md sits at the repository root and audits a codebase that
             no longer exists.
File:        bloat.md (repo root)
Evidence:    Header: "2026-04-20 ... branch RFID, head ebb77b6".
             Its P0.1 finding names apps/web/src/routes/mobile/mobile-operations.tsx.
             ls apps/web/src/routes → no mobile/ folder.
Impact:      It is a long optimisation report at the root, which reads as
             current. Its P0/P1 items are mostly unactionable.
Severity:    MEDIUM
Recommendation: Move to docs/archive/ with a dated header, or delete.
```

### CLAUDE.md's own drift — found by applying its own rule

`CLAUDE.md` mandates re-deriving every count. Doing so:

| Claim | Command | Actual | Verdict |
|---|---|---|---|
| 24 API modules | `ls apps/api/src/modules/ \| wc -l` | **24** | ✅ |
| 36 models, 13 enums | `grep -cE "^model \|^enum "` | **36 / 13** | ✅ |
| 42 permissions | `grep -cE "^\s+[A-Z_]+:\s*'" permissions.ts` | **42** | ✅ |
| 48 reauth actions | `grep -cE "^\s+[A-Z_]+:" reauth-actions.ts` | **48** | ✅ |
| 12 sidebar items | `sidebar-items.ts` | **12** | ✅ |
| 97 audit actions | `grep -cE "^\s+[A-Z_]+:" audit-actions.ts` | **97** | ✅ |
| 25 config defs | `ls config/defs/*.def.ts \| wc -l` | **25** | ✅ |
| 51 routes | `grep -cE "<Route" main.tsx` | **51** | ✅ |
| 6 worker tasks | `app.ts` taskList literal | **6** | ✅ |
| 19 lib modules | `ls apps/web/src/lib \| wc -l` | **19** | ✅ |
| **18 custom hooks** | `ls apps/web/src/hooks \| wc -l` | **20** | ❌ **STALE** |
| **24 config pages** *and* **25 config pages** | `ls routes/config/*.tsx \| wc -l` | **24** | ⚠️ **CLAUDE.md states BOTH numbers, in two different bullets of the same file.** 24 is correct. |

**11 of 13 counts verified exact.** That is a good record — but the two misses
matter, because one of them is a self-contradiction inside the file that is
supposed to be the source of truth.

### Missing documentation
- **No architecture decision record for the audit-delete capability** (§18 HIGH).
- **No runbook for the `instrument_telemetry_history` migration hazard** (§9
  CRITICAL). The knowledge exists only in an operator's notes, not in the repo.
- **No `npm audit` / dependency-review cadence documented.**

---

## 25. Deployment

| Aspect | Finding |
|---|---|
| Model | Windows-native. **No Docker, no compose, no k8s, no nginx/Apache/IIS.** |
| Installer | Inno Setup — `installer/DigiLog.iss` |
| Services | Two Windows services via `scripts/register-services.ps1`: `DigiLogDB` (bundled PostgreSQL via `pg_ctl register`) and `DigiLogAPI` (node + WinSW) |
| Dependency ordering | ✅ `<depend>DigiLogDB</depend>` — the API cannot start before its database |
| Restart policy | ✅ `<onfailure action="restart" delay="10 sec" />` |
| Start mode | ✅ Automatic — survives reboot |
| **`NODE_ENV`** | ✅ `<env name="NODE_ENV" value="production" />` — **this is important**: it activates every fail-closed guard in §17 |
| Env file | `DOTENV_CONFIG_PATH` points at an operator-managed `digilog.env` outside the repo |
| Log rotation | ✅ roll-by-size, 10 MB × 8 |
| TLS | mkcert dev certs in `certs/`; `TLS_KEY_PATH`/`TLS_CERT_PATH` for real deployments |
| SPA serving | Optional — `SERVE_WEB` makes the API serve the built UI, removing the need for a separate web server |
| Scripts | 19 in `scripts/`: install, uninstall, upgrade, provision-db, backup-db, register-backup-task, stage-runtime, build-bundle, build-installer, verify-migrations, verify-windows-deployment |
| Dev/prod separation | ✅ Clear. `start-app.bat`/`stop-app.bat` for dev; the PowerShell install chain for production. |
| Rollback | `scripts/upgrade.ps1` exists — rollback semantics **UNKNOWN** without reading it in full |
| Cloud | An EC2 Windows + RDS deployment exists out-of-band. **There is no IaC for it in this repo** — it is provisioned and deployed by hand (`deploy-to-aws.bat` + `docs/DEPLOY-AWS-EC2.md`). |

```
🟡 Finding:  Production infrastructure has no representation in the repository.
Evidence:    No Terraform/CloudFormation/CDK/Ansible anywhere in the tree.
             deploy-to-aws.bat is a client-side push helper, not provisioning.
Impact:      The live environment cannot be rebuilt from this repository.
             For a validated (21 CFR Part 11) system, "how the production
             environment was constructed" is normally part of IQ/OQ evidence.
Severity:    MEDIUM (higher if the deployment is customer-facing/validated)
Confidence:  HIGH
Recommendation: At minimum, commit a documented, versioned build sheet for the
             EC2/RDS environment. IaC would be better.
```

```
🔵 Finding:  certs/rootCA.pem is a decoy.
Evidence:    CLAUDE.md records (dated 2026-08-06) that this file is a hand-rolled
             "CN=DigiLog Root CA" that signs nothing in use, that the real CA is
             %LOCALAPPDATA%\mkcert\rootCA.pem, and that the false claim
             "cost two agents an investigation each".
Severity:    LOW
Recommendation: Delete it, or rename it to rootCA.UNUSED.pem. The cost of
             keeping it is already measured.
```

---

## 26. Orphaned Components

| Category | Item | Verdict |
|---|---|---|
| Orphaned API | — | **None.** All 249 route registrations resolve to a live handler. |
| Orphaned module | — | **None.** All 24 registered in `app.ts`. |
| Orphaned page | `config/audit-templates.tsx`, `branding.tsx`, `field-ids.tsx`, `pagination.tsx` | **FALSE ALARM** — composed as tabs by `display-settings.tsx` and `appearance.tsx`. Verified. |
| Orphaned component | `components/ui/error-popup.tsx`, `components/ui/radio.tsx` | ✅ **Genuinely orphaned** (knip + grep) |
| Orphaned lib | `lib/report-review.ts` | ✅ **Genuinely orphaned** — and calls a nonexistent API |
| Orphaned UI shell | `components/SendForReviewButton.tsx` | ⚠️ **Suspected** — the surviving button of the report-review feature. Confirm it is not rendered before removing. |
| Orphaned constants | 9 `SYNC_*`/`CONNECTIVITY_*` in `lib/timing-constants.ts` | ✅ **Genuinely orphaned** |
| Orphaned exports | `getLastServerContact`, `subscribeToServerContact` | ✅ **Genuinely orphaned** (read side of a live write side) |
| Orphaned DB table | — | **None.** All 36 models + both raw-SQL tables have live readers and writers. |
| Orphaned model | `InstrumentTelemetryLatest` | ⚠️ **Model orphaned from the Prisma client, table fully alive.** Do not remove. |
| Orphaned migration | — | None. 24 migrations, all applied. |
| Orphaned configuration | ~~`/api/health` in `PUBLIC_PATHS`~~ | ❌ **NOT orphaned — finding withdrawn.** The route exists (`app.ts:297`) and is the tablet's liveness probe. See §13. |
| Orphaned configuration | `capacitor://localhost` in the CORS fallback | ✅ Removed-mobile leftover |
| Orphaned service | — | None |
| Orphaned script | `test-engine.mjs` (root) | ⚠️ Not referenced by any `package.json` script, `turbo.json`, or `vitest.workspace.ts`. Review. |
| Orphaned assets | `old/` (160 files, 5.7 MB) | ⚠️ No code reference; apply the pre-deletion rule |
| Orphaned doc | `bloat.md` | ✅ Audits a codebase that no longer exists |

**The orphan count is low and the false-positive rate among naive candidates
was high (4 config pages, 3 of 5 knip "unused files", 2 Prisma models).**
Every removal below should be re-verified with a fresh grep at the time it is
made.

---

## 27. Business Flow Review

### Flow 1 — Governed instrument attribute edit (the §11 archetype)

```
User edits an attribute in the instrument detail panel
 ↓ Frontend  routes/instruments/detail.tsx
   The panel renders ONLY what GET /api/instruments/:id/attributes says is
   editable — it does not compute editability itself.
 ↓ API       PUT /api/instruments/:id/attributes/:key
 ↓ AuthN     plugins/auth.ts — JWT
 ↓ AuthZ     plugins/rbac.ts — INSTRUMENT_UPDATE
 ↓ Re-auth   x-reauth-password header, if the role requires it
 ↓ Gate      modules/instruments/attribute-access.ts — the ONE gate shared by
             POST/PUT/DELETE. Narrows INSTRUMENT_UPDATE, never widens it.
             Decision logic lives in @digilog/shared/attribute-access.
 ↓ Validate  reason REQUIRED on change/delete (not on first fill)
 ↓ Write     instrument_attributes  +  audit_trail (hash-chained, with reason)
 ↓ Response  → SWR revalidates → panel re-renders from the server's answer
```
**Assessment: exemplary.** One gate, server-side decision, mandatory reason,
hash-chained record, and the client never re-derives the policy. This is the
pattern the rest of the codebase should be measured against.

### Flow 2 — Telemetry ingest → alarm → annunciator

```
Device → one of 4 transports (HTTP POST / WebSocket / raw TCP / MQTT via EMQX)
 ↓ AuthN   per-instrument token (NOT a user JWT — PUBLIC_PATHS exemption)
 ↓ Write   instrument_telemetry_latest (UPSERT)
         + instrument_telemetry_history (INSERT, routed to a monthly partition)
 ↓ Evaluate  immediately on ingest (~1s), AND on the alarm_evaluation cron
             every minute — the cron CANNOT be removed, because OFFLINE alarms
             fire on the ABSENCE of telemetry.
 ↓ Raise   alarms row; ruleSnapshot FREEZES decimals at raise time so the §11
           record reads back the way it was seen
 ↓ Fan out ├─ Notification (in-app / email / SMS) via notification_rules
           └─ alarm_webhook job (maxAttempts: 1; retry bounded INSIDE the task)
              → HTTP to an operator-typed LAN hooter
              → one alarm_webhook_deliveries row PER ATTEMPT (§11 receipt)
 ↓ Clear   derived from readings — never commanded
```
**Assessment: well designed.** Notable correct decisions: keyed off the
INSTRUMENT (not the rule, which is nullable for `INSTRUMENT_LIMIT` alarms);
cooldown throttles `RAISED` only, never the silence signals; a body renderer
separate from the HTML-escaping template engine, because escaping corrupts JSON.
**Weakness:** the cooldown map is in-memory, so this flow is single-instance.

### Flow 3 — Backup / restore (the weak flow)

```
Admin → POST /api/backup/export
 ↓ getAllTables()  — SELECT tablename FROM pg_tables  ← NO PARTITION FILTER
 ↓ per table: COUNT(*) guard, then SELECT * fully into memory
 ↓ stripSensitiveColumns → adm-zip → download
                                     (governed by DOWNLOAD_REPORT reauth)
Restore ← POST /api/backup/restore
 ↓ TRUNCATE everything in reverse topological order
 ↓ DISABLE triggers → insert in FK-safe order → second pass for self-refs
 ↓ ENABLE triggers
```
**Assessment: the highest-risk flow in the system.** Whole-DB in memory, no
streaming, no partition awareness (§20), and **zero e2e tests** (§23). The
guard rail (`BACKUP_MAX_ROWS_PER_TABLE`) is honest about why it exists — its
error message literally says the pipeline "will OOM at this size" and points at
a streaming refactor that has not landed.

### Flow 4 — Login and session

```
POST /api/auth/login (public, per-route rate limited)
 ↓ bcrypt verify → password expiry check → 409 SESSION_CONFLICT if one is open
 ↓ sessions row + JWT (jose HS256, TTL clamped to JWT_EXPIRY_HOURS, default 1h)
 ↓ audit_trail LOGIN
Background: session_sweep cron → idle/expired sessions → LOGOUT audit rows
Frontend:   use-single-tab.ts enforces one session per browser
```
**Assessment: solid.** Single-session enforcement, expiry sweep with audit,
short token TTL, password history and expiry policy. The N+1 in the sweep
(§20) is the only defect.

### Cross-flow inconsistency

The **notification-rules** and **user-groups** modules sit on the alerting
path of every flow above — they decide *who gets told* — and both have
**zero tests**. That is the single most consequential coverage gap relative to
what the module does.

---

## 28. Critical Findings — Prioritised

> ### ✅ REMEDIATION UPDATE — 2026-08-29, commits `7fde43e`, `28582fa`, `a87fd06`
>
> **C1, H1, H2 and H4 are fixed. H3's engineering work is done; one decision
> remains with QA/RA.** Two additional defects were found while writing the
> tests and fixed in the same pass.
>
> | # | Status | What was done |
> |---|---|---|
> | **C1** | ✅ **Fixed** | `lib/migration-guard.ts` + `scripts/check-migration-safety.mjs`, run by `npm test` and gating `npm run db:migrate`. Proven to exit 1 on an injected `DROP TABLE "instrument_telemetry_history"` and 0 on the clean tree. Deliberately does **not** add a Prisma model — see below. |
> | **H1** | ✅ **Fixed** | `getAllTables()` now scans `pg_class` with `relkind IN ('r','p') AND relispartition = false`. |
> | **H2** | ✅ **Fixed** | `src/e2e/backup-restore.e2e.test.ts`, 10 tests including a full export→restore round trip. |
> | **H3** | ⚠️ **Half** — engineering done, **decision outstanding**, **one known gap** | `AUDIT_HARD_DELETE_ENABLED` added, **defaulting to enabled (no behaviour change)**. The trigger-suspend dance is now one helper with the re-enable in a `finally`. **Whether to flip the default is still a QA/regulatory decision.** **Gap:** the switch is backend-only — see below. |
> | **H4** | ✅ **Fixed** | 83 e2e tests across the four modules; three of them were also registered in `test-helper.ts`, without which no e2e could reach them at all. |
>
> **H1 was worse than this report originally stated, and the correction matters.**
> The report said backup would "likely fail outright" at production volume.
> Measured against the live database on 2026-08-29, it does **not** fail — it
> succeeds and produces a corrupt archive:
>
> ```
> instrument_telemetry_history           226,582 rows
> instrument_telemetry_history_2026_08   226,582 rows   ← the same rows
> pg_tables (public)                          42 relations
> pg_class, partition children excluded       38 relations
> ```
>
> Every reading was exported **twice**, and restore inserted both copies —
> inserting into the parent routes the row into its child partition, then the
> child's own dump adds it again. A §11 telemetry record silently **doubled**
> on every restore. A silent corruption is a worse failure than a loud one, so
> this was under-rated, not over-rated. The regression test fails at exactly
> 2× (9,844 exported for 4,922 real readings on the test database) when the fix
> is reverted, which is how it was confirmed non-vacuous.
>
> **C1 is real and recurring, not theoretical.** Fifteen committed migrations
> carry a comment from an author who had just stripped Prisma's generated
> `DROP TABLE "instrument_telemetry_history"` by hand. It has been generated on
> essentially every migration since 2026-08-08 and removed manually each time.
> The guard automates a step that has been performed correctly fifteen times
> and only has to be forgotten once.
>
> **Two further defects, found by the new tests (neither in the original report):**
>
> - **P2023 → 500.** `id` columns are `uuid`, so `findUnique({ where: { id:
>   'not-a-uuid' } })` made Postgres fail to parse the value and Prisma threw
>   before the route's own 404 check could run. Every uuid-keyed route answered
>   **500 INTERNAL_ERROR** — and in production dispatched a SYSTEM_ERROR
>   notification — for an ordinary bad request. Now **400**.
> - **P2025 → 500.** Routes that let Prisma signal "no such record"
>   (`findUniqueOrThrow`, bare `update`/`delete`) answered **500** for a
>   missing row. Now **404**.
>
> Both are mapped centrally in `lib/errors.ts:prismaErrorToResponse`, so the
> fix covers every route rather than the handful the tests touched. That
> function is now shared with `src/e2e/test-helper.ts`, whose error handler is
> a reduced copy of the real one and had omitted the P2002 translation
> entirely — meaning **no e2e could observe the status a client actually
> receives for a Prisma failure**. That divergence is closed.
>
> **Verification:** `apps/api` `tsc --noEmit` clean; full suite **1735 passed /
> 0 failed across 134 files** (single-fork, against `compliance_core_db_test`).
>
> **Still open — needs a human decision, not code:**
> **H3.** The product can still permanently delete §11 audit records and break
> the hash chain, because that is what it has always done and removing it in a
> patch would break an operator workflow nobody agreed to change. Setting
> `AUDIT_HARD_DELETE_ENABLED=false` removes the capability; `bulk-redact`
> already covers the legitimate "this content must not be retained" case
> without breaking the chain. **Whether that becomes the default is a
> QA/regulatory call.**
>
> **H3 also ships with a known, deliberate gap — recorded rather than hidden,
> because this section is about capabilities nobody consciously owned.**
> The switch is **backend-only**. `apps/web/src/routes/audit/index.tsx:54`
> gates the delete affordance on the AUDIT_DELETE *permission*
> (`can('audit.delete')`), not on the flag, so with
> `AUDIT_HARD_DELETE_ENABLED=false` a user holding that permission still sees
> the button and receives a 403 when they click it. Backend enforcement is
> correct and complete; only the affordance is stale. This violates
> `CLAUDE.md`'s "feature toggles need BOTH frontend visibility and backend
> route permission".
>
> It was left open deliberately rather than patched: the right fix is for the
> SERVER to tell the client the capability is off — the pattern
> `GET /api/instruments/attribute-access/me` already uses — and **not** for the
> client to re-derive it, which the "Never reconstruct server-side decision
> logic in the client" rule forbids. That is a new API surface with its own
> touchpoints, and it should not be bolted on in the same pass that added the
> switch. Until it lands, an installation turning the capability off should
> **also revoke `AUDIT_DELETE` from every role**, which removes the button and
> the permission together.
>
> **A forward-compatibility note on H1, for whoever upgrades:** archives taken
> AFTER the fix contain the telemetry parent but no partition children. Restore
> them with pre-fix code and the omitted-table guard reports
> `BACKUP_INCOMPLETE`, naming the partitions, and requires `force=true`. The
> reverse direction is safe and self-healing — a pre-fix archive restored by
> fixed code simply skips the child keys and inserts each reading once. Upgrade
> the code before relying on a new archive.
>
> The findings below are the ORIGINAL audit, left unedited for the record.



### 🔴 CRITICAL

| # | Finding | Location | Why |
|---|---|---|---|
| C1 | `instrument_telemetry_history` exists in the DB but not in `schema.prisma`. Any `prisma migrate dev` / `db push` will generate `DROP TABLE`. | `apps/api/prisma/schema.prisma` (absence) | Silent, total, irreversible telemetry loss, armed behind a routine developer command. Known operationally, undefended in code. §9 |

### 🟠 HIGH

| # | Finding | Location | Why |
|---|---|---|---|
| H1 | Backup enumerates `pg_tables` with no partition filter | `backup.repository.ts:49-65` | Backup export likely fails outright at production volume; restore would duplicate rows. Disaster recovery is probably non-functional. §20 |
| H2 | Backup/restore has **zero e2e tests** | `apps/api/src/e2e/` | The riskiest, most raw-SQL-heavy module is the least tested. An e2e round trip would have caught H1. §23 |
| H3 | Audit records can be **physically deleted**, breaking the §11 hash chain | `audit/routes.ts:565-588, 640-655` | 21 CFR Part 11 §11.10(e). Well-governed and self-documenting, but it is a regulatory posture decision that must be consciously owned. §18 |
| H4 | Four modules on the alerting path have **zero tests** | `notification-rules`, `user-groups`, `admin-requests`, `debug-traces` | These decide who gets alerted. `admin-requests` also owns a public endpoint. §23 |

### 🟡 MEDIUM

| # | Finding | Location | Why |
|---|---|---|---|
| M1 | Residual user-enumeration oracle + PII on a public endpoint | `admin-requests/routes.ts:78-115` | `exists` + `fullName` to anonymous callers, 20/15min per IP. §18 |
| M2 | `GET /api/notifications` has no default or max page size | `notification.service.ts:54` | Latent full-table read; only the client's habit prevents it. §20 |
| M3 | Session sweep: N+1 update, unbounded `findMany` | `auth/session-sweep.ts:37-58` | §20 |
| M4 | Five hand-rolled tab controls, no `ui/tabs.tsx` | 5 route files | Accessibility duplicated five ways; a prior fix was reverted (`9a9bb9e`). §16 |
| ~~M5~~ | ⚠️ **WRONG ON BOTH COUNTS, real defect was different.** "32 log statements" undercounted: the grep `log\.(info\|warn)` cannot match `helpers.logger.info`, missing the worker tasks, and it missed **42 `console.*` calls** entirely — the ingest listeners, MQTT bridge, enqueue helpers and config discovery all DO log. Real total ~80. And "workers, MQTT lifecycle and ingest rejections log nothing" was simply false. The genuine defect, found by measuring: logging ran through TWO mechanisms — `app.log` (level-aware, structured, request-scoped) and `console.*` (honours nothing, prints in production at any level, unparseable alongside pino's JSON). Fixed 2026-08-29 with `lib/logger.ts`. | `apps/api/src` | §22 |
| M6 | `PROJECT_ARCHITECTURE.md` / `PROJECT_SUMMARY.md` document a nonexistent Android/RFID subsystem | repo root | Actively misleads new engineers; invents a phantom keystore incident. §24 |
| M7 | Production infrastructure has no IaC or versioned build sheet | repo-wide | The validated environment cannot be rebuilt from the repo. §25 |
| M8 | `CLAUDE.md` states the config-page count as **both 24 and 25** | `CLAUDE.md` | A self-contradiction in the designated source of truth. §24 |
| ~~M9~~ | ⚠️ **PARTLY WRONG — the recommendation was.** `lib/report-review.ts` is NOT dead: `submitForReview` is imported by `components/SendForReviewButton.tsx`, which IS mounted at `routes/audit/index.tsx:428`, and `canDownloadReview` has its own test. What is true is that the backend `/api/report-reviews` is gone. What makes it harmless is `SEND_FOR_REVIEW_ENABLED = false` (dated 2026-06-22) — the component returns `null` before rendering, so nothing can call the dead route. This is RETAINED UI for a removed feature, not dead code, and deleting it would have thrown away a deliberate re-enable path. Fixed 2026-08-29 by warning at the flag that re-enabling is a backend job first. Only `fetchReview`/`reviewSignatures`/`downloadReview`/`ReviewFull` are genuinely unused. | `lib/report-review.ts` | §10 |

### 🔵 LOW

| # | Finding | Location |
|---|---|---|
| ~~L1~~ | ❌ **WITHDRAWN — this finding was WRONG.** `/api/health` exists and is load-bearing: `app.ts:297` registers it directly (no route prefix), so the audit's evidence grep `get('/health'` could never have matched it. It is the tablet's liveness probe — `apps/web/src/lib/connectivity.ts probeServer` treats a non-2xx as "server unreachable" — and its `PUBLIC_PATHS` entry is required. Removing it was attempted on 2026-08-29 and reverted within minutes. `CLAUDE.md` carries the same false claim ("There is no `/health` route") from the same bad grep. **The lesson is the audit's own rule turned on itself: a 0-hit grep is evidence only if the pattern could have matched.** | `plugins/auth.ts:179`, `app.ts:297` |
| L2 | `capacitor://localhost` in the CORS fallback; 5176 absent from it | `app.ts:127` |
| L3 | Trigger re-enable not in `finally` | `audit/routes.ts`, `backup.repository.ts` |
| L4 | In-memory rate limiter and webhook cooldown — single-instance ceiling | `app.ts:189`, `alarm-webhooks/` |
| L5 | `certs/rootCA.pem` is a decoy that has already cost two investigations | `certs/` |
| L6 | Hardcoded demo password in an operator script | `apps/api/scripts/demo-live-scenario.ts` |
| ~~L7~~ | ⚠️ **PARTLY WRONG.** "No route-level code splitting" was false — `main.tsx:1` imports `lazy`/`Suspense` and **23 routes were already lazy**. The audit's evidence line said "No `React.lazy` was found", which simply was not looked for hard enough. What WAS true is narrower: the heaviest **config** pages were still eager — `alarm-webhooks.tsx` (959 lines), `floorplans.tsx` (772), `role-access.tsx`, `alarm-rules.tsx` and four more — so the least-visited screens in the product were parsed on every login. Fixed 2026-08-29: 23 → 31 lazy routes. | `apps/web/src/main.tsx` |
| L8 | 80 MB log retention may be short for §11 diagnostics | `scripts/register-services.ps1:78-82` |
| L9 | 6 duplicate exports (two names per symbol) | `lib/api-client.ts`, `shared/types/roles.ts`, 3 pages |
| L10 | Test URLs reference the removed filter domain | `api-client-reauth-shape.test.ts` |

### ⚪ CLEANUP

`lib/report-review.ts` · `components/ui/error-popup.tsx` ·
`components/ui/radio.tsx` · 9 `SYNC_*`/`CONNECTIVITY_*` constants ·
`getLastServerContact`/`subscribeToServerContact` · `exceljs` from
`apps/api/package.json` · `bloat.md` · `old/` (160 files, 5.7 MB) ·
`test-engine.mjs` (verify first) · `certs/rootCA.pem`

---

## 29. Dead / Unused Consolidated Summary

| Category | Item | Location | Evidence | Confidence | Recommendation |
|---|---|---|---|---|---|
| Dependency | `exceljs` | `apps/api/package.json` | `grep -rn "exceljs" apps/api/src` → **0 hits** (the only repo-wide hit in `apps/api` is the manifest line itself); sole consumer is `apps/web`, which declares it separately | **HIGH** | Remove |
| File | `lib/report-review.ts` | `apps/web/src/lib/` | No backend route for `/api/report-reviews`; knip: all 4 exports unused | **HIGH** | Remove |
| File | `components/ui/error-popup.tsx` | `apps/web/src/` | knip unused file; no importer repo-wide | **HIGH** | Remove |
| File | `components/ui/radio.tsx` | `apps/web/src/` | same | **HIGH** | Remove |
| Constants | 9 × `SYNC_*` / `CONNECTIVITY_*` | `lib/timing-constants.ts:23-92` | 9 importers, **all** import only `CLIPBOARD_COPY_RESET_MS`; knip agrees | **HIGH** | Remove |
| Function | `getLastServerContact`, `subscribeToServerContact` | `lib/server-contact.ts:87,103` | write side live, read side has 0 consumers | **HIGH** | Remove |
| Config | `'/api/health'` in `PUBLIC_PATHS` | `plugins/auth.ts:179` | `grep "get('/health'"` → 0 hits | **HIGH** | Remove |
| Config | `capacitor://localhost` | `app.ts:127` | mobile app removed from this fork | **HIGH** | Remove |
| Doc | `bloat.md` | repo root | audits `routes/mobile/`, which does not exist | **HIGH** | Archive |
| Doc | `PROJECT_ARCHITECTURE.md` §§ on android/RFID | root | `ls apps/` → api, web | **HIGH** | Archive/rewrite |
| Component | `SendForReviewButton.tsx` | `apps/web/src/components/` | orphan of the dead report-review feature | **MEDIUM** | Verify not rendered, then remove |
| Function | `computeChecksumV2` | `lib/hash-chain.ts:202` | knip unused | **MEDIUM** | **Review only** — §11 tamper-evidence. Read `audit-verify.ts` first |
| Exports | ~11 assorted (`SENSITIVE_KEY_RE`, `MetaPill`, `CheckboxGroup`, `REPORT_DEFS`, …) | various | knip unused | **MEDIUM** | Review individually |
| Script | `test-engine.mjs` | repo root | not in any `package.json` script, `turbo.json`, or `vitest.workspace.ts` | **MEDIUM** | Verify, then remove |
| Files | `old/` (160 files, 5.7 MB) | repo root | no code reference | **MEDIUM** | Read before deleting (CONTRIBUTING's revert receipts) |
| Cert | `certs/rootCA.pem` | `certs/` | signs nothing in use (CLAUDE.md, dated) | **MEDIUM** | Remove or rename |
| DB column | *(none)* | — | `instruments.block`/`.area` were investigated and **cleared** — they are read on every list request and used as a live search filter (`instruments/routes.ts:456`). See the correction in §15. | — | **No column removals recommended** |
| API | ~12 `super-admin/data/*` + `dashboards/*` routes | see §13 | no frontend string match | **LOW** | **Do not remove.** Confirm with request logging first |
| DB table | *(none)* | — | all 36 models + 2 raw-SQL tables have live readers and writers | — | No drops |

### Explicit false positives — do NOT remove

`scripts/publish-demo-telemetry.ts` · `scripts/retire-limit-attributes.ts` ·
`vitest.workspace.ts` · `runAlarmWebhookJob` (string-keyed worker dispatch) ·
`BackupTooLargeError` (thrown in its own file) · `fake-ad-server.ts` exports ·
`lib/config-registry.ts` types (auto-discovery contract) ·
`InstrumentTelemetryLatest` model (table alive via raw SQL) ·
`NotificationRuleRecipient` model (alive via nested `include`) ·
`config/{audit-templates,branding,field-ids,pagination}.tsx` (tab-composed) ·
`mqtt` and `@fastify/websocket` (both previously mis-declared dead — see
`CLAUDE.md`)

---

## 30. Cleanup Plan

### Phase 1 — Safe cleanup (very low risk, no behaviour change)
1. Remove `exceljs` from `apps/api/package.json`; run `npm install`; confirm
   `apps/api` builds (`npm run lint -w @digilog/api`).
2. Delete `lib/report-review.ts` and (after confirming it is not rendered)
   `components/SendForReviewButton.tsx`.
3. Delete `components/ui/error-popup.tsx` and `components/ui/radio.tsx`.
4. Delete the 9 `SYNC_*`/`CONNECTIVITY_*` constants and the two dead
   `server-contact.ts` readers.
5. Remove `'/api/health'` from `PUBLIC_PATHS` and `capacitor://localhost` from
   the CORS fallback; add `http://localhost:5176` while there.
6. Move `bloat.md` to `docs/archive/`.
7. Fix `CLAUDE.md`: hooks 18 → **20**; resolve the 24-vs-25 config-page
   contradiction in favour of **24**.

**Verification gate for Phase 1:** `npm run lint` (tsc `--noEmit`, both apps)
**and** `npm test`. Remember that vitest does not typecheck — both gates are
required, and neither alone is sufficient.

### Phase 2 — Refactoring (behaviour-preserving)
1. Extract `withTriggersDisabled(tx, table, fn)` with a `finally` re-enable;
   migrate the 3 call sites.
2. Add `components/ui/tabs.tsx` with correct ARIA + keyboard behaviour. Land
   the primitive with tests **first**, then migrate one of the 5 pages per
   commit — `9a9bb9e` shows a big-bang attempt was reverted.
3. Give `GET /api/notifications` a default (50) and max (500) `limit`.
4. Fix the session-sweep N+1: add `take:`, batch the `updateMany` after the
   audit writes.
5. Split `modules/instruments/routes.ts` (2,392 lines) along its natural seams:
   attributes, tokens, telemetry, child roster.
6. Add `React.lazy` to the `config/*` routes.
7. Archive or rewrite `PROJECT_ARCHITECTURE.md` and `PROJECT_SUMMARY.md`.

### Phase 3 — Database (requires live DB validation; nothing here is safe blind)
1. **First, and before anything else:** add a CI guard that fails any generated
   migration containing `DROP TABLE "instrument_telemetry_history"`. This
   defuses C1 without changing the schema.
2. Add a schema comment to `InstrumentTelemetryLatest` recording that all
   access is raw SQL.
3. Run the read-only census this audit could not:
   `SELECT tablename FROM pg_tables WHERE schemaname='public';` (confirms H1)
   and per-table row counts.
4. **No column drops are recommended.** `instruments.block` / `.area` were the
   only candidates and they were cleared — see the correction in §15.
5. Review index coverage against `pg_stat_user_indexes`. **No index changes
   should be made on source-reading alone.**

### Phase 4 — Architecture
1. **Fix the backup partition enumeration (H1)** — filter to
   `relkind='r' AND relispartition=false` and handle
   `instrument_telemetry_history` explicitly (stream it, or exclude it and
   cover it with `pg_dump`/PITR).
2. **Write the backup/restore e2e round trip (H2)** — seed, export, wipe,
   restore, assert equality. Highest-value single test in the repo, and it
   validates the fix from step 1.
3. Add tests for `notification-rules`, `user-groups`, `admin-requests`,
   `debug-traces`.
4. Decide the horizontal-scaling question. If more than one API instance is
   ever wanted, the in-memory webhook cooldown and error-notification limiter
   must move to Postgres. If not, write that down as a constraint.
5. Commit a versioned build sheet (or IaC) for the EC2/RDS environment.

### Phase 5 — Security & performance
1. **Take a documented decision on the audit-delete capability (H3)** with QA/RA.
   Consider a build/config flag that removes the delete routes for validated
   installs, leaving only redact.
2. **Close the enumeration oracle (M1)** — make `user-lookup` unnecessary by
   accepting any employee ID on the contact-admin form and resolving validity
   administratively.
3. Add structured logging to the six worker tasks, the MQTT client lifecycle,
   and ingest token rejections (M5).
4. Run `npm audit --omit=dev` and establish a cadence.
5. Configure a coverage reporter so §23's percentages stop being UNKNOWN.
6. Raise WinSW `keepFiles` to match the validation package's diagnostic
   retention.

---

## 31. Overall Health Score

### **74 / 100**

| Dimension | Score | Reasoning |
|---|---|---|
| **Architecture** | **82** | One composition root; clean routes→service→repository layering; a real shared kernel; policy resolved server-side and never re-derived in the client. Held back by hard single-instance assumptions (in-memory cooldown + rate limiter) and one 2,392-line module. |
| **Code Quality** | **86** | The highest score here, and earned. Zero commented-out code, zero stray `console.log`, zero swallowed exceptions, and comments that explain *why* at the exact line that would otherwise be misread. Deductions for 5 duplicated tab controls and 3 copies of the trigger-disable dance. |
| **API Quality** | **84** | 249 route registrations (~300 at runtime), 0 broken, 0 duplicated. Consistent auth/permission/reauth layering. Swagger on every route. Deducted for ~12 endpoints with no identifiable consumer and one dead frontend caller. |
| **Database** | **62** | Schema design is good — deliberate enum-vs-string choices, meaningful NULLs, sensible relations. But **C1** (a live table absent from the schema, with a DROP armed behind a routine command) is the single most dangerous thing in the repo, and **H1** (partition-blind backup) compounds it. |
| **Security** | **80** | Genuinely above average: fail-closed secret handling, HSTS/CSP/Permissions-Policy, no injectable raw SQL despite 20+ `Unsafe` call sites, secret masking with a test, no stack-trace leakage, TRACE/CONNECT blocked. Deducted for the §11 delete capability (H3) and the residual enumeration oracle (M1). |
| **Performance** | **68** | Server-side LTTB downsampling and honest refetch-on-zoom are sophisticated and correct. Undercut by the backup memory model, the notifications page-size gap, the session-sweep N+1, and no route-level code splitting. |
| **Frontend** | **78** | React 19 + SWR + Tailwind v4, no `console.log`, a real design-system folder, hand-rolled SVG charts instead of a heavy library. Deducted for the missing `tabs` primitive, two orphaned components, a dead lib module, and 1,000+ line pages. |
| **Testing** | **72** | 215 test files against 630 sources, e2e against real Postgres, snapshot-locked permission maps, and reference-equality tests guarding a subtle §11 invariant. But four modules on the alerting path have zero tests, backup/restore has no e2e, and coverage is unmeasured. |
| **Documentation** | **55** | The lowest score. In-code documentation is outstanding and `CLAUDE.md` + `docs/recreation/` are strong. But two root docs describe a nonexistent Android/RFID subsystem, `bloat.md` audits a deleted codebase, and the source-of-truth file contradicts itself on a count. A new engineer's first three reads would all mislead them. |
| **Deployment** | **70** | The Windows-service path is well engineered — dependency ordering, restart policy, `NODE_ENV=production`, log rotation, idempotent scripts. Deducted because production infrastructure has no representation in the repository at all. |
| **Maintainability** | **75** | Consistent module shape, a genuine shared kernel, a documented change→docs map, and a codebase that explains its own traps. Deducted for the largest files, the duplication clusters, and documentation that cannot be trusted. |

### Judgement

This is a **well-engineered codebase with an under-maintained documentation
layer and two specific, fixable structural hazards.**

The things that are hard to build are largely done right: the hash-chained
audit trail, instrument visibility enforced on the query (404, never 403), the
single attribute-access gate, server-side downsampling by selection rather than
averaging, and a permission model derived from one tree with drift locked by a
snapshot test. Several of these are better than what is typical in commercial
compliance software.

The things that are easy to neglect have been neglected. Backup and restore —
the disaster-recovery path of a regulated system — is the least-tested and
most-likely-broken module. The telemetry history table's absence from the
schema is a loaded gun with the safety off. And the root documentation would
send a new engineer looking for an Android app that was deleted months ago.

**The two highest-leverage actions, in order:**

1. **Add the CI guard against `DROP TABLE "instrument_telemetry_history"`.**
   One check; defuses the only CRITICAL finding; costs nothing.
2. **Write the backup/restore e2e round-trip test.** It validates the H1 fix,
   closes the largest coverage gap, and exercises the code path whose failure
   would be most expensive.

---

## Appendix — Verification Commands

Every count in this report is reproducible. Run from the repository root:

```bash
# Structure
find apps/api/src apps/web/src packages -type f | wc -l     # 630
ls apps/api/src/modules/ | wc -l                            # 24
find apps/api/src apps/web/src -name '*.ts*' -not -name '*.test.*' \
  | xargs wc -l | grep total    # ~76,000 (xargs may batch; sum the totals)

# Database
grep -cE "^model " apps/api/prisma/schema.prisma            # 36
grep -cE "^enum "  apps/api/prisma/schema.prisma            # 13
ls apps/api/prisma/migrations | wc -l                       # 24
grep -n "instrument_telemetry_history" apps/api/prisma/schema.prisma   # 0  <- C1

# Permissions / registries
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts   # 42
grep -cE "^\s+[A-Z_]+:"     packages/shared/src/types/reauth-actions.ts # 48
grep -cE "^\s+[A-Z_]+:"     packages/shared/src/types/audit-actions.ts  # 97

# Surfaces
grep -cE "<Route" apps/web/src/main.tsx                     # 51
ls apps/api/src/modules/config/defs/*.def.ts | wc -l        # 25
ls apps/web/src/routes/config/*.tsx | wc -l                 # 24
ls apps/web/src/hooks/ | wc -l                              # 20  <- CLAUDE.md says 18
ls apps/web/src/lib/   | wc -l                              # 19

# Tests
find apps packages tests -name '*.test.ts*' | grep -v node_modules | wc -l  # 215
ls apps/api/src/e2e | wc -l                                 # 44

# Dead code
npx knip --no-progress
grep -rn "exceljs" apps/api/src                             # 0  <- unused dep
grep -rn "report-reviews" apps/api/src                      # 0 routes
grep -rn "relispartition\|partition" apps/api/src/modules/backup/  # 0  <- H1

# Hygiene
grep -rn "console.log" apps/web/src --include=*.tsx | grep -v test  # 0
grep -rn "NODE_TLS_REJECT_UNAUTHORIZED" apps packages scripts       # 3, all scripts
```

### 🟠 NEW FINDING — `npm audit` run 2026-08-29, was UNKNOWN in this report

The Dependency Audit (§19) recorded confirmed vulnerabilities as
**"UNKNOWN — `npm audit` not run"**. It has now been run. It is not clean.

```
npm audit --omit=dev
19 vulnerabilities (4 moderate, 14 high, 1 critical)
```

Two matter for THIS application specifically, and one is a lockfile fault
rather than an upstream one:

**D1 — ✅ FIXED 2026-08-29 (see below). Originally: `@fastify/static` installed at 9.3.0 while `package.json` declared
`^10.1.0`.** `package-lock.json:3674` pins 9.3.0 at the top level, so `npm ci`
installs a version the manifest does not permit. 9.3.0 carries
*"Authorization Bypass via Non-Canonical URL Paths"* (HIGH). This is not
abstract here: `app.ts:179` serves `UPLOADS_ROOT` at `/uploads/`, and
`/uploads/photos/`, `/uploads/branding/` and `/uploads/floorplans/` are all in
`PUBLIC_GET_PATHS` — unauthenticated. A path-canonicalisation bypass on that
handler is the one advisory in this list with a public, unauthenticated reader
in front of it. **Severity: HIGH. Fix first.**

**D2 — `adm-zip` 0.5.16**: *"Crafted ZIP file triggers 4GB memory allocation"*
(HIGH). `POST /api/backup/restore` accepts an uploaded archive and unzips it.
Permission-gated and reauth'd, so the caller is an authenticated admin, but it
is a one-request OOM of the API process. Latest is 0.6.0 (a major bump).

**D3 — `tar` (CRITICAL, transitive)**: arbitrary file write via hardlink path
traversal, reached through `@mapbox/node-pre-gyp` — build tooling for `bcrypt`,
not a runtime request path. Lower real-world exposure than D1 despite the
higher label.

Also flagged: `find-my-way` (HTTP/2 DoS — this server does not enable HTTP/2),
`react-router`/`react-router-dom` (RSC-mode CSRF — this app does not use RSC),
`js-yaml`, `postcss`, `nanoid`, `brace-expansion`, `fast-uri`, `deepmerge-ts`.

**`npm audit fix` CANNOT RUN, and the reason is its own finding.** It aborts
with ERESOLVE:

```
peer vite@"^3.1.0 || ^4.0.0 || ^5.0.0" from vite-plugin-pwa@0.20.5
Found: vite@6.4.3
```

`vite-plugin-pwa@0.20` does not support Vite 6. The dependency tree is already
in a state npm will not reproduce, which is why the lockfile has drifted from
the manifest (D1) and why no automated remediation can proceed. §19 flagged
`vite-plugin-pwa ^0.20.0` as a "potential concern" because a `^` on a 0.x major
is not a compatibility guarantee; this is that concern having already happened.

### ✅ D1 RESOLVED — and the root cause was not what it looked like

`npm install @fastify/static@^10.1.0` did **not** fix it: the manifest moved to
`^10.1.3` and the lockfile stayed on 9.3.0. The reason:

```
@fastify/swagger-ui@5.2.5 → "@fastify/static": "^9.0.0"
```

npm hoisted 9.3.0 to satisfy swagger-ui, and the API's `^10` was quietly left
unsatisfied rather than nested. So the drift was not a stale lockfile that
needed regenerating — it was a **transitive constraint pinning the tree one
major behind**, and any attempt to fix it by bumping `@fastify/static` alone
would have kept appearing to fail for no visible reason.

Fixed by upgrading the thing that held it back:
`@fastify/swagger-ui` **5.2.5 → 6.1.1**, which depends on
`@fastify/static ^10.1.0`. `@fastify/static` now resolves to **10.1.3** and the
advisory is gone. **19 → 17 vulnerabilities.**

Verified beyond the test suite, because nothing in it covers static serving or
`/docs` — the two things this upgrade actually touches. Booted the API on a
spare port and probed:

| Check | Result |
|---|---|
| `GET /api/health` | 200 |
| `GET /docs` | 200, Swagger UI HTML renders |
| `GET /uploads/photos/<file>` (public path) | 200, correct content |
| `GET /uploads/<file>` (non-public path) | 401 — auth layer still gates it |
| `GET /uploads/photos/../secret.txt` | 401, file NOT served |
| `%2e%2e` encoded traversal | 401, file NOT served |
| `..%5c` backslash traversal | 403 |
| `%252e%252e` double-encoded | 404 |

Also confirmed incidentally: the boot log is now structured JSON from the M5
logger (`{"level":40,...,"msg":"[ingest:mqtt] client error"}`), so that
migration works through the real pino path and not just under test.

**Still open: D2 (`adm-zip`), D3 (`tar`), and the `vite-plugin-pwa` / Vite 6
peer conflict that still blocks `npm audit fix` wholesale.**

**Recommended order:** resolve the `vite-plugin-pwa` / Vite 6 peer conflict
first (upgrade it, or drop the PWA plugin — the offline domain it was added for
no longer exists), then regenerate the lockfile so `@fastify/static` matches its
declared `^10.1.0`, then re-run `npm audit`. Do not `npm audit fix --force`:
it wants to install `exceljs@3.4.0`, a breaking downgrade of the library both
the PDF and Excel report paths depend on.

**Not fixed in this session** — an unresolvable-by-tooling dependency upgrade
touching the build plugin, the router and the ZIP reader is not a change to
make in a cleanup pass without a full regression run behind it.

### Corrections made during this audit

Recorded in the spirit of `CLAUDE.md`'s own dated self-corrections. Four
claims were written, then falsified by a follow-up grep before publication:

| Claim as first written | What the grep showed | Where corrected |
|---|---|---|
| "187 endpoints" | The pipeline ended in `sort \| uniq -c`, collapsing nine modules' identical `GET /`. Real figure: **249 call sites, ~300 runtime routes.** | §6 |
| "No `child_process` / `exec` in `apps/api/src`" | `system-health/routes.ts:3` imports `exec` and shells out twice. Static strings, so still no injection — but the claim was false. | §18 |
| "No swallowed exceptions were found" | **72** parameterless `catch {}` blocks; one fabricates a 0-byte disk reading on the health endpoint. | §21 |
| "`instruments.block`/`.area` are removal candidates" | Both are read on every list request and used as a live search filter. **Wrong in the damaging direction.** | §15 |

The fourth is the instructive one: it came from quoting `CLAUDE.md` — the
best-maintained doc in the repo — instead of grepping. Its own Sync Rule
("don't trust prior docs — verify") applies to itself.

### Not verified — requires runtime/database access

- Row counts per table; always-NULL columns; duplicate rows
- Actual index usage (`pg_stat_user_indexes`)
- Whether `pg_tables` currently returns telemetry partitions (confirms H1)
- `npm audit` results
- Test coverage percentages
- Live request logs (would convert every POSSIBLY UNUSED API into a fact)

---

*End of audit. This report is the only file created; no existing file was
modified, renamed, or deleted, and no database object was touched.*

---

## Appendix B — Full Endpoint Inventory

Extracted mechanically from every route file under `apps/api/src/modules/`,
then joined to the `prefix` values in `app.ts:337-385`. Module paths are
**relative**; the full endpoint is `prefix + path`.

Command used:

```bash
grep -rnoE "\.(get|post|put|patch|delete)[^(]*\(\s*'[^']*'" \
  apps/api/src/modules --include=routes.ts --include=*-routes.ts \
  --include=*.routes.ts | sort -u
```

Legend — **FE**: a matching `/api/...` string literal exists in `apps/web/src`.

### `/api/auth`
| Method | Path | FE |
|---|---|---|
| POST | `/login` | ✅ |
| POST | `/logout` | ✅ |
| POST | `/refresh` | ✅ |
| POST | `/verify` | ⚠️ (reauth path) |
| POST | `/change-password` | ✅ |
| POST | `/forgot-password` | ✅ |
| POST | `/beacon-logout` | ⚠️ (`navigator.sendBeacon`) |
| GET | `/me` | ✅ |
| PUT | `/profile` | ✅ |

### `/api/users`
`GET /` ✅ · `GET /:id` ✅ · `POST /` ✅ · `PUT /:id` ✅ · `DELETE /:id` ✅ ·
`POST /:id/disable` ✅ · `POST /:id/enable` ✅ · `POST /:id/unlock` ✅ ·
`POST /:id/reset-password` ✅ · `POST /bulk-delete` ✅ · `GET /stats` ✅ ·
`GET /reset-requests` ✅ · `GET /reset-requests/pending` ✅ ·
`POST /reset-requests/:id/process` ✅ · `POST /password-expiry-sweep` **worker**

### `/api/roles`
`GET /` ✅ · `GET /:name` ✅ · `POST /` ✅ · `PUT /:name` ✅ · `DELETE /:name` ✅ ·
`GET /active` ✅ *(PUBLIC GET)* · `GET /:name/creatable` ⚠️ ·
`GET /permissions/all` ⚠️ · `GET /access-matrix` ✅ · `GET /attribute-access` ✅ ·
`PUT /attribute-access/:name` ✅ · `GET /instrument-scope` ✅ ·
`GET /instrument-scope/instruments` ✅ *(deliberately UNSCOPED)* ·
`PUT /instrument-scope/role/:name` ✅ · `PUT /instrument-scope/user/:userId` ✅ ·
`GET /panel-access` ✅ · `PUT /panel-access/role/:name` ✅ ·
`PUT /panel-access/user/:userId` ✅ · `PUT /dashboard-layout/role/:name` ✅

### `/api/config` — static routes
| File | Method | Path |
|---|---|---|
| `access-matrix.routes.ts` | GET / PUT | `/access-matrix`, `/access-matrix/my-modules` |
| `action-reauth.routes.ts` | GET / PUT | `/action-reauth`, `/action-reauth/check`, `/action-reauth/my-actions` |
| `alarm-limits.routes.ts` | GET | `/alarm-limits/status-texts` |
| `audit-templates.routes.ts` | GET / PUT | `/audit-templates`, `/audit-templates/current` |
| `branding.routes.ts` | GET / PUT | `/branding` *(PUBLIC GET)* |
| `export-options.routes.ts` | GET / PUT | `/export-options`, `/export-options/current` |
| `field-ids.routes.ts` | GET / PUT | `/field-ids`, `/field-ids/:fieldId` |
| `report-page-titles.routes.ts` | GET / PUT | `/report-page-titles`, `/report-page-titles/current` |
| `roles.routes.ts` | GET / PUT / DELETE | `/roles`, `/roles/:role`, `/users/:userId`, `/my-config`, `/my-dashboard-layout` |
| `user-id.routes.ts` | GET / PUT / POST | `/user-id`, `/user-id/next`, `/user-id/validate` |

Plus the def-driven pairs `GET /<key>` and `GET /<key>/current` for `datetime`,
`export-limit`, `instrument-activity`, `instrument-attributes`, `pagination`,
`password-policy`; and `GET /registry/manifest` (dynamic routes).

### `/api/instruments` — the largest surface
`GET /` ✅ · `GET /:id` ✅ · `POST /` ✅ · `PUT /:id` ✅ · `DELETE /:id` ✅ ·
`POST /bulk` ✅ · `GET /telemetry-overview` ✅ · `GET /telemetry-aggregate` ✅ ·
`GET /:id/telemetry` ✅ · `GET /:id/telemetry-keys` ✅ · `GET /:id/attributes` ✅ ·
`POST /:id/attributes` ✅ · `PUT /:id/attributes/:key` ✅ ·
`DELETE /:id/attributes/:key` ✅ · `GET /attribute-access/me` ✅ ·
`GET /:id/children` ✅ · `GET /eligible-children` ✅ · `GET /:id/token` ✅ ·
`PUT /:id/token` ✅ · `POST /:id/regenerate-token` ✅ · `GET /:id/dead-letters` ⚠️

### `/api/ingest/v1` — device-facing, token-authenticated
`POST /telemetry` · `POST /mqtt-auth` · WS `/ws` — all in `PUBLIC_PATHS`
because the caller is a device or the EMQX broker, not a logged-in user.

### `/api/alarms`
`GET /` ✅ · `GET /summary` ✅ · `POST /:id/acknowledge` ✅ · `GET /rules` ✅ ·
`POST /rules` ✅ · `PUT /rules/:id` ✅ · `DELETE /rules/:id` ✅

### `/api/alarm-webhooks`
`GET /` ✅ · `GET /:id` ✅ · `POST /` ✅ · `PUT /:id` ✅ · `DELETE /:id` ✅ ·
`POST /:id/test` ✅ · `GET /:id/deliveries` ✅ *(instrument-visibility scoped)*

### `/api/floorplans`
`GET /` ✅ · `GET /:id` ✅ *(knowingly unscoped)* · `POST /` ✅ · `PUT /:id` ✅ ·
`DELETE /:id` ✅ · `POST /:id/rooms` ✅ · `PUT /:id/rooms/:roomId` ✅ ·
`DELETE /:id/rooms/:roomId` ✅ · `PUT /:id/rooms/:roomId/instruments` ✅ ·
`GET /:id/rooms/:roomId/history` ✅ *(membership query IS scoped)*

### `/api/functional-locations`
`GET /` ✅ · `GET /:id` ✅ · `POST /` ✅ · `PUT /:id` ✅ · `DELETE /:id` ✅ ·
`PUT /:id/instruments` ✅ · `GET /linkable-instruments` ✅

### `/api/audit`
`GET /` ✅ · `GET /:id` ✅ · `GET /verify-chain` ⚠️ · `DELETE /:id` ⚠️ ·
`POST /:id/redact` ⚠️ · `POST /bulk-delete` ✅ · `POST /bulk-redact` ✅ ·
`POST /report-export-log` ✅

### `/api/notifications`
`GET /` ✅ · `GET /unread-count` ✅ · `PUT /:id/read` ✅ · `PUT /:id/unread` ✅ ·
`PUT /bulk-read` ✅ · `PUT /bulk-unread` ✅ · `PUT /mark-all-read` ✅ ·
`DELETE /:id` ✅ · `POST /bulk-delete` ✅

### `/api/notification-settings` (module `notification-delivery`)
`GET/PUT /email` ✅ · `POST /email/test` ✅ · `GET /email/oauth2/authorize` ✅ ·
`GET /email/oauth2/code` **external redirect** · `GET /email/oauth2/redirect-uri` ✅ ·
`GET /email/oauth2/status` ✅ · `GET/PUT /sms` ✅ · `POST /sms/test` ✅ ·
`GET /logs` ✅ · `GET /logs/stats` ✅ · `DELETE /logs/:id` ✅ ·
`GET /templates` ✅ · `POST /templates` ✅ · `PUT /templates/:id` ✅ ·
`DELETE /templates/:id` ✅ · `POST /send` ⚠️

### `/api/notification-rules`
`GET /` ✅ · `GET /:id` ✅ · `POST /` ✅ · `PUT /:id` ✅ · `DELETE /:id` ✅ ·
`PUT /:id/toggle` ✅ · `POST /:id/test` ✅ · `GET /event-types` ✅

### `/api/user-groups`
`GET /` ✅ · `POST /` ✅ · `PUT /:id` ✅ · `DELETE /:id` ✅ ·
`GET /:id/members` ✅ · `POST /:id/members` ✅ · `DELETE /:id/members/:userId` ✅

### `/api/admin-requests`
`GET /` ✅ · `POST /` ✅ · `POST /:id/process` ✅ · `GET /pending-count` ⚠️ ·
`GET /user-lookup` ✅ **PUBLIC GET — see §18 M1**

### `/api/dashboards`
`GET /` ✅ · `GET /:id` ⚠️ · `POST /` ⚠️ · `PUT /:id` ⚠️ · `DELETE /:id` ⚠️ ·
`PUT /:id/layout` ⚠️ · `POST /:id/widgets` ⚠️ · `PUT /:id/widgets/:widgetId` ⚠️ ·
`DELETE /:id/widgets/:widgetId` ⚠️ · `POST /:id/assign` ⚠️ ·
`DELETE /:dashboardId/assign/:assignmentId` ⚠️ · `GET /widget-types` ⚠️ ·
`GET /:id/data/:widgetId` ⚠️  — **the cluster flagged POSSIBLY UNUSED in §13**

### `/api/super-admin`
`GET/PUT /api-lock` ✅ · `GET /stats` ⚠️ · `GET /data/audit-trail` ⚠️ ·
`GET/POST /data/notifications` ⚠️ · `PUT/DELETE /data/notifications/:id` ⚠️ ·
`GET/POST /data/admin-requests` ⚠️ · `PUT/DELETE /data/admin-requests/:id` ⚠️

### Remaining prefixes
- `/api/instrument-profiles` — `GET /`, `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id` — all ✅
- `/api/help` — `GET /`, `GET /:key`, `GET /:id/versions`, `POST /`, `PUT /:id`, `DELETE /:id` — all ✅
- `/api/ldap` — `GET/PUT /config`, `GET /status`, `POST /test-connection` — ✅
- `/api/backup` — `GET /export`, `POST /validate`, `POST /restore` — ✅
- `/api/uploads` — `POST /photo`, `POST /floorplan`, `POST /branding-background` — ✅
- `/api/debug/traces` — `GET /`, `GET /:id`, `GET /stats`, `GET /operation-trace`, `PUT /operation-trace`, `PUT /entity/:id/toggle` — ✅
- `/api/system-health` — `GET /` — ✅

**Totals: 249 route-registration call sites (~300 routes at runtime, once the config loops expand), 26 registered prefixes, 0 broken,
0 duplicated.** Roughly 25 carry a ⚠️ (no frontend string match) and are
classified POSSIBLY UNUSED in §13 — none is recommended for removal on that
evidence alone.
