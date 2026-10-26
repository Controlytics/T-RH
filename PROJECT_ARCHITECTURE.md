# compliance-core — Architecture

**Re-derived 2026-08-29.** Every count below came from a command run against
the tree that day; the commands are at the bottom so you can re-run them rather
than trust this file.

> The previous version of this document is at
> `docs/archive/PROJECT_ARCHITECTURE-2026-07-04.md`. It was 445 lines
> describing an `apps/android/` Capacitor wrapper, an `rfid_scan_app/` Kotlin
> scanner, a committed `rfid-key.jks` signing keystore and
> `start-digilog.bat` — **none of which exist in this fork**. It carried a
> drift-warning banner, but the banner was 12 lines and the fiction was 400+,
> and the keystore line in particular sent readers chasing a security incident
> that had never happened. Archived rather than patched, because a warning over
> false content is not a fix.

## What this system is

A single-tenant 21 CFR Part 11 administration and instrument-monitoring
platform: users, roles, a hash-chained audit trail, e-signature re-auth,
notifications, and instrument monitoring (MQTT/HTTP/WS/TCP ingest, telemetry,
alarms, functional locations, floorplans).

It is a fork of an upstream product ("DigiLog") that has been aggressively
stripped. **There is no mobile app, no RFID, no offline sync, no Capacitor
build, no multi-tenancy and no filter/cleanroom domain.** A document or request
that assumes any of those is describing upstream DigiLog, not this repository.

## Shape

