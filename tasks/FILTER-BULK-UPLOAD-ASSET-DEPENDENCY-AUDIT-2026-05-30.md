# Filter Bulk Upload — Asset/Entity Dependency Audit & Root Cause

**Date:** 2026-05-30 · **Branch:** RFID

## TL;DR (brutally honest)

The "Parent connections reached" error is **not a bulk-upload bug** — it is the symptom of a deeper truth: **filters are still stored as `asset_instances` with `asset_relationships`, governed by `asset_templates`.** The A-01 work done so far (Slice 1 single-create + Slice 2 bulk upload) changed the **API surface** (the operator no longer sends `templateId`/`attributes`) but **did not change the persistence substrate**. Every filter — bulk OR single — is still created by `instanceService.create()`, which writes an asset instance, two asset relationships, and validates the parent's asset-template connection limit.

The typed `filters` / `ahus` / `areas` / `blocks` tables exist, but for filter **creation** they are **populated by a database trigger** (`fn_mirror_asset_instance`) off the `asset_instances` write — they are a mirror, not the write target. Making the Filter module truly standalone = finishing A-01 Phase 2–5 (a multi-day migration), not a one-line fix.

---

## 1. Root Cause of "Parent connections reached"

**File:** `apps/api/src/modules/assets/services/instance.service.ts:33-37`

```ts
const parentMax = (parentTemplate as any)?.maxConnections ?? 10;
if (parentMax > 0) {
  const parentUsed = await relationshipRepository.countBySourceAsset(parentId);
  if (parentUsed >= parentMax) {
    throw new ValidationError(`Parent entity has reached max connections (${parentUsed}/${parentMax})`);
  }
}
```

- The **AHU's asset template** carries `max_connections = 10` (verified in DB: `AHU-E` template `max_connections=10`).
- `validateParent()` counts existing `asset_relationships` of type `CONTAINS` under the AHU and throws when the count reaches 10.
- Bulk upload calls `instanceService.create()` **once per row**; each call runs `validateParent(ahuId, filterTemplateId)`.
- Live DB shows the busiest AHU already has **9** CONTAINS children — uploading 2+ filters to it trips `10/10`.

**Chain:** `bulk-upload-filter.service.ts` → `instanceService.create()` (line 214 of bulk service) → `validateParent()` (instance.service.ts:88) → throw (instance.service.ts:36).

This limit is a **legacy asset-template concept**. In the typed model an AHU→Filter link is just a `filters.ahu_id` FK with no inherent cap, so the limit is meaningless for filters.

---

## 2. Files / classes causing the issue

| File | Role in the problem |
|---|---|
| `apps/api/src/modules/assets/services/instance.service.ts` | `validateParent()` (connection-limit throw) + `instanceService.create()` (writes asset_instances + asset_relationships) — **the universal create path for filters** |
| `apps/api/src/modules/assets/services/bulk-upload-filter.service.ts` | Calls `instanceService.create()` per row (line ~214) |
| `apps/api/src/modules/assets/services/filter-fields.service.ts` | `resolveFilterTemplateRef()` — resolves the FILTER **asset_template** id that the create requires |
| `apps/api/src/modules/hierarchy/hierarchy.service.ts` | `createFilter()` (single-create) — also delegates to `instanceService.create()` |
| `apps/api/src/modules/assets/repositories/relationship.repository.ts` | `countBySourceAsset()` (the count used in the limit) + CONTAINS/CONTAINED_IN pair create |
| `apps/api/src/modules/assets/repositories/template.repository.ts` | Stores `maxConnections` / `maxParentConnections` on asset templates |
| DB trigger `fn_mirror_asset_instance` | Mirrors the asset_instances write into the typed `filters` table |

---

## 3. Exact code locations where Asset/Entity logic runs for a filter create

`instanceService.create()` (`instance.service.ts`), per filter row:

1. **`templateRepository.findById(data.templateId)`** (line 72) — loads the FILTER **asset_template**.
2. Duplicate-name check on **`asset_instances`** (lines 76-79).
3. `validateAttributeValues(...)` against template `attributeSchema` (lines 82-85) — empty for FILTER, skipped.
4. **`validateParent(ahuId, templateId)`** (line 88) → connection-limit throw (lines 17-41). ← **the error**
5. **`tx.assetInstance.create(...)`** (line 96) — writes **`asset_instances`** (with `templateId`, `parentId`, `attributes` JSON).
6. **`tx.filterDetails.create(...)`** (line 134) — **`filter_details`** sidecar (`filterSet`, `filterProfileId`).
7. **`tx.assetRelationship.create(...)` × 2** (lines 145-148) — **`asset_relationships`** `CONTAINS` + `CONTAINED_IN` ("parent connections").
8. `auditLog('ASSET_RELATIONSHIP_CREATED')` (lines 157-166) + `auditLog('ASSET_CREATED', targetType:'asset_instance')` (lines 169-177).
9. `if (template.dataIngestionEnabled)` → UNS mapping + `device_credentials` + `connectivity_status` (lines 180-214). **Does NOT fire for filters** (FILTER template has `dataIngestionEnabled=false`), but is a latent dependency if that flag is ever set.
10. **DB trigger `fn_mirror_asset_instance`** fires on the `asset_instances` insert → upserts the typed **`filters`** row (`ahu_id` from parent).

