# Sidebar RBAC — Phase 2 Implementation Plan (Close Security Gaps)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the genuine, safe-to-fix authorization gaps found in the analysis (`tasks/RBAC-SIDEBAR-REDESIGN-ANALYSIS.md` §3.1) — without removing any *legitimate* access.

**Architecture:** Add missing `requirePermission`/`requireAnyPermission` preHandlers to ungated endpoints; flip the config access-matrix from fail-OPEN to default-DENY while seeding explicit grants that preserve every role's *current* reach; add one defense-in-depth route guard. Uppercase `PERMISSIONS` stays the enforced vocabulary (Phase-1 decision).

**Tech Stack:** Fastify (apps/api), React Router (apps/web), vitest, Postgres. Local Windows dev — verify with `curl -sk` against `https://localhost:3000` (the project's established API-test method).

## Global Constraints

- **Phase 2 intentionally CHANGES behavior** (it removes *unauthorized* access). The hard rule: **never remove LEGITIMATE access.** Every task must preserve what authorized roles can reach today — especially Task 2.5 (access-matrix), which must seed current grants before flipping the default.
- **Do NOT touch these — they are intentionally public/self-scoped** (verified 2026-06-30): `GET /api/config/branding` (login theming, in `PUBLIC_GET_PATHS`), `GET /api/roles/active` (pre-auth contact-admin, in `PUBLIC_GET_PATHS`), `GET /api/config/tablet-access/my-features`, `GET /api/config/access-matrix/my-modules` (self-scoped, consumed at the login gate), and the Dashboard route `/` (all-authenticated landing + catch-all). Gating any of these breaks login or locks out minimal roles.
- **`/quality-notifications` is already enforced** server-side via `canSeeQnn` (403) — not a security gap; only an optional cosmetic FE guard (Task 2.7, low priority).
- **Export fail-open (`useExportOptions`) is a UI affordance, not a security control** — real export enforcement would require backend export endpoints, most of which don't exist (client-side PDF). Out of scope; documented only.
- Uppercase `PERMISSIONS` enforced vocabulary unchanged. Reauth axis unchanged. Rebuild `@digilog/shared` after any shared edit. git-bash heredoc for commits. One commit per task. Branch `RFID`.
- **Verification method:** for each gated endpoint, prove with `curl -sk` that an authorized token gets 2xx and an unauthorized token (a role lacking the perm) gets **403** — BEFORE and AFTER, so the change is demonstrated. The default login is `superadmin`/`Admin@123`; create or reuse a low-privilege test user (e.g. a VIEWER) for the negative case. Never PUT throwaway data to real config (memory: no test-writes to real config).

---

## File Structure

| File | Change |
|---|---|
| `apps/api/src/modules/report-reviews/routes.ts` | Add `requireAnyPermission` to the 3 GET endpoints (Task 2.1) |
| `apps/api/src/modules/notifications/routes.ts` | Add `requirePermission('NOTIFICATION_DELETE')` to single DELETE (Task 2.2) |
| `apps/web/src/main.tsx` | Wrap `/checklist/:entityId` route guard (Task 2.3) |
| (investigate) `POST /api/data/checklist` handler | Locate + gate or confirm gated (Task 2.4) |
| `apps/web/src/routes/config/index.tsx` + `apps/api/.../config/static-routes/access-matrix.routes.ts` + seed | Default-DENY + preserve current grants (Task 2.5) |
| `apps/api/src/modules/help/routes.ts` | Gate help GETs with `CONFIG_READ` (Task 2.6, low priority) |
| `apps/web/src/routes/filter-management/quality-notifications.tsx` (optional) | Cosmetic FE guard mirroring canSeeQnn (Task 2.7, optional) |
| Docs | CHANGELOG + analysis doc gap-status update (Task 2.8) |

---

## Task 2.1: Gate the Report Reviews GET endpoints (gap S4)

**Files:**
- Modify: `apps/api/src/modules/report-reviews/routes.ts` (the 3 GETs at ~L34, L42, L54)

**Context:** `GET /api/report-reviews/queue`, `GET /api/report-reviews`, and `GET /api/report-reviews/:id` currently have **no** permission preHandler — any authenticated user can read the review queue and report snapshots by URL. The page route guard already requires one of `[REPORT_REVIEW_SUBMIT, REPORT_REVIEW, REPORT_APPROVE]` (main.tsx:250), so gating the GETs with the SAME any-of set removes the gap with **zero** legitimate-access loss. The POST review/approve already require `REPORT_REVIEW`/`REPORT_APPROVE` — leave those unchanged.

- [ ] **Step 1: Baseline — prove the gap exists**

Start the API (`cd apps/api && npx tsx watch src/app.ts`). Log in as a low-privilege user lacking all report perms (e.g. VIEWER) and capture its token. Run:
`curl -sk -H "Authorization: Bearer <VIEWER_TOKEN>" https://localhost:3000/api/report-reviews/queue -o /dev/null -w "%{http_code}\n"`
Expected NOW: `200` (the gap — VIEWER can read the queue).

- [ ] **Step 2: Add the gate to all three GETs**

In `report-reviews/routes.ts`, add to each of the 3 GET route definitions a preHandler (matching the existing decorator style used elsewhere in the file):

```ts
preHandler: [app.requireAnyPermission('REPORT_REVIEW_SUBMIT', 'REPORT_REVIEW', 'REPORT_APPROVE')],
```

(If a GET already has a `preHandler` array, add the decorator to it; if it has none, add the array. Match the import/usage of `requireAnyPermission` already present in the codebase — e.g. cleaning-profiles/routes.ts uses `app.requireAnyPermission(...)`.)

- [ ] **Step 3: Verify the gap is closed + authorized access preserved**

Restart/reload the API. Re-run the VIEWER curl from Step 1 → Expected: `403`.
Then with a token for a role that HAS `REPORT_REVIEW` (e.g. SUPERVISOR per seed) → Expected: `200`:
`curl -sk -H "Authorization: Bearer <SUPERVISOR_TOKEN>" https://localhost:3000/api/report-reviews/queue -o /dev/null -w "%{http_code}\n"`
Also confirm the Report Reviews page still loads for SUPER_ADMIN/SUPERVISOR in the browser (no console errors, queue populates).

- [ ] **Step 4: Typecheck + commit**

Run: `npm run lint -w @digilog/api` (tsc --noEmit) → clean.
```bash
git add apps/api/src/modules/report-reviews/routes.ts
git commit -F - <<'EOF'
fix(rbac): gate Report Reviews GET endpoints (close S4)

The queue/list/detail GETs had no permission preHandler — any authenticated user
could read the review queue + report snapshots by URL. Gate all three with the same
any-of set the page route already requires (REPORT_REVIEW_SUBMIT | REPORT_REVIEW |
REPORT_APPROVE). No legitimate user loses access.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2.2: Gate Notifications single-delete (gap S5)

**Files:**
- Modify: `apps/api/src/modules/notifications/routes.ts` (DELETE `/:id` at ~L243)

**Context:** `DELETE /api/notifications/:id` has **no `requirePermission`** (only reauth `DELETE_NOTIFICATION`), while `POST /api/notifications/bulk-delete` requires `NOTIFICATION_DELETE` (~L152). Asymmetric: a user blocked from bulk-delete can still delete one-by-one. The frontend already restricts both delete buttons to SUPER_ADMIN. Add `requirePermission('NOTIFICATION_DELETE')` to the single delete to match bulk. **Do NOT** add permission gates to the read/mark-read endpoints — those are intentionally per-user-scoped (a user manages their own notifications) and gating them would break every user's notification panel.

- [ ] **Step 1: Baseline**

As a user with `NOTIFICATION_VIEW` but NOT `NOTIFICATION_DELETE` (most non-admin roles), find one of their notification ids and:
`curl -sk -X DELETE -H "Authorization: Bearer <TOKEN>" https://localhost:3000/api/notifications/<id> -o /dev/null -w "%{http_code}\n"`
Expected NOW: 2xx (or a reauth challenge), NOT 403 — the gap.

- [ ] **Step 2: Add the gate**

Add `app.requirePermission('NOTIFICATION_DELETE')` to the DELETE `/:id` preHandler (preserving its existing reauth `enforceReauth('DELETE_NOTIFICATION')` — both layers coexist; gate runs first via preHandler, reauth inside the handler).

- [ ] **Step 3: Verify**

Re-run Step 1 curl → Expected: `403`. With a `NOTIFICATION_DELETE` holder (SUPER_ADMIN) → delete still works (expect reauth challenge then success). Confirm a normal user's notification panel still loads and mark-read still works (those endpoints untouched).

- [ ] **Step 4: Typecheck + commit**

```bash
npm run lint -w @digilog/api
git add apps/api/src/modules/notifications/routes.ts
git commit -F - <<'EOF'
fix(rbac): require NOTIFICATION_DELETE on single notification delete (close S5)

Single DELETE /:id had only a reauth check, no permission gate, while bulk-delete
required NOTIFICATION_DELETE — a user blocked from bulk could still delete one-by-one.
Add the matching gate. Read/mark-read endpoints stay ungated (per-user scoped).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2.3: Add a route guard to `/checklist/:entityId` (gap S3, defense-in-depth)

**Files:**
- Modify: `apps/web/src/main.tsx` (the `/checklist/:entityId` route, ~L265)

**Context:** This standalone mobile checklist route sits OUTSIDE the `AppLayout` auth wrapper; auth is enforced inside the component (redirects to `/login` when `!user`) and all its APIs require a token — so it is NOT reachable unauthenticated. But it has no *permission* guard. Adding `<RequireRole permissions={[PERMISSIONS.CHECKLIST_SUBMIT]}>` is defense-in-depth and consistent with every other page. `CHECKLIST_SUBMIT` exists (`permissions.ts:56`) and is the semantically exact permission (the page submits checklists). **Verify first** that the roles meant to use the mobile checklist (OPERATOR/MAINTENANCE/SUPERVISOR per seed) all hold `CHECKLIST_SUBMIT` — they do per seed — so none lose access.

- [ ] **Step 1: Confirm seed roles that need it hold CHECKLIST_SUBMIT**

Check `apps/api/prisma/default-roles.ts`: OPERATOR, MAINTENANCE, SUPERVISOR include `'CHECKLIST_SUBMIT'`. (They do.) SUPER_ADMIN bypasses. So gating with CHECKLIST_SUBMIT locks out only roles that were never meant to operate checklists.

- [ ] **Step 2: Wrap the route**

The route currently renders the component directly (component handles its own redirect). Wrap it:

```tsx
<Route path="/checklist/:entityId" element={
  <RequireRole permissions={[PERMISSIONS.CHECKLIST_SUBMIT]}>
    <ChecklistFormPage />
  </RequireRole>
} />
```

(Use the actual component import name already used at that route. Keep it in the same routing block it currently lives in — do NOT move it under AppLayout, since it is intentionally a standalone no-sidebar layout. `RequireRole` only needs `useAuth`, which works outside AppLayout.)

- [ ] **Step 3: Verify**

`npx vite build` (apps/web) → clean. In the browser: as an OPERATOR, open `/checklist/<a real entity id>` → still renders. As a VIEWER (no CHECKLIST_SUBMIT) → "Access Denied" panel instead of the form. Confirm the unauth case still redirects to login (component logic intact).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/main.tsx
git commit -F - <<'EOF'
fix(rbac): add CHECKLIST_SUBMIT route guard to /checklist/:entityId (close S3)

Standalone mobile checklist route had no permission guard (auth was component-only).
Add RequireRole[CHECKLIST_SUBMIT] for defense-in-depth + consistency; all operating
roles (OPERATOR/MAINTENANCE/SUPERVISOR) already hold it, so none lose access.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2.4: Locate and gate `POST /api/data/checklist` (NEW finding)

**Files:**
- Investigate: `apps/api/src/` (the handler for `POST /api/data/checklist`)
- Modify: that handler's route (add a gate IF ungated)

**Context:** The Phase-2 investigation could NOT find the route handler for `POST /api/data/checklist` (the mobile checklist submit target, `checklist-form/index.tsx:189`). It is NOT in `PUBLIC_PATHS` (so it requires a token), but its *permission* gate is unconfirmed — a possible real under-gating of a CFR-relevant e-signature submission. This task RESOLVES it.

- [ ] **Step 1: Find the handler**

Search: `grep -rn "data/checklist\|'/checklist'\|\"/checklist\"" apps/api/src` and check how `/api/data/*` routes are registered (look for a `data` module or a prefix registration in `app.ts`). Identify the exact route definition and any existing preHandler.

- [ ] **Step 2: Decide + act based on what you find**

- If it already has `requirePermission`/`requireAnyPermission` (e.g. `CHECKLIST_SUBMIT` or `FILTER_OPERATE`): **no change** — document the finding in the report and skip to commit (docs only) or no-op.
- If it has NO permission gate: add `app.requireAnyPermission('CHECKLIST_SUBMIT', 'FILTER_OPERATE')` (mirroring the cycle-bound `POST /:id/submit-checklist` which uses `FILTER_OPERATE`, and the standalone checklist semantics which use `CHECKLIST_SUBMIT`). If the endpoint turns out to be dead (no live caller, superseded by `/:id/submit-checklist`), report that — do NOT gate dead code; flag for removal in a later cleanup.

- [ ] **Step 3: Verify (only if a gate was added)**

Curl the endpoint with a no-CHECKLIST_SUBMIT/no-FILTER_OPERATE token → 403; with an OPERATOR token → reaches the handler (2xx or validation error, not 403). Confirm the mobile checklist submit still works end-to-end in the browser for an OPERATOR.

- [ ] **Step 4: Commit (with findings)**

```bash
git add apps/api/src/<the-file>
git commit -F - <<'EOF'
fix(rbac): gate POST /api/data/checklist with CHECKLIST_SUBMIT|FILTER_OPERATE

<Adjust message to what you found: "was ungated, added gate" OR "confirmed already
gated, no change" OR "dead endpoint, flagged for removal">.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2.5: Config access-matrix — flip fail-OPEN → default-DENY, preserving current access (gap S1, the big one)

**Files:**
- Modify: `apps/web/src/routes/config/index.tsx` (`canAccessModule`, ~L282 — the `if (!assigned) return !EXPLICIT_GRANT_KEYS.has(moduleKey)` fail-open default)
- Modify/seed: the `access-matrix` SystemConfig (preserve current grants)

**Context:** `canAccessModule` returns **true** for any config module with no access-matrix entry (except `EXPLICIT_GRANT_KEYS`). This is fail-OPEN: a brand-new config card is visible to every role that reaches `/config`. The fix is default-DENY — but flipping it blind would hide the 4 general cards (password-policy, datetime, backup, user-id) from ADMIN (the only non-SUPER_ADMIN role that reaches `/config`, via CONFIG_READ). **So the flip MUST be paired with seeding explicit grants that reproduce current access.**

> **DECISION (recommended, confirm before implementing):** Preserve current effective access — seed the access-matrix so every role that can reach a card *today* keeps it, then default-deny only governs NEW/unconfigured modules going forward. This is zero-legitimate-access-loss. The alternative (hard default-deny with no seeding) would force an admin to manually re-grant the 4 general cards and risks locking ADMIN out of routine config. **Recommend the preserve approach.**

- [ ] **Step 1: Capture current access (the preservation baseline)**

Determine which roles reach `/config` at all (the Configuration sidebar item requires `config.view`/`config.edit` → CONFIG_READ/CONFIG_UPDATE → SUPER_ADMIN + ADMIN per seed). For each general `configCard` (password-policy, datetime, backup, user-id) and each currently-unconfigured module, record which roles `canAccessModule` returns true for TODAY (default-allow → all roles reaching /config, i.e. ADMIN; SUPER_ADMIN bypasses). Write this baseline to the task report. This is the set we must preserve.

- [ ] **Step 2: Write a failing test for default-deny semantics**

Add a unit test for `canAccessModule` logic (extract the predicate to a pure function if it isn't already — e.g. `canAccessModule(moduleKey, role, isSuperAdmin, accessMatrix, explicitGrantKeys)` — so it's testable without rendering). Test cases: (a) SUPER_ADMIN → always true; (b) module WITH a matrix entry listing the role → true; (c) module WITH an entry NOT listing the role → false; (d) module with NO entry → **false** (the new default-deny, was true). Run → the (d) case fails against current code.

- [ ] **Step 3: Flip the default + preserve**

Change the `canAccessModule` default branch from `return !EXPLICIT_GRANT_KEYS.has(moduleKey)` (allow-unless-fail-closed) to `return false` (deny-unless-granted). Then ensure current access is preserved: seed the `access-matrix` config so ADMIN is explicitly granted the modules it reaches today (the 4 general cards + any currently-visible module). Do this via the access-matrix config (the proper mechanism), NOT by special-casing in code. Provide the exact seed entries in the task report.

- [ ] **Step 4: Verify default-deny + no lockout**

Test passes. In the browser: SUPER_ADMIN sees all config cards (unchanged). ADMIN sees exactly what it saw before (the 4 general cards + previously-visible modules — no fewer). A NEW hypothetical unconfigured module is now hidden from ADMIN until granted (the fix). No role that had config access loses a card it had.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/config/index.tsx <test file> <seed/config changes>
git commit -F - <<'EOF'
fix(rbac): config access-matrix default-DENY, preserving current grants (close S1)

canAccessModule returned true for unconfigured modules (fail-OPEN) — new config
cards were visible to every role reaching /config. Flip to default-DENY and seed
explicit grants reproducing current ADMIN access, so no role loses a card it had
while future/unconfigured modules are hidden until explicitly granted.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2.6: Gate Help GET endpoints (gap S2-help, low priority)

**Files:**
- Modify: `apps/api/src/modules/help/routes.ts` (GET `/` ~L10, GET `/:key` ~L78)

**Context:** Help list/detail GETs allow any authenticated user; the only UI (`/config/help`) is SUPER_ADMIN-only. No pre-auth consumer. Gate reads with `CONFIG_READ` (conservative — ADMIN holds it; SUPER_ADMIN bypasses). Low urgency (already auth-required), but closes the read-exposure for consistency. **Verify no context-help/HelpButton component fetches these for non-admin users** before gating — the investigation found none, but re-confirm with a quick grep so you don't break an in-app help popup.

- [ ] **Step 1: Confirm no non-admin consumer**

`grep -rn "/api/help" apps/web/src` — confirm the only callers are within `routes/config/help.tsx` (SUPER_ADMIN page). If a HelpButton/context-help component calls it for general users, STOP and report — gating would break in-app help; in that case the correct gate is broader (authenticated-only, i.e. no change) and this task becomes a no-op.

- [ ] **Step 2: Gate the GETs**

If Step 1 confirms admin-only usage: add `app.requirePermission('CONFIG_READ')` to both GET routes.

- [ ] **Step 3: Verify + commit**

VIEWER token → 403; ADMIN/SUPER_ADMIN → 200; `/config/help` page still works. Commit with message `fix(rbac): gate Help GET reads with CONFIG_READ (close S2-help)`.

---

## Task 2.7: (OPTIONAL) Cosmetic FE guard on `/quality-notifications`

**Context:** Not a security gap (backend `canSeeQnn` already 403s + the page self-guards via `/qnn/visible`). Purely cosmetic consistency. **Recommend SKIP** unless you want the route to show "Access Denied" via `RequireRole` rather than the page's own not-allowed panel — but there is no `QNN_VIEW` permission, so a `RequireRole` would have to be role-based (`roles={[...]}`) and would DUPLICATE the config-driven `canSeeQnn` logic, risking drift. **Decision: leave as-is; the server gate is the real control.** Documented here so a future reviewer doesn't re-flag it.

- [ ] No action. (Recorded as a deliberate non-fix.)

---

## Task 2.8: Docs sync + analysis-doc gap status

**Files:**
- Modify: `CHANGELOG.md`, `tasks/RBAC-SIDEBAR-REDESIGN-ANALYSIS.md` (mark S1/S3/S4/S5 closed; note S2/S6/S7/S8 as intentional/non-gaps with the 2026-06-30 findings), `tasks/todo.md`

- [ ] **Step 1: Update CHANGELOG** with a Phase 2 entry summarizing the closed gaps (S1 default-deny+preserve, S4 report-reviews, S5 notifications single-delete, S3 checklist route guard, S2.4 data/checklist) and the explicitly-NOT-gaps (branding/roles-active/dashboard/qnn/tablet-self-scoped — intentional public/self-scoped).
- [ ] **Step 2: Update the analysis doc** §3.1 table: mark each S-item Closed / Intentional with a one-line note + the verifying evidence.
- [ ] **Step 3: `tasks/todo.md`** audit-log line. Commit `docs(rbac): record Phase 2 gap closures + intentional-public findings`.

---

## Self-Review

**Spec coverage (vs analysis §3.1):** S1 (Task 2.5), S4 (2.1), S5 (2.2), S3 (2.3 + new 2.4). S2/S6/S7 reclassified as intentional (not gaps) with verified evidence — documented, not "dropped." S8 documented as a UI affordance. S2-help is the one low-priority real read-exposure (2.6).

**Out of scope (correctly deferred):** FE/BE mismatches M1–M6 are Phase 3 (e.g. the `CONFIG_UPDATE`-vs-`ROLE_MANAGE` escalation on the role-config tabs, status-update/retire/replace/delete mismatches). Per-page View granularity is Phase 4. The new tree admin UI + `useCan()` are Phase 5.

**Risk notes:** Task 2.5 is the only one with real lockout risk — its preserve-current-grants step is mandatory and gated by a no-lockout verification. Tasks 2.1/2.2 are low-risk (gating with the same perm the page already requires). Task 2.4 may turn into a no-op or a removal-flag depending on what the handler search finds — the task handles all three outcomes. Every backend gate is proven with a before/after 403 curl, not assumed.

**Decisions needing confirmation before implementing:** (1) Task 2.5 preserve-vs-hard-deny approach (recommend preserve); (2) Task 2.4 action depends on the handler search (built into the task); (3) Task 2.6 low-priority — include or defer.
