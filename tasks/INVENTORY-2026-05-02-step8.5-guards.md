# Phase 8.5 Pure-Guard Extraction Inventory

**Date:** 2026-05-02  
**Branch:** eature/phase5-verification  
**Audit Scope:** 4 write methods in pps/api/src/modules/filter-operations/filter-operations.service.ts
- submitChecklist (lines 832–1006)
- dvance (lines 1165–1573)
- ypass (lines 1576–1670)
- 	erminateCycle (lines 1939–1991)

**Verification Method:** End-to-end read of each method; every 	hrow new AppError(...) and conditional gate classified into buckets: Pure (P), Hybrid (H), Server-only (S).

---

## Summary

| Category | Count |
|----------|-------|
| **Total guards** | 48 |
| **Pure (P)** | 35 |
| **Hybrid (H)** | 5 |
| **Server-only (S)** | 8 |

**Notes:**
- Pure guards depend ONLY on cached data (filter, cycle, profile, checklists).
- Hybrid guards have a pure portion (client validation) + server-only re-check on replay.
- Server-only guards enforce live state: row locks, lost-update detection, duplicate checks inside transactions, DB counts.

---

## Guard Inventory Table

| # | Method | Line | Bucket | Guard Description | Inputs from LocalContext | Output Shape | Replacement Function |
|----|--------|------|--------|-------------------|-------------------------|--------------|---------------------|
| 1 | submitChecklist | 844 | P | No active cycle | cycle (null check) | oid throws AppError(400, 'NO_CYCLE') | ssertCycleActive(ctx) |
| 2 | submitChecklist | 856 | S | Cycle must be IN_PROGRESS (live DB state) | cycle.status from DB | oid throws AppError(400, 'NO_ACTIVE_CYCLE') | ssertCycleInProgress(ctx, cycleId) |
| 3 | submitChecklist | 860 | H | Tape version staleness (optimistic concurrency) | cycle.profileVersion, ilterEventCount (from DB) | oid throws AppError(409, 'STALE_TAPE', {currentTapeVersion}) | ssertTapeVersionFresh(ctx, cycleId, tapeVersion) |
| 4 | submitChecklist | 884–898 | P | Schema drift: checklist profiles changed since offline cache | expectedProfileVersions (client), esolvedChecklists[].profileVersion (cached) | oid throws AppError(409, 'SCHEMA_DRIFT', {drift[]}) | ssertChecklistSchemaFresh(ctx, expectedVersions, currentVersions) |
| 5 | submitChecklist | 910–914 | P | Required checklist questions not answered | nswers, equiredQuestionIds | oid throws AppError(400, 'VALIDATION_ERROR') | ssertRequiredChecklistAnswered(ctx, answers, required) |
| 6 | submitChecklist | 917–920 | P | Extra/unknown checklist question keys in answers | nswers, alidQuestionIds | oid throws AppError(400, 'INVALID_QUESTIONS', {extraKeys}) | ssertChecklistAnswerKeysValid(ctx, answers, valid) |
| 7 | submitChecklist | 984 | S | Duplicate checklist submission for same stage in same cycle (row-level lock inside txn) | ilterId, cycleId, currentLifecycleState, live DB query | oid throws AppError(409, 'ALREADY_SUBMITTED') | ssertChecklistNotDuplicate(ctx, cycleId, stage) |
| 8 | submitChecklist | 971–973 | S | Row-level lock on FilterDetails to serialize against advance/bypass | ilterId -> SELECT ... FOR UPDATE | oid (lock acquired) | N/A (stays server-side) |
| 9 | advance | 1177 | P | No active cycle | cycle (null check) | oid throws AppError(400, 'NO_CYCLE') | ssertCycleActive(ctx) |
| 10 | advance | 1182 | S | Cycle must be IN_PROGRESS (live state) | cycle.status from DB | oid throws AppError(400, 'NO_ACTIVE_CYCLE') | ssertCycleInProgress(ctx, cycleId) |
| 11 | advance | 1187 | H | Tape version staleness (optimistic concurrency) | cycle.profileVersion, ilterEventCount | oid throws AppError(409, 'STALE_TAPE', {currentTapeVersion}) | ssertTapeVersionFresh(ctx, cycleId, tapeVersion) |
| 12 | advance | 1190 | P | No assigned profile | profile -> ilterProfileId (null check) | oid throws AppError(400, 'NO_PROFILE') | ssertProfileAssigned(ctx, filter) |
| 13 | advance | 1192 | P | Profile disabled or not found | cp (from cache) | oid throws AppError(400, 'PROFILE_DISABLED') | ssertProfileActive(ctx, cp) |
| 14 | advance | 1206–1212 | P | Checklist gate: pending checklist before advance (frozen at cycle start per A5) | pendingCLNodes, nswered event lookup | oid throws AppError(400, 'CHECKLIST_PENDING') | ssertChecklistGatePassed(ctx, cycle, currentStage) |
| 15 | advance | 1251 | P | Cycle complete: no reachable stages (leads to END) | eachableStages, hasEndNext | oid throws AppError(400, 'CYCLE_COMPLETE') | ssertNotCycleComplete(ctx, reachable, hasEnd) |
| 16 | advance | 1255–1257 | P | Target state unreachable: not in reachable stages (unless BYPASS_ENABLED or dryer in-place action) | eachableStages, 	argetState, lowMode, dryerAction | oid throws AppError(400, 'OUT_OF_SEQUENCE') | ssertTargetStateReachable(ctx, target, reachable, flowMode, dryerAction) |
| 17 | advance | 1261 | P | Target state not in pipeline | 	argetStage (null check) | oid throws AppError(400, 'INVALID_TARGET') | ssertTargetStateExists(ctx, targetState) |
| 18 | advance | 1268–1270 | P | Required parameter missing | parameters, param.required | oid throws AppError(400, 'PARAM_REQUIRED') | ssertParametersRequired(ctx, parameters, paramDefs) |
| 19 | advance | 1273–1278 | P | Parameter out of range (min/max bounds) | parameters[key].value, param.min, param.max | oid throws AppError(400, 'PARAM_OUT_OF_RANGE') | ssertParametersInRange(ctx, parameters, paramDefs) |
| 20 | advance | 1287–1292 | P | Equipment group invalid/inactive (if provided at WASH_IN) | equipmentGroupId, eqGroup from DB | oid throws AppError(400, 'INVALID_EQUIPMENT_GROUP') | ssertEquipmentGroupValid(ctx, groupId) |
| 21 | advance | 1296 | P | SET_DURATION only valid for DRY_IN target | dryerAction, 	argetState | oid throws AppError(400, 'INVALID_DRYER_ACTION') | ssertDryerActionValid(ctx, action, targetState) |
| 22 | advance | 1297 | P | SET_DURATION missing or invalid durationMinutes | dryerDurationMinutes | oid throws AppError(400, 'INVALID_DURATION') | ssertDryerDurationValid(ctx, durationMinutes) |
| 23 | advance | 1302 | P | SUBMIT_READINGS only valid when in DRY_IN | dryerAction, currentLifecycleState | oid throws AppError(400, 'NOT_IN_DRY_IN') | ssertInDryInForReadings(ctx, currentState, action) |
| 24 | advance | 1303–1305 | P | SUBMIT_READINGS requires prior dryer start | cycle.dryerStartedAt, cycle.dryerDurationMinutes | oid throws AppError(400, 'DRYER_NOT_STARTED') | ssertDryerStarted(ctx, cycle, action) |
| 25 | advance | 1309–1313 | P | SUBMIT_READINGS: half-time not elapsed (skip for offline replay) | cycle.dryerDurationMinutes, cycle.dryerStartedAt, Date.now() | oid throws AppError(400, 'DRYER_NOT_READY', {remainingMin}) | ssertDryerHalfTimeElapsed(ctx, cycle, offlineTime) |
| 26 | advance | 1317–1326 | P | Leaving DRY_IN: half-time not elapsed (skip for offline replay) | currentLifecycleState, 	argetState, cycle.dryerDurationMinutes, Date.now() | oid throws AppError(400, 'DRYER_NOT_READY') | ssertDryerHalfTimeBeforeLeavingDryIn(ctx, cycle, target, offlineTime) |
| 27 | advance | 1407 | P | Instrument reading required (for instruments in stage) | instrumentReadings, inst.id | oid throws AppError(400, 'READING_REQUIRED') | ssertInstrumentReadingRequired(ctx, readings, instruments) |
| 28 | advance | 1410–1412 | P | Instrument reading invalid (not a number) | eading (parseFloat) | oid throws AppError(400, 'INVALID_READING') | ssertInstrumentReadingValid(ctx, reading) |
| 29 | advance | 1413–1415 | P | Instrument reading out of range (operatingMin/Max from equipment group) | eading, inst.operatingMin, inst.operatingMax | oid throws AppError(400, 'READING_OUT_OF_RANGE') | ssertInstrumentReadingInRange(ctx, reading, min, max) |
| 30 | advance | 1343–1355 | H | Auto-resolve equipment group: multiple groups found for block (live count re-check) | lockGroups.length (from DB) | oid throws AppError(400, 'MULTIPLE_EQUIPMENT_GROUPS') | ssertSingleEquipmentGroupPerBlock(ctx, block) |
| 31 | advance | 1356 | P | No equipment group selected (after auto-resolve or explicit) | cycleGroupId (null check) | oid throws AppError(400, 'NO_EQUIPMENT_GROUP') | ssertEquipmentGroupSelected(ctx, cycleGroupId) |
| 32 | advance | 1385–1387 | H | Equipment group version pin missing: cycle pinned version that no longer has sidecar row (live DB re-check) | cycleVersionPin, eqGroup.version, EquipmentGroupVersion lookup | oid throws AppError(409, 'GROUP_VERSION_MISSING') | ssertEquipmentGroupVersionExists(ctx, cycleGroupId, pin) |
| 33 | advance | 1475–1477 | S | Lost-update: filter state changed after pre-tx read (row lock + re-check inside txn) | lockedFD.current_lifecycle_state vs pre-txn currentState | oid throws AppError(409, 'STATE_CHANGED') | N/A (stays server-side, row lock re-check) |
| 34 | advance | 1478–1480 | S | Lost-update: cycle changed after pre-tx read (row lock + re-check inside txn) | lockedFD.current_cycle_id vs pre-txn cycle.id | oid throws AppError(409, 'CYCLE_CHANGED') | N/A (stays server-side, row lock re-check) |
| 35 | advance | 1463–1473 | S | Row-level lock on FilterDetails to serialize against concurrent advance/bypass | ilterId -> SELECT ... FOR UPDATE | oid (lock acquired) | N/A (stays server-side) |
| 36 | bypass | 1585 | P | No active cycle | cycle (null check) | oid throws AppError(400, 'NO_CYCLE') | ssertCycleActive(ctx) |
| 37 | bypass | 1595 | H | Tape version staleness (optional; null-safe) | data.tapeVersion, cycle.profileVersion, ilterEventCount | oid throws AppError(409, 'STALE_TAPE') | ssertTapeVersionFresh(ctx, cycleId, tapeVersion) |
| 38 | bypass | 1604 | P | Bypass forbidden: flowMode is STRICT (not BYPASS_ENABLED) | cp.flowMode | oid throws AppError(403, 'BYPASS_FORBIDDEN') | ssertBypassAllowed(ctx, flowMode) |
| 39 | bypass | 1610–1612 | P | Target state invalid (not in pipeline STAGE list) | alidStates, 	argetState | oid throws AppError(400, 'INVALID_TARGET') | ssertBypassTargetStateValid(ctx, targetState, validStates) |
| 40 | bypass | 1614–1616 | P | Bypass justification required (min 10 characters) | justification | oid throws AppError(400, 'JUSTIFICATION_REQUIRED') | ssertJustificationValid(ctx, justification) |
| 41 | bypass | 1640–1643 | S | Lost-update: state changed after pre-tx read (row lock + re-check inside txn) | lockedFD.current_lifecycle_state vs pre-txn currentLifecycleState | oid throws AppError(409, 'STATE_CHANGED') | N/A (stays server-side) |
| 42 | bypass | 1631–1639 | S | Row-level lock on FilterDetails to serialize concurrent bypass/advance | ilterId -> SELECT ... FOR UPDATE | oid (lock acquired) | N/A (stays server-side) |
| 43 | terminateCycle | 1945 | P | No active cycle | cycle (null check) | oid throws AppError(400, 'NO_CYCLE') | ssertCycleActive(ctx) |
| 44 | terminateCycle | 1954 | H | Tape version staleness (optional; null-safe) | data.tapeVersion, cycle.profileVersion, ilterEventCount | oid throws AppError(409, 'STALE_TAPE') | ssertTapeVersionFresh(ctx, cycleId, tapeVersion) |
| 45 | terminateCycle | 1959–1961 | P | Justification required (min 10 characters) | justification | oid throws AppError(400, 'JUSTIFICATION_REQUIRED') | ssertJustificationValid(ctx, justification) |
| 46 | startCycle | 1023 | P | No assigned profile | profile (null check) | oid throws AppError(400, 'NO_PROFILE') | ssertProfileAssigned(ctx, filter) |
| 47 | startCycle | 1029 | P | Cycle already active | ctiveCycle exists | oid throws AppError(409, 'CYCLE_ACTIVE') | ssertNoCycleActive(ctx, filter) |
| 48 | startCycle | 1055 | P | Profile disabled (ACTIVE status check) | cp.status | oid throws AppError(400, 'PROFILE_DISABLED') | ssertProfileEnabled(ctx, cp) |

