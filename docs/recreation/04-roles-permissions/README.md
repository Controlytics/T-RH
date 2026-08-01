# Phase 4 — Roles, Permissions & Access Control

*Counts verified by executing the built `PERMISSION_TREE` module and querying the
live `roles` table, 2026-07-25. Updated 2026-08-01 for the Data Injection (P1)
group — see §10. The `configurable`/`FEATURE_PRIVILEGES` count below was
re-verified 2026-08-01 by rebuilding `packages/shared` and executing the
compiled tree once the branch had settled (no agents mid-edit on
`permission-tree.ts`) — superseding the same-day source-derived pass that
had left it flagged unverified.*

```bash
node -e "const t=require('./dist/types/permission-tree.js');
         const n=t.PERMISSION_TREE.flatMap(g=>g.nodes);
         console.log(n.length, n.filter(x=>x.configurable).length, t.PERMISSION_TREE.length)"
# 2026-07-25: → 38 nodes, 26 configurable, 8 groups
# 2026-08-01: → 54 nodes, 42 configurable, 9 groups
```

---

## 1. The model in one picture

This system has **four distinct concepts** that are easy to conflate. Getting
them wrong is the most likely way a rebuild introduces a privilege leak.

```
┌────────────────────────────────────────────────────────────────────┐
│ PERMISSION_TREE  (packages/shared/src/types/permission-tree.ts)    │
│ 8 sidebar groups → 38 action nodes                                 │
│                                                                    │
│   Each node carries:                                               │
│     gate         → the DISCRIMINATING permission the backend       │
│                    actually checks.  [] means SUPER_ADMIN-only.    │
│     permissions  → the GRANT-EXPANSION set handed out when an      │
│                    admin enables the toggle (includes read deps).  │
│     configurable → is this node an admin-facing toggle? (26 are)   │
│     enforce      → a = enforced today · b = needs a narrow gate    │
│                    c = cosmetic/visibility-only                    │
│     reauthAction → cross-linked step-up action, if any             │
└────────────────────────────────────────────────────────────────────┘
                              │ derived from
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
 FEATURE_PRIVILEGES   FEATURE_TO_PERMISSION_MAP   SIDEBAR_PRIVILEGE_MAP
 (26 admin toggles)   (toggle → permissions[])    (sidebar visibility)
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

## 2. The permission constants (30 → 46 with Data Injection P1)

```bash
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts   # → 46 (2026-08-01; was 30)
```

The 16 added by P1 (§10): `HIERARCHY_{VIEW,CREATE,UPDATE,DELETE}`,
`GATEWAY_{VIEW,CREATE,UPDATE,DELETE}`, `INSTRUMENT_{VIEW,CREATE,UPDATE,DELETE}`,
`COMM_PROFILE_{VIEW,CREATE,UPDATE,DELETE}`.

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

## 3. The 9 sidebar groups and 54 nodes (was 8 groups / 38 nodes before P1)

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
| `data-injection` **(P1, 2026-08-01)** | `hierarchy.view/.create/.edit/.delete`, `gateways.view/.create/.edit/.delete`, `instruments.view/.create/.edit/.delete`, `comm_profiles.view/.create/.edit/.delete` — 16 nodes |

**54 total nodes** (38 + the 16 added by `data-injection`); **42 are
`configurable: true`** (was 26; +16, exactly the Data Injection nodes — all
16 of which are configurable, i.e. all are admin toggles, unlike the pre-P1
groups which mix configurable and enforced-only nodes). The remaining 12
enforced-only nodes are all pre-P1. `FEATURE_PRIVILEGES` (derived from the
`configurable: true` nodes) is therefore **42**, verified 2026-08-01 by
executing the built tree — see the header note above.

**Sidebar items: 10** — the 9 groups above plus `home` (Module Guide), which has
no permission group and is therefore visible-to-all by permission while still
being per-role toggleable on the Sidebar tab.

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

**51 actions across 8 categories** (was 39 across 7 before P1): Backup,
Configuration, Help, Notifications, Role Management, Super Admin, User
Management, **Data Injection** (new, 12 actions — §10).

```bash
grep -cE '^\s+[A-Z_]+:' packages/shared/src/types/reauth-actions.ts   # → 51 (2026-08-01; was 39)
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

## 10. Data Injection (P1) group — landed 2026-08-01

The 9th sidebar group, `data-injection`, backs the new hierarchy / gateway /
instrument / communication-profile foundation
(`../02-inventory/README.md` §11, `../05-database/README.md`). It follows the
existing tree conventions exactly:

- **16 nodes**, 4 per page (`View`/`Add`/`Edit`/`Delete`) × 4 pages
  (Hierarchy, Gateways, Instruments, Communication Profiles).
- **Every node is `enforce: 'a'`** — all 16 are enforced by a real backend
  `requirePermission(...)` gate in the corresponding route file from day one
  (verified against `apps/api/src/modules/{hierarchy,gateways,instruments,
  communication-profiles}/routes.ts`). There is no category-`b`/`c` debt in
  this group.
- **Grant sets follow the same read-dependency pattern as the rest of the
  tree** — e.g. `gateways.create`'s `permissions` includes `GATEWAY_CREATE`
  **and** `GATEWAY_VIEW`, `HIERARCHY_VIEW`, `COMM_PROFILE_VIEW`, because
  creating a gateway requires being able to see the hierarchy node and
  communication profile it references. Per the §1 rule, the `gate` for that
  same node is the single narrow `GATEWAY_CREATE` — the grant set is not used
  for authorization.
- **12 new reauth actions**, one per Create/Update/Delete across the 4 pages
  (`CREATE_HIERARCHY_NODE` … `DELETE_COMM_PROFILE`), all in a new `Data
  Injection` reauth category. View actions carry no reauth action, matching
  every other read-only node in the tree.
- **`visibilityPrivilegeIds`** on the group is `['hierarchy.view',
  'gateways.view', 'instruments.view', 'comm_profiles.view']` — any one of
  the four view permissions makes the sidebar item visible, same pattern as
  every other multi-page group.

No `RoleConfig` seed data grants any of these 16 permissions to any default
role — a site must explicitly enable Data Injection per role, same as
`AUDIT_DELETE` (§5).
