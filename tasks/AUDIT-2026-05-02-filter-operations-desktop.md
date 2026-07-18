# Phase 8.6 Audit: filter-operations.tsx (Desktop) — 2026-05-02

## Overview
Desktop filter operations (2088 lines) manages batch cleaning cycle scanning, stage advancement, checklist dialogs, equipment group selection, dryer timing, and offline queue persistence. Primary audit target: lines referencing pipeline-derived state, offline cache, and stage progression logic.

---

## Key Line References: Pipeline State & Offline Cache

### nextAllowedStages (Stage Progression)
| Line | Context | What It Does | 8.6 Strategy |
|------|---------|-------------|--------------|
| 88 | Init cached filter state | Caches `nextAllowedStages: st.nextAllowedStages ?? []` from API | Migrate to `serverAuthorizedStages[]` in normalized schema |
| 534 | `updateCachedStateAfterAdvance()` | Sets `nextAllowedStages: cycleComplete ? [] : nextAllowed` after graph walk | Move logic to Phase 8.6 pipeline executor; store as `allowedTransitions` |
| 574, 642, 720 | Batch submit inspection | Reads `state.nextAllowedStages ?? []` to validate stage reachability | Query new unified state shape via `/api/filters/{id}/state` |
| 721-722 | Validation gate | Blocks advance if `!nextAllowed.includes(activeStage.key)` | Enforce via `stageTransitionValidator()` from pipeline-executor |

**Summary**: `nextAllowedStages` computed offline via graph walk (lines 493-524). 8.6 absorbs this into pipeline-executor's transition resolver; desktop cache stores result under `allowedTransitions` key.

### pendingChecklist (Offline Checklist Cascade)
| Line | Context | What It Does | 8.6 Strategy |
|------|---------|-------------|--------------|
| 86, 489, 491, 535 | Build & cache | `pendingChecklist` computed from graph CHECKLIST nodes after stage (lines 450-491) | Unify with `buildOfflineChecklist()` in pipeline-executor/checklist.ts |
| 435-436 | Batch gate | Pops checklist dialog if `cs?.pendingChecklist?.length > 0` after queued advance | Response from queued advance now includes checklist; no secondary fetch |
| 729, 733 | Submit batch → dialog | Shows dialog with `state.pendingChecklist` when pending | Dialog triggered by advance response; no local state lookup needed |
| 1059-1060, 1112-1113, 1366-1367 | API response → dialog | Sets dialog from `advanceResult?.pendingChecklist` or `result?.pendingChecklist` | Server returns checklist in advance/start-cycle response (Phase 8.3) |

**Summary**: `buildOfflineChecklist()` (lines 461-477) mirrors graph walk to populate questions. Phase 8.6 defers to server; offline fallback queries cached profile versions.

### updateOfflineState (Post-Advance Cache Update)
| Line | Context | What It Does | 8.6 Strategy |
|------|---------|-------------|--------------|
| 479-552 | `updateCachedStateAfterAdvance()` | Full function: recomputes `nextAllowedStages`, `pendingChecklist`, cycle completion after each offline advance | Replace with minimal offline-sync trigger; let Phase 8.3 API populate full state |
| 404, 1194, 1238, 1293 | Call sites | Invoked after queued advance with new stage key | Async queue manager calls state-sync helper post-push |
| 540, 545, 549-550 | Local store update | Calls `updateFilterStateLocally()` and `clearOfflineCycleId()` | Keep local store updates; remove redundant graph walks |

**Summary**: Lines 479–552 are the largest offline state manipulation block. Phase 8.6 strategy: after queuing an advance, store the known facts (new stage, cycle ID) locally; defer pipeline recomputation to sync/server response.

### Local Graph Walker (Lines 500–524)
| Line | Context | What It Does | 8.6 Strategy |
|------|---------|-------------|--------------|
| 502-518 | Graph walk (if graph exists) | Depth-first walk from current stage, collect reachable STAGE nodes, skip CHECKLIST | Move to pipeline-executor as `computeReachableStages(graph, stageKey)` |
| 520-524 | Linear pipeline fallback | If no graph, step through `pipelineStages` array | Keep fallback in pipeline-executor; mark as legacy codepath |

**Summary**: Graph walker is deterministic; extract to shared executor module to unify mobile + desktop.

---

## Desktop ↔ Mobile Divergences

### 1. Graph Walking
- **Desktop** (lines 500–524): local walk via `walk()` closure; fallback to linear pipeline
- **Mobile** (mobile-operations.tsx ~line 450): same pattern via `findChecklistsAfterStage()` helper
- **Divergence**: Identical logic, but called at different points. Desktop caches result; mobile queries on-demand.
- **8.6 Fix**: Extract both to `pipeline-executor/graph-walker.ts`; both call same function.

### 2. Checklist Build
- **Desktop** (lines 461–477): `buildOfflineChecklist()` filters cached profiles by `checklistProfileId`
- **Mobile** (mobile-operations.tsx): equivalent helper with same signature
- **Divergence**: None—both fetch from cache.
- **8.6 Fix**: Merge into `pipeline-executor/checklist.ts`

### 3. Batch vs Single Handling
- **Desktop**: Supports batch queue scanning (lines 168, 370–379, 555–750); applies shared dialogs to entire batch
- **Mobile**: Single-filter-per-dialog flow; no batch scanning UI
- **Divergence**: Desktop's `pendingBatch` (line 171) splits reason/equipment/dryer/checklist dialogs from scan queue (line 168)
- **8.6 Impact**: Batch dialogs must support multi-filter context; normalize response shape to include batch results per filter.

