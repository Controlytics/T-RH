# Filter Walk-Through — Online Flow

## Overview

This document traces the complete end-to-end flow for an operator walking a filter through a cleaning cycle on the web or mobile app. The operator scans/selects a filter, picks a cleaning reason, starts the cycle, advances through pipeline stages (WASH_IN → WASH_OUT → DRY_IN → DRY_OUT → STORAGE_IN → STORAGE_OUT or per profile), submits checklists between STAGE nodes when prompted, may bypass stages if needed (deviation), and terminates or auto-completes on END.

All 5 write operations (start-cycle, advance, submit-checklist, bypass, terminate-cycle) follow a strict guard sequence: loadLocalContext → assertCycleActive → offlineTime validation → assertTapeVersionFresh → assertProfileActive → operation-specific guards → lockAndVerifyFilterState in transaction → mutation → audit log. Each write returns the full server state via getCurrentState, which computes actions[] and tapeVersion via the decision-tape generator. The tapeVersion is a monotonic counter per cycle, derived from (profileVersion, filterEventCount), and clients must send it back on the next write for staleness checks.

---

## 1. start-cycle

### Frontend
**File:** apps/web/src/routes/filter-management/filter-operations.tsx:863-1105

Entry point: handleReasonSubmit() at line 920. Builds cycleBody with cleaningReasonKey, cleaningJustification, cleaningAreaId, equipmentGroupId.

For WASH_IN: immediately calls start-cycle (line 975), then fetches current-state (line 1002) to get fresh tapeVersion for paired advance (Phase 8.7 Wave-2 pattern to avoid STALE_TAPE).

For non-WASH_IN or offline: calls executeOrQueue('start-and-advance', ...) as single queue item.

### API call

POST /api/filters/:id/start-cycle

Body: cleaningReasonKey (required), cleaningJustification, cleaningAreaId, equipmentGroupId, offlinePerformedAt (offline), clientOpId (offline)

### Backend route + impl

**Route:** apps/api/src/modules/filter-operations/routes.ts:134-175
- Prehandler: app.requirePermission('FILTER_OPERATE')
- Enforceauth gate: line 168 — enforceReauth('START_CLEANING_CYCLE', req, reply)

**Implementation:** apps/api/src/modules/filter-operations/cycle-write/start-cycle.ts:27-207

### Guards (in order)

1. idempotency check (line 46): findExistingByClientOpId()
2. HTML escape (line 49): sanitize cleaningJustification
3. getFilter() (line 51): fetch filter; throws 404 if not found
4. resolveFilterProfile() (line 52): resolve profile; throws 400 NO_PROFILE if none
5. activeCycle check (line 56-60): if filter.currentCycleId IN_PROGRESS, throw 409 CYCLE_ACTIVE
6. validateBlockChange() (line 63): ensure cleaningAreaId matches or has approval
7. validateOfflinePerformedAt() (line 40): validate wall-clock timestamp
8. getCleaningReasons() (line 65): validate cleaningReasonKey
9. justification length (line 71-72): enforce min 10 chars if reason.requiresJustification
10. profile.status check (line 84-86): throw 400 PROFILE_DISABLED if not ACTIVE

**Transaction block (123-197):**
- SELECT FOR UPDATE on filter_details (124-128): acquire lock and recheck currentCycleId
- equipmentGroupVersionPin lookup (142-149): pin live group.version if provided (Phase A.4 P1)
- ChecklistProfile version pinning (94-112): snapshot every ChecklistProfile in pipeline
- Create CleaningCycle (151-175): insert with cycleCode, checklistVersionPins, equipmentGroupVersionPin
- Create FilterEvent (CYCLE_STARTED) (177-187): immutable event
- Upsert FilterDetails.currentCycleId (190-194)

### DB writes

- CleaningCycle (insert): cycleCode, filterId, profileId, cleaningReasonKey, equipmentGroupVersionPin, checklistVersionPins, status=IN_PROGRESS
- FilterEvent (insert): eventType=CYCLE_STARTED, clientOpId, checksum, ipAddress
- FilterDetails (upsert): currentCycleId
- audit_trail (insert): action=CYCLE_STARTED

### Response + FE side effects

201 Created with cycle metadata (no tape). FE immediately calls getCurrentState (line 1002) to fetch fresh tape.

---

## Summary

**tapeVersion formula:** tapeVersion = computeTapeVersion(profileVersion, eventCount)

Clients send back the tape from prior response; server rejects with 409 STALE_TAPE if mismatch.

**Offline flow:** executeOrQueue wraps writes; queues offline, caches locally via recomputeAndCacheFilterState, replays on sync with clientOpId idempotency.

---
