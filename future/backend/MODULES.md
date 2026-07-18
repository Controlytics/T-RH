# Backend Modules

All modules live under `apps/api/src/modules/<name>/`. Each module typically contains a `routes.ts` (Fastify plugin factory), one or more `*.service.ts` files (business logic), and schemas. Some modules split routes across multiple files (`events-routes.ts`, `execution-routes.ts`, `dynamic-routes.ts`, `org-detail-routes.ts`, per-resource routes under `routes/` for the assets module).

Endpoint counts below come from `grep 'app.(get|post|put|patch|delete)'` on 2026-04-20.

---

## Identity & access

| Module | Endpoints | What it does |
|---|---|---|
| `auth` | 9 | Login / logout / refresh / beacon-logout / me / profile / change-password / verify (reauth) / forgot-password |
| `users` | 14 | Full user CRUD, enable/disable/unlock, password reset, reset-request queue |
| `user-groups` | 7 | Group CRUD + member add/remove |
| `roles` | 8 | Role CRUD, `/active` public read, `/permissions/all`, creatable-role matrix |
| `ldap` | 4 | Config get/put, test-connection, status |
| `admin-requests` | 5 | Create + list + pending-count + user-lookup + `POST /:id/process` executes the action |
| `block-change-requests` | 5 | Cross-block approval workflow; pending-count, approve/reject |

## Audit + system

| Module | Endpoints | What it does |
|---|---|---|
| `audit` | 4 | List, read, delete, bulk-delete audit rows (hash-chain-backed) |
| `system-health` | 1 | Aggregated health summary |
| `deployment-check` | 1 | Smoke endpoint — verifies module wiring; used by CI |
| `backup` | 3 | `/export` (dynamic, all 64 tables), `/restore`, `/validate` |

## Config + governance

| Module | Endpoints | What it does |
|---|---|---|
| `config` (static routes) | 40 | Typed config endpoints (password-policy, report-settings, pagination, user-id, branding, roles, field-ids, action-reauth, audit-templates, tablet-access, access-matrix, cleaning-profile-assignment, dashboard-cards, datetime, my-config) *(alarm-columns removed 2026-05-17 with the rule-chain/alarm tear-out)* |
| `config` (dynamic routes) | 3 | `/registry/manifest` + per-module-key `GET|PUT /dynamic/:moduleKey` — driven by `config-discovery.ts` |

## IoT platform *(REMOVED — see notes below)*

> The IoT ingestion layer was torn out in two waves: **rule-chain 2026-05-17** and **data-ingestion / uns / connectivity / queries / retention 2026-06-11..2026-06-17 (Phase 7)**. TimescaleDB + MQTT went with it. Only the `debug-traces` inspector survives, repurposed onto `audit_trail`.

| Module | Endpoints | What it does |
|---|---|---|
| ~~`data-ingestion`~~ | — | *removed 2026-06-17* |
| `debug-traces` | 4 | **SURVIVES** — repurposed 2026-06-12 onto `audit_trail` (was `data-ingestion/debug-trace`); `/api/debug/traces` renders each audited action as a single-stage trace |
| ~~`rule-chain`~~ | — | *removed 2026-05-17* |
| ~~`queries/telemetry`~~ | — | *removed 2026-06-17* |
| ~~`queries/export`~~ | — | *removed 2026-06-17* |
| ~~`queries/alarm`~~ | — | *removed 2026-05-17 (alarm subsystem) / 2026-06-17 (queries module)* |
| ~~`queries/retention`~~ | — | *removed 2026-06-17* |
| ~~`uns`~~ | — | *removed 2026-06-17* |
| ~~`connectivity`~~ | — | *removed 2026-06-17* |
| `qr-code` | 1 | QR generation |
| `notifications` | 9 | Inbox list, counts, mark-read (single + bulk), delete |
| `notification-delivery` | 18 | Email + SMS channel config, OAuth2 flows, templates, logs, send endpoint |
| `notification-rules` | 8 | Event-driven rules with toggle + test |
| `dashboards` | 13 | Dashboard CRUD + widget CRUD + layout + assignment + data adapter + widget catalog |
| `uploads` | 1 | `POST /photo` (photo upload) |
| `help` | 6 | Help articles with key lookup, versioning |

## Digital FMS (Filter Management)

| Module | Endpoints | What it does |
|---|---|---|
| `assets/templates` | 6 | Template CRUD + versions |
| `assets/instances` | 10 | Instance CRUD + tree + bulk-upload-filters + status + lifecycle-state + children |
| `assets/relationships` | 3 | Relationship CRUD |
| `assets/identifiers` | 4 | Identifier list/lookup/create/delete (one-per-entity enforced in service) |
| `cleaning-profiles` | 9 | Pipeline profile CRUD + toggle + assign-assets + `POST /:id/validate` |
| `checklist-profiles` | 9 | Template + questions (add/edit/delete) + reorder |
| `filter-profiles` | 6 | Filter→profile assignment |
| `filter-operations` | 11 | State machine: current-state, batch-states, start-cycle, advance, submit-checklist, bypass, retire, replace, terminate-cycle, retirements, replacements |
| `filter-operations/events-routes` | 5 | Events, cycles, cycle detail, dashboard-stats, reasons |
| `pm-schedules` | 16 | Template.csv, upload, AHU configs, entries (approve/reject/resubmit/edit), due, per-entity, history, CRUD |
| `pm-schedules/execution-routes` | 2 | Create + update PM executions |
| `equipment-groups` | 6 | Group CRUD + by-block |
| `report-templates` | 9 | Template CRUD + toggle + versions + duplicate |
| `reports` | 8 | Generate, list, get, PDF, preview, delete, sign (e-sig), reject |

## Multi-tenant + org

| Module | Endpoints | What it does |
|---|---|---|
| `tenant-admin` | 6 | Org CRUD + info |
| `tenant-admin/org-detail-routes` | 15 | Per-org: users, entities, templates, user-entity assignments, visible-entities |
| `super-admin` | 35 | Orgs CRUD + stats + filter-data admin (retirements, replacements) + data management console (cleaning-cycles, filter-events, audit-trail, alarms, notifications, admin-requests, block-change-requests, pm-entries — each with list/edit/delete) |
| `org-admin` | 3 | Read-only org-scoped views of users, entities, info |
| `entity-assignments` | 6 | User↔entity assignment CRUD + bulk + `/my-entities` |

---

## Module conventions

- **Route factory signature:** `export async function xRoutes(app: FastifyInstance) { ... }`
- **Schema discipline:** almost every route declares a Fastify schema with `body`, `params`, `querystring`, `response`. Fastify **strips** any response field not in the schema — if data "disappears," check the schema.
- **Audit:** mutations that affect business data are logged via `auditLoggerPlugin` + the `lib/audit.ts` helper (hash-chained).
- **Permissions:** protected routes use `preHandler` from `rbacPlugin` with a permission constant from `@digilog/shared`.
- **Config modules:** a new config surface needs updates to **12 touchpoints** — see `CLAUDE.md`'s "Config sync rule" memory reference. The short list: `config-discovery.ts` import, `config/index.tsx` card, sidebar (both files), permissions, privileges, reauth, seed, auth plugin, shared rebuild.
- **Offline replay:** mutation endpoints accept an `x-offline-replay: true` header and an `offlinePerformedAt` timestamp in the body when invoked by the sync engine. Validation remains server-side.

## Services and repositories

Most modules place DB access in a `*.service.ts`. The `assets` module goes further and has dedicated `repositories/` + `helpers/` with their own unit tests in `__tests__/` folders (attribute-validator, cycle-detection, descendant-collector, identifier/instance/relationship repositories).