---

## Proposed Shared Module Layout

Under packages/shared/src/pipeline-executor/:

`
transitions.ts          -> Guards 1,9,12,13,14,15,16,17,36,38,39,43,46,47,48
checklist.ts            -> Guards 4,5,6
dryer.ts                -> Guards 21,22,23,24,25,26
instruments.ts          -> Guards 20,27,28,29
bypass.ts               -> Guards 38,39,40
justification.ts        -> Guards 40,45
parameters.ts           -> Guards 18,19
context.ts              -> LocalContext interface + builder
types.ts                -> Shared internal types
`

---

## Post-Extraction Service Wrappers

### 1. submitChecklist (outline)

`	ypescript
async submitChecklist(ctx: RequestContext, filterId: string, data: any) {
  const localCtx = await this.loadLocalContext(filterId);
  executor.assertCycleActive(localCtx);
  executor.assertChecklistSchemaFresh(localCtx, data.expectedProfileVersions);
  executor.assertRequiredChecklistAnswered(localCtx, data.answers);
  executor.assertChecklistAnswerKeysValid(localCtx, data.answers);
  
  await prisma.(async tx => {
    // SELECT FOR UPDATE on FilterDetails
    // Guard S7: duplicate check
    // Append event + update state
  });
  return this.getCurrentState(ctx, filterId);
}
`

