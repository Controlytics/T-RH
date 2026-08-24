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
