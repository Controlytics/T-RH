# Legacy Offline-Sync-Service Deprecation Audit

**Date:** 2026-05-02  
**Scope:** pps/web/src/lib/offline-sync-service.ts end-to-end  
**Status:** Phase 8.4b shipping new versioned sync; legacy runs in parallel; 8.6 subsuming.

---

## Executive Summary

The legacy syncAllDataForOffline() caches **9 entity types** into the cache IDB store using **key/value blob patterns**. Phase 8.4b introduced a **parallel, versioned-cache sync** at sync-since.ts, writing to **6 new v5 stores** (syncFilterCleaningProfiles, syncFilterProfiles, syncEquipmentGroups, syncChecklistProfiles, syncAssetTemplates, syncFilters).

**Critical finding:** The legacy path caches **3 entities the new path does NOT yet cover**:
- cleaning-reasons — No replacement in sync-since (used by filter operations)
- checklist-profiles — Marked as deferred to 8.4a follow-up (comment in routes.ts:26)
- pm-schedules/due — No replacement (used by mobile tab)

Also, the legacy path caches **filter state snapshots** (ilter-state-\) and **identifier map** — both are queried post-sync but differ from the new versioned stores.

**Recommendation:** 8.6 must complete the v5 sync store coverage BEFORE deprecating the legacy path, or risk offline breakage.

---

## What Legacy offline-sync-service.ts Caches

### 1. Templates (Master)
- **Endpoint:** GET /api/assets/templates?limit=1000
- **IDB Store:** cache (key: 	emplates)
- **Usage:** Mobile wrapper, filter operations (template filtering)
- **New Home:** sync-since.ts already provides ssetTemplates → syncAssetTemplates
- **Status:** ✅ Covered

### 2. Filter Instances (Master)
- **Endpoint:** GET /api/assets/instances?limit=500
- **IDB Store:** Both ilters (raw CachedFilter shape) AND cache (key: instances-raw)
- **Usage:** Mobile wrapper, filter operations, all pages that list filters
- **New Home:** sync-since.ts provides ilters → syncFilters
- **Status:** ✅ Covered (different store but same data source)

### 3. Filter States (Per-Filter Snapshots)
- **Endpoint:** GET /api/filters/batch-states (with fallback to individual /:id/current-state)
- **IDB Store:** cache (key: ilter-state-\)
- **Usage:** Mobile operations, filter operations (optimistic updates, cycle state checks)
- **New Home:** None — these are snapshot blobs, not versioned rows
- **Status:** ⚠️ PARTIAL GAP

### 4. Cleaning Reasons
- **Endpoint:** GET /api/filters/reasons
- **IDB Store:** cache (key: cleaning-reasons)
- **Usage:** Reason dialog (filter-management/filter-operations), mobile operations
- **New Home:** None in sync-since (deferred)
- **Status:** ❌ **NOT COVERED**

### 5. Equipment Groups (With Instruments)
- **Endpoint:** GET /api/equipment-groups
- **IDB Store:** cache (key: equipment-groups)
- **Usage:** Dryer dialog, stage scan dialog (equipment selection + readings validation)
- **New Home:** sync-since.ts provides equipmentGroups → syncEquipmentGroups
- **Status:** ✅ Covered

### 6. Identifier Map (RFID/Barcode → Filter)
- **Endpoint:** GET /api/assets/identifiers?limit=1000
- **IDB Store:** cache (key: identifier-map; 3 variants per ID: raw, uppercase, lowercase)
- **Usage:** RFID scan resolution (mobile-operations.tsx, stage-scan-dialog.tsx)
- **New Home:** None — this is a computed, denormalized map
- **Status:** ⚠️ **NOT COVERED** (but not an entity; can be rebuilt from /api/assets/identifiers)

### 7. PM Schedules / Due Tasks
- **Endpoint:** GET /api/pm-schedules/due
- **IDB Store:** cache (key: due-tasks)
- **Usage:** Mobile wrapper "My Tasks" tab (offline fallback)
- **New Home:** None in sync-since
- **Status:** ❌ **NOT COVERED**

### 8. Checklist Profiles (With Questions)
- **Endpoint:** GET /api/checklist-profiles?limit=100&isActive=true
- **IDB Store:** cache (key: checklist-profiles)
- **Usage:** Mobile operations (dialog rendering, answer submission)
- **New Home:** sync-since.ts schema says checklistProfiles but routes.ts:26 marks as deferred to 8.4a follow-up
- **Status:** ⚠️ **DEFERRED** (defined but empty in 8.4b)

### 9. Cleaning Profiles (Stages, Connections, Full Pipeline)
- **Endpoint:** GET /api/filter-cleaning-profiles?limit=100&status=ACTIVE + individual /:id for full pipeline
- **IDB Store:** cache (key: cleaning-profiles for list; cleaning-profile-\ for full)
- **Usage:** Pipeline visualization (cleaning-profile-editor.tsx), stage resolution
- **New Home:** sync-since.ts provides ilterCleaningProfiles → syncFilterCleaningProfiles
- **Status:** ✅ Covered (list only; full pipeline is separate)

---

## Calling Sites

