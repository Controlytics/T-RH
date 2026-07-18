# Step 6 — FilterDetails 1:1 split (plan + execution doc)

**Goal:** move `filterProfileId`, `currentLifecycleState`, `currentCycleId`, `filterSet` from `AssetInstance` to a new 1:1 `FilterDetails` table. These fields are meaningless for non-filter rows; the join keeps AssetInstance generic.

**Standing rules:** DB resets OK; Q4 — no commits until told; auto-mode active.

---

## Inventory totals (live grep at start)

- **Backend:** 124 occurrences across 11 files
- **Frontend:** 99 occurrences across 15 files
- **Schema/seed/migrations:** counted within backend

Hot spots:
- `apps/api/src/modules/filter-operations/filter-operations.service.ts` — 68 occurrences (55% of backend)
- `apps/api/src/modules/assets/services/bulk-upload-filter.service.ts` — 12
- `apps/api/src/modules/pm-schedules/pm-schedule.service.ts` — 12
- `apps/web/src/routes/filter-management/filter-list.tsx` — 21
- `apps/web/src/routes/filter-management/filter-operations.tsx` — 10
- `apps/web/src/routes/mobile/mobile-operations.tsx` — 11

## Decision: API-response-shape preservation

API responses (filter list, current-state, batch-states, traceability, etc.) keep returning these fields **flat on the instance object**, the way they do today. The DB normalizes underneath; the frontend stays unchanged. **This kills 99 frontend touchpoints from the work list** — they all keep working as-is.

Backend services do the join + flatten via a small helper module.

## Schema changes

1. Add `model FilterDetails`:
   - `id` uuid PK
   - `assetInstanceId` uuid unique FK → AssetInstance.id (cascade on delete)
   - `filterProfileId` uuid? FK → FilterProfile.id
   - `currentLifecycleState` varchar(100)?
   - `currentCycleId` uuid? FK → CleaningCycle.id
   - `filterSet` `FilterSetLabel?`
   - `createdAt` / `updatedAt` timestamps
   - Indexes: `currentLifecycleState`, `currentCycleId`
2. Drop from `AssetInstance`:
   - `filterProfileId`, `currentLifecycleState`, `currentCycleId`, `filterSet` columns
   - `filterProfile` and `currentCycle` relations
   - `@@index([currentLifecycleState])` index
3. Move inverse relations:
   - `FilterProfile.assetInstances` → `FilterProfile.filterDetails` (renamed, points at FilterDetails)
   - `CleaningCycle.activeInstances` → `CleaningCycle.activeFilterDetails`
4. Eager creation: when `instanceService.create` makes a new instance whose template's `templateKind === 'FILTER'`, also insert a `FilterDetails` row with all fields null. Saves null checks downstream.

## Helper module: `apps/api/src/lib/filter-details.ts`

```ts
export type FilterCore = {
  id: string;
  name: string | null;
  parentId: string | null;
  filterProfileId: string | null;
  currentLifecycleState: string | null;
  currentCycleId: string | null;
  filterSet: 'SET_A' | 'SET_B' | null;
};

// Read: returns flat shape compatible with existing service code
async function getFilterCore(filterId: string): Promise<FilterCore | null>;

// Read: just the filter-specific fields (returns null if FilterDetails row absent)
async function getFilterDetails(filterId: string): Promise<{...} | null>;

// Write: upsert by assetInstanceId (creates row if missing)
async function upsertFilterDetails(filterId: string, patch: Partial<{
  filterProfileId: string | null;
  currentLifecycleState: string | null;
  currentCycleId: string | null;
  filterSet: 'SET_A' | 'SET_B' | null;
}>): Promise<void>;

// Convenience: clear the active cycle (used at terminate / retire / cycle complete)
async function clearFilterCycle(filterId: string): Promise<void>;

// Flatten helper: takes an AssetInstance with `filterDetails` included and returns flat shape
function flattenFilterFields<T extends { filterDetails?: any }>(instance: T): T & FilterCore;
```

