# Phase 6 — API Analysis

**139 paths across 19 groups.** The complete path-by-path listing is generated
directly from the running server's OpenAPI document:
**[`endpoints.md`](endpoints.md)**.

```bash
curl -sk https://localhost:3001/docs/json | jq '.paths | length'   # → 139
```

This page documents the **conventions** every endpoint follows, which is what a
rebuild actually needs — the path list is mechanical.

---

## 1. Surface shape

| Group | Paths | Group | Paths |
|---|---|---|---|
| `config` | 35 | `notification-rules` | 5 |
| `notification-settings` | 14 | `debug` | 5 |
| `users` | 12 | `user-groups` | 4 |
| `notifications` | 9 | `help` | 4 |
| `dashboards` | 9 | `admin-requests` | 4 |
| `auth` | 9 | `ldap` | 3 |
| `super-admin` | 7 | `backup` | 3 |
| `audit` | 7 | `uploads` | 1 |
| `roles` | 6 | `system-health` | 1 |
| | | `health` (root) | 1 |

**Configuration is a quarter of the API.** That is the defining characteristic
of this system: it is built to be reconfigured by administrators at a regulated
site, without a redeploy.

## 2. Middleware pipeline (every request)

```
@fastify/helmet     → security headers + HSTS
@fastify/cors       → origin allow-list (ALLOWED_ORIGINS; required in prod)
@fastify/rate-limit → 5000 requests / minute, global
authPlugin          → JWT verify → attach user + permissions (30s cache)
rbacPlugin          → provides requirePermission / requireAnyPermission /
                      requireSuperAdmin decorators
route preHandler    → the authority check          §11.10(g)
enforceReauth       → step-up password check       §11.200
schema validation   → Fastify JSON Schema / Zod
sanitize.ts         → HTML-strip all text input
handler → service → Prisma
writeAudit()        → same transaction             §11.10(e)
```

Registration order is in `apps/api/src/app.ts`. **A rebuild must preserve this
order**; in particular, authorisation before validation before sanitisation
before persistence before audit-in-transaction.

## 3. Authentication

- **Bearer JWT** in `Authorization`. Issued by `POST /api/auth/login`.
- Token lives in the browser's `sessionStorage` (deliberate — shared workstations).
- **30-minute refresh cycle** via `POST /api/auth/refresh`.
- **Refresh is blocked for `forcePasswordChange` users** → `403 FORCE_PASSWORD_CHANGE`.
- `GET /api/auth/me` returns the user plus their effective permissions; the
  frontend caches it for resilience.

### Public / unauthenticated endpoints
- `GET /health` — liveness (returns even without auth, so TLS can be probed)
- `GET /api/config/password-policy/current` — the client must render policy
  hints on the change-password screen before a session exists
- `GET /api/roles/active` — populates the public Contact Admin form
- `POST /api/auth/login`

Everything else requires a valid JWT.

## 4. Authorisation

Two decorators from `plugins/rbac.ts`:

```ts
app.requirePermission('CONFIG_UPDATE')            // single permission
app.requireAnyPermission('AUDIT_READ', 'AUDIT_EXPORT')  // OR semantics
```

Observed usage frequency (`grep -rho ... | sort | uniq -c`):

| Permission | Route usages |
|---|---|
| `CONFIG_UPDATE` | 31 |
| `CONFIG_READ` | 27 |
| `ROLE_MANAGE` | 9 |
| `DASHBOARD_MANAGE` | 6 |
| `USER_RESET_PASSWORD` | 4 |
| `USER_CREATE` | 4 |
| `READ_DEBUG_TRACE` | 4 |
| `USER_READ` | 3 |
| `DASHBOARD_VIEW` | 3 |
| `requireAnyPermission(...)` | 3 |

**SUPER_ADMIN bypasses** these checks — but its actions are still audited
identically. Bypass is not exemption from the record.

## 5. Re-authentication (§11.200)

`enforceReauth(action)` appears in **19 module route files**. When a step-up is
required and not satisfied, the API responds `401 REAUTH_REQUIRED`; the client
opens the re-auth dialog and retries with the credential.

- **10-second in-memory cache** so multi-step operations do not re-prompt.
- **Which actions require re-auth is configurable** (`action-reauth` surface),
  not hardcoded — sites tune their own signature policy.
- 39 actions across 7 categories.

## 6. Request/response conventions

**Validation.** Fastify JSON Schema on route definitions; Zod schemas from
`packages/shared/src/schemas/` for shared payload shapes. Responses are
schema-serialised, which also acts as an output allow-list.

**Errors.** Centralised via `lib/errors.ts` (`AppError`) and `lib/error-schemas.ts`
(`errorResponses`), so every route documents the same error envelope. Notable
codes: `REAUTH_REQUIRED` (401), `FORCE_PASSWORD_CHANGE` (403),
`UNSUPPORTED_MEDIA_TYPE` (415), and `409 CONFLICT` for the concurrent-session case.

**Pagination.** `?page=&limit=` with `{data, total}`-shaped responses on list
endpoints. Default page size comes from the `pagination` config surface, so it
is site-tunable.

**Secrets.** `lib/mask-secrets.ts` redacts sensitive config values on read —
SMTP passwords and similar never round-trip to a client.

**Config surface pattern.** Most config groups expose a matched pair:
`GET/PUT /api/config/<key>` (the editable record, permission-gated) and
`GET /api/config/<key>/current` (the *effective* resolved value, more widely
readable). A rebuild should keep this split — it is what lets low-privilege
clients render correctly without seeing the editable record.

**Dynamic config.** `/api/config/dynamic/:key` serves definitions that opt into
the generic renderer instead of a bespoke page (e.g. `export-limit`).

**Rate limiting is two-tier.** The global budget is deliberately loose
(5000/min) because a single active client fires bursts of SWR fetches; an
earlier 500/min ceiling returned 429s that the client read as "offline" and
retried, producing a self-reinforcing storm. Brute-force protection is instead
applied **per route** on the auth surface:

| Route | Limit |
|---|---|
| `POST /api/auth/login` | 10 / minute |
| `POST /api/auth/refresh` | 30 / minute |
| `POST /api/auth/change-password` | 5 / minute |
| `POST /api/auth/verify` (re-auth) | 5 / minute |
| `POST /api/auth/forgot-password` | 3 / **15 minutes** |

A rebuild must keep this shape: loose global, tight on credentials. A single
global limit cannot serve both purposes.

## 7. Documented behaviours worth preserving

- **`409` on concurrent login** rather than silently killing the old session —
  the user is shown the existing session's IP and login time and must confirm.
- **Bulk operations return partial success** with per-item results rather than
  failing the whole batch.
- **Audit endpoints are asymmetric by design**: read/export are ordinary
  permissions; `redact` is chain-preserving; `delete` is off by default and
  breaks the chain loudly (see [`../05-database/audit-chain.md`](../05-database/audit-chain.md)).

## 8. Known gaps a rebuild should close

1. **`NOTIFICATION_VIEW` / `NOTIFICATION_MANAGE` are enforced by no route.**
   They are visibility-only toggles (honestly tagged `enforce: 'c'`). Either
   enforce them or remove them.
2. **`GET /api/roles/access-matrix` is authenticated but not `ROLE_MANAGE`-gated**
   — intentional, to power the Module Guide for all users. Worth re-confirming
   it exposes nothing a viewer could not already infer.
3. **Debug traces are success-only.** They read from `audit_trail`, so there are
   no error codes or durations. Either build real tracing or rename the feature
   to reflect what it is.
4. **Dead CORS entry.** `capacitor://localhost` remains in the allow-list with
   no Capacitor client. Remove it.
