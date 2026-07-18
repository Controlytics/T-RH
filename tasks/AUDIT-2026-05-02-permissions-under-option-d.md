# Audit: Permission & Reauth Interaction with Shared Executor (Option D)

## Executive Summary

Option D (Phase 8.5) introduces a pure-function shared executor (`packages/shared/src/pipeline-executor/`) that is called from both server and client. The permission and reauth systems remain **server-only** by design — the shared executor carries only the user's cached permissions in `LocalContext.user.permissions`, which the FE can use for UI preview gating. The server is always the final authority on write permission, reauth requirement, and session validity.

---

## 1. Permission/Role Guards on the 4 Write Methods (Server-Side)

All 4 cycle operations have **route-level permission middleware** that fires **before** the service method:

| Write Method | Route | Permission Required | Reauth Action |
|---|---|---|---|
| `startCycle()` | `POST /:id/start-cycle` | `FILTER_OPERATE` | `START_CLEANING_CYCLE` |
| `advance()` | `POST /:id/advance` | `FILTER_OPERATE` | None (not gated) |
| `submitChecklist()` | `POST /:id/submit-checklist` | `FILTER_OPERATE` | `SUBMIT_CHECKLIST_WITH_SIGNATURE` |
| `bypass()` | `POST /:id/bypass` | `FILTER_BYPASS` | `BYPASS_FILTER_STAGE` |
| `terminateCycle()` | `POST /:id/terminate-cycle` | `FILTER_BYPASS` | `TERMINATE_CLEANING_CYCLE` |

**Implementation:** Routes use `app.requirePermission(...)` preHandler from `filter-operations/routes.ts` (lines 138, 181, 238, 294, 433). The `requirePermission` decorator is a Fastify plugin that reads `req.user.permissions` (extracted from JWT) and throws a 403 if the permission is missing.

**Key Detail:** Permission checks happen **before** the service method is invoked. The service (`filter-operations.service.ts`) performs no additional permission re-checks — it assumes the preHandler has already validated.

---

## 2. Reauth Flows Triggered by Cycle Ops (Server-Side)

Three of the four write methods trigger re-authentication:

1. **startCycle → START_CLEANING_CYCLE** (route line 171)
2. **submitChecklist → SUBMIT_CHECKLIST_WITH_SIGNATURE** (route line 286)
3. **bypass → BYPASS_FILTER_STAGE** (route line 334)
4. **terminateCycle → TERMINATE_CLEANING_CYCLE** (route line 471)

**Reauth Implementation** (`lib/reauth-check.ts`):
- Config read from `SystemConfig.configKey='action-reauth'` (Zod shape: `ActionReauthConfig`)
- Config structure: `{ [actionId]: string[] }` — array of role IDs that require reauth for that action
- 10-second in-memory cache to avoid DB hit on every mutation
- Password extracted from request body (`_currentPassword` field) or header (`x-reauth-password`)
- Validated against user's `passwordHash` via bcrypt `verifyPassword()`
- **Offline requests bypass reauth** (line 49: `x-offline-replay: 'true'` header skips check)

**Reauth Actions Enum** (`packages/shared/src/types/reauth-actions.ts` — 81 total):
- START_CLEANING_CYCLE / SUBMIT_CHECKLIST_WITH_SIGNATURE / BYPASS_FILTER_STAGE / TERMINATE_CLEANING_CYCLE
- Plus 77 other actions across 16 categories

---

## 3. Frontend Permission Preview (Cached Permissions)

**FE Permission Cache Path:**
1. Login response (`auth/login`) returns user object with `permissions?: string[]`
2. `useAuth()` hook fetches `/api/auth/me` and caches to `localStorage.digilog_cached_user`
3. `LocalContext.user.permissions` on the client is this cached array

**FE Uses Permissions For:**
- `<RequireRole permissions={[PERMISSIONS.FILTER_OPERATE]}>` wrapper hides/shows entire pages
- Action tape renderer (`ActionRenderer.tsx`) receives `disabled` prop (which the parent can derive from permissions)
- Caller (filter-operations page) decides button visibility

No explicit permission guard in current action-button code — pattern is **implicit disable** based on the action tape itself not emitting disabled actions. Phase 8.5 will add explicit permission predicates to the shared executor.

---