```
                    ┌──────────────── Instruments / Devices ────────────────┐
                    │  HTTP POST      WebSocket      raw TCP      MQTT      │
                    │  /ingest/v1/    /ingest/v1/ws  INGEST_TCP_  (EMQX     │
                    │  telemetry                     PORT         5.3.2)    │
                    └───────────────────────┬───────────────────────────────┘
                                            │ per-instrument token
                                            │ (NOT a user JWT — see
                                            │  plugins/auth.ts PUBLIC_PATHS)
 Browser                                    ▼
 ┌──────────────┐        HTTPS      ┌──────────────────────────────────┐
 │ React 19 SPA │ ───────────────►  │  Fastify 5  (apps/api/src/app.ts)│
 │  SWR cache   │  JWT Bearer +     │  onRequest → authPlugin          │
 │  53 routes   │  x-reauth-password│            → rbacPlugin          │
 └──────────────┘                   │  26 route prefixes               │
        ▲                           └───────────┬──────────────────────┘
        │                           ┌───────────▼──────────────────────┐
        │                           │ modules/*  routes → service      │
        │                           │            → repository          │
        │                           │ lib/ audit · hash-chain · jwt    │
        │                           │      logger · errors             │
        │                           └───────────┬──────────────────────┘
        │                           ┌───────────▼──────────────────────┐
        │                           │ Prisma 6 (38 models)             │
        │                           │  + raw SQL for both telemetry    │
        │                           │    tables and the backup engine  │
        │                           └───────────┬──────────────────────┘
        │                                       ▼
        │                           ┌──────────────────────────────────┐
        │                           │ PostgreSQL 18                    │
        │                           │  compliance_core_db              │
        │                           │  compliance_core_db_test         │
        │                           │  graphile_worker schema          │
        │                           │  instrument_telemetry_history    │
        │                           │    PARTITIONED, no Prisma model  │
        │                           └──────────────────────────────────┘
        │                                       ▲
        │  in-app notifications                 │
        └───────────────────────────┌───────────┴──────────────────────┐
                                    │ graphile-worker (7 tasks)        │
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

## Counts (2026-08-29)

| Thing | Count |
|---|---|
| API modules (`apps/api/src/modules/`) | **24** |
| Route registrations in `app.ts` | **249** call sites / ~300 at runtime¹ |
| Registered route prefixes | **26** |
| Prisma models / enums | **36 / 13** |
| Migrations | **24** |
| Permissions / reauth actions | **42 / 48** |
| Audit actions | **97** |
| Sidebar items | **12** |
| Config defs / config pages | **35 / 22**² (re-derived 2026-10-05) |
| Frontend `<Route>`s | **51** (31 lazy) |
| Web hooks / lib modules | **26 / 22** (re-derived 2026-10-05: `use-row-keys.ts`, `safe-storage.ts` landed that day) |
| graphile-worker tasks | **6** |
| Test files | **~220** |

¹ A static grep undercounts: `config/routes.ts` and `config/dynamic-routes.ts`
register routes in a LOOP (a `configEndpoint` factory called 6 times, and
GET/PUT over the 35 auto-discovered defs — `ls apps/api/src/modules/config/defs/*.def.ts | wc -l`, 2026-10-05, after `telemetry-retention.def.ts` landed that day), so 6 + 2 × 35 routes come from 4 call
sites. Expand the config registry before trusting any route census.

² These are not meant to be equal. Some defs render through the dynamic config
page with no file of their own; `alarm-webhooks.tsx` is a page with no def.

## Things that will bite you

- **`instrument_telemetry_history` is partitioned and has NO Prisma model**
  (Prisma cannot express `PARTITION BY`). `prisma migrate dev` / `db push`
  will generate a `DROP TABLE` for it — fifteen committed migrations carry a
  comment from an author who stripped exactly that by hand.
  `apps/api/src/lib/migration-guard.ts` now fails the build if one slips
  through. **Do not "fix" it by adding a model**: Prisma would then emit a
  plain `CREATE TABLE` for a fresh environment, producing an unpartitioned
  table, and ingest dies at the first month boundary.
- **`/api/health` exists** (`app.ts:297`) and is the tablet's liveness probe.
  Its `PUBLIC_PATHS` entry is required. Two documents claimed it did not exist,
  both from a grep pattern that could not have matched it.
- **`instrument_scope` holds two shapes permanently** — a bare `string[]` for
  rows written before 2026-08-28, `{locationIds, instrumentIds}` since.
  `modules/instruments/visibility.ts:normalizeScope()` is the ONE reader of
  both; a second `Array.isArray` test anywhere reads a legacy restricted row as
  unrestricted.
- **Single-instance assumptions.** The alarm-webhook cooldown map and the
  error-notification rate limiter are in-memory. Two API instances double both.
- **The test suite must run single-fork** (`npm test` in `apps/api` is wired
  for it) and runs against `compliance_core_db_test`, which `vitest.env.ts`
  enforces fail-closed.

## Deployment

Windows-native. No Docker, no compose, no nginx/IIS. Two Windows services
registered by `scripts/register-services.ps1` — `DigiLogDB` (bundled
PostgreSQL) and `DigiLogAPI` (node + WinSW, `NODE_ENV=production`, restart on
failure, 32×10 MB rotated logs). Installer is Inno Setup
(`installer/DigiLog.iss`). The API can serve the built SPA itself via
`SERVE_WEB`, so no separate web server is required.

There is **no infrastructure-as-code** for the EC2/RDS environment — see
`docs/deployment-methods/` and `docs/DEPLOY-AWS-EC2.md` for the manual steps.

## Re-derive these numbers

```bash
ls apps/api/src/modules/ | wc -l                                   # 24
grep -cE "^model |^enum " apps/api/prisma/schema.prisma            # 36 / 13
ls apps/api/prisma/migrations | wc -l                              # 24
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts    # 42
grep -cE "^\s+[A-Z_]+:"     packages/shared/src/types/reauth-actions.ts # 48
grep -cE "^\s+[A-Z_]+:"     packages/shared/src/types/audit-actions.ts  # 97
ls apps/api/src/modules/config/defs/*.def.ts | wc -l               # 35 (2026-10-05)
ls apps/web/src/routes/config/*.tsx | wc -l                        # 24
grep -cE "<Route" apps/web/src/main.tsx                            # 51
ls apps/web/src/hooks/ | wc -l                                     # 20
ls apps/web/src/lib/   | wc -l                                     # 19
```

## See also

- `docs/audit/2026-08-29-technical-audit.md` — full technical audit, including
  the findings that turned out to be wrong and why.
- `docs/recreation/` — the verified inventory.
- `CLAUDE.md` — working rules, and a running list of claims this repo has had
  to correct about itself.
