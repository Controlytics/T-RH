# Backend — Quick Tour

**Location:** `apps/api/`
**Tech:** Fastify 5.2 + TypeScript (ESM, `"type": "module"`), Prisma 6.3 (PostgreSQL 18 — single `digilog_db`, vanilla; TimescaleDB dropped 2026-06-11), graphile-worker on Postgres for the job queue (Phase 2 of windows-friendly-rewrite swapped from BullMQ + ioredis; commit `7832af1`), `jose` 6 for JWT, `ldapts` 8.1 for LDAP. **No MQTT broker** (Mosquitto/EMQX removed 2026-06-17), **no Redis** (removed 2026-05-01; pub/sub is in-process), and **no server-side PDF engine** — the `puppeteer-core` + Edge + `@napi-rs/canvas` reports stack was removed 2026-07-04; PDF export is now client-side (`apps/web` `lib/pdf-report.ts`, jsPDF).
**Entry:** `apps/api/src/app.ts`
**Dev:** `cd apps/api && npm run dev` → `tsx watch src/app.ts`
**Build + run (prod-style local):** `npm run build` (tsc) → `node dist/app.js`. PM2 / EC2 are no longer in scope (removed in commit `251be95`).

## Directory map

```
apps/api/src/
├── app.ts                  Fastify bootstrap, plugin order, route registration
├── lib/                    Cross-cutting utilities (JWT, hash-chain, password, sanitize, errors, swagger, config-discovery, prisma, reauth-check, etc.)
├── plugins/                Fastify plugins (audit-logger, auth, rbac)
├── modules/                Feature modules (see MODULES.md)
├── transport/              (REMOVED 2026-06-17 — MQTT client/handler + WS handler + MQTT auth routes torn out with the data-ingestion tear-out)
├── workers/                graphile-worker tasks (notification, pm_overdue_check, session_sweep; the ingestion + maintenance workers were removed 2026-06-17)
├── e2e/                    Vitest integration tests hitting a real DB
└── types/                  Ambient typings
```

## Request lifecycle

1. **Top-level plugins** (order matters — see `app.ts` lines ~100–135):
   - CORS, Helmet, rate-limit (500 req/min), multipart, static, Swagger UI. *(the `websocket` plugin was removed 2026-07-03 with the pub/sub tear-out.)*
   - `auditLoggerPlugin` — logs mutation endpoints into the audit table.
   - `authPlugin` — `onRequest` hook that verifies the JWT (skipped for `PUBLIC_PATHS`), caches session config (1 min) and role scope (5 s). Populates `req.user` with a `JwtPayload`.
   - `rbacPlugin` — provides helpers for route-level permission checks.
2. **Route modules** registered under `/api/...` prefixes.
3. ~~**Device-token routes** (`/api/data/telemetry`, etc.)~~ *(removed 2026-06-17 with the data-ingestion tear-out).*
4. ~~**WebSocket** (`/api/ws`)~~ *(removed — the `@fastify/websocket` plugin + WS handler were torn out 2026-07-03 after the Redis pub/sub layer was retired 2026-05-01).*

## Public paths (no JWT)

Defined in `plugins/auth.ts`:

- Always public: `/api/auth/login`, `/api/auth/forgot-password`, `/api/auth/beacon-logout`, `/api/health`, `/api/notification-settings/email/oauth2/code`. *(`/api/internal/mqtt`, `/api/ws`, and `/api/data/*` (device token) were removed 2026-06-17..2026-07-03 with the MQTT/WebSocket/data-ingestion tear-out.)*
- Dev-only public: `/docs`, `/docs/` (Swagger UI — hidden in production).
- `GET`-only public: `/api/config/branding`, `/api/config/datetime/current`, `/uploads/photos/`, `/uploads/branding/`, `/api/roles/active`, `/api/admin-requests/user-lookup`.
- `/api/config/password-policy/current`, `/api/config/report-settings/current`, `/api/config/pagination/current` are marked public inside their own route definitions.

## Key plugins

| Plugin | File | Role |
|---|---|---|
| `authPlugin` | `plugins/auth.ts` | JWT verification + user injection, public-path bypass, session/role caches; maintains `PUBLIC_GET_PATHS` allowlist |
| `rbacPlugin` | `plugins/rbac.ts` | `requirePermission(perm)` (single perm) AND `requireAnyPermission(...perms)` (granular toggle fallback for `FCP_* OR CHECKLIST_*`, `ASSET_* OR EG_*`, etc.); `enforceReauth(action, req, reply)` accepts `string \| string[]` |
| `auditLoggerPlugin` | `plugins/audit-logger.ts` | Hooks into mutations and writes audit rows (SHA-256 hash-chained per-org); applies `audit-templates.ts` so UUIDs don't leak in the audit UI |

## Cross-cutting libs (`src/lib/`)

