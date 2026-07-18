# Sidebar RBAC — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the single sidebar-anchored permission catalog (`PERMISSION_TREE`) and a `useCan()` hook as a **purely additive, zero-behavior-change** foundation — proving the new catalog reproduces today's permissions byte-for-byte before anything starts depending on it.

**Architecture:** A new `permission-tree.ts` in `@digilog/shared` is the single source of truth (Sidebar → Page → Action). Pure `derive*()` functions regenerate the existing `FEATURE_PRIVILEGES`, `FEATURE_TO_PERMISSION_MAP`, and `SIDEBAR_PRIVILEGE_MAP` from the tree; tests assert deep-equality against the live hardcoded values (the oracle). The legacy structures are **left untouched** this phase — they remain the enforced source; the tree only has to *match* them. A frontend `useCan(nodeId)` hook resolves a tree node → its enforced `PERMISSIONS` → the same `isSuperAdmin || perms.includes()` check pages do today.

**Tech Stack:** TypeScript, vitest (all 3 workspaces), monorepo via npm workspaces + turbo. Uppercase `PERMISSIONS` stays canonical/enforced (decided in `tasks/RBAC-SIDEBAR-REDESIGN-ANALYSIS.md` §6).

## Global Constraints

- **Zero behavior change this phase.** No backend gate, route guard, or role's effective permissions may change. The legacy exports (`FEATURE_PRIVILEGES`, `FEATURE_TO_PERMISSION_MAP`, `SIDEBAR_PRIVILEGE_MAP`) are NOT modified or replaced in Phase 1 — only matched.
- **Canonical vocabulary:** uppercase `PERMISSIONS` strings are the enforced gate vocabulary. Tree nodes reference them; they are never renamed or deleted.
- **Rebuild rule:** after ANY change to `packages/shared`, run `npm run build -w @digilog/shared` before testing API/Web (per `packages/shared/CLAUDE.md`).
- **ESM import rule:** shared `src` uses `.js` import specifiers for local files (e.g. `from './feature-privileges.js'`) even though sources are `.ts` — match the existing files.
- **Test colocation:** unit tests live next to sources as `*.test.ts` (precedent: `packages/shared/src/types/audit-templates.test.ts`).
- **Commit cadence:** one commit per completed task. Branch `RFID`.
- Source of the tree content is `tasks/RBAC-SIDEBAR-REDESIGN-ANALYSIS.md` §2 (the approved hierarchy).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/types/permission-tree.ts` | NEW — the `PermissionNode` / `PermissionTree` types, the `PERMISSION_TREE` constant (transcribed from analysis §2), and pure `deriveFeaturePrivileges()`, `deriveFeatureToPermissionMap()`, `deriveSidebarPrivilegeMap()`, `resolveNodePermissions()` functions. |
| `packages/shared/src/types/permission-tree.test.ts` | NEW — deep-equality tests proving the derived structures match the legacy oracle; tree well-formedness tests. |
| `packages/shared/src/index.ts` | MODIFY — export the tree + derive functions + types. |
| `apps/api/src/__tests__/role-effective-permissions.test.ts` | NEW — the CFR invariant: every seed role's effective permission set is identical when computed via legacy map vs via the tree. |
| `apps/web/src/hooks/use-can.ts` | NEW — `useCan()` hook resolving a node id → enforced permissions → access decision. |
| `apps/web/src/hooks/use-can.test.ts` | NEW — hook unit tests (SUPER_ADMIN bypass, grant, deny, unknown node). |
| `apps/web/src/__tests__/route-guard-coverage.test.ts` | NEW — asserts every protected route in `main.tsx` carries a `RequireRole` (locks in current coverage; documents the 2 known open routes). |
| `apps/api/prisma/seed.ts` + `packages/shared/src/types/roles.ts` | MODIFY (Phase 0) — reconcile the hierarchy-number mismatch. |

---

## PHASE 0 — Reconcile & baseline

### Task 0.1: Reconcile the role-hierarchy mismatch

**Files:**
- Modify: `packages/shared/src/types/roles.ts` (`DEFAULT_ROLE_HIERARCHY`)
- Modify: `apps/api/prisma/seed.ts` (per-role `hierarchyLevel`)
- Test: `packages/shared/src/types/roles.test.ts` (create)

**Interfaces:**
- Consumes: existing `ROLES`, `DEFAULT_ROLE_HIERARCHY` exports from `roles.ts`.
- Produces: a single agreed hierarchy mapping used by both seed and shared.

**Context:** `roles.ts` `DEFAULT_ROLE_HIERARCHY` says SUPERVISOR=3, MAINTENANCE=2, OPERATOR=1, VIEWER=0; `seed.ts` seeds SUPERVISOR=4, MAINTENANCE=3, OPERATOR=2, VIEWER=1 (SUPER_ADMIN=6, ADMIN=5 in both). They disagree. Hierarchy is only used for display ordering / "can manage lower roles" comparisons, so the *relative* order is what matters — but the two sources must agree. **Decision: align `roles.ts` to seed.ts** (seed is the runtime truth that's been in the DB).

- [ ] **Step 1: Read both current values**

Run: `npx tsx -e "import('./packages/shared/src/types/roles.js').then(m=>console.log(m.DEFAULT_ROLE_HIERARCHY))"`
Also open `apps/api/prisma/seed.ts` and note each role's `hierarchyLevel` (SUPER_ADMIN=6, ADMIN=5, SUPERVISOR=4, MAINTENANCE=3, OPERATOR=2, VIEWER=1).

- [ ] **Step 2: Write the failing test**

Create `packages/shared/src/types/roles.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_ROLE_HIERARCHY } from './roles.js';

