# A-01 — Coupled-Cluster Frontend Migration Plan

**Status:** Drafted 2026-05-29. Ready to execute in a dedicated session.
**Estimated effort:** Half-day to one day of careful sequential work.
**NOT a parallel-subagent task** — file dependencies require one coordinator with full context.

> 3 parallel subagents independently reported `DONE_WITH_CONCERNS` on these files this session, identifying the same blocker: the 5 files share an IndexedDB cache contract that can only be evolved atomically. This plan turns that finding into an executable sequence.

> **Related (2026-05-30) — separate WRITE-path slice, not part of this read-path cluster:** Filter single-**create** was cut over off `templateId`/`attributeSchema` onto `POST /api/hierarchy/filters` (concrete fields validated against the live `filter-field-options` config; FILTER template id resolved internally; the `fn_mirror_asset_instance` trigger still mirrors into typed `filters`). See `docs/superpowers/plans/2026-05-30-filter-create-typed-cutover.md`. Follow-ups: filter **edit** path + **bulk upload** (Slice 2, `.xlsx` dropdowns). Does not change the IDB read contract below.

---

## The 6 files and their shared contract

| File | Lines | Role |
|---|---|---|
| `apps/web/src/lib/offline-store.ts` | 794 | IndexedDB schema + cache CRUD primitives. `CachedFilter` interface + `cacheFilters()`/`getCachedFilters()`. |
| `apps/web/src/lib/offline-sync-service.ts` | 243 | Online → offline prime: fetches `/api/assets/instances` + `/api/assets/templates` + `/api/assets/identifiers` and writes into IDB. |
| `apps/web/src/routes/filter-management/hooks/use-filter-operations-offline-cache.ts` | 269 | Per-component cache-prime hook used by filter-operations.tsx. |
| `apps/web/src/routes/filter-management/filter-operations.tsx` | 1720 | Operator desktop cycle UI. Reads from IDB cache + discriminates entity kind via `templateId`. |
| `apps/web/src/routes/mobile/mobile-wrapper.tsx` | 2249 | Tablet shell. Same cache + discriminator pattern. |
| `apps/web/src/routes/mobile/mobile-operations.tsx` | 3399 | Tablet cycle-ops panel. Same. |
| **Total** | **8674** | |

### Shared contract today

1. **One mixed-kind `filters` IDB store** seeded by `cacheFilters(instances)` where `instances = response.data` from `/api/assets/instances?limit=500` — blocks, areas, AHUs, and filters all written into the same store.
2. **`CachedFilter` interface requires `templateId: string`** (`offline-store.ts:130-141`) — used by consumers to discriminate entity kind.
3. **One mixed `templates` cache key** seeded by `getCachedData<any[]>('templates')` after fetching `/api/assets/templates?limit=1000`.
4. **Consumer discrimination pattern:** `f.templateId === blockTemplateId` / `i?.template?.templateKind === 'AHU'` — looks up the template kind by joining with the mixed templates cache.
5. **SWR cache key shared:** all 3 consumer files use `useSWR('/api/assets/instances?limit=500')`. Any `mutate()` call must use the exact same key.

### Why piecemeal migration breaks it

- Migrating ONE consumer changes its SWR key → other consumers' `mutate()` invalidations stop working → stale data.
- Migrating the cache layer alone breaks consumers that still expect mixed-kind data via `templateId`.
- The typed `Filter` Prisma model dropped `templateId` on 2026-05-25 (commit `97d298c`) — `/api/hierarchy/filters` returns null for it. Existing `CachedFilter.templateId: string` interface is structurally incompatible.

---

## Target architecture

### New IndexedDB schema (DB version bump)

Add 4 typed stores **alongside** the legacy `filters` mixed store:

| Store name | Key path | Rows | Replaces |
|---|---|---|---|
| `cache_blocks` | `id` | Typed Block rows | Subset of legacy `filters` store |
| `cache_areas` | `id` | Typed Area rows | Same |
| `cache_ahus` | `id` | Typed AHU rows | Same |
| `cache_filters_typed` | `id` | Typed Filter rows | Same |
| (legacy) `filters` | `id` | Drops after cutover | — |

Each typed row matches the `/api/hierarchy/<kind>` response shape (no `templateId`; uses typed FKs `blockId`/`areaId`/`ahuId`).

