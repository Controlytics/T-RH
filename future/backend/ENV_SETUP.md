# Backend Environment Setup

For the full root-level setup (Windows dev box), the authoritative guide is **`LOCAL_SETUP_WINDOWS.md`** at the repo root. This document focuses specifically on the backend (`apps/api/`).

## Prerequisites

- Node 20+ / 22 + npm 11 (root `package.json` pins `"packageManager": "npm@11.6.2"`)
- PostgreSQL 18 with a single database: `digilog_db` (app + graphile-worker schema). *(The `digilog_tsdb` telemetry DB + TimescaleDB extension were removed 2026-06-17 with the data-ingestion tear-out — no TimescaleDB anymore.)*
- ~~Mosquitto 2.0 — optional unless testing MQTT ingest~~ *(removed 2026-06-17 — MQTT broker (Mosquitto/EMQX) + `install-mosquitto.ps1` gone; no broker anymore).*
- ~~Redis / Memurai ≥5~~ *(removed 2026-05-01 — the job queue moved to graphile-worker on Postgres and pub/sub is now in-process; no Redis/Memurai dependency).*
- ~~Microsoft Edge for PDF reports~~ — **no longer needed.** The server-side `puppeteer-core` + Edge reports PDF engine was removed 2026-07-04; PDF export is now client-side (`apps/web` `lib/pdf-report.ts`, jsPDF). No Edge/Chromium dependency.
- JDK 21 + Android SDK (only if you also build the APK) — installed at `C:\Users\hello\` on the reference dev box.

## First-time setup

```bash
# from repo root
npm install

# copy and edit env
cp .env.example .env
# - fill in DATABASE_URL for digilog_db
# - (TSDB_* / init-tsdb.sql removed 2026-06-17 — no TimescaleDB DB to bootstrap)
# - generate JWT_SECRET + VERIFICATION_TOKEN_SECRET (see .env.example for node -e helper)

# run migrations against the app DB
npm run db:migrate     # → cd apps/api && npx prisma migrate dev
npm run db:seed        # → cd apps/api && npx prisma db seed

# start dev
cd apps/api && npm run dev     # tsx watch → port 3000 (or API_PORT)
```

The default super-admin after seeding is `superadmin` / `Admin@123`.

## Running on HTTPS locally

If you're testing the APK against your local dev box, set `API_HTTPS=true`. The server will load `certs/server.key` + `certs/server.crt` (mkcert is the easiest way to generate these).

The APK bakes in `https://192.168.1.22:3000` as its API base, so if you change your dev host address you must rebuild the APK.

## Production-style local build

DigiLog is now Windows-local-only. EC2 / PM2 / Linux are no longer in scope (removed in commit `251be95`).

```bash
# compile TypeScript
npx tsc -p apps/api/tsconfig.json

# run the compiled JS
node apps/api/dist/app.js

# or build the customer installer (on a build machine with Inno Setup 6)
powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1
# → produces DigiLog-Setup-<ver>.exe (bundles portable Postgres; on run it
#   provisions the DB + registers the DigiLogDB/DigiLogAPI Windows services).
# (The old package-for-production.ps1 / install-on-target.ps1 scripts were removed 2026-07-04.)
```

After Phase 4 of the windows-friendly-rewrite the Fastify API serves both the SPA (from `apps/web/dist/`) and `/api/*` directly on port 3000 over HTTPS (`API_HTTPS=true` + mkcert certs). A reverse proxy (Nginx / IIS) is optional / customer-choice; nothing in the standard install path depends on it.

## Swagger

- Local dev: `https://localhost:3000/docs` (public)
- `NODE_ENV=production` disables `/docs` (see `plugins/auth.ts` `PUBLIC_PATHS`)

## Database tips

- ~~`digilog_tsdb` is the **telemetry** store (TimescaleDB hypertables)~~ *(removed 2026-06-17 — `digilog_tsdb` + TimescaleDB dropped with the data-ingestion tear-out; only `digilog_db` (Prisma-managed app DB) remains).*
- Restores rewrite the `roles` table — reseed (or `UPDATE`) after a restore to recover lost permissions.
- Dynamic backup goes through `pg_tables` + `jsonb_populate_recordset` and handles all 64 tables without needing superuser.

## ~~Connecting locally with Memurai on Windows (optional)~~ *(removed 2026-05-01)*

Redis/Memurai is no longer used at all. The job queue lives on Postgres via graphile-worker and pub/sub is now in-process (EventEmitter bus); `ioredis` was uninstalled 2026-05-01 and the remaining pub/sub consumers were torn out in Phase 6/7. There is no Memurai service to install or run.

## Android build (optional)

See `LOCAL_SETUP_WINDOWS.md` for the full flow. In brief:

```bash
cd apps/web && npm run build         # output to apps/web/dist
cd ../android && npx cap sync        # mirrors dist into Capacitor
# open in Android Studio or:
cd android && ./gradlew assembleDebug
```
