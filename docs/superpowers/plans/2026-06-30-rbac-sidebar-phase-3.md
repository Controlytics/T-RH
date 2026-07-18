# Sidebar RBAC — Phase 3 Implementation Plan (Fix FE/BE Mismatches)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Eliminate the FE/BE authorization mismatches (analysis `tasks/RBAC-SIDEBAR-REDESIGN-ANALYSIS.md` §3.2, M1–M6) where a hidden button is still reachable via direct API, or a weaker/wrong permission governs an action.

**Architecture:** Align each action's backend gate to the intended permission. Guiding principle (confirmed with the user 2026-06-30): **the more-restrictive intent wins** — tighten the backend to match the stricter UI, closing the API bypass; never loosen the UI. Uppercase `PERMISSIONS` stays the enforced vocabulary.

**Tech Stack:** Fastify (apps/api), vitest, Postgres. Local Windows dev.

## Global Constraints

- **Direction = tighten backend** (user decision 2026-06-30): for delete actions the UI restricts to SUPER_ADMIN, make the API SUPER_ADMIN too. For M1/M2, enforce the *specific* intended permission (the one the UI already gates on), dropping the broader fallback that created the bypass.
- **No legitimate UI access may break.** Verify per task that the roles which currently SEE the button (per seed: SUPER_ADMIN always; ADMIN holds the granular perms) retain access. SUPER_ADMIN bypasses every gate. Tightening only removes **API-only** access from roles that never had the button (e.g. MAINTENANCE/OPERATOR via FILTER_OPERATE, or ADMIN via direct delete API) — that is the intended fix, not a regression.
- **Vestigial-permission honesty:** after tightening deletes to SUPER_ADMIN, `USER_DELETE` / `PM_DELETE` / `NOTIFICATION_DELETE` no longer gate anything (SUPER_ADMIN bypasses regardless). Remove them from ADMIN's seed array so the role catalog tells the truth (Task 3.7). Live-DB impact is nil — the perms are no-ops once the gates are SUPER_ADMIN-only.
- **CFR invariant:** after any seed/role change, `apps/api/src/__tests__/role-effective-permissions.test.ts` must still pass (every role perm valid + tree/legacy maps agree).
- **Runtime verification owed:** these are behavior-affecting. Prove each with `curl -sk` — a holder of the OLD-but-now-insufficient permission (e.g. an ADMIN for deletes, a MAINTENANCE for status/retire) gets **403**, and a SUPER_ADMIN still succeeds. The controller may lack low-priv creds + the dev server may be live (test logins disrupt it); if so, hand the user the curl checklist rather than fabricating results.
- Rebuild `@digilog/shared` after shared edits. git-bash heredoc commits. One commit per task. Branch `RFID`.

---

## File Structure

| File | Task | Change |
|---|---|---|
| `apps/api/src/modules/config/static-routes/roles.routes.ts` | 3.1 | 2 PUTs: `CONFIG_UPDATE` → `ROLE_MANAGE` |
| `apps/api/src/modules/config/static-routes/action-reauth.routes.ts` | 3.1 | PUT: `CONFIG_UPDATE` → `ROLE_MANAGE` |
| `apps/web/src/routes/config/role-access.tsx` (+ roles-components tabs) | 3.1 | gate the 3 tab Save buttons on ROLE_MANAGE (FE consistency) |
| `apps/api/src/modules/assets/routes/instance.routes.ts` (PATCH `:id/lifecycle-state`) | 3.2 | `ASSET_UPDATE` → `FILTER_STATUS_UPDATE` |
| `apps/api/src/modules/filter-operations/routes.ts` (`/:id/retire`, `/:id/replace`) | 3.3 | drop `FILTER_OPERATE` from the any-of → require `FILTER_RETIRE` / `FILTER_REPLACE` |
| `apps/api/src/modules/users/routes.ts` (`DELETE /:id`, `POST /bulk-delete`) | 3.4 | `USER_DELETE` → `requireSuperAdmin()` |
| `apps/api/src/modules/pm-schedules/routes.ts` (`DELETE /:id`) | 3.5 | `PM_DELETE` → `requireSuperAdmin()` |
| `apps/api/src/modules/notifications/routes.ts` (`DELETE /:id`, `POST /bulk-delete`) | 3.6 | `NOTIFICATION_DELETE` → `requireSuperAdmin()` |
| `apps/api/prisma/default-roles.ts` | 3.7 | remove `USER_DELETE`/`PM_DELETE`/`NOTIFICATION_DELETE` from ADMIN |
| `CHANGELOG.md`, analysis §3.2, `tasks/todo.md` | 3.8 | docs sync + CFR re-verify |

