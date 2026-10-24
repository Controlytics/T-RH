# compliance-core

A 21 CFR Part 11 administration platform: user and role management, a
hash-chained tamper-evident audit trail, e-signature re-authentication on
sensitive actions, notifications, and instrument monitoring (telemetry ingest,
alarms, functional locations, floorplans and per-instrument trends).

It is a fork of DigiLog that has been stripped back to that core. The
cleanroom filter/AHU/cleaning domain the upstream product was built around is
**not** here — see "What this fork does not have" below.

Monorepo: Fastify 5 API, React 19 + Vite 6 SPA, two shared workspaces, one
PostgreSQL database, Turborepo for task running. Windows-first local dev.

> **Every count and command in this file was re-derived from live code on
> 2026-08-27**, on branch `data-injection`. The command that produced each
> number is printed beside it, so you can re-run it rather than trusting this
> document. Do that — docs in this repo drift.

## Repository layout

`ls apps/ packages/`

| Path | What it is for |
|---|---|
| `apps/api/` | Fastify backend. Auth, RBAC, audit chain, notifications, instruments, ingest, alarm webhooks. **25** modules (`ls apps/api/src/modules/ \| wc -l`). Prisma schema + migrations live here. |
| `apps/web/` | React SPA (Vite, Tailwind 4, SWR, react-router). **54** `<Route>` elements (`grep -cE "<Route" apps/web/src/main.tsx`; 53 → 54 on 2026-10-24). |
| `packages/shared/` | Contracts both sides import: **44** permissions, **56** reauth actions, **14** sidebar items, the permission tree, Zod schemas. |
| `packages/queue/` | graphile-worker producer + runner. Postgres-backed — no Redis. |
| `docs/` | Project docs. `docs/recreation/` is the verified inventory. |
| `scripts/` | PowerShell scripts for start/stop, DB provisioning, migration verification, packaging. |
| `tests/integration/` | Cross-workspace suite, gated on `INTEGRATION_TEST=1`. |
| `future/`, `old/` | Design notes and archived docs. Both describe upstream DigiLog in places. |

Counts came from: `grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts`,
`grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts`,
`grep -cE "id: '" packages/shared/src/types/sidebar-items.ts`.

The database has **37 models and 13 enums** (re-derived 2026-10-05; 36 → 37 on 2026-09-22 with `FloorplanRoomLink`)
(`grep -cE "^model " apps/api/prisma/schema.prisma`, and `grep -cE "^enum "` on
the same file).

## Running it locally

### Prerequisites

- Node.js **24.x** and npm. The version is pinned in ONE place — the root
  `package.json` `engines.node` field (`"24.x"`, added 2026-10-05) with a
  matching `.nvmrc` — because the Linux `.deb` build (`scripts/linux/build-deb.sh`)
  refuses any other major and the Windows installer bundles a Node zip whose
  ABI must match the native modules compiled on the build machine. Every other
  doc that states a Node version cites that field; change it there first. The
  root `package.json` also pins `npm@11.6.2` via `packageManager`, which is only
  enforced if you have Corepack on. This machine runs Node v24.14.1 and npm
  11.11.0.
- PostgreSQL. `psql --version` here reports 18.3, reachable on `localhost:5432`.
  No minimum is enforced anywhere in the repo.
- Windows. The launcher and provisioning scripts are PowerShell; the app itself
  is plain Node and has no Windows-only runtime dependency.

### The short path

```
start-app.bat
```

`scripts/start-app.ps1` (the batch file is a thin launcher) checks Node, reads
`apps/api/.env`, verifies the database and the ports, runs `npm install`,
builds the shared workspaces, runs `prisma generate`, then opens two windows
running the API and the web dev server. It is safe to re-run — every step is
skipped when already satisfied. `stop-app.bat` shuts it down.

Use this path if you can. The manual path below has two sharp edges that the
script exists to handle.

### The manual path

```bash
npm install
npm run build -w @digilog/shared
npm run build -w @digilog/queue
```

Create `apps/api/.env` from `apps/api/.env.example`. Two things to fix as you
copy it: the example's `DATABASE_URL` names `digilog_db`, but this checkout
uses **`compliance_core_db`**; and this checkout is configured for ports
**3001 and 5176** rather than the code defaults of 3000 and 5175, which a
sibling DigiLog checkout owns on the machine this was set up on. At minimum
you need `DATABASE_URL`, `JWT_SECRET`, `PORT=3001` and `WEB_PORT=5176`
(`VERIFICATION_TOKEN_SECRET` is no longer read — removed 2026-10-05 with
`POST /api/auth/verify`, audit SEC-5).