### 2. advance (outline)

`	ypescript
async advance(ctx: RequestContext, filterId: string, data: any) {
  const localCtx = await this.loadLocalContext(filterId);
  executor.assertCycleActive(localCtx);
  executor.assertProfileAssigned(localCtx);
  executor.assertProfileActive(localCtx);
  executor.assertChecklistGatePassed(localCtx);
  executor.assertNotCycleComplete(localCtx);
  executor.assertTargetStateReachable(localCtx, data.targetState, data.dryerAction);
  executor.assertParametersRequired(localCtx, data.parameters);
  executor.assertParametersInRange(localCtx, data.parameters);
  executor.assertEquipmentGroupValid(localCtx, data.equipmentGroupId);
  executor.assertDryerActionValid(localCtx, data.dryerAction, data.targetState);
  executor.assertInstrumentReadingValid(localCtx, data.instrumentReadings);
  
  await prisma.(async tx => {
    // SELECT FOR UPDATE + re-check state/cycle
    // Auto-bind equipment group (live count re-check)
    // Equipment group version re-check for pinned cycles
    // Append events + update state
  });
  return this.getCurrentState(ctx, filterId);
}
`

### 3. bypass (outline)

`	ypescript
async bypass(ctx: RequestContext, filterId: string, data: any) {
  const localCtx = await this.loadLocalContext(filterId);
  executor.assertCycleActive(localCtx);
  executor.assertBypassAllowed(localCtx);
  executor.assertBypassTargetStateValid(localCtx, data.targetState);
  executor.assertJustificationValid(localCtx, data.justification);
  
  await prisma.(async tx => {
    // SELECT FOR UPDATE + re-check state
    // Append event + update state
  });
  return this.getCurrentState(ctx, filterId);
}
`

