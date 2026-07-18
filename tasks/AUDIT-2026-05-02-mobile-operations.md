# Phase 8.6 Audit: Mobile Operations (`mobile-operations.tsx`)

**File:** apps/web/src/routes/mobile/mobile-operations.tsx (2486 lines)
**Date:** 2026-05-02 | **Scope:** FE executor consumption

---

## Executive Summary

The file orchestrates tablet filter operations: RFID scanning, offline caching, pipeline validation, checklist resolution, and dialog workflows. Four critical functions must migrate to the shared executor:

1. `computeNextStages()` (594-622) - graph walk + stageLookup fallback
2. `findChecklistsAfterStage()` (692-727) - two-tier checklist discovery  
3. `buildOfflineChecklist()` (729-754) - profile resolution
4. `updateOfflineState()` (757-812) - offline cache rebuild
5. `validateOfflineGate()` (644-674) - pre-execution gate

---

## nextAllowedStages References

| Line | Usage | Context | 8.6 Strategy |
|------|-------|---------|-------------|
| 516 | `cachedState.nextAllowedStages ?? []` | Cache read for batch | `executor.computeNextActions(ctx)` |
| 518 | `computeNextStages(...)` fallback | Compute if empty | Delete - executor handles |
| 833 | Cache read in buildOfflineState | Offline state build | executor |
| 801 | Write to cache | Write result | Keep; input from executor |
| 847 | Write to cache | Offline build | Keep |
| 875 | Cache online response | Server-provided | Keep as-is |
| 901 | Gate read | Validation | `executor.assertCanAdvanceTo()` |

---

## pendingChecklist References

| Line | Usage | Context | 8.6 Strategy |
|------|-------|---------|-------------|
| 532 | Gate input check | Batch validation | `executor.hasPendingChecklist(ctx)` |
| 566 | Post-advance check | Find pending | `executor.computeChecklistsAfterStage()` |
| 567 | Dialog trigger | UI decision | Keep; from executor output |
| 771 | Build from nodes | Resolver | `executor.buildChecklistsFromNodes()` |
| 777 | Block advancement | Enforcement | executor logic |
| 802 | Write result | Cache write | `cacheData()` only |
| 1312 | Clear after submit | Cache write | Keep |

---

## updateOfflineState() - Deletion Target

**Lines 757-812 (56 lines):** Rebuilds offline state after operation.

Call sites:
- Line 552: batch queue
- Line 1004: PM auto-start  
- Line 1078: queued single submit
- Line 1134: reason submit
- Line 1201: dryer duration
- Line 1244: equipment submit

**Replacement:** Inline executor + cacheData at each site (4 lines per site).

---

## stageLookup - Input Only

Server-computed per-stage table (Phase B.7): `stageLookup[stageKey] = { nextStages: [...], pendingChecklistProfileIds: [...] }`

| Line | Usage | 8.6 Strategy |
|------|-------|-------------|
| 596 | Tier-1 in computeNextStages | executor input |
| 764 | Cache read | executor input |
| 694 | Tier-1 in findChecklistsAfterStage | executor input |
| 874 | Cache online response | Keep unchanged |

No changes: stageLookup is read-only input data.

---

## Components & Dialogs

**Rendered components:**
1. MobileOperationsPage (line 39) - main view
2. DryingFilterCard (line 2296) - dryer countdown + temp

**Dialogs (and trigger conditions):**
- Reason (1042): new cycle, no PM match
- Equipment (1021/1065): block + stage match
- Dryer Duration (1054): DRY_IN, no duration set
- Checklist (567/1029/1076/1083/1151): pendingChecklist.length > 0 (EXECUTOR-COMPUTED)
- Block Change (966/1033/1089): approval required

---

## IndexedDB Operations

**Reads:**
- Lines 283-284, 416-417, 468, 514+: getCache() for state/profiles/maps

**Writes:**
- Line 374: cache filter-state on startup (24h TTL)
- Line 804, 868-882: PHASE 8.6 TARGETS
  - After operation: cacheData() with executor output
  - Online response: cache() unchanged

---

## API Endpoints

| Endpoint | Line | Impact |
|----------|------|--------|
| GET /api/filters/:id/current-state | 862 | Keep - returns stageLookup |
| GET /api/filters/batch-states | 370 | Keep |
| POST /api/filters/:id/{advance,start-cycle,...} | via executeOrQueue | Keep |
| GET /api/equipment-groups/by-block/:id | 1015, 1111 | Keep |

---

## RFID Scan Flow

1. Keyboard trap (130-195) → resolveFilter()
2. Fetch state: API or cache (includes stageLookup)
3. validateOfflineGate() → executor.assertCanAdvanceTo()
4. Check pendingChecklist → executor result
5. No cycle? → reason dialog or PM auto-start
6. Equipment readings (if needed)
7. executeOrQueue() - API or queue
8. updateOfflineState() → DELETE; executor + cacheData
9. Check pending checklist again → open dialog
10. Mutate filter list

---

## Phase 8.6 Implementation Plan

**Change 1: Delete computeNextStages() (29 lines)**
Calls at 518, 656, 780, 835, 1311
Replace: executor.computeNextActions(ctx)
Net: -29

**Change 2: Delete findChecklistsAfterStage() (35 lines)**
Calls at 769
Replace: executor.computeChecklistsAfterStage(ctx)
Net: -35

**Change 3: Delete buildOfflineChecklist() (25 lines)**
Calls at 771
Replace: part of executor result
Net: -25

**Change 4: Delete validateOfflineGate() (31 lines)**
Calls at 522, 906
Replace: executor.assertCanAdvanceTo()
Net: -31

**Change 5: Delete updateOfflineState() (56 lines)**
Calls at 6 sites
Replace: 4-line executor + cacheData at each (6 × 4 = 24 lines)
Net: -56 + 24 = -32

**Change 6: Add executor import**
Net: +1

**Change 7-8: Inline replacements**
- 6 × updateOfflineState calls
- 2 × gate checks
- 3 × computeNextStages calls  
- 1 × checklist discovery
Net: -100+ total

---

## Summary Statistics

| Metric | Value |
|--------|-------|
| Functions deleted | 4 |
| Lines deleted | 148 |
| Lines added | ~20 |
| Net reduction | **-128 lines** |
| Dialogs affected | 1 (Checklist) |
| Breaking changes | None |

---

## Testing Checklist

- Offline cycle: start → advance → stage locked
- Batch queue: all items validated via executor gate
- DRY_IN: dryer countdown → temp submit → next stages
- Block change: approval → operation unblocks
- stageLookup: preferred over local graph walk
- Chained CHECKLISTs: detected correctly
- Checklist dialog: auto-opens after advance
- Sync: offline cache matches server response