## Repository read updates

`instanceRepository.findById`, `findMany`, `findTree` add `include: { filterDetails: true }` and flatten before returning. The existing API serialization stays the same.

## Service write updates

Replace every `prisma.assetInstance.update({ where: { id }, data: { currentCycleId / currentLifecycleState / filterSet / filterProfileId: ... } })` with `upsertFilterDetails(id, { ... })`.

Replace `assetInstance.groupBy({ by: ['currentLifecycleState'], ... })` with `filterDetails.groupBy({ by: ['currentLifecycleState'], where: { ..., assetInstance: { isActive: true, status: { not: 'Retired' } } } })`.

## Order of execution

1. Schema edit + `prisma format` + `prisma generate`
2. Helper module
3. Update `instance.repository.ts` (read flatten)
4. Update `instance.service.ts` (eager FilterDetails on filter-kind create)
5. Rewrite `filter-operations.service.ts` (largest file)
6. Update `filter-profile.service.ts`, `cleaning-profile.service.ts`, `bulk-upload-filter.service.ts`, `pm-schedule.service.ts`, `pm-schedules/execution-routes.ts`
7. Update `super-admin/routes.ts` (`filterProfileId` lookup)
8. Update `assets/routes/instance.routes.ts` (probably only types)
9. Update `filter-operations/routes.ts` (probably only schemas)
10. Update `config/defs/ahu-filter-set-config.def.ts` (probably types only)
11. `tsc --noEmit` → fix any errors
12. `prisma db push --force-reset --accept-data-loss` (PRISMA_USER_CONSENT env)
13. Reseed
14. Build to dist
15. Restart API service
16. Curl test pass: list, tree, current-state, batch-states, dashboard-stats, ahu-configs
17. E2E walk via fresh browser session: filter list, filter operations, cleaning cycles history, mobile, PM schedules
18. Bug sweep + fix
19. Doc sync

## Risks / known issues to watch

- **Cycle bootstrap.** When `startCycle` writes `currentCycleId` for the first time, the FilterDetails row must exist. Eager creation on instance-create handles new filters; for existing filters in seeded DB, the eager-creation runs at instance-create time after the DB reset.
- **Seed compatibility.** seed.ts may insert filter instances directly with the 4 fields; needs update.
- **groupBy semantics change.** `assetInstance.groupBy(by: currentLifecycleState)` includes only filter-kind rows that ever had a state. After split, `filterDetails.groupBy(by: currentLifecycleState)` returns rows where FilterDetails exists — equivalent for filter-kind instances but excludes non-filter instances by construction (correct behavior).
- **`filterEvent.filterId`** stays a column on FilterEvent pointing at AssetInstance.id directly (cycle events are about the filter, not just its detail row). No change needed there.
- **Frontend API contract.** Repository flatten ensures the existing filter list / current-state shapes don't change. Worst case: if any consumer reads `filterDetails` as a sub-object expecting it not to exist, that breaks — but no consumer exists today since the field is new.

## Acceptance gates

- `tsc --noEmit` exit 0
- `prisma validate` clean
- DB reset + reseed succeed
- API restart healthy
- Curl: filter dashboard-stats `totalFilters: N` matches `SELECT count(*) FROM filter_details`
- E2E: start cycle → advance through 1 stage → submit checklist → advance → cycle completes; verify FilterEvent rows + FilterDetails state changes
- Regression sweep on the 12 user-facing filter pages: no console errors, data renders

## Out-of-scope (intentionally deferred)

- Step 5b checklist hardening (will land after Step 6 per prior decision)
- AssetInstance broader normalization (other meaningless-for-non-filter fields)
- Adding a discriminator constraint that "FilterDetails only exists for templateKind=FILTER" — eager creation already enforces it operationally; DB-level constraint is a Tier-2 polish