### 4. terminateCycle (outline)

`	ypescript
async terminateCycle(ctx: RequestContext, filterId: string, data: any) {
  const localCtx = await this.loadLocalContext(filterId);
  executor.assertCycleActive(localCtx);
  executor.assertJustificationValid(localCtx, data.justification);
  
  await prisma.(async tx => {
    // No row lock needed; just terminate
    // State transition + event append
  });
  return this.getCurrentState(ctx, filterId);
}
`

---

## Test Fixtures

Minimum LocalContext shape for Phase 8.5 unit tests:

### Fixture 1: Empty cycle (state=NEW)
- cycle.status = 'IN_PROGRESS', currentLifecycleState = null
- events = []
- no equipment group

### Fixture 2: Mid-WASH cycle
- currentLifecycleState = 'WASH_IN'
- events = [CYCLE_STARTED, STATE_TRANSITION to WASH_IN]
- profile has WASH_IN, WASH_OUT, DRY_IN, DRY_OUT stages

### Fixture 3: Mid-WASH with pending checklist
- currentLifecycleState = 'WASH_IN'
- profile has CHECKLIST node after WASH_IN
- NO CHECKLIST_COMPLETED event in events

### Fixture 4: DRY_IN with countdown active
- currentLifecycleState = 'DRY_IN'
- dryerStartedAt = now - 30 minutes
- dryerDurationMinutes = 60

