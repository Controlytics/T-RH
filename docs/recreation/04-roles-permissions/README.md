# Phase 4 — Roles, Permissions & Access Control

*Counts verified by executing the built `PERMISSION_TREE` module and querying the
live `roles` table, 2026-07-25; re-verified 2026-08-05 after the instruments
registry added a 9th group.*

```bash
node -e "const t=require('./dist/types/permission-tree.js');
         const n=t.PERMISSION_TREE.flatMap(g=>g.nodes);
         console.log(n.length, n.filter(x=>x.configurable).length, t.PERMISSION_TREE.length)"
# → 42 nodes, 30 configurable, 9 groups
```

---

## 1. The model in one picture

This system has **four distinct concepts** that are easy to conflate. Getting
them wrong is the most likely way a rebuild introduces a privilege leak.

```
┌────────────────────────────────────────────────────────────────────┐
│ PERMISSION_TREE  (packages/shared/src/types/permission-tree.ts)    │
│ 9 sidebar groups → 42 action nodes                                 │
│                                                                    │
│   Each node carries:                                               │
│     gate         → the DISCRIMINATING permission the backend       │
│                    actually checks.  [] means SUPER_ADMIN-only.    │
│     permissions  → the GRANT-EXPANSION set handed out when an      │
│                    admin enables the toggle (includes read deps).  │
│     configurable → is this node an admin-facing toggle? (30 are)   │
│     enforce      → a = enforced today · b = needs a narrow gate    │
│                    c = cosmetic/visibility-only                    │
│     reauthAction → cross-linked step-up action, if any             │
└────────────────────────────────────────────────────────────────────┘
                              │ derived from
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
 FEATURE_PRIVILEGES   FEATURE_TO_PERMISSION_MAP   SIDEBAR_PRIVILEGE_MAP
 (30 admin toggles)   (toggle → permissions[])    (sidebar visibility)
```

`FEATURE_PRIVILEGES`, `FEATURE_TO_PERMISSION_MAP`, and `SIDEBAR_PRIVILEGE_MAP`
were once hand-maintained; they are now **derived**, and a frozen-snapshot test
(`legacy-maps-derived.test.ts` + `__snapshots__/legacy-maps-snapshot.ts`) locks
the derivation so drift fails CI.

### ⚠ The single most important rule

> **Grant set ≠ gate.** Never OR over a node's `permissions` (or
> `resolveNodePermissions`) as an authorisation check — it includes read
> dependencies and will over-grant.

Authorisation checks **must** use `gate`:
- Frontend: `useCan('<node-id>')` (`apps/web/src/hooks/use-can.ts`)
- Backend: `requirePermission(...)` / `requireAnyPermission(...)`

**This has already caused a real privilege leak.** Broad `ASSET_*` permissions
sat in several toggles' grant sets; granting "Update Status" handed out
`ASSET_UPDATE`, which satisfied the *edit* gate — lighting up every edit control
and creating a genuine backend escalation. The fix was to remove the broad perms
from the grant sets. A rebuild must keep the two sets structurally separate,
ideally with types that make mixing them impossible.

## 2. The 34 permission constants

```bash
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts   # → 34
```

| Domain | Constants |
|---|---|
| Users (7) | `USER_CREATE`, `USER_READ`, `USER_UPDATE`, `USER_DELETE`, `USER_ENABLE_DISABLE`, `USER_UNLOCK`, `USER_RESET_PASSWORD` |
| Config (3) | `CONFIG_READ`, `CONFIG_UPDATE`, `FIELD_ID_UPDATE` |
| Roles (1) | `ROLE_MANAGE` |
| Audit (3) | `AUDIT_READ`, `AUDIT_EXPORT`, `AUDIT_DELETE` |
| Notifications (5) | `NOTIFICATION_VIEW`, `NOTIFICATION_CREATE`, `NOTIFICATION_UPDATE`, `NOTIFICATION_DELETE`, `NOTIFICATION_MANAGE` |
| Dashboards (4) | `DASHBOARD_CREATE`, `DASHBOARD_MANAGE`, `DASHBOARD_VIEW`, `DASHBOARD_ASSIGN` |
| Debug (2) | `READ_DEBUG_TRACE`, `MANAGE_DEBUG_TRACE` |
| Backup (3) | `BACKUP_MANAGE`, `BACKUP_EXPORT`, `BACKUP_RESTORE` |
| Admin requests (2) | `ADMIN_REQUEST_APPROVE`, `ADMIN_REQUEST_REJECT` |
| Instruments (4) | `INSTRUMENT_READ`, `INSTRUMENT_CREATE`, `INSTRUMENT_UPDATE`, `INSTRUMENT_DELETE` |

## 3. The 9 sidebar groups and 42 nodes

| Group | Nodes |
|---|---|
| `dashboard` | `dashboard.view`, `.create`, `.manage`, `.assign` |
| `users` | `users.view`, `.create`, `.edit`, `.delete`, `.enable_disable`, `.unlock`, `.reset_password` |
| `admin-requests` | `admin_requests.approve`, `.reject` |
| `configuration` | `config.view`, `.edit`, `.field_ids`, `roles.manage`, `backup.export`, `.restore`, `roles.view`, `.create`, `.edit`, `.delete`, `.assign_permissions`, `.configure_sidebar`, `.configure_reauth` |
| `notifications` | `notifications.view`, `.manage`, `.delete`, `.mark` |
| `audit` | `audit.view`, `.export`, `.redact`, `.delete`, `.verify_chain` |
| `system-health` | `system_health.view` |
| `debug-traces` | `debug.view`, `.manage` |
| `instruments` | `instruments.view`, `.create`, `.edit`, `.delete` |