> **Verify exact line numbers before editing** — the analysis cites them but they drift. Each task says how to locate its target.

---

## Task 3.1: M6 — close the role-config privilege escalation (require ROLE_MANAGE)

**Context:** The Roles & Access page's **Permissions**, **Sidebar**, and **Re-auth** tabs save via endpoints gated only on `CONFIG_UPDATE` (+ a reauth challenge), NOT `ROLE_MANAGE`. So a role holding `CONFIG_UPDATE` but not `ROLE_MANAGE` could edit per-role permissions, sidebar visibility, and the reauth policy — a privilege-escalation surface. (Per seed, only SUPER_ADMIN+ADMIN hold `CONFIG_UPDATE`, and both also hold `ROLE_MANAGE`, so there is no *current* exploit — but the gate is wrong in principle and a future custom role with `CONFIG_UPDATE` would inherit the hole.) These endpoints administer roles → they must require `ROLE_MANAGE`.

**Targets (confirmed):**
- `roles.routes.ts:61` — `PUT /api/config/roles/:name` (permissions + sidebar tabs) — `requirePermission('CONFIG_UPDATE')`
- `roles.routes.ts:134` — `PUT /api/config/users/:userId` (per-user sidebar override) — `requirePermission('CONFIG_UPDATE')`
- `action-reauth.routes.ts:27` — `PUT /api/config/action-reauth` (reauth tab) — `requirePermission('CONFIG_UPDATE')`

- [ ] **Step 1: Confirm no legit CONFIG_UPDATE-only consumer**

`grep -rn "/api/config/roles/\|/api/config/users/\|/api/config/action-reauth" apps/web/src` — confirm the only callers are the Roles & Access page (`role-access.tsx` + `roles-components/`). If any other page (held by a CONFIG_UPDATE-but-not-ROLE_MANAGE role) writes these, STOP and report. (Expected: only the SA/ROLE_MANAGE-gated Roles & Access page.)

- [ ] **Step 2: Swap the gate on all three endpoints**

Change each `preHandler: [app.requirePermission('CONFIG_UPDATE')]` → `preHandler: [app.requirePermission('ROLE_MANAGE')]`. Leave the reauth lines (`UPDATE_ROLE_CONFIG`/`UPDATE_USER_CONFIG`/`UPDATE_REAUTH_CONFIG`) unchanged — they are the orthogonal step-up axis.

- [ ] **Step 3: FE consistency — gate the tab Save buttons on ROLE_MANAGE**

In `role-access.tsx` the Permissions/Sidebar/Re-auth tab Save buttons enable on dirty-state only. Add the page's existing `isSuperAdmin` check (`role==='SUPER_ADMIN' || permissions.includes('ROLE_MANAGE')`, already computed at `role-access.tsx:45`) to each Save's `disabled`/render condition, so a user without ROLE_MANAGE can't click a Save that will 403. (The Roles tab already does this.)

- [ ] **Step 4: Verify + commit**

