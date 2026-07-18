# Sidebar RBAC — Phase 5 Plan (Make the Catalog Live)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Stop the `PERMISSION_TREE` catalog from being a parallel/validated-only structure and make it the **single source that drives** sidebar visibility, button gating, config-card visibility, and the Roles & Access admin UI — via one `useCan()` hook — then retire the legacy maps it duplicates.

---

## Why this is decomposed into 5A–5E (read first)

Phase 5 spans several independent subsystems. Doing it as one mega-change would be unreviewable and risky. Each sub-plan below is independently shippable and gets its **own** detailed plan when its turn comes. **This document fully specifies 5A** (the foundation everything else needs) and outlines 5B–5E.

| Sub | Scope | Depends on | Risk |
|---|---|---|---|
| **5A** | `gate: Permission[]` field on every node + `useCan()` hook (the corrected, deferred-from-Phase-1 piece) | Phases 2–4 (settled backend gates) | Low — additive, no wiring yet |
| **5B** | Sidebar rendering reads the tree (`visibilityPrivilegeIds`) instead of `SIDEBAR_PRIVILEGE_MAP` | 5A | Medium — changes what users see in the nav |
| **5C** | Refactor ~20 pages' button gating from ad-hoc `isSuperAdmin \|\| perms.includes()` to `useCan('<node>')` | 5A | Medium — many files, each verifiable |
| **5D** | Roles & Access admin UI → hierarchical Sidebar→Page→Action tree picker (replaces flat checkbox list) + cross-linked reauth column | 5A | Medium — UX rebuild, no enforcement change |
| **5E** | Retire `sidebar-privilege-map.ts` + make `FEATURE_PRIVILEGES`/`FEATURE_TO_PERMISSION_MAP` the *derived* exports (delete the hand-maintained originals) — resolves Phase-1 finding I1 | 5B+5C+5D (nothing may read the originals) | Medium — final consolidation |

**Sequencing:** 5A first (foundation). Then 5B/5C/5D can proceed in any order (or parallel — independent surfaces). 5E LAST (only safe once nothing reads the legacy originals). Each sub-plan ends shippable; you can stop after any.

---

# SUB-PLAN 5A — `gate` field + `useCan()` hook

**Goal:** Give every action node a `gate: Permission[]` — the **discriminating backend permission(s)** that authorize the action — and a `useCan(nodeId)` hook that gates UI elements on it. This is the piece reverted in Phase 1 (commit `7d2ef3b`) because it ORed over the *grant set*; now it gates over the *real backend gate*.

## The core distinction (why Phase 1's version was wrong)

A node has TWO permission concepts — keep them separate:
- **`permissions`** (already exists) = the GRANT-expansion set = what enabling the toggle grants a role (= `FEATURE_TO_PERMISSION_MAP`; includes read dependencies like `USER_READ`). Used by the admin UI when saving role grants. **NOT an authorization check.**
- **`gate`** (NEW) = the DISCRIMINATING permission(s) the backend actually requires to perform the action. Used by `useCan()` to decide "can this user do it." Sourced from the real backend gate (post-Phase 2/3/4).

