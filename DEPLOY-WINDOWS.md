# DigiLog — Windows Deployment (pointer)

> **This manual deployment guide has been retired.** DigiLog now ships as a packaged
> **`DigiLog-Setup-<ver>.exe`** (Inno Setup) installer that bundles its own portable PostgreSQL,
> writes its runtime config, provisions the database, and registers Windows services — the customer
> installs nothing else. The old manual flow this file used to describe (install external
> PostgreSQL + TimescaleDB + Mosquitto by hand, run `install-on-target.ps1` /
> `install-mosquitto.ps1` / `package-for-production.ps1`) is gone: those scripts were removed
> 2026-07-04, and TimescaleDB / MQTT / Redis were removed earlier (see below).

## Where the deployment docs live now

| You want to… | Read |
|---|---|
| **Deploy DigiLog on a customer / on-prem Windows box** (the runbook) | **`docs/PHARMA_DEPLOYMENT_21CFR.md`** — `.exe` installer, internal-CA HTTPS, no reverse proxy, 21 CFR Part 11 controls, step-by-step runbook, tablet/APK + root-CA trust |
| **Understand what the installer bundles and how it's built** (internals) | **`tasks/EXE-PACKAGING-PLAN.md`** — milestones M0–M8; the build + install + upgrade scripts |
| **Build the installer** | `scripts/build-installer.ps1` (→ `build-bundle.ps1` → stage runtime + portable Postgres + WinSW → Inno `ISCC` → `Setup.exe`) |
| **Provision / register / upgrade at install time** (run by the installer) | `scripts/install.ps1` → `provision-db.ps1` + `register-services.ps1`; upgrades via `scripts/upgrade.ps1` |
| **Smoke-check a running deployment** | `scripts/verify-windows-deployment.ps1` (API `/api/health` + graphile-worker schema) |

## What the current stack is (and isn't)

- **Two components on the server:** PostgreSQL 18 (single database `digilog_db`) and one Node process — the Fastify API serves the built SPA on `:3000` (HTTPS). The graphile-worker job queue lives inside Postgres.
- **Services:** the installer registers `DigiLogDB` (bundled Postgres) and `DigiLogAPI` (WinSW) as auto-starting Windows services.
- **Data survives upgrades:** program files in `C:\Program Files\DigiLog`, data + secrets + backups in `C:\ProgramData\DigiLog`. `upgrade.ps1` is data-safe (pg_dump backup → forward-only `prisma migrate deploy`, never `db push`).
- **HTTPS is required for the APK** — use an internal-CA cert bound to an internal DNS hostname (or the mkcert dev certs with `rootCA.pem` trusted on each tablet). See `docs/PHARMA_DEPLOYMENT_21CFR.md` §3.2.
- **Not used anymore — do NOT install:** TimescaleDB (dropped 2026-06-11), Mosquitto / any MQTT broker / EMQX (removed 2026-06-17), Redis / Memurai (removed 2026-05-01), Microsoft Edge / Chromium (the server-side reports PDF engine that needed it was removed 2026-07-04). There are no `TSDB_*`, `MQTT_*`, `EMQX_*`, `UNS_*`, or `MOSQUITTO_*` env keys — see `apps/api/.env.example`.

## Historical upgrade caveats (no longer apply to installer-managed databases)

The retired guide's "Phase 8.7 release notes" covered one-time manual-upgrade caveats for environments
that had been hand-migrated via `prisma db push` before 2026-05-03:

- the `20260503162127_capture_schema_vs_db_drift` drift migration needing `prisma migrate resolve --applied` on populated DBs,
- pre-8.7 tablet offline queues (`tapeVersion: null`) 400-ing on first sync after the APK upgrade,
- the 2026-05-04 audit-hardening cutover (`OFFLINE_REPLAY_SECRET`, `audit_hash_chain` migration, `GET /api/audit/verify-chain`, `offline-grant` flow).

These do **not** apply to installer-managed databases (fresh installs are greenfield — every migration
applies in order; upgrades run forward-only `migrate deploy` on a DB the installer created). The full
narrative is preserved in **`CHANGELOG.md`** (search "Phase 8.7", "audit hash chain", "OFFLINE_REPLAY_SECRET").
