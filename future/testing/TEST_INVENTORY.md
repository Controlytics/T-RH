# Test Inventory

Every automated test file in the repo, grouped by surface. Verified by `find apps packages -name "*.test.ts"` on 2026-04-20.

## Backend e2e (`apps/api/src/e2e/`) — 15 suites

Boot Fastify + hit a real DB. Point `DATABASE_URL` at a test DB before running. *(The `TSDB_*` requirement was dropped 2026-06-17 with the TimescaleDB tear-out.)*

| Suite | Covers |
|---|---|
| `audit.test.ts` | List, read, delete, bulk-delete, hash-chain integrity |
| `auth.test.ts` | Login / logout / refresh / reauth / forgot-password |
| `checklist-submission.test.ts` | Answer-format data assertions (pure data, no HTTP). *(Originally hit `POST /api/data/checklist`, removed 2026-06-17; the HTTP portions were dropped and live cleaning-checklist flow now lives in `phase2-filter-operations.test.ts` / `ahu-completion-gate.e2e.test.ts`.)* |
| `checklist-templates.test.ts` | Checklist profile CRUD + questions |
| `config.test.ts` | Each config surface read/write, partial updates |
| ~~`connectivity.test.ts`~~ | *removed 2026-06-17 with the connectivity module tear-out* |
| `entities.test.ts` | Templates, instances, relationships, identifiers |
| `health.test.ts` | `/api/health` |
| `help-articles.test.ts` | CRUD + versioning |
| `notifications.test.ts` | Inbox CRUD + bulk |
| `qr-codes.test.ts` | Generation + lookup |
| `roles.test.ts` | Role CRUD + creatable matrix |
| ~~`rule-chains.test.ts`~~ | *removed 2026-05-17 with the rule-chain tear-out* |
| `system-health.test.ts` | Aggregate health + per-service probes |
| `users.test.ts` | User CRUD + lockout + password reset |

## Backend library unit tests (`apps/api/src/lib/`) — 9 files

| File | Subject |
|---|---|
| `audit.test.ts` | Audit helper |
| `build-context.test.ts` | Request-context builder |
| `error-schemas.test.ts` | Fastify error schemas |
| `errors.test.ts` | `AppError` class |
| `hash-chain.test.ts` | 21 CFR hash chain |
| `jwt.test.ts` | JWT sign/verify |
| `password.test.ts` | Hash/verify |
| `reauth-check.test.ts` | Reauth gate |
| `user-id-validator.test.ts` | Dynamic user-ID validator |

## Backend module unit tests (`apps/api/src/modules/**/__tests__/`)

### Assets module — 10 files
- `helpers/__tests__/attribute-validator.test.ts`, `cycle-detection.test.ts`, `descendant-collector.test.ts`
- `repositories/__tests__/identifier.repository.test.ts`, `instance.repository.test.ts`, `relationship.repository.test.ts`, `template.repository.test.ts`
- `services/__tests__/identifier.service.test.ts`, `instance.service.test.ts`, `relationship.service.test.ts`, `template.service.test.ts`

### Auth module — 2 files
- `auth.repository.test.ts`, `auth.service.test.ts`

### Backup module — 3 files
- `backup.helpers.test.ts`, `backup.repository.test.ts`, `backup.service.test.ts`

### Config module — 2 files
- `config.repository.test.ts`, `config.service.test.ts`

### ~~Data-ingestion module — 11 files~~ *(REMOVED 2026-06-17 with the data-ingestion tear-out)*

### Notifications — 2 files
- `notification.repository.test.ts`, `notification.service.test.ts`

### Roles — 2 files
- `role.repository.test.ts`, `role.service.test.ts`

### ~~Rule chain — 4 files~~ *(REMOVED 2026-05-17 with the rule-chain tear-out)*

### ~~UNS — 2 files~~ *(REMOVED 2026-06-17 with the UNS tear-out)*

### Users — 2 files
- `user.repository.test.ts`, `user.service.test.ts`

### Plugins — 3 files
- `audit-logger.plugin.test.ts`, `auth.plugin.test.ts`, `rbac.plugin.test.ts`

### ~~Transport — 4 files~~ *(REMOVED 2026-06-17 — MQTT client/handler/auth + WS handler tests torn out with the data-ingestion tear-out)*

### ~~Workers — 2 files~~ *(REMOVED 2026-06-17 — `ingestion.worker` + `maintenance.worker` deleted with the data-ingestion tear-out)*

## Shared package (`packages/shared/src/**`)

- `schemas/assets.test.ts`
- `schemas/auth.test.ts`
- `schemas/config.test.ts`
- `schemas/users.test.ts`
- `types/audit-templates.test.ts`

## ~~DB package (`packages/db/src/__tests__/`)~~ *(REMOVED 2026-06-17 — the `packages/db/` workspace was deleted with the TimescaleDB tear-out)*

- ~~`telemetry-batcher.test.ts`~~

## Shell e2e scripts (`tests/e2e-scripts/`)

- `e2e-full-test.sh` — full-flow happy path
- `e2e-functional-test.sh` — functional coverage
- ~~`e2e-ingest.sh` — ingestion pipeline smoke~~ *(obsolete — the ingestion pipeline was removed 2026-06-17)*
- `e2e-live-test.sh` — live-system smoke (run against a deployed instance)

## Manual test cases (`tests/manual-test-cases/`) — 25 files

TC-01 through TC-25, one per module: authentication, user-mgmt, roles, entity templates, entity instances, relationships, identifiers, configuration, audit-trail, notifications, ~~data-ingestion, rule-chains, UNS, telemetry-queries, alarms, export, retention, connectivity~~ *(these 8 removed 2026-05-17..2026-06-17 with the rule-chain + data-ingestion tear-outs)*, QR-codes, help-articles, debug-traces, backup-restore, session-mgmt, uploads, 21-CFR-compliance.

## Execution guides (`tests/test-execution-guides/`) — 25 files

EG-01 through EG-25 pair 1:1 with the TC numbering above. These are the step-by-step scripts QA runs for each manual test case. See `tests/test-execution-guides/README.md` for sign-off conventions.

## Gaps (flagged for PRs)

- **No frontend unit or component tests.** Any React change is verified by manual QA + Playwright traces (archived in `old/playwright-artifacts/`).
- **No automated test for the offline sync engine.** Phase 3 gap.
- ~~**No load / concurrency tests for MQTT ingestion.**~~ *(N/A — MQTT ingestion was removed 2026-06-17.)*
- **Phase 3/4 modules** (cleaning-profiles, filter-operations, pm-schedules, report-templates, reports, admin-requests, block-change-requests, equipment-groups, tenant-admin, super-admin, notification-delivery, notification-rules, ~~connectivity~~ *(removed 2026-06-17)*, dashboards, ~~queries~~ *(removed 2026-06-17)*, org-admin, entity-assignments, LDAP, filter-profiles, checklist-profiles, deployment-check) — **no dedicated module unit tests yet.** Coverage is currently via the general e2e suites and manual TCs.
