# Multiple Equipment Groups per Block — Design

**Date:** 2026-07-16
**Branch:** RFID
**Status:** IMPLEMENTED 2026-07-16 (commit `2183090`)

> **Implemented.** create()-always-active; `setActive()` + `PATCH /:id/active`
> removed; `equipment_groups.toggle` tree node removed (non-configurable → no
> count change, frozen snapshot untouched); web config toggle UI removed; runtime
> unchanged (dialog picker + `assertSingleEquipmentGroupPerBlock` safety net).
> Existing inactive groups left as-is. Tests: delete()-guard (9) + create-active
> (2). API 1203/0 (119 files), web 600/0 (45).

## Problem

Today a block may have at most **one active equipment group**. Enabling a group
via the config Enable/Disable toggle flips every other group in the block off.
The user wants **multiple equipment groups available per block at once**, and the
Enable/Disable option **removed entirely**.

## Key insight — the runtime already supports multiple groups

The single-active restriction lives only on the **config** side. The cleaning
runtime already copes with multiple groups:

- The equipment dialog (`components/equipment-dialog.tsx:186-202`) renders a
  **group picker** over `dialog.groups` whenever the cycle is not yet bound to a
  group — the operator selects which group to record readings against.
- `advance.ts` binds the chosen group to the cycle (`cycle.equipmentGroupId`);
  subsequent readings stages reuse that pinned group.
- `assertSingleEquipmentGroupPerBlock` (`MULTIPLE_EQUIPMENT_GROUPS`) only fires
  in the auto-resolve *fallback* (`!cycleGroupId` AND >1 active group) — i.e.
  when a group wasn't selected. It stays as a **safety net**: "please select
  one" is the correct response there.

So the fix is to remove the config restriction; the operator-picks-per-cleaning
flow the user chose is already built.

## Decisions (approved with the user)

- **Remove Enable/Disable entirely** — no toggle. Every non-deleted group is
  always available.
- **Operator picks the group per cleaning** — the existing dialog picker; no new
  UI.
- **Existing inactive groups: leave as-is** (safe default). `isActive=false` is
  ambiguous — it means BOTH "disabled by the old toggle" AND "soft-deleted by
  delete()" (delete sets `isActive=false` through its own EG_DELETE-gated path).
  We cannot distinguish them, so we do NOT blanket-reactivate (that would
  resurrect deleted groups). Currently-active groups stay available; multiple can
  now coexist going forward. A specific disabled group can be reactivated on
  request by id.

## Changes

### Backend
1. `equipment-groups.service.ts` `create()`: **always create active.** Remove the
   "create INACTIVE if the block already has an active group" logic (and the now-
   moot single-active race comment + partial-unique-index note). New groups are
   `isActive: true`.
2. `equipment-groups.service.ts`: **remove `setActive()`** (the enable/disable +
   flip-others-off method) and its `assertSafeToDeactivate('disable', ...)` use.
   Delete (`delete()`, soft-delete via its own path) is unchanged.
3. `equipment-groups/routes.ts`: **remove the `PATCH /:id/active` route.**
4. Keep `assertSingleEquipmentGroupPerBlock` and the runtime auto-resolve as-is
   (safety net + single-group convenience). No runtime behavior change.

### Frontend
5. `routes/config/equipment-groups.tsx`: **remove the Enable/Disable toggle UI** —
   `handleToggleActive`, `canToggle`, the confirm dialog ("this disables N other
   groups"), and the active/inactive card dimming (`opacity-70`, the grey header
   bar for inactive). Cards render uniformly "available". `includeInactive` in the
   list fetch may stay (harmless) or be dropped; groups shown are the active set.

### Shared permission tree
6. `packages/shared/src/types/permission-tree.ts`: **remove the
   `equipment_groups.toggle` node** (line ~673, action `Enable/Disable`, gate
   `EG_EDIT`). There is **no separate permission constant** (`EG_TOGGLE` does not
   exist — the node reused `EG_EDIT`), so only the tree node goes.
   **CORRECTION (verified in code):** this node is **not `configurable`**, and
   both `deriveFeaturePrivileges` and `deriveFeatureToPermissionMap` filter
   `configurable === true`. So the derived `FEATURE_PRIVILEGES` /
   `FEATURE_TO_PERMISSION_MAP` counts (**83**) do **not** change, and the
   frozen-snapshot test in `legacy-maps-derived.test.ts` needs **no edit**. The
   node is consumed only by the frontend `useCan('equipment_groups.toggle')`,
   which is removed in step 5. Still rebuild `@digilog/shared` and run its tests
   to confirm (`permission-tree.test.ts` asserts id-uniqueness only). If it's
   listed in `CONFIGURABLE_PRIVILEGE_ORDER`, remove it there too (the map derive
   skips it regardless, but keep the list clean). `EG_EDIT` stays.

### Docs + build
7. CHANGELOG + this spec marked implemented; root/api/web CLAUDE.md counts if the
   feature-privilege total is quoted; rebuild web `dist` + APK (config page + the
   permission-derived maps are bundled).

## Testing

- **Backend unit/e2e:** `create()` on a block that already has an active group →
  the new group is `isActive: true` (was `false`). `PATCH /:id/active` route is
  gone (404). Existing create/edit/delete tests still pass.
- **Shared:** the frozen-snapshot test updated to the new feature-privilege count;
  `npm run build -w @digilog/shared` clean.
- **Runtime (regression):** the `assertSingleEquipmentGroupPerBlock` +
  instrument-resolution tests still pass unchanged (the guard is untouched). A
  block with two active groups → the equipment dialog shows both and readings
  validate against the selected one (covered by existing dialog behavior; add a
  focused test only if a cheap one exists).
- **No-regression:** full API + web suites vs current baselines (API 1204/118,
  web 600/44). Web build + APK.

## Touch points

- `apps/api/src/modules/equipment-groups/equipment-groups.service.ts` (create,
  remove setActive)
- `apps/api/src/modules/equipment-groups/routes.ts` (remove PATCH /:id/active)
- `apps/web/src/routes/config/equipment-groups.tsx` (remove toggle UI)
- `packages/shared/src/types/permission-tree.ts` (remove node) + the
  frozen-snapshot test + `npm run build -w @digilog/shared`
- Any test referencing `setActive` / `PATCH /:id/active` / `equipment_groups.toggle`
- Docs + `dist`/APK rebuild

## Out of scope / risks

- **No data migration.** Existing inactive groups untouched (decision above).
- **No runtime rewrite** — multi-group cleaning already works; we only unlock it.
- **Concurrency note retired:** the create-time single-active race + the
  can't-build-partial-unique-index note (block MUPS already has two active
  groups) become moot — multiple active is now the intended state.
- Confirm no other caller of `setActive` / `PATCH /:id/active` exists before
  removing (grep during implementation).
