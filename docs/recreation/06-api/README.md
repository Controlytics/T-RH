# Phase 6 — API Analysis

**153 paths across 23 groups**, verified 2026-08-01 (was 139 across 19 groups
on 2026-07-25 — the +14 is the Data Injection P1 modules, §9). The complete
path-by-path listing referenced below (**[`endpoints.md`](endpoints.md)**)
was generated against the pre-P1 server and **has not been regenerated in
this pass** — it is out of scope for this doc-sync task (only the 5
`docs/recreation` READMEs + CHANGELOG). Treat `endpoints.md` as stale for the
4 new module groups until it is regenerated from a live `/docs/json` pull.

```bash
curl -sk https://localhost:3001/docs/json | jq '.paths | length'   # → 153 (2026-08-01; was 139)
```

This page documents the **conventions** every endpoint follows, which is what a
rebuild actually needs — the path list is mechanical.

---

## 1. Surface shape

| Group | Paths | Group | Paths |
|---|---|---|---|
| `config` | 36 (was 35; +1 for `uns-settings`, P1) | `notification-rules` | 5 |
| `notification-settings` | 14 | `debug` | 5 |
| `users` | 12 | `user-groups` | 4 |
| `notifications` | 9 | `help` | 4 |
| `dashboards` | 9 | `admin-requests` | 4 |
| `auth` | 9 | `ldap` | 3 |
| `super-admin` | 7 | `backup` | 3 |
| `audit` | 7 | `uploads` | 1 |
| `roles` | 6 | `system-health` | 1 |
| | | `health` (root) | 1 |
| `instruments` **(P1)** | 4 | `hierarchy` **(P1)** | 3 |
| `gateways` **(P1)** | 3 | `communication-profiles` **(P1)** | 3 |

**Configuration is a quarter of the API.** That is the defining characteristic
of this system: it is built to be reconfigured by administrators at a regulated
site, without a redeploy. The 4 new P1 groups (§9) add 13 paths on top of
that — source-derived from route registrations, not yet cross-checked
against `endpoints.md` (which predates P1; see the note above).

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
- 51 actions across 8 categories (was 39 / 7 before P1; see
  [`../04-roles-permissions/README.md`](../04-roles-permissions/README.md) §10).

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
5. **`endpoints.md` predates P1** (§9) — regenerate it from a live
   `/docs/json` pull before relying on it for the 4 new module groups.

## 9. Data Injection (P1) — 4 new module groups, landed 2026-08-01

Registered in `apps/api/src/app.ts` under `/api/communication-profiles`,
`/api/hierarchy`, `/api/gateways`, `/api/instruments`. All four follow every
convention in §2–§6 unchanged — same middleware pipeline, same
`requirePermission`/`enforceReauth`/`writeAudit`-in-transaction shape as the
pre-P1 modules. Nothing new was introduced at the framework level; this
section records what's specific to the new surface.

**Route inventory** (13 unique OpenAPI paths, 21 route registrations —
GET/POST share `/`, so path count is lower than registration count):

| Module | Routes |
|---|---|
| `hierarchy` | `GET /`, `POST /`, `PUT /:id`, `POST /:id/move`, `DELETE /:id` |
| `gateways` | `GET /`, `GET /:id/instruments`, `POST /`, `PUT /:id`, `DELETE /:id` |
| `instruments` | `GET /`, `GET /:id/topics`, `POST /`, `PUT /:id`, `PUT /:id/topics/:category`, `DELETE /:id` |
| `communication-profiles` | `GET /protocols`, `GET /`, `POST /`, `PUT /:id`, `DELETE /:id` |

**Secret masking on `CommunicationProfile.config`.** The module's own
`maskForResponse`/`maskForAudit` wrap the shared `lib/mask-secrets.ts` with
two explicit allowlists (response-safe keys vs. audit-safe keys), rather than
the module inventing its own redaction. `maskSecrets` **fails closed** — an
unrecognised key is redacted by default until a human explicitly adds it to
an allowlist — so a new connection-config field added later (a new protocol's
credential shape) is redacted automatically rather than silently leaking.
Masked config is what lands in both the API response *and* the audit diff —
a raw secret never reaches an audit row, because audit rows are permanent
and effectively unredactable in practice.

**`GET /api/instruments/:id/topics`** is the resolved-topics endpoint —
it runs `resolveTopics()` (pure function, no DB write) over the instrument's
hierarchy ancestry, gateway slug, and `uns-settings` config, merged with any
persisted `InstrumentTopic` overrides, and returns the effective topic string
per `TopicCategory`. `PUT /api/instruments/:id/topics/:category` is the only
way to set/clear an override; there is no bulk-override endpoint.

**Audit actions (12 new):** `HIERARCHY_NODE_{CREATED,UPDATED,MOVED,DELETED}`,
`GATEWAY_{CREATED,UPDATED,DELETED}`, `INSTRUMENT_{CREATED,UPDATED,DELETED}`,
`INSTRUMENT_TOPIC_OVERRIDE_{SET,CLEARED}`, plus 3 more for communication
profiles (`COMMUNICATION_PROFILE_{CREATED,UPDATED,DELETED}`) — 15 total new
`AUDIT_ACTIONS` entries across the 4 modules. Every mutating route in all
four modules calls `writeAudit()` in the same transaction as the write,
matching the §2 pipeline. **Telemetry is deliberately not audited** — see
[`../05-database/README.md`](../05-database/README.md) §11.9 for why (there
is none yet to audit; the boundary decision is for when an adapter lands).

**No protocol adapter exists.** These 4 modules are pure CRUD over
configuration rows — hierarchy nodes, gateway/instrument records, connection
profiles, and derived/overridden topic strings. None of them open a network
connection, poll a device, or subscribe to a broker. `GET
/api/communication-profiles/protocols` lists the 18 seeded `Protocol` rows
(all `is_enabled: false`) for the frontend picker; nothing consumes that flag
to actually connect.
