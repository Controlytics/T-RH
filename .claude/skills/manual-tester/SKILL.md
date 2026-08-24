---
name: manual-tester
description: Use when the user asks to "test the app", "run manual tests", "test the dashboard", "test instruments", "test alarms", "test the audit trail", "verify data in browser", or needs end-to-end manual testing of compliance-core — driving the UI, exercising instrument monitoring and §11 flows, and verifying data in the database and browser.
version: 0.3.0
---

# Manual Tester — compliance-core

Structured workflows for manually testing this 21 CFR Part 11 platform: user
and role administration, the hash-chained audit trail, e-signature
re-authentication, notifications, and instrument monitoring (telemetry ingest,
alarms, functional locations, floorplans, the graphical and tabular dashboards,
and per-instrument trend pages).

> **Rewritten 2026-08-24.** Version 0.2.0 of this skill described the **filter /
> cleaning-cycle / PM / RFID domain**, which was stripped from this fork
> (2026-07-18 and 2026-08-20), and asserted that "there is no telemetry
> ingestion, no MQTT broker, and no alarm subsystem to test." **All three of
> those are false** — verified 2026-08-24: `apps/api/package.json` carries
> `mqtt@^5.15.2`, `app.ts` registers `/api/ingest/v1`, and `modules/alarms/`
> and `modules/instruments/` are live. It also told you to run
> `start-digilog.bat`, which does not exist, and to curl `/api/health`, which
> is not a route. Every command below was re-verified against live code.

## Prerequisites

Local Windows dev only — there is no live server to test against.

**1. Start it.** From the project root:

```bash
start-app.bat          # wraps scripts/start-app.ps1 — idempotent, verifies deps
```

Or manually, in two terminals:

```bash
cd apps/api && npx tsx watch src/app.ts
# reads apps/api/.env: PORT=3001, API_HTTPS=true

cd apps/web
WEB_PORT=5176 API_PROXY_TARGET=https://localhost:3001 npx vite --host
```

**Those two web env vars are not optional.** `apps/web/vite.config.ts` defaults
to port 5175 and proxies `/api` to `https://localhost:3000` — which is the
**sibling DigiLog checkout's** backend. A bare `npx vite` here gives you an app
that appears to work while reading the wrong database. If a test result makes no
sense, check the port in your address bar before anything else.

**2. Confirm the API is up.** There is no `/health` route — do not curl one.
Any response at all proves the server and TLS are alive:

```bash
curl -sk --ssl-revoke-best-effort -o /dev/null -w "%{http_code}" https://localhost:3001/api/system-health
```

`401` is a pass here — it means TLS terminated and the route rejected an
unauthenticated call. `/api/system-health` requires ADMIN. On Windows, curl uses
Schannel and returns exit 60 on valid local certs without
`--ssl-revoke-best-effort`; that is not a broken chain.

**3. Sign in.** `superadmin`, with the password that was passed as
`INITIAL_ADMIN_PASSWORD` when the database was seeded. There is no default
password in this repo — seeding throws without that variable — and
`forcePasswordChange` is `false`, so you will not be prompted to change it.

**4. Know which database you are looking at.** `compliance_core_db` is dev;
`compliance_core_db_test` is for e2e and is migrated **separately**. A migration
applied to only one makes every instrument-touching test 500 in a way that looks
like application code.

## A hard constraint on how you verify

**Playwright cannot get past login on this machine.** Its browser cannot fetch
the API through the mkcert certificate, and `browser_click` silently no-ops. Do
not report a UI behaviour as verified because a script "clicked" something.

So: **verify beneath the UI, and hand the visual check to the operator.** Assert
against the API with `app.inject` or curl, and against the database with Prisma
or psql. When you have done all you can, say plainly which parts you have not
seen, and ask the operator to look. Never claim to have seen a page render.

While the operator is looking, ask them to watch for unstyled or misaligned
elements and for console errors — those are the two failures that no
below-the-UI check will ever catch.

## What is worth testing here

Live modules (`ls apps/api/src/modules/` — 23): admin-requests, alarms, audit,
auth, backup, config, dashboards, debug-traces, floorplans,
functional-locations, help, instrument-profiles, instruments, ldap,
notification-delivery, notification-rules, notifications, roles, super-admin,
system-health, uploads, user-groups, users.

High-value flows, roughly in order of how badly they fail if broken:

1. **The audit chain.** Every §11 action must leave a row, and the chain must
   verify. Check that a rejected action leaves NO row and a successful one
   leaves exactly one, with `beforeValue`/`afterValue` naming what changed.
2. **E-signature re-authentication.** Actions configured to require it must
   reject without a password and audit the attempt. Policy is per role — check
   Config → Roles & Access before concluding a prompt is missing.
3. **Instrument visibility.** A scoped role must not see instruments outside its
   scope, and out-of-scope lookups must **404, never 403** — a 403 confirms the
   instrument exists, which is the leak the design avoids.
4. **Alarms.** Raised against the instrument's own limits where it has them,
   else its room's; the precision is frozen onto the alarm at raise time.
5. **Dashboards.** Tabular and graphical views must agree with each other and
   with the alarms page about the same reading.
6. **Report downloads.** Period + remarks + re-authentication are required, the
   audit write happens BEFORE the file is produced, and a failed audit write
   must cancel the download.

## What does not exist — do not test for it, and do not "restore" it

No filters, AHUs, cleaning cycles, checklists, PM schedules, assets or
equipment groups. No mobile app, RFID, Capacitor build or offline sync. No
`packages/db`, no TimescaleDB, no `digilog_tsdb`.

**But MQTT ingest DOES exist** (`/api/ingest/v1`, EMQX 5.3.2 as the broker), and
so do alarms and telemetry. Several documents in this repo still claim
otherwise. If a doc and the code disagree, the code wins — re-derive from
`apps/api/src/app.ts` before believing either.

## Reporting results

State what you ran, what you observed, and what you could not check. If a test
fails, give the actual output rather than a summary of it. If you fixed
something incidentally, say so. Do not describe a run as passing when part of it
was skipped — name the skip.
