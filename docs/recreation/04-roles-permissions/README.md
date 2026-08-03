# Phase 4 — Roles, Permissions & Access Control

*Counts verified by executing the built `PERMISSION_TREE` module and querying the
live `roles` table, 2026-07-25. Updated 2026-08-01 for the Data Injection (P1)
group — see §10. The `configurable`/`FEATURE_PRIVILEGES` count below was
re-verified 2026-08-01 by rebuilding `packages/shared` and executing the
compiled tree once the branch had settled (no agents mid-edit on
`permission-tree.ts`) — superseding the same-day source-derived pass that
had left it flagged unverified. Re-verified again 2026-08-01, same day, after
the final whole-branch review (finding I4): 8 of the 16 data-injection nodes
(`gateways.create/edit/delete`, `instruments.edit/delete`,
`comm_profiles.create/edit/delete`) were found to advertise a role-config
toggle with no corresponding UI — `gateways.tsx`/`profiles.tsx`/
`instruments.tsx` are read-only tables — and were switched to
`configurable: false`. Node count and group count are unchanged; only the
configurable count moved, 42 → 34.*

*Re-verified 2026-08-03 for Data Injection (P3, alarms & instrument
liveness) — see §11. Source: `PERMISSION_TREE.flatMap(g => g.nodes)` via the
passing `packages/shared/src/types/__tests__/data-injection-tree.test.ts`
(`'brings the tree to 9 groups and 57 nodes'`), not a rebuild-and-execute
pass like the P1 figures above — the compiled-tree command below was not
re-run this pass, so treat the P3 row as source-derived, consistent with the
test suite, but not cross-checked against `dist/` the way the P1 numbers
were. **Note:** `packages/shared/src/types/permission-tree.test.ts` has 2
pre-existing failures unrelated to P3 (`checklists.submit` gate assertion) —
flagged, not fixed, out of scope for a docs-only pass; does not affect the
P3 counts below, which come from the separate, fully-passing
`data-injection-tree.test.ts`.*

```bash
node -e "const t=require('./dist/types/permission-tree.js');
         const n=t.PERMISSION_TREE.flatMap(g=>g.nodes);
         console.log(n.length, n.filter(x=>x.configurable).length, t.PERMISSION_TREE.length)"
# 2026-07-25: → 38 nodes, 26 configurable, 8 groups
# 2026-08-01 (P1 landed): → 54 nodes, 42 configurable, 9 groups
# 2026-08-01 (I4 fix, same day): → 54 nodes, 34 configurable, 9 groups
# 2026-08-03 (P3, source-derived via test suite): → 57 nodes, 38 configurable, 9 groups
```

---

## 1. The model in one picture

This system has **four distinct concepts** that are easy to conflate. Getting
them wrong is the most likely way a rebuild introduces a privilege leak.