**42 total nodes; 30 marked `configurable: true`** and therefore surfaced as
admin toggles. The other 12 are *enforced-only*: the permission is still checked
by the backend, but there is no per-role toggle for it (either because it
duplicates another toggle's capability, or because it is SUPER_ADMIN-only).

**Sidebar items: 10 groups' worth, 9 registered** — `SIDEBAR_ITEMS` holds the 8
original groups plus `home` (Module Guide), which has no permission group and is
therefore visible-to-all by permission while still being per-role toggleable on
the Sidebar tab. The `instruments` group exists in `PERMISSION_TREE` but is
deliberately NOT yet in `SIDEBAR_ITEMS` — its pages do not exist until Instruments
Task 9/10, so a toggle for it would point at nothing.

## 4. The `enforce` taxonomy

Each node is tagged with how genuinely enforced it is. A rebuild should aim to
eliminate categories **b** and **c**.

| Tag | Meaning | Rebuild action |
|---|---|---|
| `a` | Enforced by a real backend gate today | Keep as-is |
| `b` | Would need a new narrower backend gate to be real | Implement the gate |
| `c` | Cosmetic / visibility-only — enforced by **no** route | Enforce it or delete it |

Known category-`c` cases: `notifications.view` and `notifications.manage`. Their
permissions are checked by no route (notification endpoints are user-scoped and
auth-only). They are honest visibility toggles, and are tagged accordingly
rather than pretending to be security controls. **This honesty is a feature of
the current design and should be preserved** — a rebuild must not silently
present cosmetic toggles as authorisation.

## 5. Roles

Live table (`select name, hierarchy_level, jsonb_array_length(permissions) from roles`):

| Role | Level | Permission count | Intent |
|---|---|---|---|
| `SUPER_ADMIN` | 6 | 29 | System owner. Bypasses frontend checks. |
| `ADMIN` | 5 | 26 | Day-to-day administration |
| `SUPERVISOR` | 4 | 4 | Oversight / read + limited approve |
| `MAINTENANCE` | 3 | 3 | Operational maintenance |
| `OPERATOR` | 2 | 3 | Routine use |
| `VIEWER` | 1 | 3 | Read-only |

**SUPER_ADMIN holds 29 of 30** — it does **not** hold `AUDIT_DELETE`. That
permission is granted to no role by default, deliberately: it is the only
operation that permanently breaks the audit chain, so enabling it is an explicit
site decision.

Custom roles can be created and appear automatically throughout the UI
(including the Module Guide) with their own colour.

### Per-role configuration

`RoleConfig` stores, per role: `sidebar_items` (jsonb), `home_widgets` (jsonb),
`permissions` (jsonb). Per-user overrides live in `UserConfig`. The effective
set is role config merged with user config, exposed at
`GET /api/config/my-config`.

## 6. Frontend enforcement

**Button/action gating** — `useCan('<node-id>')`, used across ~19 pages. It
resolves the node's `gate` and ORs it against the user's permissions, with a
SUPER_ADMIN bypass.

**Sidebar visibility** — `isSidebarItemVisible()` over the tree. An item with no
tree group and no visibility privileges defaults to **visible** (e.g. `home`).
A rebuild must keep this default, or new sidebar items silently disappear.

**Route guards** — `<RequireRole permissions={[PERMISSIONS.X]}>` in `main.tsx`.

**Legacy pattern** — the older inline `isSuperAdmin || perms.includes(...)`
remains for non-button logic (data-layer queries, workflow-role checks). A
rebuild should converge everything on `useCan`.

## 7. Re-authentication actions

**40 actions across 8 categories**: Backup, Configuration, Help, Instruments,
Notifications, Role Management, Super Admin, User Management.

```bash
grep -cE '^\s+[A-Z_]+:' packages/shared/src/types/reauth-actions.ts   # → 40
```

Re-auth is an **orthogonal axis** to permissions: a permission answers *may you*,
a re-auth action answers *prove it is you, now*. Which actions require re-auth
is admin-configurable via the `action-reauth` config surface, and enforced by
`enforceReauth()` in 19 module route files.

**Rebuild caution.** Upstream carried three re-auth actions that no endpoint ever
enforced — pure theatre in the config UI. They were removed. A rebuild should
add a test asserting **every declared re-auth action is referenced by at least
one route**, so theatre cannot reappear.

## 8. Access-matrix endpoint

`GET /api/roles/access-matrix` returns active roles + their permissions +
per-role sidebar config. It is **authenticated but not `ROLE_MANAGE`-gated**,
because the Module Guide shows every user which roles perform which steps. This
is an intentional transparency decision, not an oversight — but a rebuild should
confirm it exposes no permission the viewer could not already infer.

## 9. Rebuild checklist

1. Model `gate` and `permissions` as **distinct types**, so they cannot be
   swapped at a call site.
2. Keep the tree the single source of truth; keep all maps derived.
3. Keep the frozen-snapshot drift test.
4. Add a test: every re-auth action is enforced by ≥1 route.
5. Add a test: every `enforce: 'a'` node's `gate` appears in a real route guard.
6. Preserve "no tree group ⇒ visible" as the sidebar default.
7. Keep `AUDIT_DELETE` unassigned by default.
8. Preserve the honest `enforce: 'c'` tagging rather than hiding cosmetic toggles.