Then `bulk-upload-filter.service.ts` calls **`identifierService.create(...)`** → **`asset_identifiers`** (RFID).

---

## 4. Database tables involved in a single bulk-created filter

| Table | Written? | Legacy or typed |
|---|---|---|
| `asset_instances` | ✅ direct | **legacy** (this is the real row) |
| `asset_templates` | read (FK target) | **legacy** (FILTER template required; `templateId` is NOT NULL) |
| `asset_relationships` | ✅ direct (CONTAINS + CONTAINED_IN) | **legacy** (the "parent connections") |
| `filter_details` | ✅ direct | filter sidecar (keyed by `asset_instance_id`) |
| `asset_identifiers` | ✅ direct (if rfidTag) | legacy identifier table |
| `filters` (typed) | ✅ **via trigger only** | typed mirror — NOT the write target |
| `device_credentials`, `connectivity_status` | only if `dataIngestionEnabled` | legacy (not for filters today) |

---

## 5. Why it is "still using old Asset/Entity logic" — the honest architectural reason

- `AssetInstance.templateId` is **NOT NULL** → a FILTER `asset_template` must exist and be referenced on every create.
- The typed `filters` table is **populated by the trigger** off `asset_instances`; there is **no direct filter-write path** in the create flow (`instanceService.create` uses `tx.assetInstance.create`, not `dispatchCreate`).
- **Readers are split:** `apps/web/src/routes/filter-management/filter-operations.tsx` reads the **typed** `/api/hierarchy/filters` (migrated in A-01 Cluster Step 4), but **`filter-list.tsx`** (the page hosting Bulk Upload) and others still read **legacy** `/api/assets/instances`. So a filter must exist in `asset_instances` to be visible there.

Net: the Filter module is **not yet independent**; it sits on the asset/entity substrate. Slice 1/2 cut the operator-facing surface, not the storage.

---

## 6. Recommended fixes — two tiers

### Tier 1 — Immediate unblock (small, low-risk): stop applying the asset connection-limit to filters

The connection-limit is meaningless for AHU→Filter. Options (in order of preference):

- **(a) Code (recommended):** in `validateParent()`, skip the `maxConnections` check when the **child template kind is `FILTER`** (or when the parent kind is `AHU`). ~5 lines. Unblocks bulk + single immediately; no data migration; no risk to other kinds.
- **(b) Data:** `UPDATE asset_templates SET max_connections = 0 WHERE template_kind = 'AHU';` — `0` disables the check (`if (parentMax > 0)`). One statement, but applies to all AHU children and is a per-install data change (won't propagate to other DBs).
- **(c)** Both — code guard for correctness everywhere + data fix for existing installs.

This removes the **symptom** but filters remain asset_instances (Tier 2 is the real ask).

### Tier 2 — Standalone Filter module (large = A-01 Phase 2–5)

Make filter create/read/update/delete operate on the typed `filters` + `filter_details` tables directly, with an `ahu_id` FK and **no** `asset_instances` / `asset_relationships` / `asset_templates` / `validateParent`. This requires:

1. A dedicated **`filterService.create()`** writing `filters` (+ `filter_details`) directly — no template lookup, no relationships, no connection limit.
2. Migrate **all remaining readers** off `/api/assets/instances` to `/api/hierarchy/filters` (notably `filter-list.tsx`, mobile wrappers, data-management console) — otherwise typed-only filters become invisible.
3. Retire the `fn_mirror_asset_instance` trigger's FILTER branch and the dual-write once no one reads the legacy table.
4. Backfill/relax the `FilterDetails` → `filters` merge (schema.prisma:514-520 notes the four cycle columns will re-home into `filters`).
5. Drop the FILTER `asset_template` requirement.

This is exactly the scope in `tasks/A-01-PHASE-2-PLAN.md` (107 `prisma.assetInstance` sites across 39 files) + the cluster read-migration plan. It is **engineer-days**, not a quick patch, and must keep the dual-write consistent until every reader moves.

---

## 7. Legacy code/dependencies to remove from the Filter module (Tier 2 endgame)

- `validateParent()` + `maxConnections`/`maxParentConnections` for filters (asset-template connection limits).
- `asset_relationships` CONTAINS/CONTAINED_IN creation for filters (replaced by `filters.ahu_id` FK).
- FILTER `asset_template` + `templateId`/`templateVersion`/`attributes` JSON on the filter row (replaced by concrete columns + `filter-field-options` config).
- The `fn_mirror_asset_instance` FILTER branch + the dual-write.
- `asset_identifiers` could stay (generic) or move to a filter-owned `rfid`/identifier table.
- Every `/api/assets/instances` read in the filter UI.

---

## Recommendation

Do **Tier 1 (a)** now to unblock bulk upload (filters should never hit an asset connection cap). Treat **Tier 2** as the real "standalone Filter module" deliverable and schedule it as the next A-01 phase with its own plan — it is the only thing that truly removes the asset/entity dependency, and it must move the readers in lockstep to avoid making filters invisible.