### 1. Mobile Wrapper (pps/web/src/routes/mobile/mobile-wrapper.tsx)
- **Initial sync:** Lines 75–81, syncAllDataForOffline() fires once after login
- **Re-sync on operations complete:** Lines 98–109, after onSyncEvent triggers
- **Reads from cache:** Templates (155), cleaning-reasons (156), due-tasks (157), approvals (158)

### 2. Mobile Operations (pps/web/src/routes/mobile/mobile-operations.tsx)
- **Cached data:** Reads identifier-map (stage-scan-dialog reference), filter states, templates
- **No explicit syncAllDataForOffline call** — relies on mobile-wrapper's initial + re-sync

### 3. Desktop Filter Operations (pps/web/src/routes/filter-management/filter-operations.tsx)
- **No direct call to syncAllDataForOffline** — uses useOffline() hook
- **Reads:** Templates, identifier-map, filter states, equipment-groups, checklist-profiles

### 4. Reason Dialog (pps/web/src/routes/filter-management/components/cleaning-reason-dialog.tsx)
- **Reads:** cleaning-reasons via getCachedData('cleaning-reasons')
- **Fallback:** SWR fetch when online

### 5. Stage Scan Dialog (pps/web/src/routes/filter-management/components/stage-scan-dialog.tsx)
- **Reads:** identifier-map via getCachedData()
- **Fallback:** Rebuilds from live identifiers when online

---

## Entity Coverage Matrix

| Entity | Legacy Store | New Sync Store | 8.4b Status | Blocking? |
|--------|---|---|---|---|
| Templates | cache | syncAssetTemplates | ✅ Ready | No |
| Filter Instances | filters | syncFilters | ✅ Ready | No |
| Filter States | cache | None | ⚠️ GAP | No* |
| Cleaning Reasons | cache | None | ❌ MISSING | **Yes** |
| Equipment Groups | cache | syncEquipmentGroups | ✅ Ready | No |
| Identifier Map | cache | None | ⚠️ GAP | **Yes** |
| PM Due Tasks | cache | None | ❌ MISSING | **Yes** |
| Checklist Profiles | cache | syncChecklistProfiles (empty) | ⚠️ DEFERRED | **Yes** |
| Cleaning Profiles | cache | syncFilterCleaningProfiles | ✅ Ready | No |

*States are snapshots; can keep in legacy cache.

---

## Phase 8.6 / 8.7 Deprecation Plan

### Stage 0 — Inventory (Complete)
- [x] Audit legacy path end-to-end
- [x] Map each entity to new home
- [x] Identify gaps (cleaning-reasons, pm-tasks, checklist-profiles, filter-states, identifier-map)

### Stage 1 — Fill Gaps (8.6 feature work)
1. **Cleaning Reasons:** Add to GET /api/sync/since response
   - New IDB store or blob in cache?
   - FE replaces getCache('cleaning-reasons') → sync store read

2. **PM Due Tasks:** Decide scope
   - Option A: Offline unsupported (requires online)
   - Option B: Add snapshot to sync response
   - Recommend: A (tasks are real-time)

3. **Checklist Profiles:** Complete 8.4a deferred work
   - Add questions to sync response
   - Populate syncChecklistProfiles in FE

4. **Filter State Snapshots:** Keep in legacy cache
   - Versioned stores won't help (not versioned data)
   - FE reads from both ilter-state-* and syncFilters

5. **Identifier Map:** Add server computation
   - Sync endpoint returns map or list?
   - FE rebuilds or caches?

### Stage 2 — Wire New Stores (8.6 impl)
- [ ] Replace all getCache() calls with sync store reads
- [ ] Update dialogs: reason, checklist, equipment
- [ ] Test offline transitions

### Stage 3 — Sunset Legacy Path (8.6 or 8.7)
**Prerequisite:** All FE wired, offline tests pass
- [ ] Remove syncAllDataForOffline() call from mobile-wrapper.tsx
- [ ] Delete syncAllDataForOffline() function
- [ ] Remove deprecated cache keys from LRU exemptions
- [ ] Verify no regressions

### Stage 4 — Archive (Post-8.6)
- [ ] Update CHANGELOG.md
- [ ] Close tracking issue

---

## Verification Checklist

- [ ] Mobile "My Tasks" works offline (or shows online-required msg)
- [ ] Reason dialog renders offline with data
- [ ] Checklist questions appear offline
- [ ] RFID scan resolves filter name offline
- [ ] Equipment readings show correct limits offline
- [ ] Filter state displays correctly
- [ ] No duplicate data in old + new stores
- [ ] Offline → online transitions work smoothly

---

## Risk Assessment

**High Risk:** Removing legacy path before all 9 entities have replacements.
**Medium Risk:** Offline My Tasks tab if PM data not synced.
**Low Risk:** Once Gap 1 (cleaning-reasons) is filled, deprecation is straightforward.

---

## Assumptions

- 8.6 timeline allows for gap-filling work
- "Checklist profiles deferred to 8.4a follow-up" will complete before 8.6 deprecation
- Filter state snapshots will remain legacy (not versioned)
- Single-tenant simplifies sync (no org scoping needed)

