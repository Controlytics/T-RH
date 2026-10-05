# docs/archive — documents kept for the record, not for reference

Everything in this folder describes software that is **no longer in this fork**.
It is kept because deleting documentation in this repo has gone wrong before:
`docs/CONTRIBUTING.md`'s pre-deletion receipts record that a bulk delete of
`future/` was reverted **twice**, and that every file in it turned out to hold
unique knowledge not duplicated anywhere else at sufficient depth.

So the rule here is: **archived, not deleted.** These files are out of the
active doc set — nothing is expected to keep them current, and a count or an
endpoint quoted inside them is almost certainly wrong. Do not cite them as
evidence about how the system works today. Re-derive from live code.

## What is here, and why it left

### `OFFLINE_SYNC_ARCHITECTURE.md` (archived 2026-08-24)

Described an IndexedDB offline queue, a Capacitor APK, and an
`x-offline-replay` backend path, storing into `cleaning_cycles` and
`filter_events`. None of it exists: `ls apps/` shows only `api` and `web`,
there is no Capacitor build, and the filter domain was stripped 2026-08-20.

Read for unique knowledge before archiving: it is descriptive rather than
argued — 519 lines with two mentions of rationale — so it documents a removed
implementation, not a reusable design. Nothing was extracted.

### `PHASE_5_RECENT_WORK.md` (archived 2026-08-24)

A progress log for the filter / RFID / PM domain that no longer exists.

**Three things were extracted before it was archived**, each verified against
live code first:

| Knowledge | Now lives in | Status when checked |
|---|---|---|
| "Never reconstruct server-side decision logic in the client" | root `CLAUDE.md`, "Never" section | Principle holds; re-anchored to a live example (server-resolved instrument decimals and attribute access) because the original one was removed |
| The generic backup technique (`pg_tables` + `jsonb_populate_recordset`) | comment block in `apps/api/src/modules/backup/backup.repository.ts` | Confirmed still in use — and this was the only place explaining *why* |
| `requireAnyPermission` and keyed re-authentication | `apps/api/CLAUDE.md` | Confirmed live in `plugins/rbac.ts` and `lib/reauth-check.ts`, now used by admin-requests / backup / uploads |

**One claim was deliberately NOT rescued:** the document said backup restore
round-trips `password_hash`. That reversed on 2026-05-16 — `password_hash` is
stripped on export. A rescued claim is trusted *because* someone bothered to
save it, which makes rescuing a stale one worse than losing it.

### `API_REFERENCE-2026-08-24.md` (archived 2026-10-05)

The root `API_REFERENCE.md`, last edited 2026-08-24. Documented ten lines of
the removed filters module and none of the six instrument-era modules
(`alarms`, `floorplans`, `functional-locations`, `alarm-webhooks`,
`report-reviews`, ingest); its own drift banner quoted 23 modules, 42
permissions and 47 reauth actions against 25 / 44 / 50 on the day it was
archived (`ls apps/api/src/modules/ | wc -l`, the two `grep -cE` commands in
root `CLAUDE.md`). Read for unique knowledge first: the authentication,
users, roles, audit and config sections are prose restatements of the route
files, and the instrument section is a subset of root `CLAUDE.md` "Key API
Endpoints". Nothing was extracted. The root file is now a pointer to the live
Swagger UI and `docs/recreation/06-api/endpoints.md`.

### `scripts-nssm/` (archived 2026-10-05)

`install-services-phase5.ps1` and `uninstall-services-phase5.ps1` — the Phase 5
(2026-04) NSSM service registration for a worktree-scoped verification
deployment on `:3000` / `:5175`. The live installer path is
`scripts/register-services.ps1` (WinSW); nothing executes these two. Before
the move, `grep -rl install-services-phase5` found them named only in
`CHANGELOG.md`, `docs/archive/PHASE_5_RECENT_WORK.md`,
`docs/EXE_PACKAGING_FEASIBILITY.md`, `docs/recreation/02-inventory/README.md`,
`future/architectural-refactor-9-steps.md`, `tasks/DEAD-CODE-AUDIT-2026-07-04.md`,
`windowsIssues.md` and `.gitignore` — prose, no caller. Kept because they are
the only record of the NSSM-era service layout.

