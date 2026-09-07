# compliance-core — Project Summary

**Re-derived 2026-08-29.**

> The previous version is at `docs/archive/PROJECT_SUMMARY-2026-07-04.md`. It
> asserted on line 6 that `rfid_scan_app/` does not exist and then listed
> `rfid_scan_app/ — Native Kotlin Android RFID scanner` in its own directory
> tree forty lines later, and its database row carried a paragraph of upstream
> DigiLog schema history (FilterProfile, ChecklistProfileVersion,
> EquipmentGroupVersion, AssetTemplate) for models that are gone. Archived
> rather than patched.

## What it is

A 21 CFR Part 11 administration and instrument-monitoring platform for a single
site: user and role administration, a tamper-evident hash-chained audit trail,
e-signature re-authentication on governed actions, notification routing, and
live instrument monitoring with alarms.

## Stack

| Layer | Choice |
|---|---|
| Backend | Fastify 5, TypeScript (ESM), Node 20+ |
| Database | PostgreSQL 18 via Prisma 6 — **36 models, 13 enums** |
| Frontend | React 19, Vite 6, React Router 7, SWR, Tailwind v4 |
| Auth | JWT (`jose`, HS256, 1h default) + bcrypt; session table; single-tab enforcement |
| Jobs | graphile-worker on Postgres — **6 tasks**. No Redis. |
| Ingest | MQTT (EMQX 5.3.2), WebSocket, raw TCP, HTTP POST |
| Reports | jsPDF + exceljs, client-side |
| Deployment | Windows services (WinSW) + Inno Setup. No containers. |

## Layout

```
apps/api/        Fastify backend — 24 modules, 249 route registrations
apps/web/        React SPA — 52 routes, 23 config pages
packages/shared/ permissions (42), reauth actions (48), sidebar items (13),
                 PERMISSION_TREE, zod schemas, telemetry maths
packages/queue/  graphile-worker wrapper + crontab.txt
docs/            active docs; docs/recreation/ is the verified inventory;
                 docs/archive/ is explicitly NOT current
scripts/         19 PowerShell/TS operational scripts
old/             superseded material — see old/README.md
```

## What this fork does NOT have

Stated plainly because most stale documentation in this repository is stale in
exactly this direction:

- **No mobile app.** No `apps/android/`, no Capacitor, no APK, no
  `rfid_scan_app/`, no RFID hardware integration, no signing keystore.
- **No offline sync.** No IndexedDB queue, no sync engine.
- **No filter / cleanroom domain.** No filters, AHUs, assets, cleaning cycles,
  checklists, PM or replacement schedules, equipment groups. Removed in the
  2026-07-18 Phase 0 strip and the 2026-08-20 vocabulary removal.
- **No multi-tenancy.** Removed 2026-04-30. JWT `scope` always stamps `GLOBAL`.
- **No TimescaleDB**, no `digilog_tsdb`, no Redis, no `packages/db`.
- **No dark theme.**

## Compliance posture

- **Audit trail is hash-chained** (`lib/hash-chain.ts`), with an unkeyed SHA
  era (V2) and a keyed HMAC era (V3, `AUDIT_CHAIN_KEY` held outside the
  database). `AUDIT_CHAIN_KEYED_FROM` is the out-of-band anchor.
- A Postgres trigger, `audit_trail_no_delete`, blocks physical deletes.
- **Two endpoints can still suspend that trigger and hard-delete records**,
  breaking the chain. They are permission-gated, re-authenticated, rate-limited
  and meta-audited, and `AUDIT_HARD_DELETE_ENABLED=false` removes them
  entirely. **The default is enabled — whether it should be is a QA/RA
  decision, not an engineering one.** See
  `docs/audit/2026-08-29-technical-audit.md` finding H3.
- Governed actions require re-auth (48 actions, 8 categories) and, for
  attribute changes and report downloads, a mandatory reason.

## Health

Last full audit: `docs/audit/2026-08-29-technical-audit.md` (2026-08-29).
Overall **74/100** at the time of writing, with the CRITICAL and HIGH findings
since remediated. Read the remediation banner at the top of §28 — including the
four findings that turned out to be wrong on contact with the code, which is
the most useful part of that document for anyone auditing it next.

## Re-derive anything here

See the command block at the bottom of `PROJECT_ARCHITECTURE.md`. Per
`CLAUDE.md`'s documentation-sync rule, every numeric claim in this repository
must be backed by a `grep`/`ls` at the moment the doc is touched — and the same
rule applies to this file.
