# Phase 2 — Project Inventory

*Every count below is followed by the command that produced it, run 2026-07-25.*

---

## 1. Repository structure

```
compliance-core/
├── apps/
│   ├── api/                  Fastify 5 backend (TypeScript, ESM)
│   │   ├── prisma/           schema.prisma, migrations/, seed.ts, default-roles.ts
│   │   └── src/
│   │       ├── app.ts        composition root — plugin + route registration
│   │       ├── modules/      18 feature modules (routes/service/schema per module)
│   │       ├── lib/          22 cross-cutting libraries (audit, jwt, hash-chain…)
│   │       ├── plugins/      auth.ts, rbac.ts (Fastify plugins)
│   │       ├── workers/      3 graphile-worker task handlers
│   │       └── e2e/          end-to-end test suites
│   └── web/                  React 19 + Vite 6 SPA
│       └── src/
│           ├── main.tsx      router — 38 <Route> definitions
│           ├── routes/       11 route groups
│           ├── components/   layout, UI primitives, dialogs
│           ├── hooks/        17 custom hooks
│           └── lib/          20 client libraries
├── packages/
│   ├── shared/               Zod schemas + PERMISSION_TREE (source of truth)
│   └── queue/                graphile-worker wrapper
├── scripts/                  16 PowerShell install/ops scripts
├── certs/                    mkcert TLS certs for local HTTPS
└── docs/recreation/          ← this dossier
```

**No `apps/android`, no `rfid_scan_app`, no `packages/db`.** See
[`absent-subsystems.md`](absent-subsystems.md).

```bash
ls apps/        # → api web
ls packages/    # → queue shared
```

## 2. Headline counts (verified)

| Metric | Count | Command |
|---|---|---|
| API modules | **18** | `ls apps/api/src/modules/ \| wc -l` |
| API paths (OpenAPI) | **139** | `curl -sk https://localhost:3001/docs/json \| jq '.paths \| length'` |
| Prisma models | **23** | `grep -cE '^model ' apps/api/prisma/schema.prisma` |
| Prisma enums | **6** | `grep -cE '^enum ' apps/api/prisma/schema.prisma` |
| DB triggers | **1** | `pg_trigger` where not internal |
| DB custom functions | **1** | `block_audit_trail_delete` (rest are pgcrypto) |
| DB views | **0** | — |
| DB sequences | **1** | `audit_trail_chain_position_seq` |
| Frontend routes | **38** | `grep -cE '<Route' apps/web/src/main.tsx` |
| Frontend route groups | **11** | `ls apps/web/src/routes/` |
| Config pages | **21** | `ls apps/web/src/routes/config/*.tsx` |
| Config definitions | **21** | `ls apps/api/src/modules/config/defs/*.def.ts` |
| Custom hooks | **17** | `ls apps/web/src/hooks/` |
| Client libs | **20** | `ls apps/web/src/lib/*.ts` |
| API libs | **22** | `ls apps/api/src/lib/` (excl. tests) |
| Permission constants | **30** | `grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts` |
| Reauth actions | **39** | `grep -cE '^\s+[A-Z_]+:' packages/shared/src/types/reauth-actions.ts` |
| Feature privileges | **26** | derived from `PERMISSION_TREE`; locked by snapshot test |
| Sidebar permission groups | **8** | `PERMISSION_TREE` groups |
| Sidebar items (configurable) | **9** | `sidebar-items.ts` |
| Roles (seeded) | **6** | `select count(*) from roles` |
| Background job tasks | **3** | `notification`, `password_expiry_check`, `session_sweep` |
| Color themes | **10** | `apps/web/src/lib/themes.ts` |

## 3. The 18 API modules

| Module | Paths | Responsibility |
|---|---|---|
| `config` | 35 | 21 config surfaces + dynamic config registry |
| `notification-delivery` | 14 | templates, logs, email/SMS delivery settings |
| `users` | 12 | user CRUD, lock/unlock, password reset, stats |
| `notifications` | 9 | per-user notification inbox |
| `dashboards` | 9 | dashboard definitions, widgets, assignment |
| `auth` | 9 | login, logout, refresh, me, change-password |
| `super-admin` | 7 | API lock, data console, unretire |
| `audit` | 7 | query, export, verify-chain, redact, delete |
| `roles` | 6 | role CRUD, access matrix, active roles |
| `notification-rules` | 5 | event → recipient rules |
| `debug-traces` | 5 | audit-backed pipeline trace viewer |
| `user-groups` | 4 | group CRUD + membership |
| `help` | 4 | help articles + versioning |
| `admin-requests` | 4 | request → approve/reject workflow |
| `ldap` | 3 | optional directory integration |
| `backup` | 3 | export / restore / schedule |
| `uploads` | 1 | file upload (multipart) |
| `system-health` | 1 | health metrics |
| *(root)* `health` | 1 | liveness probe |

```bash
sed 's|^/api/||' be.txt | cut -d/ -f1 | sort | uniq -c | sort -rn
```

## 4. Cross-cutting libraries (`apps/api/src/lib/`)

Grouped by concern — these are the pieces a rebuild must reproduce faithfully:

