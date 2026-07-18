# Asset vs Filter Permission Duplication — Findings + Consolidation Plan

**Date:** 2026-06-30 (branch RFID)
**Trigger:** User: *"in filters permissions assets permissions and filters permissions are same but repeated with different names — check once."*
**Status:** ✅ DONE (conservative path). User chose **"hide the duplicate toggles"** (not full removal).
Implemented 2026-06-30: `assets.create/edit/delete` PERMISSION_TREE nodes made enforced-only (`configurable`
dropped → removed from the role-config picker). `ASSET_CREATE/UPDATE/DELETE` perm constants KEPT (still in
roles + accepted as backend alternates). FEATURE_PRIVILEGES 99→96; frozen snapshot + counts updated; roles
unchanged (verified: ASSET_* still in `allMappedPerms` via filters.hierarchy_create/bulk_upload/status_update/
equipment_groups.*). Tests: legacy-maps-derived 8/8, permission-tree 21/21, web coverage 8/8, api+web tsc clean.
**Full removal (§4 below) NOT executed** — deferred; would change MAINTENANCE/SUPERVISOR access + need a migration.

### Remaining instance of the same pattern (flagged, not yet actioned)
The RFID toggles are the *same* duplication class: `assets.identifiers.create` ("Assign RFID Tags / Create
Identifiers") + `assets.identifiers.delete` ("Unassign RFID Tags") vs `filters.rfid_manage`
("Assign / Unassign RFID Tags") — backend identifier routes accept `ASSET_IDENTIFIER_*` OR `FILTER_RFID_MANAGE`.
Same fix available (make `assets.identifiers.create/delete` enforced-only, keep `filters.rfid_manage` as the
single toggle). `assets.relationships.create/delete` are NOT duplicates (no filter-side equivalent) — keep.

---

## 1. The finding (confirmed, with receipts)

The Filters page (`sidebarId: 'filter-list'`) role-config shows **two parallel write vocabularies** for the same capability:

| "Asset Management" toggle | grants | "Filters Page Controls" equivalent | grants |
|---|---|---|---|
| Create Assets | `ASSET_CREATE` | Create Filters + Create Block/Area/AHU | `FILTER_CREATE`, `FILTER_HIERARCHY_CREATE` |
| Edit Assets | `ASSET_UPDATE` | Edit Filters + Edit Block/Area/AHU | `FILTER_EDIT`, `FILTER_HIERARCHY_EDIT` |
| Delete Assets | `ASSET_DELETE` | Delete Filters + Delete Block/Area/AHU | `FILTER_DELETE`, `FILTER_HIERARCHY_DELETE` |

These are **the same capability at the enforcement boundary**: every filter/hierarchy create/edit/delete endpoint accepts *either* via `requireAnyPermission(...)`. `ASSET_*` is the original generic-asset layer; `FILTER_*` is the later filter-specific layer. Since this app's only "assets" are filters + hierarchy + equipment, they collapse onto each other.

### Why this is more than UI clutter
The backend create/edit/delete endpoints are **polymorphic** (`POST /api/assets/instances` creates blocks, areas, AHUs, *and* filters). They literally cannot distinguish "create a filter" from "create a block" — so `ASSET_CREATE`, `FILTER_CREATE`, and `FILTER_HIERARCHY_CREATE` are **backend-equivalent**; the only differentiation is which FE dialog opens. The names differ; the granted power does not.

## 2. Complete consumer map of `ASSET_CREATE` / `ASSET_UPDATE` / `ASSET_DELETE`

### 2a. Backend gates (14 total)
**Alternates** (ASSET_* sits beside a FILTER_*/EG_* that already suffices — ASSET_* is redundant here):
- `instance.routes.ts`: POST `/instances` (:263), filter-upload-template (:310), bulk-upload ×2 (:353,:419), PUT `/instances/:id` (:471), DELETE `/instances/:id` (:623)
- `hierarchy/routes.ts`: POST (:305), PUT (:339), DELETE (:372) `/filters`
- `equipment-groups/routes.ts`: test-url (:147), POST (:161), PUT (:186), PATCH active (:213), DELETE (:235)

**🚩 SOLE gate** (only place with no FILTER_*/EG_* alternate):
- `instance.routes.ts:520` — `PATCH /instances/:id/status` → `requirePermission('ASSET_UPDATE')`. **Confirmed orphan: the frontend never calls this path** (FE status changes go through `/lifecycle-state`, gated `FILTER_STATUS_UPDATE`). Sibling `/lifecycle-state` was already moved off `ASSET_UPDATE` in the M1 fix (:563).

### 2b. Equipment groups do NOT route through the generic ASSET_CREATE endpoint
EG instruments are `EquipmentGroupInstrument` rows created/updated/deleted inside `equipment-groups.service.ts` transactions — never via `instanceService`. They're fully reachable through `EG_*` alone. ASSET_* is only an *alternate* on the EG routes.

### 2c. Frontend
**Zero** gating references to the three constants (only an audit-log color map in `audit-helpers.ts`, display-only). The web app gates via `useCan(nodeId)` → tree `gate` arrays; it never names `ASSET_CREATE/UPDATE/DELETE` literally.

### 2d. Default roles (`apps/api/prisma/default-roles.ts`)
| Role | ASSET_CREATE | ASSET_UPDATE | ASSET_DELETE | Also has FILTER_*? |
|---|---|---|---|---|
| SUPER_ADMIN | ✅ | ✅ | ✅ | full FILTER_* (and bypasses checks) |
| ADMIN | ✅ | ✅ | ✅ | full FILTER_* |
| SUPERVISOR | ✅ | — | — | FILTER_CREATE, FILTER_EDIT only |
| MAINTENANCE | ✅ | ✅ | — | **none** — all write power is via ASSET_* |
| OPERATOR | — | — | — | n/a (read + operate) |
| VIEWER | — | — | — | n/a |

### 2e. Catalog / tree / derived
- Constants: `permissions.ts:35-37`; labels `permission-categories.ts:35-37`; `role.service.ts:64-66`.
- Tree nodes with ASSET_* in **gate**: `assets.create/edit/delete`, `assets.relationships.create/delete`, `filters.create/edit/delete`, `filters.hierarchy_edit/delete`.
- Tree nodes with ASSET_* in **grant-expansion** (`permissions`): `assets.create/edit/delete`, `filters.bulk_upload`, `filters.status_update`, `filters.hierarchy_create`, `equipment_groups.create/edit/delete/toggle`.
- Derived + frozen in `__snapshots__/legacy-maps-snapshot.ts` (regenerated, not a separate consumer).

### 2f. Reauth + audit (KEEP — not affected)
- Reauth keys `CREATE_ASSET`/`UPDATE_ASSET`/`DELETE_ASSET` are *separate string constants* still used by the filter/hierarchy routes (paired with `CREATE_FILTER` etc.). Keep.
- Audit actions `ASSET_CREATED`/`UPDATED`/`DELETED` still emitted by `instance.service.ts` + `filter.service.ts` regardless of perms. Keep (21 CFR §11).

## 3. The one real decision: role behavioral impact

Removing `ASSET_*` from the `requireAnyPermission` alternates **changes effective access** for roles whose write power comes (partly or wholly) from `ASSET_*`:

- **MAINTENANCE** — today, via `ASSET_CREATE`+`ASSET_UPDATE`, it *can* create/edit filters, create/edit block/area/AHU, create/edit/toggle equipment groups, bulk-upload, and change status. It holds **no** explicit `FILTER_*`/`EG_*`. Drop `ASSET_*` and MAINTENANCE loses all of that unless we grant the equivalents.
- **SUPERVISOR** — via `ASSET_CREATE` it can also create block/area/AHU and equipment groups and bulk-upload (beyond its explicit `FILTER_CREATE`/`FILTER_EDIT`). Drop `ASSET_CREATE` and those extra creates disappear unless granted.

**Two policies:**
- **Policy 1 — preserve exact behavior (recommended).** Translate each role's `ASSET_*` into the precise `FILTER_*`/`EG_*` set that reproduces today's access. No user sees any change. (MAINTENANCE gains: `FILTER_CREATE, FILTER_HIERARCHY_CREATE, FILTER_BULK_UPLOAD, EG_CREATE, FILTER_EDIT, FILTER_HIERARCHY_EDIT, EG_EDIT, FILTER_STATUS_UPDATE`. SUPERVISOR gains: `FILTER_HIERARCHY_CREATE, FILTER_BULK_UPLOAD, EG_CREATE`.)
- **Policy 2 — retune to intent.** Treat removal as a chance to set MAINTENANCE/SUPERVISOR filter/equipment write perms deliberately (you specify the intended access per role). Risk: changes what those roles can do today.

This is the only choice that needs your input; everything else is mechanical.

## 4. Proposed plan (after decision)

1. **Re-gate the orphan** `PATCH /instances/:id/status`: `ASSET_UPDATE` → `FILTER_STATUS_UPDATE` (mirror M1). Verify FE-unused (done).
2. **Strip `ASSET_CREATE/UPDATE/DELETE`** from all 13 alternate `requireAnyPermission` gates (instance ×6, hierarchy ×3, equipment-groups ×5 — minus the orphan now handled). Each retains its FILTER_*/EG_* alternates.
3. **Remove tree nodes** `assets.create/edit/delete` (pure duplicates of `filters.*` + `filters.hierarchy_*`). Strip `ASSET_*` from the `gate` of `filters.*`/`assets.relationships.*` and from the `permissions` grant-expansion of `filters.bulk_upload/status_update/hierarchy_create` + `equipment_groups.*`.
4. **Remove constants** from `permissions.ts`, `permission-categories.ts`, `role.service.ts` catalog (109→106 perms; FPs 99→96).
5. **Default roles** (`default-roles.ts`): apply the chosen policy (translate or retune).
6. **Regenerate** derived maps + frozen snapshot; update counts in all tests/docs.
7. **Migration** (hand-authored, per migration-driven rule — NOT `db push`): strip `ASSET_CREATE/UPDATE/DELETE` from live `roles.permissions` JSON and add the translated `FILTER_*`/`EG_*` per policy. Idempotent.
8. **Verify:** api+web+shared typecheck; tree/snapshot/CFR tests; targeted runtime curl (a MAINTENANCE-role token creating a filter should still 200 under Policy 1).

**Keep untouched:** `ASSET_VIEW`/`ASSET_READ` (canonical read, load-bearing everywhere), `ASSET_RELATIONSHIP_*`, `ASSET_IDENTIFIER_*`, reauth `*_ASSET` keys, audit `ASSET_*ED` actions.

## 5. Effort / risk
Medium. ~10 files + 1 migration. Risk concentrated in the role translation (§3) and the live-DB migration. Reversible (pre-change git tag). No schema change beyond a JSON-column data migration.