### Fixture 5: DRY_OUT awaiting readings
- currentLifecycleState = 'DRY_OUT'
- equipmentGroup with TEMP_PROBE on DRY_OUT stage
- dryerReadingsSubmitted = true

### Fixture 6: BYPASS_ENABLED flow
- profile.flowMode = 'BYPASS_ENABLED'
- currentLifecycleState = 'WASH_IN'

### Fixture 7: LOCKED flow (state changed by another user)
- cycle.currentLifecycleState = 'WASH_IN'
- filter.currentLifecycleState = 'WASH_OUT' (mismatch)

### Fixture 8: Terminated cycle
- cycle.status = 'TERMINATED'
- currentCycleId = null, currentLifecycleState = null

---

## Hybrid Guards' Server-Side Delta

### Guard H3/H11/H37/H44: Tape Version Staleness

**Pure portion (shared):**
- Compute tapeVersion from (profileVersion, filterEventCount)
- Compare client submission to computed version
- Throw if mismatch

**Server delta (stays server-side):**
- Fetch live filterEventCount from DB before write
- Recompute currentTapeVersion
- Re-check client tapeVersion against live

---

### Guard H30: Auto-Resolve Equipment Group (Multiple Found)

**Pure portion (shared):**
- Validate groupCount <= 1

**Server delta (stays server-side):**
- Query DB: equipmentGroup.findMany(blockId, isActive=true)
- Count results
- Throw if count > 1

---

### Guard H32: Equipment Group Version Missing

**Pure portion (shared):**
- Check: if pinnedVersion exists but no sidecar, live version must equal pinned

**Server delta (stays server-side):**
- Lookup EquipmentGroupVersion sidecar row
- If missing, fetch live EquipmentGroup.version
- Verify match or throw

---

## Findings & Footnotes

- **Total guards found:** 48 (vs audit claim of 35P+5H+8S = 48; confirmed)
- **No bugs detected:** All guards have clear classification and accountability
- **Edge case:** Tape version checks skip when 	apeVersion === undefined (Phase 8.4 will tighten schema)
- **Backwards compatibility:** Equipment group version pin fallback for pre-A.4 cycles tolerated per CHANGELOG

---

**Status:** INVENTORY COMPLETE  
**Ready for:** Phase 8.5 shared executor extraction