**Compliance-critical**
- `audit.ts` — the audit writer; appends hash-chained rows
- `hash-chain.ts` — V1/V2 unkeyed SHA-256, V3 keyed HMAC-SHA256
- `audit-verify.ts` — chain-walk verification
- `audit-diff.ts` — before/after value diffing for audit detail
- `reauth-check.ts` — re-authentication enforcement (10s cache)

**Identity**
- `jwt.ts`, `password.ts`, `password-validator.ts`, `password-expiry.ts`,
  `user-id-validator.ts`, `super-admin-lock.ts`

**Infrastructure**
- `prisma.ts`, `config-discovery.ts`, `config-registry.ts`, `errors.ts`,
  `error-schemas.ts`, `build-context.ts`, `swagger.ts`, `uploads-dir.ts`,
  `format-datetime.ts`

**Security**
- `sanitize.ts` — HTML stripping on all text input
- `mask-secrets.ts` — redacts secrets from config responses/logs

## 5. Frontend structure

**Route groups** (`apps/web/src/routes/`): `admin-requests`, `audit`, `auth`,
`config`, `dashboard.tsx`, `debug`, `home`, `notifications`, `profile`,
`system-health`, `users`.

**Hooks** (17): `use-auth`, `use-branding`, `use-can`, `use-datetime-format`,
`use-drag-scroll`, `use-export-limit`, `use-export-options`, `use-field-labels`,
`use-pagination-config`, `use-reauth`, `use-report-labels`,
`use-report-page-titles`, `use-role-colors`, `use-session`, `use-single-tab`,
`use-super-admin-lock`, `use-toast`.

**Client libs** (20): `api-base`, `api-client`, `cn`, `datetime-input`,
`excel-export`, `export-surfaces`, `format-by-least-count`, `password-utils`,
`pdf-report`, `report-export-log`, `report-labels`, `report-review`,
`report-types`, `resolve-bulk-targets`, `server-contact`, `swr-config`,
`theme-styles`, `themes`, `timing-constants`, `url-utils`.

## 6. The 21 configuration definitions

Auto-discovered at boot by `lib/config-discovery.ts` and registered into
`lib/config-registry.ts`. Boot log confirms: `[config-registry] 21 modules registered`.

`access-matrix`, `action-reauth`, `audit-templates`, `backup`, `branding`,
`datetime`, `export-limit`, `export-options`, `field-ids`, `help`,
`login-security`, `notification-email`, `notification-logs`,
`notification-rules`, `notification-sms`, `pagination`, `password-policy`,
`report-page-titles`, `roles`, `session`, `user-id`.

**Adding a config def touches multiple files** — the def, the discovery import,
the config index card, and (unless it uses the dynamic renderer) a page. The
`export-limit` def is the reference example of the *dynamic* path: it renders
through `dynamic-config.tsx` with no bespoke page.

## 7. Background jobs

graphile-worker, backed by the same PostgreSQL database (no Redis). Boot log:
`Worker connected and looking for jobs... (task names: 'notification',
'password_expiry_check', 'session_sweep')`.

| Task | Handler | Purpose |
|---|---|---|
| `notification` | `workers/notification.worker.ts` | dispatch queued notifications |
| `password_expiry_check` | `workers/password-expiry.worker.ts` | flag/notify expiring passwords |
| `session_sweep` | `workers/session-sweep.worker.ts` | expire idle sessions |

## 8. Environment & configuration

`apps/api/.env` (gitignored). Keys that matter:

| Variable | Purpose | Note |
|---|---|---|
| `DATABASE_URL` | Postgres connection | |
| `PORT` | listen port | **`API_PORT` in .env is dead** — `app.ts:397` reads `PORT` |
| `API_HTTPS` | enable TLS | `true` locally; certs from `certs/` |
| `AUDIT_CHAIN_KEY` | HMAC key for v3 audit checksums | **must live outside the DB** |
| `INITIAL_ADMIN_PASSWORD` | seed admin password | seed **throws** if unset — deliberate |
| `ALLOWED_ORIGINS` | CORS allow-list | required in production |
| `JWT_SECRET` | token signing | |

`apps/web/.env.production` is tracked **blank** and marked `skip-worktree` on
purpose, so no developer's IP address enters the repository.

## 9. Deployment assets

`scripts/` (PowerShell, Windows): `install.ps1`, `uninstall.ps1`, `upgrade.ps1`,
`provision-db.ps1`, `apply-schema.ps1`, `backup-db.ps1`,
`register-backup-task.ps1`, `register-services.ps1`, `unregister-services.ps1`,
`install-services-phase5.ps1`, `uninstall-services-phase5.ps1`,
`stage-runtime.ps1`, `build-bundle.ps1`, `build-installer.ps1`,
`verify-migrations.ps1`, `verify-windows-deployment.ps1`.

`verify-migrations.ps1` is the **drift guard** — it builds a scratch database
from migrations and asserts it diffs empty against the dev database. It must
pass before any schema change is committed.

## 10. What is absent

See [`absent-subsystems.md`](absent-subsystems.md) for the full evidence table.