```
┌────────────────────────────────────────────────────────────────────┐
│ PERMISSION_TREE  (packages/shared/src/types/permission-tree.ts)    │
│ 9 sidebar groups → 57 action nodes (2026-08-03; was 38 pre-P1)     │
│                                                                    │
│   Each node carries:                                               │
│     gate         → the DISCRIMINATING permission the backend       │
│                    actually checks.  [] means SUPER_ADMIN-only.    │
│     permissions  → the GRANT-EXPANSION set handed out when an      │
│                    admin enables the toggle (includes read deps).  │
│     configurable → is this node an admin-facing toggle? (38 are)   │
│     enforce      → a = enforced today · b = needs a narrow gate    │
│                    c = cosmetic/visibility-only                    │
│     reauthAction → cross-linked step-up action, if any             │
└────────────────────────────────────────────────────────────────────┘
                              │ derived from
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
 FEATURE_PRIVILEGES   FEATURE_TO_PERMISSION_MAP   SIDEBAR_PRIVILEGE_MAP
 (38 admin toggles)   (toggle → permissions[])    (sidebar visibility)
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

## 2. The permission constants (30 → 46 with Data Injection P1 → 49 with P3)

```bash
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts   # → 49 (2026-08-03; was 46 after P1, 30 pre-P1)
```

The 16 added by P1 (§10): `HIERARCHY_{VIEW,CREATE,UPDATE,DELETE}`,
`GATEWAY_{VIEW,CREATE,UPDATE,DELETE}`, `INSTRUMENT_{VIEW,CREATE,UPDATE,DELETE}`,
`COMM_PROFILE_{VIEW,CREATE,UPDATE,DELETE}`. P2 added none (§11 of
`../06-api/README.md`). The 3 added by P3 (§11 below): `ALARM_VIEW`,
`ALARM_ACKNOWLEDGE`, `ALARM_THRESHOLD_MANAGE`.

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

## 3. The 9 sidebar groups and 57 nodes (54 after P1, 38 pre-P1)

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
| `data-injection` **(P1, 2026-08-01; +3 nodes in P3, 2026-08-03)** | `hierarchy.view/.create/.edit/.delete`, `gateways.view/.create/.edit/.delete`, `instruments.view/.create/.edit/.delete`, `comm_profiles.view/.create/.edit/.delete`, `alarms.view`/`.acknowledge`/`.thresholds` **(P3)** — 19 nodes |

**57 total nodes** (38 pre-P1 + 16 added by P1's `data-injection` group + 3
added by P3's alarm nodes). At P1 landing all 16 data-injection nodes were
`configurable: true`, bringing the total to 42 (was 26; see the superseded
figure in the header note's first bullet). As of the same-day I4 fix, 8 of
the 16 P1 nodes — `gateways.create/.edit/.delete`, `instruments.edit/.delete`,
`comm_profiles.create/.edit/.delete` — were switched to `configurable: false`
because `gateways.tsx`, `profiles.tsx` and `instruments.tsx` were read-only
tables (only `hierarchy.tsx` had full CRUD; `instrument-wizard.tsx` had
Create only) — granting those 8 toggles produced no button anywhere. Their
permission constants, `gate`, and enforced backend routes were unchanged;
only the picker-visible toggle was removed pending later UI work.

**P3 (2026-08-03) moved the count to 38 configurable, two ways at once:**
- **`instruments.edit` flipped `false → true`** (2026-08-01's I4 fix →
  2026-08-03) — the instrument detail page now edits
  `Instrument.expectedIntervalSec`, the field that switches liveness
  monitoring on for that instrument. Leaving the toggle hidden would have
  meant only `SUPER_ADMIN` could ever enable liveness on any instrument —
  "that is how the liveness half came to ship dark," per the test comment
  that documents this fix
  (`data-injection-tree.test.ts`). `gateways.create/.edit/.delete`,
  `instruments.delete`, `comm_profiles.create/.edit/.delete` remain
  `configurable: false` (7 total, down from 8) — still no create/delete UI
  for gateways or comm profiles, and no delete UI for instruments.
- **All 3 new P3 alarm nodes ship `configurable: true`** — unlike the P1
  nodes above that were hidden for want of UI, `alarms.view`,
  `.acknowledge`, and `.thresholds` each surface a real control (the alarm
  queue, the acknowledgement dialog, and the threshold editor — Task 13).

`8 (P1 baseline) + 1 (instruments.edit flip) + 3 (new alarm nodes) = 12`
configurable data-injection nodes, on top of the pre-P1 26, giving
`FEATURE_PRIVILEGES` = **38** (26 + 12), verified 2026-08-03 via the
`data-injection-tree.test.ts` assertions (`12` configurable / `7`
not-configurable within the group; `57`/`9` for the whole tree).

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

**53 actions across 8 categories** (51 across 8 after P1, was 39 across 7
before P1): Backup, Configuration, Help, Notifications, Role Management,
Super Admin, User Management, Data Injection (12 actions at P1 — §10 — +2
more in P3 — §11 — = 14).

```bash
grep -cE '^\s+[A-Z_]+:' packages/shared/src/types/reauth-actions.ts   # → 53 (2026-08-03; was 51 after P1, 39 pre-P1)
```

Re-auth is an **orthogonal axis** to permissions: a permission answers *may you*,
a re-auth action answers *prove it is you, now*. Which actions require re-auth
is admin-configurable via the `action-reauth` config surface, and enforced by
`enforceReauth()` in 19 module route files.

**One exception to "admin-configurable": `ACKNOWLEDGE_ALARM` is always-on**
(§11) — the only action in the entire system, as of P3, where the config
surface itself refuses to let an administrator turn the challenge off.

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

## 11. Data Injection (P3) — alarms & instrument liveness, landed 2026-08-03

3 new nodes in the existing `data-injection` group (§3), no new group, no
new sidebar item. Detail: [`../02-inventory/README.md`](../02-inventory/README.md)
§12, [`../06-api/README.md`](../06-api/README.md) §10,
[`../05-database/README.md`](../05-database/README.md) §13.

**The 3 nodes**, all `enforce: 'a'`, all `configurable: true`:

| Node | Gate | Permissions (grant set) | Reauth action |
|---|---|---|---|
| `alarms.view` | `ALARM_VIEW` | `ALARM_VIEW`, `INSTRUMENT_VIEW` | — (read-only, matching every other `.view` node) |
| `alarms.acknowledge` | `ALARM_ACKNOWLEDGE` | `ALARM_ACKNOWLEDGE`, `ALARM_VIEW` | `ACKNOWLEDGE_ALARM` (always-on, see below) |
| `alarms.thresholds` | `ALARM_THRESHOLD_MANAGE` | `ALARM_THRESHOLD_MANAGE`, `ALARM_VIEW`, `INSTRUMENT_VIEW` | `MANAGE_ALARM_THRESHOLD` (normal, admin-configurable) |

**`alarms.acknowledge`'s gate is deliberately narrow** — `['ALARM_ACKNOWLEDGE']`
alone, not widened to include `ALARM_VIEW`. Asserted directly in
`data-injection-tree.test.ts`: *"Reading a deviation is not signing it off
(§11.50). If the gate ever widened to include ALARM_VIEW, every viewer would
see the Acknowledge button — the backend would still 403, but the UI would
lie."* This is the same "gate is the single discriminating permission, never
the grant set" rule from §1, applied to the one node in this codebase where
getting it wrong would visually misrepresent who can sign a record.

**`alarms.view` is a required member of the group's `visibilityPrivilegeIds`.**
Without it, a role granted only the 3 alarm permissions (and none of the
pre-existing hierarchy/gateway/instrument/comm-profile view permissions)
would have the `data-injection` sidebar item hidden entirely — the alarms
page is reachable from the Data Injection hub and by no other route, so a
role scoped purely to "review and acknowledge alarms" would have no nav path
to it without this. Test-asserted in `data-injection-tree.test.ts`
alongside the pre-existing `hierarchy.view`/`gateways.view`/
`instruments.view`/`comm_profiles.view` entries.

### `ACKNOWLEDGE_ALARM` — the one always-on reauth action in the system

Every other reauth-gated action in this codebase is **admin-configurable**:
`enforceReauth(action)` consults the `action-reauth` config surface and
skips the password challenge entirely if an administrator hasn't turned it
on for the caller's role. `ACKNOWLEDGE_ALARM` breaks that pattern on
purpose, at three layers, not just one:

1. **The route** (`POST /api/alarms/:id/acknowledge`) calls
   `enforceReauthAlways`, not `enforceReauth` — see
   [`../06-api/README.md`](../06-api/README.md) §10.
2. **The declaration** carries `alwaysOn: true` in
   `packages/shared/src/types/reauth-actions.ts`'s `REAUTH_ACTIONS` map;
   `ALWAYS_ON_REAUTH_ACTIONS` is *derived* from that flag (not hand-listed),
   so a future action marked `alwaysOn: true` picks up the same treatment
   automatically. `isAlwaysOnReauthAction()` is consumed by both
   `apps/api/src/lib/reauth-check.ts` (backend enforcement) and
   `apps/web/src/hooks/use-reauth.ts` (frontend — so the re-auth dialog
   can't be dismissed as optional for this action either).
3. **The config schema actively rejects it.** `actionReauthConfigSchema`
   (`packages/shared/src/schemas/action-reauth.ts`) filters
   `ALWAYS_ON_REAUTH_ACTIONS` out of its valid-keys set, so a `PUT` to the
   `action-reauth` config surface containing an `ACKNOWLEDGE_ALARM` key —
   whether from a malicious client or a stale admin UI — fails validation
   outright rather than being silently accepted and ignored. Both reauth
   editors additionally render it as a locked row (always-required,
   non-interactive) rather than omitting it, so an administrator or an
   inspector reading the config UI sees the true policy instead of an
   absent row that could be misread as "not required."

This is a §11.50 property, not a UI nicety: acknowledgement of an alarm IS
the electronic signature the regulation requires, so the system does not
expose a control surface — anywhere, backend or frontend — that could turn
the signature into an optional courtesy. `MANAGE_ALARM_THRESHOLD` (setting a
limit) has no such restriction — it's an ordinary, admin-configurable reauth
action, because configuring a threshold is an engineering decision, not a
signed disposition.