Create and migrate the database:

```bash
# psql -c "CREATE DATABASE compliance_core_db OWNER <role>;"
#   — or run scripts/provision-db.ps1, which does role + database + grants
npm run db:migrate            # = cd apps/api && npx prisma migrate deploy
```

Seed the first user. **`npm run db:seed` on its own fails**:
`apps/api/prisma/seed.ts` throws `FATAL: INITIAL_ADMIN_PASSWORD env var must be
set` rather than baking a default password into the repo. Pass one:

```bash
cd apps/api
INITIAL_ADMIN_PASSWORD='<pick one>' npx prisma db seed
```

Then start the two servers, in two terminals:

```bash
# API — reads apps/api/.env, so PORT=3001 in that file is enough
cd apps/api && npx tsx watch src/app.ts

# Web — these two env vars are NOT optional here, see below
cd apps/web
WEB_PORT=5176 API_PROXY_TARGET=https://localhost:3001 npx vite --host
```

On Windows `cmd` that last line is
`set WEB_PORT=5176&& set API_PROXY_TARGET=https://localhost:3001&& npx vite --host`.

**Why those two env vars matter.** `apps/web/vite.config.ts` defaults to
`port: 5175` and proxies `/api` to `https://localhost:3000`. `WEB_PORT` and
`PORT` live in `apps/api/.env`, which Vite never reads. So a bare `npx vite` in
this checkout serves on 5175 and sends every API call to the *sibling* DigiLog
checkout's backend — the app appears to work, against the wrong data.
`scripts/start-app.ps1` sets both variables explicitly for exactly this reason.

`npm run dev` (turbo) has the same problem and is not the recommended path.

### Signing in

Username `superadmin`, password whatever you passed as
`INITIAL_ADMIN_PASSWORD`. There is no default password in the repo. The seed
sets `forcePasswordChange: false`, so you are not prompted to change it at
first login.

### URLs

With the ports above: web on `https://localhost:5176`, API on
`https://localhost:3001`, Swagger at `https://localhost:3001/docs`. Both are
`http://` instead if you have no certs — see below.

## Sharp edges worth knowing before you hit them

**TLS is conditional on both sides, and the certs are gitignored.**
`apps/api/src/app.ts` serves HTTPS only when `API_HTTPS=true`, reading
`certs/server.{key,crt}`. `apps/web/vite.config.ts` calls `devHttps()`, which
returns `undefined` when those files are absent — so a fresh clone gets a plain
**HTTP** dev server and a plain HTTP API. Generate the pair with mkcert (the
same invocation `scripts/start-app.ps1` prints at its cert check):

```
mkcert -key-file certs\server.key -cert-file certs\server.crt localhost 127.0.0.1
```

Trust the mkcert root at `%LOCALAPPDATA%\mkcert\rootCA.pem`. The
`certs/rootCA.pem` committed at the repo root is a *different*, hand-rolled CA
that signs nothing in use — verifying `server.crt` against it fails, and that
failure is not a broken chain.

**There are two databases, migrated separately.** Dev is
`compliance_core_db`; the vitest suite runs against `compliance_core_db_test`,
forced by `apps/api/vitest.env.ts` before Prisma connects, so test writes never
touch the immutable audit chain. A migration applied to only one of them makes
every instrument-touching e2e test return 500. Apply to both:

```bash
DATABASE_URL="postgresql://…/compliance_core_db_test?schema=public" npx prisma migrate deploy
```

The test database needs its own seed run too, with the same
`INITIAL_ADMIN_PASSWORD` mechanism.

**The audit trail is hash-chained and immutable.**
`apps/api/src/lib/hash-chain.ts`, verified by `audit-verify.ts`. Deleting rows
from `audit_trail` — which a misdirected test run has done in this checkout
before — leaves permanent gaps that cannot be repaired. That is why the
test-database guard above fails closed instead of falling back.