| File | Purpose |
|---|---|
| `prisma.ts` | Singleton `PrismaClient` |
| `jwt.ts` | Sign/verify JWTs via `jose` |
| `password.ts` + `password-validator.ts` | Hash/verify, policy enforcement |
| `hash-chain.ts` | 21 CFR audit integrity chain |
| `reauth-check.ts` | Re-authentication gate for sensitive actions |
| `sanitize.ts` | Strips HTML from text fields (uses `sanitize-html`) |
| `config-discovery.ts` + `config-registry.ts` | Auto-register config modules that expose `moduleKey` + Zod schema |
| `swagger.ts` | Registers `@fastify/swagger` + `@fastify/swagger-ui` (UI at `/docs`) |
| `errors.ts` + `error-schemas.ts` | `AppError` class + Fastify error schema helpers |
| `build-context.ts`, `org-scope.ts`, `user-id-validator.ts`, `audit.ts` | Context helpers reused across modules *(`uns-path.ts` removed 2026-06-17 with the UNS/data-ingestion tear-out)* |
| `idempotency.ts` | Offline-replay dedup via `x-client-op-id` header — checks `FilterEvent.attributes.clientOpId` for match; returns cached `current-state` on duplicate, so retries never produce duplicate cycles, double advances, or repeat checklist submissions |

## Workers (`src/workers/`)

*(The `ingestion.worker.ts` + `maintenance.worker.ts` below were removed 2026-06-17 with the data-ingestion tear-out. The live worker tasks are `notification`, `pm_overdue_check`, and `session_sweep`.)*

- ~~**`ingestion.worker.ts`**~~ — *removed 2026-06-17 (consumed the `ingestion` task, pushed telemetry to TimescaleDB via `@digilog/db` — all gone).*
- ~~**`maintenance.worker.ts`**~~ — *removed 2026-06-17 (retention cleanup gone; PM-due computation now runs as the `pm_overdue_check` graphile-worker task).*

## ~~Transport (`src/transport/`)~~ *(REMOVED 2026-06-17)*

The entire transport layer was torn out with the data-ingestion tear-out — no MQTT broker (Mosquitto/EMQX) and no WebSocket handler remain.

- ~~`mqtt-client.ts`~~ — *removed (connected the API to Mosquitto 2.0).*
- ~~`mqtt-handler.ts`~~ — *removed (routed inbound device messages into the ingestion pipeline).*
- ~~`mosquitto-acl-generator.ts` + `mosquitto-refresh-routes.ts`~~ — *removed (translated `DeviceCredential` rows into Mosquitto dynamic-security JSON).*
- ~~`mqtt-auth-routes.ts`~~ — *removed (legacy EMQX webhook endpoints).*
- ~~`ws-handler.ts`~~ — *removed (WebSocket multiplex; Redis pub/sub fan-out retired 2026-05-01).*

## Env vars (see `.env.example`)

| Group | Keys |
|---|---|
| App DB (Prisma) | `DATABASE_URL` |
| ~~TimescaleDB~~ | *removed 2026-06-17 — `TSDB_*` gone with the TimescaleDB drop* |
| ~~MQTT / Mosquitto~~ | *removed 2026-06-17 — `MQTT_*` / `MOSQUITTO_*` / `EMQX_*` gone with the MQTT broker tear-out* |
| ~~Redis~~ | *removed 2026-05-01 — `REDIS_*` gone; queue on Postgres, pub/sub in-process* |
| SMTP | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` |
| ~~UNS~~ | *removed 2026-06-17 — `UNS_ROOT_PREFIX` / `UNS_VERSION` gone with the UNS tear-out* |
| JWT | `JWT_SECRET`, `VERIFICATION_TOKEN_SECRET`, `JWT_EXPIRES_IN` |
| Server | `NODE_ENV`, `API_PORT`, `PORT` (read by `app.ts`), `API_HTTPS` (if `true`, loads `certs/server.{key,crt}`) |
| CORS | `CORS_ORIGIN`, `ALLOWED_ORIGINS` |
| Uploads | `UPLOAD_DIR`, `MAX_FILE_SIZE` |

## Build + run cheatsheet (local Windows)

```bash
# local dev (auto-reload)
cd apps/api && npm run dev

# prod-style local build
npx tsc -p apps/api/tsconfig.json   # outputs to apps/api/dist/
node apps/api/dist/app.js

# run tests
cd apps/api && npm test                          # all unit + e2e
cd apps/api && vitest run --testPathPattern=e2e  # e2e only

# build the customer installer (Inno Setup 6 on a build machine)
powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1   # → DigiLog-Setup-<ver>.exe
# (old package-for-production.ps1 / install-on-target.ps1 removed 2026-07-04)
```

## Where to read next

- **`MODULES.md`** — every feature module, one paragraph each, with grep-grounded endpoint counts.
- **`API_ENDPOINTS.md`** — full endpoint list with HTTP verb, auth, and notes.
- **`ENV_SETUP.md`** — local dev setup steps (Windows-only — no EC2).