Example — `users.delete`: `permissions: ['USER_DELETE','USER_READ']` (grant set), but `gate: []` because after Phase 3 the backend requires `requireSuperAdmin()` (no non-SA permission grants it). `useCan('users.delete')` → true ONLY for SUPER_ADMIN. If we had reused `permissions` with OR (Phase 1's bug), a `USER_READ` holder would have been granted delete.

## `gate` value rules (the convention)

For each node, set `gate` from its action's current backend gate:
- **Single permission** (e.g. `requirePermission('USER_CREATE')`) → `gate: ['USER_CREATE']`.
- **OR of permissions** (e.g. `requireAnyPermission('FCP_CREATE','CHECKLIST_CREATE')`) → `gate: ['FCP_CREATE','CHECKLIST_CREATE']` (useCan ORs → either grants).
- **SUPER_ADMIN-only** (`requireSuperAdmin()` — e.g. user/PM/notification delete, audit redact) → `gate: []`. Empty gate + the SA bypass in useCan = SA-only. Document this convention loudly.
- **Role-gated** (`requireRole('SUPER_ADMIN','ADMIN')` — e.g. system-health) → represent as `gate: []` with an optional `gateRoles?: string[]` field IF you need non-SA role gating in the UI; for system-health (SA/ADMIN) add `gateRoles: ['ADMIN']` so useCan grants ADMIN. (Add `gateRoles` only where a role-gate exists; most nodes don't need it.)
- **No backend gate / cosmetic (enforce:'c')** (e.g. client-side exports, mark-read) → `gate: []` is wrong (would hide from non-SA); instead `gate: ['<the read perm of the page>']` so the cosmetic action shows to anyone who can view the page, OR a sentinel. Simplest: for `enforce:'c'` nodes set `gate` = the page's view perm (the action is available to anyone who sees the page). Document per node.

> The `enforce` tag (a/b/c) from the analysis already classifies these — use it to drive the gate rule: `a` → real gate perm(s); SA-only `a` → `[]`; `c` → page-view perm.

## Files
- `packages/shared/src/types/permission-tree.ts` — add `gate` (+ optional `gateRoles`) to `PermissionNode`; populate every node.
- `packages/shared/src/types/permission-tree.test.ts` — gate well-formedness + the corrected resolver.
- `packages/shared/src/index.ts` — export a `resolveNodeGate(nodeId)` helper.
- `apps/web/src/hooks/use-can.ts` (NEW — the corrected hook) + `use-can.test.ts`.

## Global Constraints
- **Additive only — no page is wired to `useCan()` in 5A** (that's 5C). 5A ships the hook + gate data with tests; behavior is unchanged because nothing calls it yet.
- `gate` values must be valid `PERMISSIONS` constants (well-formedness test). The SA-only convention is `gate: []`.
- Source each `gate` from the CURRENT backend gate (the analysis §2 "APIs → backend gate" column, UPDATED for Phase 2/3/4: deletes→SA→`[]`; M1 status→`['FILTER_STATUS_UPDATE']`; M2 retire/replace→`['FILTER_RETIRE']`/`['FILTER_REPLACE']`; M6 role-config→`['ROLE_MANAGE']`; Phase-4 view perms→the narrow `*_VIEW`). Rebuild shared after edits.

### Task 5A.1 — Add `gate` to `PermissionNode` + populate every node

- [ ] **Step 1: Extend the interface** in `permission-tree.ts`:
```ts
export interface PermissionNode {
  // ...existing fields...
  /** Grant-expansion set (what enabling this toggle grants). = FEATURE_TO_PERMISSION_MAP. NOT an auth check. */
  permissions: Permission[];
  /** Discriminating backend gate — the permission(s) required to PERFORM the action.
   *  [] means SUPER_ADMIN-only (no non-SA permission grants it). useCan() ORs over this. */
  gate: Permission[];
  /** Non-SA roles that may perform the action via a backend requireRole() (rare; e.g. system-health). */
  gateRoles?: string[];
  // ...
}
```
- [ ] **Step 2: Write the well-formedness test FIRST** (extend `permission-tree.test.ts`):
```ts
describe('PermissionNode.gate', () => {
  const nodes = PERMISSION_TREE.flatMap(g => g.nodes);
  it('every gate entry is a valid PERMISSIONS constant', () => {
    const valid = new Set(Object.values(PERMISSIONS));
    for (const n of nodes) for (const p of n.gate) expect(valid.has(p as any), `${n.id} → ${p}`).toBe(true);
  });
  it('every enforce:a node has a non-empty gate OR is documented SUPER_ADMIN-only ([])', () => {
    // [] is allowed (SA-only); just assert gate is an array (the SA-only convention is intentional).
    for (const n of nodes) expect(Array.isArray(n.gate), n.id).toBe(true);
  });
  it('known SUPER_ADMIN-only actions have empty gate', () => {
    for (const id of ['users.delete','pm.delete','notifications.delete','audit.redact'])
      expect(resolveNodeGate(id), id).toEqual([]);
  });
  it('known OR-gated action lists both perms', () => {
    expect(resolveNodeGate('checklists.create').sort()).toEqual(['CHECKLIST_CREATE','FCP_CREATE'].sort());
  });
});
```
- [ ] **Step 3: Run → fails** (`gate` not defined). `npm test -w @digilog/shared -- permission-tree`.
- [ ] **Step 4: Populate `gate` on every node** from the current backend gate per the rules above. Cross-reference `tasks/RBAC-SIDEBAR-REDESIGN-ANALYSIS.md` §2 (the per-node backend-gate column) AND the Phase 2/3/4 CHANGELOG entries (the gates that changed). Add `resolveNodeGate(nodeId)` (mirror of `resolveNodePermissions` but returns `gate`). When uncertain about a node's real backend gate, grep the route file — do NOT guess (CLAUDE.md).
- [ ] **Step 5: Run → passes.** Fix any node the test names.
- [ ] **Step 6: Build + commit.** `npm run build -w @digilog/shared`. `git add` the tree + test + index export. Commit `feat(rbac): add gate field (discriminating backend perm) to PermissionNode + resolveNodeGate (Phase 5A)`.

### Task 5A.2 — Build `useCan()` over `gate` (corrected hook)

- [ ] **Step 1: Write the test FIRST** (`apps/web/src/hooks/use-can.test.ts`) — MUST include the case that caused the Phase-1 revert:
```ts
// (jsdom; mock useAuth as in the reverted Phase-1 test)
it('DENIES a read-only user the delete action (the Phase-1 bug)', () => {
  mockAuth('ADMIN', ['USER_READ']);            // holds read, not the gate
  expect(renderHook(() => useCan()).result.current('users.delete')).toBe(false);
});
it('SUPER_ADMIN can do a SA-only action (gate [])', () => {
  mockAuth('SUPER_ADMIN', []);
  expect(renderHook(() => useCan()).result.current('users.delete')).toBe(true);
});
it('grants an OR-gate when the user holds EITHER perm', () => {
  mockAuth('SUPERVISOR', ['FCP_CREATE']);      // checklists.create gate = [FCP_CREATE, CHECKLIST_CREATE]
  expect(renderHook(() => useCan()).result.current('checklists.create')).toBe(true);
});
it('denies a SA-only action to a non-SA holder of the grant-set read', () => {
  mockAuth('ADMIN', ['USER_DELETE']);          // even holding USER_DELETE: gate is [] post-Phase-3
  expect(renderHook(() => useCan()).result.current('users.delete')).toBe(false);
});
it('honors gateRoles (e.g. system-health ADMIN)', () => {
  mockAuth('ADMIN', []);
  expect(renderHook(() => useCan()).result.current('system_health.view')).toBe(true);
});
it('denies unknown node ids', () => {
  mockAuth('ADMIN', ['USER_READ']);
  expect(renderHook(() => useCan()).result.current('nope.nope')).toBe(false);
});
```
- [ ] **Step 2: Run → fails** (no `use-can`).
- [ ] **Step 3: Implement** `apps/web/src/hooks/use-can.ts`:
```ts
import { useCallback } from 'react';
import { resolveNodeGate, resolveNodeGateRoles } from '@digilog/shared'; // resolveNodeGateRoles returns node.gateRoles ?? []
import { useAuth } from './use-auth';

/** Gate a UI element on a PERMISSION_TREE node's DISCRIMINATING backend gate.
 *  SUPER_ADMIN bypasses. Otherwise: true if the user holds ANY gate perm, OR their role is in gateRoles.
 *  gate [] + not-SA + no matching gateRole = denied (SUPER_ADMIN-only action). Unknown node = denied. */
export function useCan(): (nodeId: string) => boolean {
  const { user } = useAuth();
  const role = user?.role;
  const perms = user?.permissions ?? [];
  return useCallback((nodeId: string) => {
    if (role === 'SUPER_ADMIN') return true;
    const gate = resolveNodeGate(nodeId);
    const gateRoles = resolveNodeGateRoles(nodeId);
    if (role && gateRoles.includes(role)) return true;
    if (gate.length === 0) return false; // SA-only / unknown
    return gate.some(p => perms.includes(p));
  }, [role, perms]);
}
```
  (Add `resolveNodeGateRoles` to `permission-tree.ts` + barrel in 5A.1 if not already.)
- [ ] **Step 4: Run → all pass**, especially the read-only-denied-delete case.
- [ ] **Step 5: Commit** `feat(rbac): add useCan() hook gating on node.gate (corrects Phase-1 revert) (Phase 5A)`.

### Task 5A.3 — Docs

- [ ] CHANGELOG 5A entry (gate field + useCan, additive, the grant-set-vs-gate distinction); note the Phase-1 bug is now correctly resolved. `packages/shared/CLAUDE.md` note on `gate`. `tasks/todo.md` line. Commit.

## 5A Self-Review
- The deferred Phase-1 hook is rebuilt correctly: gates on `gate` (discriminating), not `permissions` (grant set). The test that proves it: a `USER_READ`/`USER_DELETE` holder is DENIED `users.delete` (SA-only). Additive — no page wired yet, so zero behavior change. Risk is low; the real wiring risk lives in 5C.
- Open item for 5B–5E: every node's `gate` must be accurate — 5A's well-formedness test checks validity + known cases, but full gate-correctness is verified when pages adopt `useCan()` in 5C (button shows iff backend allows). Spot-check the SA-only and OR-gate nodes during 5A; broaden in 5C.

---

# OUTLINE — 5B–5E (each gets its own detailed plan)

### 5B — Sidebar reads the tree
Replace `sidebar.tsx`'s `hasPermissionForItem` (which reads `SIDEBAR_PRIVILEGE_MAP` → `FEATURE_TO_PERMISSION_MAP`) with a tree lookup over `visibilityPrivilegeIds` (already on each SidebarGroup since Phase 1 Task 1.4). Keep the per-role `config.sidebarItems` override + the `canSeeQnn` server flag. Verify each role sees the same items as today (snapshot before/after per role) — this is a zero-change refactor like Phase 1, then the legacy map can be retired in 5E.

### 5C — Page button gating → `useCan()`
Refactor the ~20 pages using ad-hoc `isSuperAdmin || perms.includes('X')` to `const can = useCan(); ... can('users.delete')`. One page per task; each verifies the buttons render for exactly the roles that the backend allows (now that `gate` reflects the real backend gate, FE and BE finally agree — this also surfaces any remaining FE/BE drift). Highest-value sub-plan: it makes button gating consistent + impossible to silently forget. Pages: users, filters, notifications, audit, pm-schedules, cleaning-profiles, checklists, equipment-groups, stage-approvals, approvals, admin-requests, report-reviews, etc.

### 5D — Roles & Access admin UI → hierarchical tree
Replace the flat `FEATURE_PRIVILEGES` checkbox list in `roles-components/permissions-tab.tsx` with a Sidebar→Page→Action tree (from `PERMISSION_TREE`): per-page "select all", per-action checkboxes, and a cross-linked **reauth** indicator per action (read from `reauthAction` on the node + the `action-reauth` config) so the admin sees both axes together. Still saves the same grant set (`permissions`) to `PUT /api/config/roles/:name` (ROLE_MANAGE, per Phase 3) — no enforcement change, a UX rebuild. This is what makes the redesign *visible* to the user.

### 5E — Retire the legacy maps (consolidation)
Once 5B/5C/5D read only the tree: make `FEATURE_PRIVILEGES`, `FEATURE_TO_PERMISSION_MAP`, and `SIDEBAR_PRIVILEGE_MAP` the **derived** exports (`export const FEATURE_PRIVILEGES = deriveFeaturePrivileges()` etc.) and DELETE the hand-maintained originals — resolving Phase-1 finding I1 (the double-maintenance of `visibilityPrivilegeIds`). The parity tests (Phase 1) flip from "derived equals original" to "derived IS the export"; keep a snapshot test so the shape can't silently drift. Grep-verify nothing imports the originals by value before deleting. This is the final single-source consolidation the whole redesign was for.
