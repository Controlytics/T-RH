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
| **Deploy DigiLog on a customer / on-prem Windows box** (the runbook) | **`docs/PHARMA_DEPLOYMENT_21CFR.md`** — `.exe` installer, internal-CA HTTPS, no reverse proxy, 21 CFR Part 11 controls, step-by-step runbook, internal root-CA trust on the browser machines |
| **Understand what the installer bundles and how it's built** (internals) | **`tasks/EXE-PACKAGING-PLAN.md`** — milestones M0–M8; the build + install + upgrade scripts |
| **Build the installer** | `scripts/build-installer.ps1` (→ `build-bundle.ps1` → stage runtime + portable Postgres + WinSW → Inno `ISCC` → `Setup.exe`) |
| **Provision / register / upgrade at install time** (run by the installer) | `scripts/install.ps1` → `provision-db.ps1` + `register-services.ps1`; upgrades via `scripts/upgrade.ps1` |
| **Smoke-check a running deployment** | `scripts/verify-windows-deployment.ps1` (API `/api/health` + graphile-worker schema) |

## What the current stack is (and isn't)

- **Three components on the server:** PostgreSQL 18 (one database, provisioned as `digilog_db` by `scripts/provision-db.ps1`), one Node process — the Fastify API serves the built SPA on `:3000` (HTTPS); the graphile-worker job queue lives inside Postgres — and, since 2026-09-08, the bundled EMQX 5.3.2 broker for instrument ingest (see the correction below).
- **Services:** the installer registers `DigiLogDB` (bundled Postgres) and `DigiLogAPI` (WinSW) as auto-starting Windows services.
- **Data survives upgrades:** program files in `C:\Program Files\DigiLog`, data + secrets + backups in `C:\ProgramData\DigiLog`. `upgrade.ps1` is data-safe (pg_dump backup → forward-only `prisma migrate deploy`, never `db push`).
- **HTTPS is required** (TLS terminates in Fastify; the audit trail's e-signature flows are not served over cleartext) — use an internal-CA cert bound to an internal DNS hostname, or for a pilot the mkcert dev certs with the mkcert root CA trusted on each browser machine. See `docs/PHARMA_DEPLOYMENT_21CFR.md` §3.2. *(This bullet said "required for the APK" and "trusted on each tablet" until 2026-10-05; there is no APK or tablet in this fork — `ls apps/` is `api`, `web`.)*
- **Not used anymore — do NOT install:** TimescaleDB (dropped 2026-06-11), Redis / Memurai (removed 2026-05-01), Microsoft Edge / Chromium (the server-side reports PDF engine that needed it was removed 2026-07-04). There are no `TSDB_*` or `UNS_*` env keys.
- **⚠️ Correction (2026-08-24) — MQTT/EMQX is back, for a different reason.** This section previously said Mosquitto/MQTT/EMQX was "removed 2026-06-17" and that there were no `MQTT_*` env keys. That was true of the *old* telemetry pipeline this file used to describe, but a **new** MQTT ingest bridge for instrument telemetry was added afterward: `apps/api/package.json` depends on `"mqtt": "^5.15.2"`, `apps/api/src/app.ts` registers `/api/ingest/v1`, `mqtt-auth-routes.ts`, an MQTT bridge (`modules/instruments/listeners/mqtt-bridge.ts`), and a raw-TCP ingest listener, and `apps/api/.env.example` has live `MQTT_BROKER_URL` / `INGEST_TCP_PORT` keys (verified `grep -n mqtt apps/api/src/app.ts` and `grep '"mqtt"' apps/api/package.json` 2026-08-24). If deploying a site that needs instrument ingest, an EMQX broker is required — see `LOCAL_SETUP_WINDOWS.md` §9A/§9B for the dev-side setup. **Since 2026-09-08 the `Setup.exe` installer bundles and provisions EMQX 5.3.2 itself** (`scripts/build-installer.ps1 -EmqxZip`, `scripts/provision-emqx.ps1`; `docs/PHARMA_DEPLOYMENT_21CFR.md` §4a covers the production broker). The script-deploy path used on the AWS instance (`deploy-on-instance.ps1`) still assumes a broker installed and configured by hand.

## Historical upgrade caveats (no longer apply to installer-managed databases; the tablet items name features removed 2026-07-18)

The retired guide's "Phase 8.7 release notes" covered one-time manual-upgrade caveats for environments
that had been hand-migrated via `prisma db push` before 2026-05-03:

- the `20260503162127_capture_schema_vs_db_drift` drift migration needing `prisma migrate resolve --applied` on populated DBs,
- pre-8.7 tablet offline queues (`tapeVersion: null`) 400-ing on first sync after the APK upgrade *(tablets, the APK and the offline queue were removed with the filter domain on 2026-07-18 — noted 2026-10-05)*,
- the 2026-05-04 audit-hardening cutover (`audit_hash_chain` migration, `GET /api/audit/verify-chain`; its `OFFLINE_REPLAY_SECRET` and `offline-grant` flow went with the offline queue — `grep -rn OFFLINE_REPLAY_SECRET apps/api/src` is empty).

These do **not** apply to installer-managed databases (fresh installs are greenfield — every migration
applies in order; upgrades run forward-only `migrate deploy` on a DB the installer created). The full
narrative is preserved in **`CHANGELOG.md`** (search "Phase 8.7", "audit hash chain", "OFFLINE_REPLAY_SECRET").