`CachedTemplate` cache key drops entirely (no kind-discriminator needed once consumers query typed stores).

### New cache-CRUD primitives (in `offline-store.ts`)

```ts
export interface CachedBlock  { id: string; name: string; description: string | null; status: string; attributes: Record<string, any>; unsPath: string | null; isActive: boolean; }
export interface CachedArea   extends CachedBlock { blockId: string | null; }
export interface CachedAhu    extends CachedBlock { areaId: string | null; }
export interface CachedFilterTyped extends CachedBlock { ahuId: string | null; }

export async function cacheBlocks(rows: CachedBlock[]): Promise<void>;
export async function cacheAreas(rows: CachedArea[]): Promise<void>;
export async function cacheAhus(rows: CachedAhu[]): Promise<void>;
export async function cacheFiltersTyped(rows: CachedFilterTyped[]): Promise<void>;

export async function getCachedBlocks(): Promise<CachedBlock[]>;
export async function getCachedAreas(): Promise<CachedArea[]>;
export async function getCachedAhus(): Promise<CachedAhu[]>;
export async function getCachedFiltersTyped(): Promise<CachedFilterTyped[]>;

// Legacy `cacheFilters()` / `getCachedFilters()` remain for transition;
// add a deprecation comment + planned removal date.
```

### Offline-sync-service changes

Replace the 3 legacy fetches (lines 1-2-6 per subagent 3 report) with 4 typed fetches:

```ts
// BEFORE:
const instances = await api.get('/api/assets/instances?limit=500');  // mixed kinds
const templates = await api.get('/api/assets/templates?limit=1000'); // for kind disc
const identifiers = await api.get('/api/assets/identifiers?limit=1000');

// AFTER:
const blocks = await api.get('/api/hierarchy/blocks?limit=500');
const areas  = await api.get('/api/hierarchy/areas?limit=500');
const ahus   = await api.get('/api/hierarchy/ahus?limit=500');
const filters = await api.get('/api/hierarchy/filters?limit=500');
const identifiers = await api.get('/api/assets/identifiers?limit=1000'); // KEEP — no /api/hierarchy/identifiers exists (identifiers are cross-kind by design)

await cacheBlocks(blocks.data);
await cacheAreas(areas.data);
await cacheAhus(ahus.data);
await cacheFiltersTyped(filters.data);
// drop the `templates` cache fetch — no discrimination needed when stores are kind-scoped
```

### Consumer changes (per file)

Each consumer drops the `templateId` discriminator pattern + reads from typed stores:

```ts
// BEFORE (in mobile-wrapper.tsx, mobile-operations.tsx, filter-operations.tsx):
const { data: instancesData } = useSWR('/api/assets/instances?limit=500');
const instances = instancesData?.data ?? [];
const filterTemplateIds = new Set(templates.filter(t => /AHU/i.test(t.name)).map(t => t.id));
const filterInstances = instances.filter(i => filterTemplateIds.has(i.templateId));
const ahus = instances.filter(i => /AHU/i.test(i.template?.name));

// AFTER:
const { data: blocksData }  = useSWR('/api/hierarchy/blocks?limit=500');
const { data: areasData }   = useSWR('/api/hierarchy/areas?limit=500');
const { data: ahusData }    = useSWR('/api/hierarchy/ahus?limit=500');
const { data: filtersData } = useSWR('/api/hierarchy/filters?limit=500');
const filterInstances = filtersData?.data ?? [];
const ahus = ahusData?.data ?? [];
const blocks = blocksData?.data ?? [];
```

Parent-chain walks change from `i.parentId` (legacy generic field) to typed FKs:
- `filter.ahuId` → AHU lookup → `ahu.areaId` → Area lookup → `area.blockId` → Block lookup.

`mutate()` calls update to the new keys (4 separate `mutate()` calls per affected cache, or a small helper `mutateAllHierarchy()`).

---

## Execution sequence (one focused session)

### Step 0 — Backup
```bash
git tag pre-coupled-cluster-migration
git checkout -b a01-coupled-cluster
```