`npm run lint -w @digilog/api` + `npm run lint -w @digilog/web` → clean. Runtime (owed): a token with CONFIG_UPDATE but not ROLE_MANAGE (you may need a custom test role) → `PUT /api/config/action-reauth` returns 403; SUPER_ADMIN/ADMIN still 200. Browser: Roles & Access tabs still save for SUPER_ADMIN.
```bash
git add apps/api/src/modules/config/static-routes/roles.routes.ts apps/api/src/modules/config/static-routes/action-reauth.routes.ts apps/web/src/routes/config/role-access.tsx
git commit -F - <<'EOF'
fix(rbac): require ROLE_MANAGE (not CONFIG_UPDATE) on role/sidebar/reauth config edits (M6)

The Permissions/Sidebar/Re-auth tabs wrote via CONFIG_UPDATE-gated endpoints, so a role
with CONFIG_UPDATE but not ROLE_MANAGE could edit role permissions, sidebar visibility,
and the reauth policy — a privilege-escalation surface. Gate all three on ROLE_MANAGE
(reauth challenge unchanged) and add the matching FE check on the tab Save buttons.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3.2: M1 — enforce FILTER_STATUS_UPDATE on filter status change

**Context:** The filter Status-Update action is gated `FILTER_STATUS_UPDATE` on the FE (`filter-list.tsx`) but the backend `PATCH /api/assets/instances/:id/lifecycle-state` requires `ASSET_UPDATE`. Two-way broken: a `FILTER_STATUS_UPDATE`-only holder sees the button but 403s; an `ASSET_UPDATE`-only holder (e.g. MAINTENANCE) has no button but can PATCH via API. Fix: make the backend require `FILTER_STATUS_UPDATE` — the permission the UI already gates on. Per seed, SUPER_ADMIN+ADMIN hold `FILTER_STATUS_UPDATE`; MAINTENANCE holds `ASSET_UPDATE` but NOT `FILTER_STATUS_UPDATE`, so it loses only the API bypass it should never have had (no UI regression — it never had the button).

- [ ] **Step 1: Locate the route**

`grep -rn "lifecycle-state" apps/api/src/modules/assets` — find the `PATCH .../:id/lifecycle-state` route (per analysis, in the assets instance routes; gate `ASSET_UPDATE`, reauth `UPDATE_FILTER_LIFECYCLE`). Confirm the current `requirePermission('ASSET_UPDATE')`.

- [ ] **Step 2: Swap the gate**

`requirePermission('ASSET_UPDATE')` → `requirePermission('FILTER_STATUS_UPDATE')` on that route. Keep the `UPDATE_FILTER_LIFECYCLE` reauth unchanged.

- [ ] **Step 3: Verify + commit**

`npm run lint -w @digilog/api` clean. Runtime (owed): a MAINTENANCE token (ASSET_UPDATE, no FILTER_STATUS_UPDATE) → PATCH lifecycle-state 403; ADMIN → 200. Browser: Status Update still works for ADMIN on the filter list.
```bash
git add apps/api/src/modules/assets/routes/instance.routes.ts
git commit -F - <<'EOF'
fix(rbac): enforce FILTER_STATUS_UPDATE on filter status change (M1)

PATCH lifecycle-state required ASSET_UPDATE while the UI gated the button on
FILTER_STATUS_UPDATE — so the permission the UI advertises was never enforced and an
ASSET_UPDATE-only role could PATCH via API. Require FILTER_STATUS_UPDATE to match the UI.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3.3: M2 — tighten Retire/Replace to FILTER_RETIRE / FILTER_REPLACE

**Context:** `POST /api/filters/:id/retire` and `/replace` use `requireAnyPermission('FILTER_OPERATE', 'FILTER_RETIRE'|'FILTER_REPLACE')`. The FE gates the buttons on `FILTER_RETIRE`/`FILTER_REPLACE` only. So an operator with `FILTER_OPERATE` (OPERATOR/SUPERVISOR/MAINTENANCE per seed) can retire/replace via API despite having no button. Fix: drop `FILTER_OPERATE` from the any-of so the backend requires the specific permission the UI gates on. SUPER_ADMIN+ADMIN hold `FILTER_RETIRE`/`FILTER_REPLACE`; operate-only roles lose just the API bypass (no UI regression).

- [ ] **Step 1: Locate + confirm** the `/:id/retire` (routes.ts:434) and `/:id/replace` (routes.ts:463) any-of gates.

- [ ] **Step 2: Tighten**

`requireAnyPermission('FILTER_OPERATE','FILTER_RETIRE')` → `requirePermission('FILTER_RETIRE')`; likewise `requirePermission('FILTER_REPLACE')`. Keep the `RETIRE_FILTER`/`REPLACE_FILTER` reauth unchanged.

- [ ] **Step 3: Verify + commit**