## 4. Drift Risk: Stale Permissions & Server Rejection

### Scenario: User Demoted While Logged In

1. Admin demotes user from `FILTER_OPERATE` to read-only via Role Privileges config
2. User's JWT and cached permissions are NOT invalidated — they remain in sessionStorage + localStorage
3. FE renders actions as enabled (using stale cached permissions)
4. User clicks Advance
5. Server rejects with 403 (route-level `requirePermission` check fails)

### Worst Case
- User completes a checklist dialog or enters instrument readings, then submits
- Server returns 403 before the service method runs
- All user input is lost (no optimistic apply; dialog/form state is discarded on error)

### When Does the Server Reject?
- **Immediately** — before the shared executor's pure guards run
- `requirePermission` preHandler checks `req.user.permissions` from the JWT
- JWT comes from the database (`User.roles → Role.permissions`) on refresh or re-login
- If user hasn't logged out, the JWT is **never re-fetched** unless they hit the 30-minute auto-refresh or manual logout

### Why No Automatic Invalidation?
- Single-tab enforcement (`digilog_tab_id`) checks one tab; doesn't update cached user across tabs
- JWT refresh runs every 30 min but doesn't refetch user profile
- Only `/api/auth/me` refetch (gated by `getToken()`) would catch the demotion via SWR's 30s polling

---

## 5. Recommended Rules for Safe FE Permission Preview

**Phase 8.5 Commit 1 (Option D pilot):**

1. **FE button disable logic should NOT rely on cached permissions alone**
   - Instead: button is disabled if action is not in current `actionTape.actions[]`
   - Server's `getCurrentState()` (line 110, routes.ts) computes the tape and returns only permitted actions
   - **Primary guard:** tape-based, not permission-based

2. **Permission cache is advisory only (soft UX gating)**
   - Use for: pre-hiding entire pages (`<RequireRole>`) so users don't see filter-ops if no cycle perms
   - NOT for: deciding which buttons to disable on an open page

3. **Server-side permission re-check before service method invocation** (already done)
   - Prehandler does it; service should NOT re-check

4. **For sensitive ops (BYPASS, TERMINATE), require reauth**
   - Reauth token is single-request only (not stored)
   - Demoted-user-with-correct-password still hits 403 from preHandler

5. **Display estimated action availability with caveat**
   - "Advance available if you have FILTER_OPERATE" — but tap shows "Permission required" if demoted

**Phase 8.5+ (after shared executor adoption):**

6. **Shared executor hosts FE-only permission preview predicates**
   - New module: `packages/shared/src/pipeline-executor/permission-predicates.ts`
   - Pure functions: `canAdvance(ctx)`, `canBypass(ctx)` reading `ctx.user.permissions`
   - FE calls before rendering buttons: `disabled={!canBypass(localContext)}`
   - Server does NOT call them; server only emits the tape

7. **Permission freshness field**
   - `/api/auth/me` returns `permissionsCheckedAt: number`
   - FE compares to current time; if stale > 5 min, show advisory warning
   - On logout or route change, clear cache

---

## 6. Summary: What Moves to Shared, What Stays Server-Only

| Check | Moves to Shared? | Rationale |
|---|---|---|
| Permission predicate (`canBypass()`, `canAdvance()`) | YES — Phase 8.5+ | Pure, deterministic, FE preview |
| Permission enforcement (403 on missing perm) | NO | Server-only; relies on JWT |
| Reauth requirement (action gated?) | NO | Config in DB; server-side cache |
| Reauth token validation (password check) | NO | Cryptographic; bcrypt |
| Session expiry (JWT still valid?) | NO | Server-only; token TTL |
| Stage reachability | YES — Phase 8.5 | Pure; transitions.ts |
| Checklist completion gate | YES — Phase 8.5 | Pure; transitions.ts |

---

## Conclusion

The shared executor is safe for guards that are purely deterministic and don't depend on server-only secrets or mutable config. Permission predicates are a good fit — they read cached user permissions from `LocalContext` and return true/false, no side effects.

The server remains the final authority on: write permission, reauth, session, and revocation. The FE permission cache is for UX smoothness only; stale cache triggers a 403, not a breach.

To eliminate drift risk entirely: implement the Phase 8.5+ "permission freshness" and "estimated action availability" recommendations above.