### Step 1 — `offline-store.ts` schema bump (~45 min)
- Bump `DB_VERSION` from N → N+1.
- Add `onupgradeneeded` handler that creates the 4 typed stores.
- Add the 4 new interfaces + 8 new CRUD functions.
- KEEP `CachedFilter` + `cacheFilters()` / `getCachedFilters()` intact (legacy support during transition).
- Tests: write a small vitest that opens an IDB instance, calls `cacheBlocks([{...}])`, verifies `getCachedBlocks()` returns it.
- Commit: `feat(offline-store): add typed-kind caches alongside legacy mixed store (A-01 cluster step 1/6)`.

### Step 2 — `offline-sync-service.ts` migration (~30 min)
- Replace legacy fetches with 4 hierarchy fetches.
- Write to BOTH new typed stores AND legacy `filters` store (transitional dual-write).
- The dual-write means any consumer that hasn't migrated yet still sees the legacy cache populated.
- Commit: `feat(offline-sync-service): prime typed caches alongside legacy (A-01 cluster step 2/6)`.

### Step 3 — `use-filter-operations-offline-cache.ts` migration (~30 min)
- Update prime function to use typed stores.
- Update `mutate()` keys to typed-store reads.
- Commit: `feat(offline-cache-hook): read from typed stores (A-01 cluster step 3/6)`.

### Step 4 — `filter-operations.tsx` consumer migration (~1 hour)
- Replace `instancesData` mixed-array reads with 4 typed `useSWR` calls.
- Drop `filterTemplateIds` / `blockTemplateId` discriminators.
- Replace `parentId` walks with typed FK walks.
- Update `mutate()` keys.
- Verify desktop cycle workflow end-to-end (login, navigate to filter, simulate cycle start).
- Commit: `feat(filter-operations): consume typed hierarchy caches (A-01 cluster step 4/6)`.

### Step 5 — `mobile-wrapper.tsx` consumer migration (~1 hour)
- Same pattern as Step 4, applied to the tablet shell.
- Verify tablet smoke test (mobile-mcp): login + see filter list + open RFID assign modal.
- Commit: `feat(mobile-wrapper): consume typed hierarchy caches (A-01 cluster step 5/6)`.

### Step 6 — `mobile-operations.tsx` consumer migration (~1.5 hour)
- Same pattern. The 13 `mutate()` call sites need careful update.
- Verify operator cycle workflow on tablet: scan RFID → start cycle → advance → terminate → confirm audit chain intact.
- Commit: `feat(mobile-operations): consume typed hierarchy caches (A-01 cluster step 6/6) + drop legacy mixed-store cache`.

### Step 7 — Drop legacy cache (~15 min)
After Steps 4-6 verified working, the legacy `filters` mixed store is unreferenced. Drop the store + `CachedFilter` interface + `cacheFilters()` / `getCachedFilters()` exports.
- Commit: `chore(offline-store): drop legacy mixed-kind filters store (A-01 cluster complete)`.

---

## Verification per step

- **tsc clean** on `apps/web` after each commit.
- **IDB schema version bump test:** open the app, observe in browser DevTools that DB version updated and new stores exist.
- **Cache populate test:** trigger online sync, verify each typed store has rows.
- **Offline replay test:** queue an operation, restart browser, replay should succeed using typed cache.
- **End-to-end smoke test:** complete one cycle on desktop + one on tablet (via mobile-mcp).

---

## Rollback per step

Each step is its own commit. To rollback step N:
- `git revert <SHA>`
- Bump `DB_VERSION` again to invalidate any partial caches written by the bad code.
- Manually clear IDB on test devices.

The tag `pre-coupled-cluster-migration` from Step 0 is the worst-case full restore.

---

## Why a parallel-subagent approach won't work

- Cache schema change in `offline-store.ts` must land BEFORE consumer migrations (otherwise consumers can't read typed data).
- All consumers must use the EXACT same `mutate()` keys (otherwise cross-component invalidation breaks).
- Atomic SWR key changes can't be parallelized — subagents can't coordinate key naming.

This is the canonical "needs one coordinator with full context" task. The work is not parallelizable.

---

## Pre-flight checks before executing

1. Verify Wave 1 mirror still intact: typed-table counts match `asset_instances` by kind (already verified once today; re-check):
   ```sql
   -- expects BLOCK 4=4, AREA 8=8, AHU 14=14, FILTER 57=57
   ```
2. Verify `entity_assignments` + `template_assignments` empty (security gate).
3. Backup current `digilog_db` snapshot.
4. Tag `pre-coupled-cluster-migration`.

If any pre-flight fails, do not start — investigate first.