`npm run lint -w @digilog/api` clean. Runtime (owed): OPERATOR token (FILTER_OPERATE, no FILTER_RETIRE) → POST retire 403; ADMIN → succeeds (reauth then 200). Browser: retire/replace still work for ADMIN.
```bash
git add apps/api/src/modules/filter-operations/routes.ts
git commit -F - <<'EOF'
fix(rbac): require FILTER_RETIRE/FILTER_REPLACE (drop FILTER_OPERATE fallback) (M2)

Retire/replace accepted FILTER_OPERATE, so operate-only roles could retire/replace via
API despite the UI hiding the buttons (which gate on FILTER_RETIRE/FILTER_REPLACE).
Drop the FILTER_OPERATE fallback so the backend matches the UI's specific permission.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3.4: M3 — tighten user delete to SUPER_ADMIN

**Context:** `DELETE /api/users/:id` (routes.ts:305-306) and `POST /api/users/bulk-delete` (routes.ts:80-81) require `USER_DELETE`; the UI hardcodes both to SUPER_ADMIN-only (deliberate hardening — `users/list.tsx` comment documents a prior leak). ADMIN holds `USER_DELETE` (seed) → can delete via API despite no button. Per user decision: make the API SUPER_ADMIN-only.

- [ ] **Step 1: Swap both gates** `requirePermission('USER_DELETE')` → `requireSuperAdmin()` on `DELETE /:id` and `POST /bulk-delete`. Keep the `DELETE_USER`/`BULK_DELETE_USERS` reauth unchanged.

- [ ] **Step 2: Verify + commit** — `npm run lint -w @digilog/api` clean. Runtime (owed): ADMIN token → DELETE user 403; SUPER_ADMIN → succeeds. UI unchanged (already SA-only).
```bash
git add apps/api/src/modules/users/routes.ts
git commit -F - <<'EOF'
fix(rbac): restrict user delete + bulk-delete to SUPER_ADMIN (M3)

UI hardcodes user delete to SUPER_ADMIN (deliberate, per a documented prior leak) but
the API allowed USER_DELETE, which ADMIN holds — an API bypass. Tighten the API to
SUPER_ADMIN to match the UI. USER_DELETE removed from ADMIN seed in Task 3.7.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3.5: M4 — tighten PM schedule delete to SUPER_ADMIN

**Context:** `DELETE /api/pm-schedules/:id` (routes.ts:677-678) requires `PM_DELETE`; the UI gates delete on `isSuperAdmin` only. ADMIN holds `PM_DELETE` → API bypass. Tighten to SUPER_ADMIN.

- [ ] **Step 1: Swap the gate** `requirePermission('PM_DELETE')` → `requireSuperAdmin()`. Keep `DELETE_PM_SCHEDULE` reauth.

- [ ] **Step 2: Verify + commit** — api tsc clean. Runtime (owed): ADMIN → DELETE pm-schedule 403; SUPER_ADMIN → succeeds.
```bash
git add apps/api/src/modules/pm-schedules/routes.ts
git commit -F - <<'EOF'
fix(rbac): restrict PM schedule delete to SUPER_ADMIN (M4)

UI gates PM delete on SUPER_ADMIN only, but the API allowed PM_DELETE (held by ADMIN) —
an API bypass. Tighten to SUPER_ADMIN. PM_DELETE removed from ADMIN seed in Task 3.7.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3.6: M5 — tighten notification delete to SUPER_ADMIN

**Context:** Phase 2 gated single-delete with `NOTIFICATION_DELETE` (S5). With the Phase 3 decision, both single `DELETE /api/notifications/:id` and `POST /api/notifications/bulk-delete` should be SUPER_ADMIN-only to match the UI (delete buttons are SA-only). This supersedes the Phase 2 single-delete gate.

- [ ] **Step 1: Swap both gates** `requirePermission('NOTIFICATION_DELETE')` → `requireSuperAdmin()` on single DELETE (added in Phase 2) and bulk-delete. Keep `DELETE_NOTIFICATION`/`BULK_DELETE_NOTIFICATIONS` reauth.

- [ ] **Step 2: Verify + commit** — api tsc clean. Runtime (owed): ADMIN → DELETE notification 403; SUPER_ADMIN → succeeds. Confirm a normal user's read/mark-read panel still works (those endpoints untouched).
```bash
git add apps/api/src/modules/notifications/routes.ts
git commit -F - <<'EOF'
fix(rbac): restrict notification delete + bulk-delete to SUPER_ADMIN (M5)

Supersedes the Phase 2 NOTIFICATION_DELETE gate: UI restricts delete to SUPER_ADMIN, so
make the API SUPER_ADMIN-only for both single and bulk delete. NOTIFICATION_DELETE
removed from ADMIN seed in Task 3.7. Read/mark-read stay ungated (per-user scoped).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3.7: Remove vestigial delete permissions from ADMIN seed + keep CFR invariant