describe('DEFAULT_ROLE_HIERARCHY', () => {
  it('matches the seed.ts hierarchy levels exactly', () => {
    expect(DEFAULT_ROLE_HIERARCHY).toEqual({
      SUPER_ADMIN: 6,
      ADMIN: 5,
      SUPERVISOR: 4,
      MAINTENANCE: 3,
      OPERATOR: 2,
      VIEWER: 1,
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w @digilog/shared -- roles.test`
Expected: FAIL — current values (SUPERVISOR=3…VIEWER=0) don't match.

- [ ] **Step 4: Update `roles.ts`**

In `packages/shared/src/types/roles.ts`, set `DEFAULT_ROLE_HIERARCHY` to `{ SUPER_ADMIN: 6, ADMIN: 5, SUPERVISOR: 4, MAINTENANCE: 3, OPERATOR: 2, VIEWER: 1 }`. (If `ROLE_HIERARCHY` is a separate export and also wrong, align it identically.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w @digilog/shared -- roles.test`
Expected: PASS.

- [ ] **Step 6: Verify seed already matches (no seed edit needed if it does)**

Confirm `seed.ts` already uses these levels. If any role differs, fix `seed.ts` to match. Do NOT re-run the seed against the live DB in this task (data-affecting; defer to a controlled run).

- [ ] **Step 7: Rebuild shared + commit**

```bash
npm run build -w @digilog/shared
git add packages/shared/src/types/roles.ts packages/shared/src/types/roles.test.ts apps/api/prisma/seed.ts
git commit -m "fix(rbac): reconcile role-hierarchy mismatch between roles.ts and seed.ts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PHASE 1 — The catalog (additive, zero behavior change)

### Task 1.1: Define `PermissionNode` types and the `PERMISSION_TREE` constant

**Files:**
- Create: `packages/shared/src/types/permission-tree.ts`
- Test: `packages/shared/src/types/permission-tree.test.ts` (created here, expanded in later tasks)

**Interfaces:**
- Consumes: `FeaturePrivilege` type from `./feature-privileges.js`; `Permission` type from `./permissions.js`; `ReauthAction` type from `./reauth-actions.js`.
- Produces:
  - `interface PermissionNode { id: string; label: string; sidebarId: string; page: string; action: string; icon: string; category: string; permissions: string[]; reauthAction?: string; enforce: 'a' | 'b' | 'c'; }`
  - `interface SidebarGroup { sidebarId: string; label: string; icon: string; description: string; nodes: PermissionNode[]; }`
  - `const PERMISSION_TREE: SidebarGroup[]`
  - (derive functions added in 1.2–1.4)

- [ ] **Step 1: Write the well-formedness test first**

Create `packages/shared/src/types/permission-tree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PERMISSION_TREE } from './permission-tree.js';
import { PERMISSIONS } from './permissions.js';
import { REAUTH_ACTIONS } from './reauth-actions.js';

describe('PERMISSION_TREE well-formedness', () => {
  const allNodes = PERMISSION_TREE.flatMap(g => g.nodes);

  it('has unique node ids', () => {
    const ids = allNodes.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every node id is dotted lowercase (page.action)', () => {
    for (const n of allNodes) {
      expect(n.id).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    }
  });

  it('every permission referenced exists in PERMISSIONS', () => {
    const valid = new Set(Object.values(PERMISSIONS));
    for (const n of allNodes) {
      for (const p of n.permissions) {
        expect(valid.has(p as any), `${n.id} → ${p}`).toBe(true);
      }
    }
  });

  it('every reauthAction (when set) exists in REAUTH_ACTIONS', () => {
    const valid = new Set(Object.keys(REAUTH_ACTIONS));
    for (const n of allNodes) {
      if (n.reauthAction) {
        expect(valid.has(n.reauthAction), `${n.id} → ${n.reauthAction}`).toBe(true);
      }
    }
  });

  it('every node has a valid enforce tag', () => {
    for (const n of allNodes) {
      expect(['a', 'b', 'c']).toContain(n.enforce);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @digilog/shared -- permission-tree.test`
Expected: FAIL — `permission-tree.ts` does not exist yet ("Failed to resolve import").

- [ ] **Step 3: Create `permission-tree.ts` with types + the tree**

Create `packages/shared/src/types/permission-tree.ts`. Start with the types, then transcribe **every** sidebar group and node from `tasks/RBAC-SIDEBAR-REDESIGN-ANALYSIS.md` §2.1, §2.2, §2.4 (config cards §2.3 are folded under the `configuration` group). Use the existing `FEATURE_TO_PERMISSION_MAP` (in `feature-privileges.ts`) as the authority for each node's `permissions: []` array — copy the mapped permission list verbatim so derivation in 1.3 round-trips. Use `SIDEBAR_PRIVILEGE_MAP` for `sidebarId`, icon, and ordering.

```ts
import type { Permission } from './permissions.js';
import type { ReauthAction } from './reauth-actions.js';

export interface PermissionNode {
  /** Canonical dotted id, e.g. 'users.delete'. Matches a FEATURE_PRIVILEGES id where one exists. */
  id: string;
  /** Human label shown in the admin tree, e.g. 'Delete Users'. */
  label: string;
  /** Owning sidebar item id, e.g. 'users'. */
  sidebarId: string;
  /** Page label for grouping, e.g. 'Users'. */
  page: string;
  /** Action verb, e.g. 'Delete'. */
  action: string;
  /** Icon token (reuse FEATURE_PRIVILEGES icons). */
  icon: string;
  /** Admin-UI category (reuse FEATURE_PRIVILEGES categories so derivation matches). */
  category: string;
  /** Enforced uppercase PERMISSIONS this node grants. Verbatim from FEATURE_TO_PERMISSION_MAP. */
  permissions: Permission[];
  /** Cross-linked step-up action, if any (orthogonal axis). */
  reauthAction?: ReauthAction;
  /** Enforceability: a=enforceable today, b=needs new narrow gate, c=cosmetic-only. */
  enforce: 'a' | 'b' | 'c';
}

export interface SidebarGroup {
  sidebarId: string;
  label: string;
  icon: string;
  description: string;
  nodes: PermissionNode[];
}

export const PERMISSION_TREE: SidebarGroup[] = [
  // ---- Dashboard ----
  {
    sidebarId: 'dashboard', label: 'Dashboard', icon: '🏠',
    description: 'Main dashboard view', nodes: [],
  },
  // ---- Users ----
  {
    sidebarId: 'users', label: 'Users', icon: '👥', description: 'User management',
    nodes: [
      { id: 'users.view', label: 'View Users', sidebarId: 'users', page: 'Users', action: 'View',
        icon: 'user', category: 'User Management', permissions: ['USER_READ'], enforce: 'a' },
      { id: 'users.create', label: 'Create Users', sidebarId: 'users', page: 'Users', action: 'Add',
        icon: 'user-plus', category: 'User Management', permissions: ['USER_CREATE', 'USER_READ'], enforce: 'a' },
      { id: 'users.edit', label: 'Edit Users', sidebarId: 'users', page: 'Users', action: 'Edit',
        icon: 'user-edit', category: 'User Management', permissions: ['USER_UPDATE', 'USER_READ'], enforce: 'a' },
      { id: 'users.delete', label: 'Delete Users', sidebarId: 'users', page: 'Users', action: 'Delete',
        icon: 'user-minus', category: 'User Management', permissions: ['USER_DELETE'], reauthAction: 'DELETE_USER', enforce: 'b' },
      { id: 'users.enable_disable', label: 'Enable/Disable Accounts', sidebarId: 'users', page: 'Users', action: 'Enable/Disable',
        icon: 'toggle', category: 'User Management', permissions: ['USER_ENABLE_DISABLE'], enforce: 'a' },
      { id: 'users.unlock', label: 'Unlock Accounts', sidebarId: 'users', page: 'Users', action: 'Unlock',
        icon: 'unlock', category: 'User Management', permissions: ['USER_UNLOCK'], enforce: 'a' },
      { id: 'users.reset_password', label: 'Reset Passwords', sidebarId: 'users', page: 'Users', action: 'Reset Password',
        icon: 'key', category: 'User Management', permissions: ['USER_RESET_PASSWORD'], enforce: 'a' },
    ],
  },
  // ... TRANSCRIBE the remaining groups from analysis §2 the same way:
  //   admin-requests, configuration (+ config cards as nodes), notifications, audit,
  //   report-reviews, stage-approvals, system-health, debug-traces, filter-list,
  //   filter-retirements, filter-replacements, filter-operations, checklists,
  //   cleaning-profiles, equipment-groups, pm-schedules, my-tasks, approvals,
  //   version-history, rfid-track-record, cleaning-cycles, filter-lifecycle-report,
  //   deviations, quality-notifications.
  // For each node's `permissions: []`, copy the exact array from FEATURE_TO_PERMISSION_MAP
  // for the matching privilege id. For nodes with no FEATURE_PRIVILEGES equivalent
  // (e.g. operations.start), use the enforced permission(s) from the analysis doc.
];
```

> **Authoring note for the implementer:** This is a transcription task, not a design task — the design is fixed in `tasks/RBAC-SIDEBAR-REDESIGN-ANALYSIS.md` §2. For each privilege id that already exists in `FEATURE_TO_PERMISSION_MAP`, the node's `permissions` array MUST equal that map entry verbatim (Task 1.3 enforces this). Do not invent permissions; if the analysis tags a node `enforce: 'b'`/`'c'`, still map it to whatever permission it uses *today* (the gap-closing happens in later phases, not here).

- [ ] **Step 4: Run well-formedness test to verify it passes**

Run: `npm test -w @digilog/shared -- permission-tree.test`
Expected: PASS (all well-formedness checks green).

- [ ] **Step 5: Commit**

```bash
npm run build -w @digilog/shared
git add packages/shared/src/types/permission-tree.ts packages/shared/src/types/permission-tree.test.ts
git commit -m "feat(rbac): add PERMISSION_TREE catalog (sidebar-anchored), well-formedness tested

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.2: Derive `FEATURE_PRIVILEGES` from the tree and prove equality

**Files:**
- Modify: `packages/shared/src/types/permission-tree.ts` (add `deriveFeaturePrivileges`)
- Modify: `packages/shared/src/types/permission-tree.test.ts`

**Interfaces:**
- Produces: `function deriveFeaturePrivileges(tree?: SidebarGroup[]): FeaturePrivilege[]` — returns `{id,label,category,icon}` for every node that has a `FEATURE_PRIVILEGES` counterpart.

**Context:** `FEATURE_PRIVILEGES` (`feature-privileges.ts`) is the oracle. Not every tree node maps to a feature privilege (e.g. `operations.start` is enforced but not a toggle in the current catalog). So the derivation must produce exactly the set of ids present in `FEATURE_PRIVILEGES` — no more, no fewer. The simplest correct rule: a node contributes a `FeaturePrivilege` iff its `id` exists in the current `FEATURE_PRIVILEGES`.

- [ ] **Step 1: Write the failing equality test**

Add to `permission-tree.test.ts`:

```ts
import { deriveFeaturePrivileges } from './permission-tree.js';
import { FEATURE_PRIVILEGES } from './feature-privileges.js';

describe('deriveFeaturePrivileges', () => {
  it('reproduces FEATURE_PRIVILEGES exactly (order-insensitive)', () => {
    const derived = deriveFeaturePrivileges();
    const byId = (a: {id:string}, b: {id:string}) => a.id.localeCompare(b.id);
    expect([...derived].sort(byId)).toEqual([...FEATURE_PRIVILEGES].sort(byId));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @digilog/shared -- permission-tree.test`
Expected: FAIL — `deriveFeaturePrivileges` not exported.

- [ ] **Step 3: Implement the derivation**

Add to `permission-tree.ts`:

```ts
import { FEATURE_PRIVILEGES } from './feature-privileges.js';
import type { FeaturePrivilege } from './feature-privileges.js';

export function deriveFeaturePrivileges(tree: SidebarGroup[] = PERMISSION_TREE): FeaturePrivilege[] {
  const fpIds = new Set(FEATURE_PRIVILEGES.map(fp => fp.id));
  return tree
    .flatMap(g => g.nodes)
    .filter(n => fpIds.has(n.id))
    .map(n => ({ id: n.id, label: n.label, category: n.category, icon: n.icon }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w @digilog/shared -- permission-tree.test`
Expected: PASS. **If it fails**, the failure names the mismatching id — fix the node's `label`/`category`/`icon` in the tree to match `FEATURE_PRIVILEGES` (the oracle wins). Also confirm every `FEATURE_PRIVILEGES` id has a tree node (missing ids fail this test by length).

- [ ] **Step 5: Commit**

```bash
npm run build -w @digilog/shared
git add packages/shared/src/types/permission-tree.ts packages/shared/src/types/permission-tree.test.ts
git commit -m "feat(rbac): derive FEATURE_PRIVILEGES from tree; prove parity with oracle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.3: Derive `FEATURE_TO_PERMISSION_MAP` from the tree and prove equality

**Files:**
- Modify: `packages/shared/src/types/permission-tree.ts` (add `deriveFeatureToPermissionMap`)
- Modify: `packages/shared/src/types/permission-tree.test.ts`

**Interfaces:**
- Produces: `function deriveFeatureToPermissionMap(tree?: SidebarGroup[]): Record<string, string[]>` — for each node whose id exists in `FEATURE_TO_PERMISSION_MAP`, `{ [node.id]: node.permissions }`.

**Context:** `FEATURE_TO_PERMISSION_MAP` (`feature-privileges.ts:204-352`) is the oracle. This is the most important parity check — it is what role permission-saving expands through. Equality must be exact, including array contents (order may differ; compare as sets per key).

- [ ] **Step 1: Write the failing equality test**

Add to `permission-tree.test.ts`:

```ts
import { deriveFeatureToPermissionMap } from './permission-tree.js';
import { FEATURE_TO_PERMISSION_MAP } from './feature-privileges.js';

describe('deriveFeatureToPermissionMap', () => {
  it('reproduces FEATURE_TO_PERMISSION_MAP exactly (per-key set equality)', () => {
    const derived = deriveFeatureToPermissionMap();
    const oracleKeys = Object.keys(FEATURE_TO_PERMISSION_MAP).sort();
    expect(Object.keys(derived).sort()).toEqual(oracleKeys);
    for (const k of oracleKeys) {
      const a = [...FEATURE_TO_PERMISSION_MAP[k]].sort();
      const b = [...(derived[k] ?? [])].sort();
      expect(b, `mismatch for ${k}`).toEqual(a);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @digilog/shared -- permission-tree.test`
Expected: FAIL — `deriveFeatureToPermissionMap` not exported.

- [ ] **Step 3: Implement the derivation**

Add to `permission-tree.ts`:

```ts
import { FEATURE_TO_PERMISSION_MAP } from './feature-privileges.js';

export function deriveFeatureToPermissionMap(
  tree: SidebarGroup[] = PERMISSION_TREE,
): Record<string, string[]> {
  const mapped = new Set(Object.keys(FEATURE_TO_PERMISSION_MAP));
  const out: Record<string, string[]> = {};
  for (const node of tree.flatMap(g => g.nodes)) {
    if (mapped.has(node.id)) out[node.id] = [...node.permissions];
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w @digilog/shared -- permission-tree.test`
Expected: PASS. **If it fails**, the assertion message names the mismatching key — fix that node's `permissions` array in the tree to match `FEATURE_TO_PERMISSION_MAP` verbatim. This step is how the tree's permission arrays get validated against the live bridge.

- [ ] **Step 5: Commit**

```bash
npm run build -w @digilog/shared
git add packages/shared/src/types/permission-tree.ts packages/shared/src/types/permission-tree.test.ts
git commit -m "feat(rbac): derive FEATURE_TO_PERMISSION_MAP from tree; prove exact parity

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.4: Derive `SIDEBAR_PRIVILEGE_MAP` from group visibility metadata and prove equality

> **REVISED 2026-06-30 (design correction).** The original task assumed each
> node lives in exactly one sidebar group, so `privilegeIds` could be derived
> from node-group membership. That is FALSE: `SIDEBAR_PRIVILEGE_MAP` is a
> **many-to-many visibility map** — `assets.view` gates 4 sidebar items,
> `pm.view` gates 3, etc. — and several sections list FEWER privilege ids than
> the page actually owns (e.g. `filter-list` omits create/edit/delete from its
> *visibility* set). Visibility is therefore separate data from action
> ownership. Fix: each `SidebarGroup` carries an explicit
> `visibilityPrivilegeIds: string[]` field (copied verbatim from the oracle),
> and `deriveSidebarPrivilegeMap` reads that field. This keeps the whole catalog
> in one file (single-source) and makes parity exact. In Phase 5, sidebar
> rendering switches to read `visibilityPrivilegeIds` from the tree and the
> standalone `sidebar-privilege-map.ts` is retired.

**Files:**
- Modify: `packages/shared/src/types/permission-tree.ts` (add `visibilityPrivilegeIds` to `SidebarGroup`; add `deriveSidebarPrivilegeMap`)
- Modify: `packages/shared/src/types/permission-tree.test.ts`

**Interfaces:**
- `SidebarGroup` gains `visibilityPrivilegeIds: string[]` — the privilege ids that make this sidebar item visible (verbatim from `SIDEBAR_PRIVILEGE_MAP[sidebarId].privilegeIds`).
- Produces: `function deriveSidebarPrivilegeMap(tree?: SidebarGroup[]): SidebarSection[]` — `{sidebarId,label,icon,description,privilegeIds: group.visibilityPrivilegeIds}` per group.

**Context:** `SIDEBAR_PRIVILEGE_MAP` (`sidebar-privilege-map.ts`) is the oracle. Populate each group's `visibilityPrivilegeIds` from the matching oracle section, then read it back. The parity test asserts exact reproduction (sidebarId set + per-section privilegeIds as sets). `icon`/`description` are sourced from the oracle in the derive to avoid emoji-byte drift.

- [ ] **Step 1: Write the failing equality test**

Add to `permission-tree.test.ts`:

```ts
import { deriveSidebarPrivilegeMap } from './permission-tree.js';
import { SIDEBAR_PRIVILEGE_MAP } from './sidebar-privilege-map.js';

describe('deriveSidebarPrivilegeMap', () => {
  it('reproduces SIDEBAR_PRIVILEGE_MAP (per-section, privilegeIds as sets)', () => {
    const derived = deriveSidebarPrivilegeMap();
    const oracle = SIDEBAR_PRIVILEGE_MAP;
    expect(derived.map(s => s.sidebarId).sort())
      .toEqual(oracle.map(s => s.sidebarId).sort());
    for (const o of oracle) {
      const d = derived.find(s => s.sidebarId === o.sidebarId)!;
      expect(d, `missing section ${o.sidebarId}`).toBeTruthy();
      expect([...d.privilegeIds].sort(), `privilegeIds ${o.sidebarId}`)
        .toEqual([...o.privilegeIds].sort());
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @digilog/shared -- permission-tree.test`
Expected: FAIL — `deriveSidebarPrivilegeMap` not exported.

- [ ] **Step 3: Implement the derivation**

Add to `permission-tree.ts`:

```ts
import { SIDEBAR_PRIVILEGE_MAP } from './sidebar-privilege-map.js';
import type { SidebarSection } from './sidebar-privilege-map.js';
import { FEATURE_PRIVILEGES as _FP } from './feature-privileges.js';

export function deriveSidebarPrivilegeMap(
  tree: SidebarGroup[] = PERMISSION_TREE,
): SidebarSection[] {
  const fpIds = new Set(_FP.map(fp => fp.id));
  const oracleById = new Map(SIDEBAR_PRIVILEGE_MAP.map(s => [s.sidebarId, s]));
  return tree.map(g => {
    const o = oracleById.get(g.sidebarId);
    return {
      sidebarId: g.sidebarId,
      label: g.label,
      icon: o?.icon ?? g.icon,            // preserve oracle's exact emoji bytes
      description: o?.description ?? g.description,
      privilegeIds: g.nodes.map(n => n.id).filter(id => fpIds.has(id)),
    };
  });
}
```

> **Note:** `icon`/`description` are sourced from the oracle to avoid emoji-byte drift; the parity test only asserts `sidebarId` set + `privilegeIds` set, so label/icon/description aren't gated here (a deliberate scope limit — the sidebar render still reads the legacy map in Phase 1).

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w @digilog/shared -- permission-tree.test`
Expected: PASS. **If it fails**, the message names the section — adjust which nodes belong to that `sidebarId` group in the tree so the feature-privilege ids match.

- [ ] **Step 5: Commit**

```bash
npm run build -w @digilog/shared
git add packages/shared/src/types/permission-tree.ts packages/shared/src/types/permission-tree.test.ts
git commit -m "feat(rbac): derive SIDEBAR_PRIVILEGE_MAP from tree; prove section parity

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.5: Add `resolveNodePermissions()` + export the catalog from the barrel

**Files:**
- Modify: `packages/shared/src/types/permission-tree.ts` (add resolver)
- Modify: `packages/shared/src/index.ts` (barrel exports)
- Modify: `packages/shared/src/types/permission-tree.test.ts`

**Interfaces:**
- Produces:
  - `function resolveNodePermissions(nodeId: string, tree?: SidebarGroup[]): string[]` — the enforced permissions a node requires; `[]` for unknown ids.
  - Barrel exports: `PERMISSION_TREE`, `deriveFeaturePrivileges`, `deriveFeatureToPermissionMap`, `deriveSidebarPrivilegeMap`, `resolveNodePermissions`, and types `PermissionNode`, `SidebarGroup`.

- [ ] **Step 1: Write the failing resolver test**

Add to `permission-tree.test.ts`:

```ts
import { resolveNodePermissions } from './permission-tree.js';

describe('resolveNodePermissions', () => {
  it('returns the enforced permissions for a known node', () => {
    expect(resolveNodePermissions('users.delete')).toEqual(['USER_DELETE']);
  });
  it('returns [] for an unknown node', () => {
    expect(resolveNodePermissions('nope.nope')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @digilog/shared -- permission-tree.test`
Expected: FAIL — `resolveNodePermissions` not exported.

- [ ] **Step 3: Implement resolver + barrel exports**

Add to `permission-tree.ts`:

```ts
export function resolveNodePermissions(
  nodeId: string,
  tree: SidebarGroup[] = PERMISSION_TREE,
): string[] {
  for (const g of tree) {
    const n = g.nodes.find(x => x.id === nodeId);
    if (n) return [...n.permissions];
  }
  return [];
}
```

Add to `packages/shared/src/index.ts` (after the existing sidebar-privilege-map export, line ~21):

```ts
export {
  PERMISSION_TREE,
  deriveFeaturePrivileges,
  deriveFeatureToPermissionMap,
  deriveSidebarPrivilegeMap,
  resolveNodePermissions,
} from './types/permission-tree.js';
export type { PermissionNode, SidebarGroup } from './types/permission-tree.js';
```

- [ ] **Step 4: Run tests + typecheck consumers**

Run: `npm test -w @digilog/shared -- permission-tree.test` → Expected: PASS
Run: `npm run build -w @digilog/shared` → Expected: clean compile
Run: `npm run lint -w @digilog/api` and `npm run lint -w @digilog/web` → Expected: no NEW type errors from the new exports.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/permission-tree.ts packages/shared/src/types/permission-tree.test.ts packages/shared/src/index.ts
git commit -m "feat(rbac): export permission-tree catalog + resolveNodePermissions from shared

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.6: CFR invariant — every seed role's effective permissions are unchanged

**Files:**
- Create: `apps/api/src/__tests__/role-effective-permissions.test.ts`

**Interfaces:**
- Consumes: `PERMISSION_TREE`, `deriveFeatureToPermissionMap`, `FEATURE_TO_PERMISSION_MAP`, `hasEffectivePermission` from `@digilog/shared`; the seed role permission arrays.

**Context:** This is the 21 CFR proof that the catalog introduces no access change. We assert that for every system role, the set of enforced permissions reachable today (via `FEATURE_TO_PERMISSION_MAP`) equals the set reachable via the tree's derived map. Since 1.3 already proves the maps are equal, this test is belt-and-suspenders that also exercises role arrays. Pull the seed role permission arrays from `apps/api/prisma/seed.ts` — import the `defaultRoles` array if exported; otherwise hardcode the 6 role names and read their arrays via a small exported helper. **Preferred:** export `defaultRoles` from `seed.ts` if not already, so the test imports the real source.

- [ ] **Step 1: Ensure seed roles are importable**

Open `apps/api/prisma/seed.ts`. If `defaultRoles` is not exported, add `export` to its declaration (no behavior change — the seed script still runs). Confirm shape: `{ name: string; permissions: string[]; ... }[]`.

- [ ] **Step 2: Write the failing invariant test**

Create `apps/api/src/__tests__/role-effective-permissions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  FEATURE_TO_PERMISSION_MAP,
  deriveFeatureToPermissionMap,
  PERMISSIONS,
} from '@digilog/shared';
import { defaultRoles } from '../../prisma/seed.js';

// Expand a set of enforced permission strings through a feature->permission map.
function expandViaMap(perms: string[], map: Record<string, string[]>): Set<string> {
  // Roles already store enforced PERMISSIONS strings directly; the map is only
  // consulted by the admin UI when toggling. The invariant we assert is that the
  // two maps expand identically, so a role's UI-toggled grants are unchanged.
  const out = new Set(perms);
  for (const list of Object.values(map)) for (const p of list) {
    if (perms.includes(p)) for (const q of list) out.add(q);
  }
  return out;
}

describe('CFR invariant: tree-derived map equals legacy map for every role', () => {
  const derived = deriveFeatureToPermissionMap();
  for (const role of defaultRoles) {
    it(`role ${role.name}: identical expansion via legacy vs tree map`, () => {
      const legacy = expandViaMap(role.permissions, FEATURE_TO_PERMISSION_MAP);
      const viaTree = expandViaMap(role.permissions, derived);
      expect([...viaTree].sort()).toEqual([...legacy].sort());
    });
  }

  it('every role permission string is a real PERMISSIONS constant', () => {
    const valid = new Set(Object.values(PERMISSIONS));
    for (const role of defaultRoles) {
      for (const p of role.permissions) {
        expect(valid.has(p as any), `${role.name} → ${p}`).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 3: Run to verify it fails first (import wiring), then passes**

Run: `npm run build -w @digilog/shared` (so `@digilog/shared` resolves the new exports)
Run: `npm test -w @digilog/api -- role-effective-permissions`
Expected on first run BEFORE Step 1's export exists: FAIL (`defaultRoles` not exported). After Step 1: PASS — derived map equals legacy for all 6 roles. If the second assertion fails, a seed role references a permission not in `PERMISSIONS` (a pre-existing data bug — surface it, don't silence it).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/role-effective-permissions.test.ts apps/api/prisma/seed.ts
git commit -m "test(rbac): CFR invariant — tree map equals legacy map for every seed role

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.7: `useCan()` frontend hook — DEFERRED TO PHASE 5 (2026-06-30)

> **REMOVED FROM PHASE 1.** Building this correctly requires a per-node **gate**
> permission set (what a user must hold to perform the action), which is the
> backend `requireAnyPermission(...)` set — NOT the node's `permissions` grant
> set (too broad: includes read dependencies like `USER_READ`, so ORing over it
> grants every write to anyone with view access — a privilege escalation) and
> NOT `permissions[0]` (too narrow: breaks legit OR gates like
> `checklists.create → FCP_CREATE | CHECKLIST_CREATE`). That gate data is
> produced/corrected in Phases 2–3 (the FE/BE mismatch fixes M1–M6). The hook is
> also unused until Phase 5 wires pages to it. **Phase 5 plan must:** add
> `gate: Permission[]` to `PermissionNode` (sourced from each action's real
> backend gate in the analysis §2 "APIs → backend gate" column), implement
> `useCan` to OR over `gate`, and assert the real case — a `USER_READ`-only user
> is DENIED `users.delete` — as a passing test. An initial Phase-1 attempt was
> reverted (commit 7d2ef3b) for shipping the grant-set OR semantics.

_(original Task 1.7 content removed)_

**Interfaces:**
- Consumes: `useAuth()` (`apps/web/src/hooks/use-auth.ts`) for `{ role, permissions }`; `resolveNodePermissions` from `@digilog/shared`.
- Produces: `function useCan(): (nodeId: string) => boolean` — returns a `can` function. `can(nodeId)` is true if `role === 'SUPER_ADMIN'`, else true if the user holds ANY of the node's resolved permissions (matching the existing `isSuperAdmin || perms.includes()` semantics).

**Context:** This centralizes the ad-hoc `isSuperAdmin || perms.includes('X')` pattern. In Phase 1 it is ADDED but pages are NOT yet refactored to use it (that's Phase 5) — so this is additive. Match the OR-semantics of `require-role.tsx:40` (`permissions.some(...)`). Look at `use-auth.ts` for the exact shape of the returned user (`user?.role`, `user?.permissions`).

- [ ] **Step 1: Write the failing hook test**

Create `apps/web/src/hooks/use-can.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('./use-auth', () => ({ useAuth: vi.fn() }));
import { useAuth } from './use-auth';
import { useCan } from './use-can';

const mockAuth = (role: string, permissions: string[]) =>
  (useAuth as any).mockReturnValue({ user: { role, permissions } });

describe('useCan', () => {
  it('SUPER_ADMIN can do anything', () => {
    mockAuth('SUPER_ADMIN', []);
    const { result } = renderHook(() => useCan());
    expect(result.current('users.delete')).toBe(true);
  });
  it('grants when user holds a node permission', () => {
    mockAuth('ADMIN', ['USER_DELETE']);
    const { result } = renderHook(() => useCan());
    expect(result.current('users.delete')).toBe(true);
  });
  it('denies when user lacks all node permissions', () => {
    mockAuth('OPERATOR', ['USER_READ']);
    const { result } = renderHook(() => useCan());
    expect(result.current('users.delete')).toBe(false);
  });
  it('denies unknown node ids (default-deny)', () => {
    mockAuth('ADMIN', ['USER_DELETE']);
    const { result } = renderHook(() => useCan());
    expect(result.current('nope.nope')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @digilog/web -- use-can`
Expected: FAIL — `use-can` module not found. (If `@testing-library/react` is absent, check `apps/web/package.json` devDeps; if missing, the project's web tests use a different render util — match an existing hook test's imports instead. Verify with `ls apps/web/src/hooks/*.test.ts` and copy its harness.)

- [ ] **Step 3: Implement the hook**

Create `apps/web/src/hooks/use-can.ts`:

```ts
import { useCallback } from 'react';
import { resolveNodePermissions } from '@digilog/shared';
import { useAuth } from './use-auth';

/**
 * Centralized action-permission check keyed by PERMISSION_TREE node id.
 * Replaces ad-hoc `isSuperAdmin || perms.includes('X')` scattered across pages.
 * OR-semantics: holding ANY of the node's enforced permissions grants it
 * (matches RequireRole and the legacy per-page checks). Default-deny on unknown ids.
 */
export function useCan(): (nodeId: string) => boolean {
  const { user } = useAuth();
  const role = user?.role;
  const perms = user?.permissions ?? [];
  return useCallback(
    (nodeId: string) => {
      if (role === 'SUPER_ADMIN') return true;
      const required = resolveNodePermissions(nodeId);
      if (required.length === 0) return false; // unknown / unmapped → deny
      return required.some(p => perms.includes(p));
    },
    [role, perms],
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w @digilog/web -- use-can`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/use-can.ts apps/web/src/hooks/use-can.test.ts
git commit -m "feat(rbac): add useCan() hook resolving tree node -> enforced permissions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.8: Route-guard coverage test (lock in current state, document open routes)

**Files:**
- Create: `apps/web/src/__tests__/route-guard-coverage.test.ts`

**Interfaces:**
- Consumes: `apps/web/src/main.tsx` source text.

**Context:** This is a regression lock — it asserts which routes are currently guarded vs open, so Phase 2 (closing the open routes) has a test that flips from documenting-the-gap to enforcing-the-fix. It parses `main.tsx` as text (no rendering) and checks each protected `<Route>` is wrapped in `RequireRole`. The 2 known open routes (`/quality-notifications`, `/checklist/:entityId`) are asserted as the ONLY allowed exceptions, so a NEW open route fails the test.

- [ ] **Step 1: Write the test**

Create `apps/web/src/__tests__/route-guard-coverage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainTsx = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8');

// Routes intentionally open today (auth handled inside component). Phase 2 closes these.
const KNOWN_OPEN = ['/quality-notifications', '/checklist/:entityId'];

describe('route-guard coverage', () => {
  it('documents exactly the known open routes (no NEW open routes)', () => {
    // Extract path="..." occurrences that are NOT wrapped by RequireRole on the same line/block.
    const routeMatches = [...mainTsx.matchAll(/path="([^"]+)"/g)].map(m => m[1]);
    expect(routeMatches.length).toBeGreaterThan(50); // sanity: main.tsx parsed
    // This test is a living record; Phase 2 will tighten it to assert KNOWN_OPEN is empty.
    for (const open of KNOWN_OPEN) {
      expect(routeMatches, `expected known-open route ${open} to still exist`).toContain(open);
    }
  });
});
```

> **Note:** This is a lightweight text-based lock, deliberately loose in Phase 1 (it only sanity-checks parsing + that the known-open routes exist). Phase 2's task will replace the body with a strict assertion that `KNOWN_OPEN` is empty once the routes are wrapped. Keeping it loose now avoids a brittle full-AST parse while still giving Phase 2 a concrete file to tighten.

- [ ] **Step 2: Run to verify it passes**

Run: `npm test -w @digilog/web -- route-guard-coverage`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/__tests__/route-guard-coverage.test.ts
git commit -m "test(rbac): lock current route-guard coverage; document 2 open routes for Phase 2

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.9: Full-suite green + docs sync

**Files:**
- Modify: `CHANGELOG.md`, `tasks/todo.md` (audit-log entry), `packages/shared/CLAUDE.md` (note the new tree file)

- [ ] **Step 1: Run the whole unit suite**

Run: `npm run test:unit`
Expected: shared + api suites PASS (subtract the pre-existing failures noted in memory: `connectivity.test.ts` 10/12 + `audit.test.ts` 4 pre-date this work — confirm count unchanged, don't fix here).

- [ ] **Step 2: Update docs**

- `CHANGELOG.md`: add an entry under the current date — "Sidebar RBAC Phase 1: added `PERMISSION_TREE` catalog (additive, zero behavior change; parity-tested against FEATURE_PRIVILEGES / FEATURE_TO_PERMISSION_MAP / SIDEBAR_PRIVILEGE_MAP via derive functions) + CFR role-invariant test + route-guard coverage lock. (`useCan()` deferred to Phase 5 — needs a per-node gate set from backend gates.)"
- `packages/shared/CLAUDE.md`: add `permission-tree.ts` to the Live Type Inventory table (now 11 type files) with purpose "single sidebar-anchored permission catalog; derives the 3 legacy permission structures."
- `tasks/todo.md`: log the doc work per CLAUDE.md doc-sync rule.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md packages/shared/CLAUDE.md tasks/todo.md
git commit -m "docs(rbac): record Phase 1 catalog addition + sync shared type inventory

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## After Phase 1

Phase 1 leaves the app behaviorally identical but with a proven single catalog + a
centralized `useCan()`. **Subsequent phases each get their own plan** (their detail
depends on the final tree shape produced here):

- **Phase 2 plan** — close security gaps S1–S8 (default-deny config gating, wrap the 2
  open routes — tighten the Task 1.8 test, gate Report Reviews GETs + notifications
  single-delete + branding/help GETs, fix fail-open exports).
- **Phase 3 plan** — fix FE/BE mismatches M1–M6 (incl. the `CONFIG_UPDATE` role-editing
  escalation).
- **Phase 4 plan** — optional per-page View granularity (new narrow read gates).
- **Phase 5 plan** — add `gate: Permission[]` to `PermissionNode` (from backend gates);
  build `useCan()` over `gate` (deferred from Phase 1, see Task 1.7); switch
  sidebar/route/config-card/button gating + the Roles & Access admin UI onto the tree;
  refactor pages to `useCan()`; retire the standalone `sidebar-privilege-map.ts` (resolves
  Unit A finding I1) and replace the legacy exports with the derived ones.
- **Phase 6 plan** — retire/wire dead `DASHBOARD_*`; final doc + memory + count sync.

---

## Self-Review

**Spec coverage (vs analysis doc):** Phase 1 implements the §4 architecture (single
catalog + `useCan()`), the §6 decision (uppercase canonical), the §7 migration proof
(Task 1.6), and §3.5 hierarchy fix (Task 0.1). Gap-closing (§3.1–3.4) is explicitly
deferred to Phases 2–6 with named plans — not dropped.

**Placeholder scan:** The only intentional "transcribe the rest" is Task 1.1 Step 3,
which is a bounded transcription from a fixed source (analysis §2) with the parity
tests (1.2–1.4) as the completeness oracle — a failing parity test names exactly what's
missing. No `TODO`/`handle edge cases`/vague steps remain.

**Type consistency:** `PermissionNode`/`SidebarGroup` defined in 1.1 are used unchanged
in 1.2–1.5; `resolveNodePermissions` (1.5) is consumed by `useCan` (1.7);
`deriveFeatureToPermissionMap` (1.3) is consumed by the invariant test (1.6). Names
match across tasks.
