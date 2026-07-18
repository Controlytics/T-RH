# Offline-Online Sync Architecture

## Problem
The tablet app's offline mode is unreliable because it tries to reconstruct server-side pipeline logic from incomplete cached data. The cached data is:
- Incomplete (missing connections graph, checklist profiles, equipment instruments)
- Stale (only cached when user happens to scan a filter while online)
- Not updated properly after offline operations

## Design Principle
**Cache the FULL server response as a single immutable snapshot per filter.** Don't reconstruct server logic — just replay the exact state the server returned.

### What to cache (master data — web → tablet):
1. **Cleaning profile pipeline** — full stages + connections graph per profile
2. **Equipment groups with instruments** — per block, with stageKey instruments
3. **Filter instances** — all active filters with parent hierarchy
4. **Cleaning reasons** — system config
5. **Identifier map** — RFID/barcode → filterId
6. **Per-filter current-state** — FULL server response cached per filter

### What to queue (tablet → web):
1. `start-and-advance` — compound cycle start + first stage
2. `advance` — stage transitions with readings
3. `submit-checklist` — checklist answers
4. `bypass` — stage bypass
5. `terminate` — cycle termination

## Data Flow

### On Login (while online):
1. Fetch all filter instances → cache in `filters` IndexedDB store
2. Fetch all templates → cache as `templates`
3. Fetch all cleaning reasons → cache as `cleaning-reasons`
4. Fetch all equipment groups (with instruments) → cache as `equipment-groups`
5. Fetch all identifiers → cache as `identifier-map`
6. **For each filter**: fetch `/current-state` → cache as `filter-state-{id}` with FULL response including:
   - `currentState`, `currentCycle`, `nextAllowedStages`, `nextBlocks`
   - `pendingChecklist`, `pipelineStages`, `profile`
   - `equipmentGroup`, `blockEquipmentGroups`
   - `homeBlock`, `blockChangeStatus`
   - `isPmDue`, `pmReasonKey`
7. **Cache the pipeline graph per profile** → `pipeline-{profileId}` with full `stages` + `connections`

### Going Offline:
User sees "Data Synced" indicator when all data is cached.

### While Offline — Operation Flow:
1. User scans filter → resolve from cached identifier map or name match
2. Read `filter-state-{filterId}` from cache → use as the state object
3. Validate stage using cached `nextAllowedStages`
4. Show appropriate dialog (reason, equipment, checklist) based on cached state
5. Queue operation in IndexedDB operations store
6. Update `filter-state-{filterId}` cache AND `filters` IndexedDB store:
   - New `currentState` = target stage
   - New `currentCycleId` = offline-cycle-{timestamp} (if cycle started)
   - Recompute `nextAllowedStages` from cached pipeline graph
   - Clear `pendingChecklist` (server recomputes on sync)

### Coming Back Online:
1. Sync engine replays queued operations in FIFO order
2. After all operations synced, re-fetch all master data (full refresh)
3. Re-cache all filter states

## Conflict Resolution
- **Server wins** for master data (profiles, equipment, reasons)
- **Client operations are replayed in order** — if server rejects (e.g., profile changed), the operation fails and user is notified
- **Duplicate prevention**: Filter's `currentLifecycleState` is checked before replay