**Context:** After 3.4–3.6, `USER_DELETE`/`PM_DELETE`/`NOTIFICATION_DELETE` gate nothing (SUPER_ADMIN bypasses regardless). Leaving them in ADMIN's seed array falsely implies ADMIN can delete. Remove them so the role catalog is honest. Live-DB impact is nil (the perms are no-ops once gates are SUPER_ADMIN-only); the existing ADMIN role row keeps them harmlessly until a re-seed/role-sync.

- [ ] **Step 1: Edit `apps/api/prisma/default-roles.ts`** — in the ADMIN role's `permissions` array, remove `'USER_DELETE'`, `'PM_DELETE'`, `'NOTIFICATION_DELETE'`. Do NOT touch SUPER_ADMIN's array (it keeps them for completeness; SA bypasses anyway). Do NOT remove `FILTER_STATUS_UPDATE`/`FILTER_RETIRE`/`FILTER_REPLACE` — those are now properly enforced and ADMIN legitimately uses them.

- [ ] **Step 2: Run the CFR invariant test** — `npm run build -w @digilog/shared` then `npm test -w @digilog/api -- role-effective-permissions` → still passes (ADMIN's shorter array is still all-valid perms; the tree/legacy maps still agree). If the "every role permission is a real PERMISSIONS constant" check or the map-equality check fails, investigate — removing perms should not break either.

- [ ] **Step 3: Decide on the catalog nodes (note, not necessarily act)** — the tree's `users.delete`/`pm.delete`/`notifications.delete` nodes still map to the now-vestigial perms. They remain valid catalog entries (SUPER_ADMIN-enforced). Leave them; Phase 5's `gate` field work will record that these gate on SUPER_ADMIN. Note this in the commit.

- [ ] **Step 4: Commit**
```bash
git add apps/api/prisma/default-roles.ts
git commit -F - <<'EOF'
chore(rbac): drop vestigial USER_DELETE/PM_DELETE/NOTIFICATION_DELETE from ADMIN seed

After M3-M5 tightened these deletes to SUPER_ADMIN-only, the granular perms gate nothing
(SUPER_ADMIN bypasses). Remove them from ADMIN's seed so the role catalog is honest.
Live-DB impact nil (no-ops post-tighten). CFR invariant test still passes. Tree nodes
users.delete/pm.delete/notifications.delete retained (SUPER_ADMIN-enforced; Phase 5 gate field).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3.8: Docs sync + CFR re-verify

- [ ] **Step 1: Full Phase-3 test pass** — `npm run build -w @digilog/shared`; `npm test -w @digilog/api -- role-effective-permissions` (pass); api + web `tsc` clean. Note the pre-existing `assets.test.ts` (limit>100) failure is unrelated.
- [ ] **Step 2: CHANGELOG** — Phase 3 entry: M1 (FILTER_STATUS_UPDATE enforced), M2 (retire/replace tightened), M3/M4/M5 (deletes → SUPER_ADMIN), M6 (role-config → ROLE_MANAGE), ADMIN seed cleanup.
- [ ] **Step 3: Analysis §3.2** — mark M1–M6 CLOSED with the resolution + commit each.
- [ ] **Step 4: `tasks/todo.md`** audit-log line. Commit `docs(rbac): record Phase 3 FE/BE mismatch closures`.

---

## Self-Review

**Spec coverage (vs §3.2):** M1 (3.2), M2 (3.3), M3 (3.4), M4 (3.5), M5 (3.6), M6 (3.1) + seed honesty (3.7) + docs (3.8). All six mismatches addressed in the user-chosen direction (tighten backend).

**Decisions baked in:** delete-direction = SUPER_ADMIN (user, 2026-06-30). M1/M2 = enforce the specific permission the UI already gates on (the only coherent "tighten" reading). M6 = ROLE_MANAGE (security bug, no policy choice).

**Risk notes:** All changes REMOVE access from roles that never had the corresponding UI button (API-only bypass closers) — so no UI regression is expected, but this IS behavior-affecting at the API layer and must be runtime-proven (curl 403/200). The one place to watch: Task 3.1 Step 1 (confirm no CONFIG_UPDATE-only consumer of the role-config endpoints) — if a non-Roles page writes them, ROLE_MANAGE could break it; the step gates on that check. Task 3.7 is the only role-data change — the CFR invariant test is its guard.

**Out of scope:** per-page View granularity (Phase 4), tree-driven sidebar/route/button gating + `useCan()` + Roles & Access tree UI (Phase 5), cleanup of dead DASHBOARD_* family + the logged dead checklist page (Phase 6).