### 4. Equipment Group Flow (WASH_IN Only)
- **Desktop** (lines 1029–1104): Inline equipment check before advance; offline flow at lines 1084–1089
- **Mobile** (mobile-operations.tsx): Similar inline check; also caches group for offline
- **Divergence**: Desktop caches group + dryer timing in filter-state (lines 1177–1189); mobile does the same
- **8.6 Fix**: No change; both patterns acceptable. Ensure 8.6 API returns `equipmentGroup` in state snapshot.

### 5. Offline State Persistence
- **Desktop** (lines 531–551): Updates both `cache()` and `updateFilterStateLocally()` after offline advance
- **Mobile** (mobile-operations.tsx): Same dual-write pattern
- **Divergence**: None
- **8.6 Note**: Dual-write must be atomic or use versioned keys to avoid sync conflicts.

### 6. Reason Dialog + Block Change Interlock
- **Desktop** (lines 1018–1134): Inline reauth in `handleReasonSubmit()`; catches BLOCK_CHANGE_REQUIRED mid-auth
- **Mobile** (mobile-operations.tsx): Same pattern
- **Divergence**: None observed
- **8.6 Note**: Keep block-change detection server-side; response includes status flag.

---

## Components, Dialogs, IDB Reads/Writes

### Dialog Components (Imported)
1. **StageScanDialog** (line 8) — Render stage + block selection UI
2. **CleaningReasonDialog** (line 9) — Reason + justification picker
3. **EquipmentDialog** (line 10) — Equipment group + instrument readings
4. **DryerDurationDialog** (line 11) — Dryer duration picker
5. **ChecklistDialog** (line 12) — Multi-question checklist form
6. **ReauthDialog** (line 6) — Password challenge for privileged actions

### IDB Operations

**Writes** (24h TTL): `filter-state-{filterId}` cached at lines 82–94, 531–537, 1178–1189, 1223–1234, 568–581  
**Reads**: `templates` (122, 129), `identifier-map` (342), `filter-state-*` (434–435, 481, 594), `checklist-profiles` (462), `equipment-groups` (623–624, 1087, 1170, 1219)

### API Calls (8 endpoints)
- `/api/filters/{id}/current-state` (81, 566) — state snapshot + next actions
- `/api/assets/identifiers/lookup/{tag}` (336) — RFID tag resolution
- `/api/equipment-groups/by-block/{blockId}` (956, 1036) — block→group mapping
- `/api/filters/reasons` (894) — reason list
- `/api/filters/{id}/start-cycle` (1032–1033) — cycle start
- `/api/filters/{id}/advance` (1053–1054, executeOrQueue) — stage advance
- `/api/filters/{id}/submit-checklist` (via ChecklistDialog component) — checklist submission
- `/api/block-change-requests` (1455) — block reassignment

---

## Phase 8.6 Implementation Plan

### 1. Extract Graph Walking & Checklist Build
**Goal**: Unify desktop + mobile.
- **New module**: `packages/shared/src/pipeline-executor/graph-walker.ts`
- **Exports**: `computeReachableStages()` (replaces lines 500–524), `findChecklistNodesAfter()` (replaces lines 450–458), `buildPendingChecklistFromNodes()` (replaces lines 461–477)

### 2. Consolidate updateCachedStateAfterAdvance → Minimal Offline Sync
**Goal**: Remove redundant graph walks from desktop.
- **Replace**: Lines 479–552 function definition with minimal `recordOfflineAdvance(filterId, stageKey)`
- **Updates**: Lines 404, 1194, 1238, 1293 call sites

### 3. Unify Checklist Dialog Trigger
**Goal**: Server response always includes `pendingChecklist`; no secondary cache inspection.
- **Remove**: Lines 431–440 (inspect cache for pending checklist)
- **Keep**: Lines 1059–1061, 1112–1113, 1366–1367 (handle API response)

### 4. Normalize Equipment & Dryer Offline Cache
**Goal**: Store only pinned snapshot; let Phase 8.3 return current group on state queries.
- **Keep**: Lines 1087–1089, 1170–1172, 1218–1221 (read cache)
- **Simplify**: Lines 1177–1189, 1223–1234 (write cache) — remove `nextAllowedStages` computation

### 5. Block Change Detection
**Goal**: Move to batch submit gate via API flag.
- **Keep**: Lines 407–415, 1066–1079, 1118–1129 (current inline handling)
- **Add**: Phase 8.6 API returns `blockChangeStatus` in state

### 6. Batch Dialog State Management
**Goal**: Track per-filter results.
- **Keep**: `pendingBatch` (line 171)
- **Update**: Response handling (lines 1001–1012, 1159–1161) to accumulate per-filter results

### 7. Remove nextAllowedStages from Offline Cache Schema
**Goal**: Offline cache stores only authoritative facts.
- **Changes**: Lines 88, 574, 612, 534 — remove `nextAllowedStages` initialization + update

### 8. Sync Integration
**Goal**: Refresh full state post-sync.
- **Keep**: Line 427 `getOfflineFilters()` refresh
- **Add**: Post-sync hook to refresh `filter-state-{filterId}`

---

## Summary

**Affected lines**: 88, 479–552, 450–458, 461–477, 500–524, 404, 1194, 1238, 1293, 431–440, 1059–1063, 1112–1115, 1366–1369, 534, 720–722, 1087–1089, 1170–1172, 1177–1189, 1218–1221, 1223–1234, 1118–1129

**Key refactors**: Extract graph-walker (30 lines), consolidate offline cache update (54 lines → 10 lines), remove secondary checklist fetch (10 lines), normalize equipment caching (20 lines)

**Desktop-mobile sync**: Batch dialogs remain desktop-only; graph walk/checklist build now shared; offline cache schema unified.

---

*Audit completed 2026-05-02 — Phase 8.6 ready for implementation.*