**MQTT ingest is real and load-bearing.** `mqtt` is a dependency in
`apps/api/package.json`; `app.ts` registers `/api/ingest/v1` and starts an MQTT
bridge plus a raw-TCP listener, both gated on their env vars
(`MQTT_BROKER_URL`, `INGEST_TCP_PORT`), so no port opens unasked. A doc
claiming ingest was removed is describing the Phase 7 tear-out of a
*different*, older pipeline. Do not delete this code on the strength of such a
doc.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | turbo build across workspaces |
| `npm run lint` | `tsc --noEmit` per workspace |
| `npm test` | turbo test (vitest). Vitest does not typecheck — run `lint` as well |
| `npm run db:migrate` | `prisma migrate deploy` against `DATABASE_URL` |
| `npm run db:seed` | seed (requires `INITIAL_ADMIN_PASSWORD`, see above) |
| `npm run db:studio` | Prisma Studio |
| `npm run db:verify-migrations` | migration drift guard, `scripts/verify-migrations.ps1` |
| `npm run check:cycles` | madge circular-dependency check |

All of these are from the root `package.json`; the per-workspace scripts are in
each workspace's own `package.json`.

## What this fork does not have

Each of these was checked, not assumed:

- **No mobile app and no Capacitor build.** `apps/android/` and
  `rfid_scan_app/` do not exist (`ls`), and no workspace `package.json`
  mentions Capacitor (`grep -ri capacitor --include=package.json`). The SPA
  *does* still register a service worker via `vite-plugin-pwa`, with
  `apps/web/src/components/pwa-reload-prompt.tsx` — note that its manifest's
  `start_url: '/m'` points at a route that no longer exists in `main.tsx`.
- **No RFID.** No scanner app, no reader SDK, no keyboard-burst guard.
- **No offline sync.** No IndexedDB usage anywhere in `apps/web/src`, no sync
  engine, no `lib/offline-replay-token.ts` — despite `apps/api/.env.example`
  still carrying a comment about it. `docs/archive/OFFLINE_SYNC_ARCHITECTURE.md`
  describes something that is gone.
- **No filter / AHU / cleaning / PM domain.** Its modules, models, pages and
  vocabulary were removed (Phase 0 strip 2026-07-18, remainder 2026-08-20). The
  only surviving mention is a list of retired config keys in
  `apps/api/src/lib/config-discovery.ts`. Restore points exist as the tags
  `pre-domain-strip` and `pre-filter-domain-strip`.
- **No Redis and no TimescaleDB.** The job queue is graphile-worker on the same
  Postgres; there is no second database beyond the test one.
- **No `packages/db` workspace**, no multi-tenancy (the JWT `scope` always
  stamps `GLOBAL`), and no CI configuration of any kind — no
  `.github/workflows`, `.gitlab-ci.yml`, `Jenkinsfile`, `.circleci` or
  `azure-pipelines.yml`. Nothing runs the tests but you.
- **No `LICENSE` file.** This repo states no licence terms. The pre-rewrite
  README asserted "Proprietary — Pankaj Exa Technologies", which is upstream
  DigiLog's vendor, not this fork's; it was dropped rather than carried over
  unverified. If this fork needs a licence stated, it needs a deliberate one.

## Where to go next

- **`CLAUDE.md`** — working agreements for this repo, and the "Live-count
  verification" block whose commands produced the numbers above. Treat the
  numbers printed in it as leads rather than facts; several have been caught
  stale, including two that this file corrects.
- **`docs/recreation/`** — the verified inventory. Where a root-level doc and
  this directory disagree, this directory is the one that was checked.
- **`docs/CONTRIBUTING.md`** — the change-to-docs map, the rule for adding a
  config def, and the pre-deletion rule.
- **`CHANGELOG.md`** — chronological history, including what was removed and when.

**Documents to distrust.** Several root-level docs were inherited from upstream
DigiLog and describe a product this repo is not: `API_REFERENCE.md`,
`PROJECT_SUMMARY.md`, `PROJECT_ARCHITECTURE.md`, `BACKEND_GUIDE.md`,
`FRONTEND_GUIDE.md`, and much of `future/`. Each of those five now carries an
explicit drift warning at the top — read the warning before you read the
document. `docs/archive/` holds documents kept only as history
(`OFFLINE_SYNC_ARCHITECTURE.md`, `PHASE_5_RECENT_WORK.md`); nothing in it
describes the current system. Anything describing filters,
AHUs, cleaning cycles, RFID, tablets or offline queues is upstream DigiLog, not
this fork.
