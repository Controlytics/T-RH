# `old/` — superseded material. NOT current. Do not cite as evidence.

**Added 2026-08-29** by the technical audit
(`docs/audit/2026-08-29-technical-audit.md`), which found 160 files and 5.7 MB
here with **no code reference and no marker saying what any of it was**. That
absence was the actual problem: a folder of confident-sounding architecture and
API docs, sitting one level below the repository root, with nothing telling a
reader it describes software that no longer exists.

## What is in here

| Path | What it is |
|---|---|
| `docs-superseded/` | Upstream DigiLog documentation — `ARCHITECTURE.md`, `API_GUIDE.md`, `DATA_INGESTION_REQUIREMENTS_v3.md`, `offline-sync-design.md`, `LDAP_INTEGRATION_GUIDE.md`, and others. Most describe the filter/cleanroom/RFID/offline domain removed in the 2026-07-18 Phase 0 strip. |
| `docs-superseded/removed-user-guides/` | End-user guides for those removed features. |
| `docs-superseded/superpowers-{plans,specs}/` | Design notes for work that shipped, was reverted, or was abandoned. |
| `reports-specs/` | Specs for the reports generate/sign module, torn out 2026-07-04. |
| `screenshots/`, `playwright-artifacts/` | Captures from old test runs. Bulk of the 5.7 MB. |
| `*.sql` | Three one-shot maintenance scripts (`backfill-orphan-entity-orgs.sql`, `remove-rulechain-alarm-runtime-cleanup.sql`, `reset-cwh-cycles.sql`). All reference tables that no longer exist — `Organization` went with multi-tenancy on 2026-04-30, `RuleChain` on 2026-05-17, `cleaning_cycles` with the filter domain. Running any of them today would error. |

## Why it was not deleted

`docs/CONTRIBUTING.md` records that a bulk delete of `future/` was **reverted
twice**. This directory is tracked in git, so its history survives a delete —
but the same was true both times `future/` came back, which suggests the cost
of losing it was judged higher than the cost of keeping it.

Deleting it is a one-line change (`git rm -r old/`) and nothing in the build,
the tests or the application references it. That call belongs to whoever owns
the repository, not to an audit. This README exists so that until someone makes
it, nobody mistakes any of this for current.

## The rule

Nothing in this directory is evidence about today's system. If something here
disagrees with the code, the code is right. For a current picture see
`docs/recreation/` (the verified inventory) and
`docs/audit/2026-08-29-technical-audit.md`.
