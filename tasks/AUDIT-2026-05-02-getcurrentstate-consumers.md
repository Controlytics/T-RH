# Phase 8.7 Cutover Audit: getCurrentState() API Consumer Analysis

**Date:** 2026-05-02  
**Cutover Goal:** Remove nextAllowedStages, pendingChecklist from /api/filters/:id/current-state response. Replaced by actions[] array + stageLookup lookup table for offline-friendly state machine.

---

## Summary

- 2 FE route consumers identified (both substantial)
- 3 deprecated fields in scope for removal
- All 3 fields actively used in cache population, offline computation, and UI branching
- 1 type definition in shared types (action-tape.ts - does NOT define CurrentState)
- 0 local CurrentState type redeclarations found in FE
- Blocking cleanup: None - actions[] + stageLookup replacements already present in routes

---

## Type Definitions

### packages/shared/src/types/action-tape.ts (258 lines)

Import shape: Exports action tape types (Action, ActionTape, TapeQuestion, etc.) - NOT a CurrentState definition. The file documents that actions[] replaces the three fields post-cutover.

Decision: Keep as-is. This is the NEW contract (Phase 8.0+).

---

## API Endpoint Definition

### apps/api/src/modules/filter-operations/routes.ts:13–115

Route: GET /:id/current-state

Schema response:
- Line 33: nextAllowedStages property
- Line 35: pendingChecklist property
- Line 77–88: stageLookup (B.7 - per-stage lookup for offline)
- Line 96–100: actions (Phase 8.0 decision-tape, gated by TAPE_PARALLEL=true)

Implementation: FilterOperationsService.getCurrentState(ctx, id, cleaningAreaId) at filter-operations.service.ts:368–829.

---

## FE Consumer 1: Mobile Filter Operations

File: apps/web/src/routes/mobile/mobile-operations.tsx (1314 lines)

### Reads of nextAllowedStages (8 unique locations):

- 516: computeNextStages() fallback cached value - keep/migrate to stageLookup
- 594-597: Tier-1 lookup via stageLookup - keep as canonical
- 833: Fallback for offline - keep (stageLookup replacement)
- 847: Cache write - keep/migrate to cache layer
- 875: Cache write from server - keep/migrate
- 901: Validation gate - replace with actions[]
- 916, 1311: UI branching - replace with actions[]

### Reads of pendingChecklist (13 unique locations):

- 532: Derived flag for UI badge - replace with actions[] check
- 566-567: Cache read/dialog pop - keep/migrate to actions[]
- 729-734: Dialog logic/batch handler - keep/migrate
- 770-802: Offline computation from graph - keep/migrate
- 848: Cache write - keep/migrate
- 871: Cache write from server - keep/migrate
- 916: Derived flag - replace with actions[] check
- 979: Validation gate - replace with executor validation
- 1029, 1076, 1082, 1142, 1151, 1250, 1256: Dialog pop after advance - keep/migrate to actions[]

### Reads of stageLookup (4 unique locations):

- 681, 694: Server-precomputed checklist lookup - keep as canonical
- 764-769: Cache read for offline graph walk - keep as canonical
- 874: Cache write from server - keep/migrate

---

## FE Consumer 2: Desktop Filter Operations

File: apps/web/src/routes/filter-management/filter-operations.tsx (1370 lines)

### Reads of nextAllowedStages (6 unique locations):

- 88: Cache write - keep/migrate
- 534, 574: Cache write from server - keep/migrate
- 612: Cache update - keep/migrate
- 642: Validation availability check - replace with actions[]
- 720-721: Validation gate + error message - replace with actions[]

### Reads of pendingChecklist (9 unique locations):

- 86, 571: Cache write - keep/migrate
- 435-436: Dialog pop on batch - replace with actions[] check
- 460, 486, 489, 493, 497, 527, 535: Offline computation - keep/migrate
- 571, 613: Cache write - keep/migrate
- 729-734: Dialog batch logic - keep/migrate
- 1059-1060, 1112-1113, 1366-1367: Dialog pop after advance - replace with actions[] check

---

## Cleanup Action Plan

### Phase 8.7 Server-side Removals:

1. routes.ts:26-35 - Delete nextAllowedStages + pendingChecklist from schema
2. filter-operations.service.ts:805-828 - Remove 3 field assignments from return
3. Keep: stageLookup, actions, all other response fields

### Phase 8.7 FE-side Cleanup (deferred):

1. Migrate cache writes to use stageLookup + actions instead
2. Replace validation gates (nextAllowedStages checks) with actions[] checks
3. Replace UI branching (pendingChecklist length checks) with actions[].type checks
4. Keep offline graph-walk logic (Tier-2) for backward compatibility

### Pre-cutover Validation:

- Verify actions[] emission in all routes
- Verify stageLookup always populated
- Run parity harness with TAPE_PARALLEL=true
- Ensure FE offline tests use stageLookup Tier-1 path

