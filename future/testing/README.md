# Testing — Quick Tour

This project has four distinct test surfaces. Know which one to touch before you write the first line.

| Surface | Location | Tool | Purpose |
|---|---|---|---|
| Backend unit | `apps/api/src/lib/*.test.ts`, `apps/api/src/modules/**/__tests__/*.test.ts` | Vitest | Pure-function + repository tests |
| Backend integration / e2e | `apps/api/src/e2e/*.test.ts` | Vitest + real DB | Per-module end-to-end API flows (15 suites; Phase 1 coverage only) |
| Shared schema tests | `packages/shared/src/**/*.test.ts` | Vitest | Validation of Zod schemas + constants |
| ~~db package tests~~ | ~~`packages/db/src/__tests__/*.test.ts`~~ | — | *(REMOVED 2026-06-17 — the `packages/db/` workspace was deleted with the TimescaleDB tear-out)* |
| Shell e2e scripts | `tests/e2e-scripts/*.sh` | bash + curl | Cross-system smoke (full-test, functional, ingest, live) |
| Manual QA — golden paths | `future/testing/MANUAL_TEST_GUIDE.md` | Humans | 12 step-by-step golden-path scripts |

> **Phase 2/3/4/5 manual test cases were deleted in the 2026-04-29 cleanup** (`tests/manual-test-cases/` had only Phase 1 coverage). Need fresh cases for filter operations, RFID, offline replay, reports, block-change approval, PM My Tasks, admin requests. The closest current automated coverage is `apps/api/src/e2e/` (also Phase 1).

## How to run

```bash
# all unit + e2e (backend + shared) via turbo
npm test

# just the fast unit subset
npm run test:unit

# backend only
cd apps/api && npm test

# backend e2e only
cd apps/api && vitest run --testPathPattern=e2e

# shared schemas only
cd packages/shared && npx vitest run

# e2e shell scripts (requires API running)
cd tests/e2e-scripts && bash e2e-functional-test.sh
```

Vitest is configured via `vitest.workspace.ts` at the repo root — the workspace includes `apps/api/vitest.config.ts` and `packages/shared/vitest.config.ts`. Adding a new app to the test matrix means registering it in `vitest.workspace.ts` too.

## File counts (2026-04-29, verified by find/grep)

- 9 backend lib unit tests under `apps/api/src/lib/__tests__/` (audit, build-context, error-schemas, errors, hash-chain, jwt, password, reauth-check, user-id-validator)
- e2e test suites in `apps/api/src/e2e/` (audit, auth, checklist-submission, checklist-templates, config, entities, health, help-articles, notifications, qr-codes, roles, system-health, users) — *the `connectivity` and `rule-chains` suites were removed with their subsystems (rule-chains 2026-05-17; connectivity 2026-06-17)*
- ~7 schema test suites under `packages/shared/src/` (assets, auth, config, users, audit-templates, + more)
- ~~1 repository test in `packages/db` (telemetry-batcher)~~ *(removed 2026-06-17 — the `packages/db/` workspace was deleted with the TimescaleDB tear-out)*
- Shell e2e scripts under `tests/e2e-scripts/`
- 12 golden-path scenarios in `future/testing/MANUAL_TEST_GUIDE.md`

## What's NOT tested automatically

Known gaps — flag in PRs:

- **Phase 2/3/4/5 e2e tests are missing.** Existing 15 e2e suites cover only Phase 1. Filter operations, RFID, offline replay, reports, block-change approval, PM My Tasks, admin-requests have NO automated coverage.
- The frontend has **no component tests** or browser E2E tests in CI. QA is manual via `MANUAL_TEST_GUIDE.md` + Playwright traces (archived in `old/playwright-artifacts/`).
- The offline sync engine has no automated integration test.
- RFID native apps (`rfid_scan_app/` standalone + `apps/android/.../RfidPlugin.java` bundled in DigiLog APK) are manually tested on hardware.
- ~~No load / stress tests for MQTT ingestion.~~ *(N/A — MQTT ingestion was removed 2026-06-17.)*

## What the e2e tests cover

Located at `apps/api/src/e2e/`. Each one boots Fastify + hits a live DB (you need `DATABASE_URL` pointing at a test instance — **do not** run these against production DBs). *(The `TSDB_*` requirement was dropped 2026-06-17 with the TimescaleDB tear-out.)*

| File | Covers |
|---|---|
| `auth.test.ts` | Login, logout, refresh, reauth, forgot-password |
| `users.test.ts` | CRUD + lockout + reset-requests |
| `roles.test.ts` | Role CRUD + permission inheritance |
| `config.test.ts` | Each config surface read/write + validation |
| `audit.test.ts` | Hash-chain integrity, bulk delete |
| `entities.test.ts` | Templates + instances + relationships + identifiers |
| `checklist-templates.test.ts` + `checklist-submission.test.ts` | Profile CRUD + end-to-end submission |
| ~~`connectivity.test.ts`~~ | *removed 2026-06-17 with the connectivity tear-out* |
| `help-articles.test.ts` | Versioned help articles |
| `notifications.test.ts` | Inbox + bulk actions |
| `qr-codes.test.ts` | Generation + lookup |
| ~~`rule-chains.test.ts`~~ | *removed 2026-05-17 with the rule-chain tear-out* |
| `system-health.test.ts` / `health.test.ts` | Aggregate + per-service probes |

## Where to read next

- `TEST_INVENTORY.md` — complete table of test files and what they assert.
- `MANUAL_TEST_GUIDE.md` — golden-path scenarios for QA (login, cleaning cycle, offline replay, RFID scan, PM approval).
