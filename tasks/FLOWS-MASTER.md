# DigiLog — End-to-End Code Flows

Code-grounded trace of the major operator flows. Every claim cites the file:line that backs it. Read `apps/api/src/modules/filter-operations/cycle-write/*.ts` and `apps/web/src/lib/{sync-engine,offline-store}.ts` alongside this doc — the citations are the canonical source.

**Scope:**
1. [Block creation](#1-block-creation)
2. [Area creation](#2-area-creation)
3. [Filter creation](#3-filter-creation)
4. [Filter cleaning profile creation](#4-filter-cleaning-profile-creation)
5. [Filter walk-through — ONLINE](#5-filter-walk-through--online)
6. [Filter walk-through — OFFLINE + sync-back](#6-filter-walk-through--offline--sync-back)

Worktree: `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`

---

## 1. Block creation

A **Block** is an `AssetInstance` whose `template.templateKind === 'BLOCK'`. It's the top of the cleanroom hierarchy: Block → Area → AHU → Filter.

### Frontend entry
- **File:** `apps/web/src/routes/filter-management/filter-list.tsx`
- **Trigger:** "Create Block" button opens `CreateHierarchyDialog` with `type: 'block'`
- **Handler:** `handleCreate()` at `:217` collects `name` + dynamic attributes from the dialog
- **Validation:** `findMissingRequiredAttributes()` checks template `attributeSchema` for required fields client-side
- **Body built:** `{ name, templateId, status: 'Active', attributes, parentId? }`

### API call
```
POST /api/assets/instances
Content-Type: application/json
Authorization: Bearer <jwt>
x-reauth-password: <pwd>            # if reauth gate fires for the role
Body: { name, templateId, status: 'Active', attributes: {...} }
```

### Backend route + handler
- **File:** `apps/api/src/modules/assets/routes/instance.routes.ts:213-255`
- **Pre-handlers:**
  - `:214` — `app.requireAnyPermission('ASSET_CREATE', 'FILTER_CREATE', 'FILTER_HIERARCHY_CREATE')`
  - `:245` — `enforceReauth(['CREATE_ASSET', 'CREATE_FILTER'], req, reply)` — multi-action reauth (gate fires if EITHER action requires reauth for the user's role)
- **Schema:** `:248` — `createAssetInstanceSchema.safeParse(req.body)`
- **Service call:** `:253` — `instanceService.create(parsed.data, buildContext(req))`

### Service / DB writes
- **File:** `apps/api/src/modules/assets/services/instance.service.ts:71-189`
- Wrapped in `prisma.$transaction()`:
  - `:96` — `prisma.assetInstance.create({ data: { name, templateId, status, attributes, isActive: true, parentId? } })`
  - `:112` — if `template.templateKind === 'FILTER'`, also create a 1:1 `FilterDetails` sidecar (Step-6 split). For BLOCK/AREA/AHU this is **skipped**.
  - `:117-120` — if `parentId` supplied, create the bidirectional `AssetRelationship` pair (`CONTAINS` + `CONTAINED_IN`). The `trg_asset_relationship_pair` constraint trigger (compliance invariants migration) enforces both halves exist.
- **Audit:**
  - `:141` — `auditLog({ action: 'ASSET_CREATED', targetType, targetId, afterValue: { name, templateName, templateKind, parentId? } })` — written through the C3 hash-chain (advisory lock + previous_checksum link).
  - `:129` — `auditLog({ action: 'ASSET_RELATIONSHIP_CREATED', ... })` if a parent was wired.

### Response
- HTTP **201** with the created instance (FilterDetails fields flattened in by `instance.repository.ts:15-17` for FILTER kinds; for BLOCK there are no FilterDetails fields).

### Frontend side effects
- `filter-list.tsx:252` — toast success
- `:253` — close dialog + clear state
- `:254` — `mutate('/api/assets/instances?limit=500')` — SWR revalidation

---

## 2. Area creation

Areas are children of Blocks. Identical wire flow to block — only the `templateId` and `parentId` differ.

### Frontend entry
- **Same page** (`filter-list.tsx`), **same handler** (`handleCreate()` at `:217`)
- Dialog opened with `type: 'area'` and `createDialog.parentId` set to the selected block's UUID
- Validation: `findMissingRequiredAttributes()` against the AREA template's `attributeSchema`

### API call
```
POST /api/assets/instances
Body: { name, templateId, status: 'Active', attributes: {...}, parentId: <blockId> }
```

### Backend route + handler
- **Same route** as Block (`instance.routes.ts:213-255`), same pre-handlers, same schema validation
- **Additional check:** `instance.service.ts:88` — `validateParent()` confirms the parent exists (prevents orphan creation)

### Service / DB writes
- `instance.service.ts:71-189` — same code path as Block:
  - Create `AssetInstance` row with `parentId = blockId`
  - **No** `FilterDetails` sidecar (templateKind is AREA, not FILTER)
  - Create `CONTAINS` + `CONTAINED_IN` relationship pair to the block
- Audits: `ASSET_CREATED` + `ASSET_RELATIONSHIP_CREATED`

### Response
- HTTP 201 with the AREA instance.

### Frontend side effects
- Identical to Block: toast → dialog close → SWR mutate.

---

## 3. Filter creation

Filters are leaves in the hierarchy: Block → Area → AHU → Filter. Two FE entry points exist: single-filter dialog and bulk CSV upload. Both hit the same backend route.

### 3a. Single-filter dialog

#### Frontend entry
- **File:** `apps/web/src/routes/filter-management/filter-list/dialogs/CreateFilterDialog.tsx`
- **Trigger:** `openCreateFilter()` at `:778` opens the dialog
- **Handler:** `submitCreateFilter()` at `:791`
  - Validates AHU selection, filter name, required dynamic attributes
  - Coerces numeric type fields per template (`:805-820`)
  - Wraps the call in `reauth.execute('CREATE_FILTER', async (password?) => {...})` at `:826`

#### API call
```
POST /api/assets/instances
Body: {
  name: 'F-001',
  templateId: <FILTER template UUID>,
  parentId: <ahuId>,                      # parent is the AHU
  filterSet: 'A' | 'B',                   # NOT persisted on initial create — see note
  filterProfileId?: <profile UUID>,       # NOT persisted on initial create — see note
  attributes: { ...dynamic attrs... }
}
```

#### Backend
- **Route:** same `instance.routes.ts:213-255` as block/area
- **Service:** `instance.service.ts:71-189`:
  - Creates `AssetInstance` with `parentId = ahuId`
  - **Eagerly creates `FilterDetails` sidecar at `:112`** because `template.templateKind === 'FILTER'`. Sidecar carries cycle-time state (`currentCycleId`, `currentLifecycleState`, `filterProfileId`, `filterSet`).
  - **`filterSet` and `filterProfileId` from the request body are IGNORED on initial single-filter create.** FilterDetails is created with both fields null. Operators must set them later via the FilterDetails edit endpoint, OR use bulk-upload (which does write them).
  - Creates `CONTAINS` + `CONTAINED_IN` relationship pair to the AHU
- **Audits:** `ASSET_CREATED` + `ASSET_RELATIONSHIP_CREATED`

#### Response
- HTTP 201 with `AssetInstance` + (empty) `FilterDetails` flattened in.

#### Frontend side effects
- `:839` — toast success
- `:840` — close dialog
- `:841` — `mutate(...)` to refresh the filter list

### 3b. Bulk CSV upload

#### Frontend entry
- `apps/web/src/routes/filter-management/filter-list/dialogs/BulkUploadDialog.tsx` (similar shape to single-filter dialog) — operator uploads a CSV with one filter per row.

#### API call
```
POST /api/assets/instances/bulk-upload-filters
Content-Type: multipart/form-data
Body: csv file + ahuId + blockId
```

#### Backend
- **Route:** `instance.routes.ts:258-334`
- **Pre-handlers:** `requireAnyPermission('ASSET_CREATE', 'FILTER_BULK_UPLOAD')` + `enforceReauth('BULK_UPLOAD_FILTERS')` — note enforceReauth runs **before** multipart consumption (audit C2 fix).
- **Service:** `apps/api/src/modules/assets/services/bulk-upload-filter.service.ts`
  - Parses CSV
  - For each row: creates AssetInstance + FilterDetails + relationship in a transaction
  - **`:240-242` — bulk DOES write `filterSet` and `filterProfileId` into FilterDetails at creation time** (single-filter path doesn't).

---

## 4. Filter cleaning profile creation

A cleaning profile is a directed pipeline graph: START → STAGE/CHECKLIST nodes → END, with `flowMode` (STRICT or BYPASS_ENABLED), per-stage `stateKey` (WASH_IN/WASH_OUT/DRY_IN/DRY_OUT/STORAGE_IN/STORAGE_OUT), and CHECKLIST nodes referencing `checklistProfileId`.

**Versioning:** snapshot-then-bump via `lineageId`. Every save archives the prior row (`status='ARCHIVED'`) and inserts a new row with `version+1` carrying the same `lineageId`. Cycles pin `profileId` at start so they always read the version that was active when they were created.

> **Detailed trace lives in** `tasks/FLOW-cleaning-profile-creation.md` (282 lines, full schema + state shapes). Key citations summarized below.

### Frontend entry
- **File:** `apps/web/src/routes/filter-management/cleaning-profile-editor.tsx:44`
- **Route:** `/filter-cleaning-profiles/:id/edit` (id="new" creates, UUID edits)
- **Visual editor:** Custom canvas/ReactFlow-style — drag nodes, wire connections, configure CHECKLIST node `checklistProfileId` from a dropdown
- **State:** `nodes: PipelineNode[]` + `connections: Connection[]` + profile metadata (`name`, `flowMode`, alarm flags)
- **Loads:**
  - GET `/api/filter-cleaning-profiles/:id` (edit mode, via SWR)
  - GET `/api/checklist-profiles?limit=500&isActive=true` (CHECKLIST node dropdown)

### API call

**Create:**
```
POST /api/filter-cleaning-profiles
x-reauth-password: <pwd>
Body: {
  name, description, flowMode: 'STRICT' | 'BYPASS_ENABLED',
  alarmOnForwardSkip, alarmOnBackwardJump, alarmOnOutOfSequence,
  stages: [{ stateKey, nodeType, configuration, positionX/Y, sortOrder }],
  connections: [{ fromIndex, toIndex, label }]   # array indices, server maps to UUIDs
}
```

**Update:**
```
PUT /api/filter-cleaning-profiles/:id
(same body shape — server archives the old row + creates v+1)
```

### Backend
- **Route file:** `apps/api/src/modules/cleaning-profiles/routes.ts`
- **POST `:68-127`** — preHandlers `requireAnyPermission('FCP_CREATE', 'CP_PAGE_CREATE')` + `enforceReauth('CREATE_CLEANING_PROFILE')` at `:122`
- **PUT `:129-165`** — preHandlers `requireAnyPermission('FCP_UPDATE', 'CP_PAGE_EDIT')` + `enforceReauth('UPDATE_CLEANING_PROFILE')` at `:160`
- **Service:** `apps/api/src/modules/cleaning-profiles/cleaning-profile.service.ts`
  - **`create()` `:84-145`** — sets `lineageId = randomUUID()`, `version=1`, `status='ACTIVE'`. Inserts profile + nested stages + connections (connections' `fromStageId`/`toStageId` resolved from sort order).
  - **`update()` `:147-265`** — wrapped in `prisma.$transaction()`:
    1. `:157-161` — flip old row to `status='ARCHIVED'`
    2. `:164-189` — insert new row with same `lineageId`, bumped `version`
    3. `:191-231` — remap connections from old stage UUIDs to new stage UUIDs via `sortOrder`
    4. `:234-237` — update every `FilterProfile.cleaningProfileId` reference from old → new
    5. `:240-250` — patch `cleaning-profile-assignment` config if it references the old ID

### Response
- 201 (create) / 200 (update) with the full profile row including new id + version.

### Frontend side effects
- Create success → navigate to `/filter-cleaning-profiles/{newId}/edit`
- Update success → if response.id ≠ current id (versioned), navigate to new id; otherwise SWR `mutate()`
- Toast notification

### Cleaning reasons lifecycle
- **Stored on the profile row** as `cleaningReasons` JSONB column (NOT versioned per profile — the editor doesn't mutate it).
- **Edited separately** via `/config/filter-cleaning-reasons` page → `PUT /api/config/dynamic/filter-cleaning-reasons` (gated by `UPDATE_CONFIG_PAGE` reauth action — added this session).

---

## 5. Filter walk-through — ONLINE

The operator scans/selects a filter, picks a cleaning reason, starts the cycle, advances through pipeline stages, submits checklists between stages when CHECKLIST nodes appear, may bypass stages (deviation), and terminates manually OR auto-completes when reaching the END node.

### Operations covered

| Op | URL | Body |
|---|---|---|
| start-cycle | `POST /api/filters/:id/start-cycle` | `{ cleaningReasonKey, cleaningJustification?, cleaningAreaId?, equipmentGroupId? }` |
| advance | `POST /api/filters/:id/advance` | `{ targetState, parameters?, equipmentGroupId?, instrumentReadings?, dryerAction?, dryerDurationMinutes?, remarks?, tapeVersion }` |
| submit-checklist | `POST /api/filters/:id/submit-checklist` | `{ answers, expectedProfileVersions?, tapeVersion }` |
| bypass | `POST /api/filters/:id/bypass` | `{ targetState, parameters?, justification, tapeVersion }` |
| terminate-cycle | `POST /api/filters/:id/terminate-cycle` | `{ justification, tapeVersion }` |
| (read) getCurrentState | `GET /api/filters/:id/current-state` | — |

All write ops also accept `clientOpId` (idempotency key) and `offlinePerformedAt` (operator wall-clock time) — used by offline replay.

### Universal guard sequence

Every cycle-write impl in `apps/api/src/modules/filter-operations/cycle-write/*.ts` runs the same sequence:

1. **Idempotency** — if `clientOpId` already processed for this filter, short-circuit and return current state. (`findExistingByClientOpId()` from `apps/api/src/lib/idempotency.ts`)
2. **HTML sanitize** text fields (`justification`, `remarks`, `cleaningJustification`)
3. **Load context** — `loadLocalContext(filterId, ctx)` from `local-context.ts` returns `{ ctx, filter, cycle, profile }` in one shot
4. **Pure guards via `@digilog/shared` executor:**
   - `assertCycleActive(localCtx)` — filter has currentCycleId
   - `assertProfileActive(localCtx, ...)` — profile non-null + status `ACTIVE`
   - `assertTapeVersionFresh(localCtx, data.tapeVersion)` — 409 STALE_TAPE if mismatch
   - op-specific guards (e.g., `assertBypassAllowed`, `assertJustificationValid`)
5. **`validateOfflinePerformedAt(data.offlinePerformedAt, { isReplay: ctx.isOfflineReplay, cycleStartedAt })`** — `apps/api/src/lib/offline-time-window.ts` — replay-only + ≤5min future skew + ≤30day stale + must be ≥ cycle.startedAt
6. **In-tx row lock + recheck** — `prisma.$transaction(async (tx) => { lockAndVerifyFilterState(tx, filterId, expectedState, expectedCycleId); ...mutate... })` from `cycle-write/locking.ts`
7. **Mutation** — insert FilterEvent (with checksum), update CleaningCycle and/or FilterDetails
8. **Audit** — `auditLog({ action, targetType: 'filter', targetId: filterId, afterValue, ... })` (writes through the C3 hash chain)
9. **Return** — `service.getCurrentState(ctx, filterId)` which emits the next `actions[]` + `tapeVersion`

### 5.1 start-cycle

#### Frontend
- `apps/web/src/routes/filter-management/filter-operations.tsx:863-1105` (web)
- Mobile equivalent in `apps/web/src/routes/mobile/mobile-operations.tsx`
- `handleReasonSubmit()` at `:920` builds body `{ cleaningReasonKey, cleaningJustification, cleaningAreaId, equipmentGroupId }`
- For WASH_IN: calls start-cycle then immediately fetches `/current-state` to obtain the fresh `tapeVersion` for the paired advance call (Phase 8.7 Wave-2 pattern to avoid STALE_TAPE)
- For other entry stages: queues a single `start-and-advance` op via `executeOrQueue`

#### Backend
- **Route:** `apps/api/src/modules/filter-operations/routes.ts:134-175` — `requirePermission('FILTER_OPERATE')` + `enforceReauth('START_CLEANING_CYCLE')` at `:168`
- **Impl:** `cycle-write/start-cycle.ts:27-207`

#### Guards (in order)
1. `:46` — clientOpId dedup
2. `:49` — sanitize cleaningJustification
3. `:51` — `getFilter()` → 404 if missing
4. `:52` — `resolveFilterProfile()` → 400 NO_PROFILE if no profile bound
5. `:56-60` — if `filter.currentCycleId` and active → 409 CYCLE_ACTIVE
6. `:63` — `validateBlockChange()` (cleaningAreaId matches home block OR has approval)
7. `:65-72` — validate cleaningReasonKey + min-10-char justification if `reason.requiresJustification`
8. `:84-86` — 400 PROFILE_DISABLED if profile not ACTIVE

#### In-tx block (`:123-197`)
- `:124-128` — `SELECT current_cycle_id FROM filter_details WHERE asset_instance_id = $1 FOR UPDATE` — row lock + recheck for race protection (audit C2 fix this branch)
- `:142-149` — if `equipmentGroupId` provided, fetch live group + capture `equipmentGroupVersionPin = group.version` (Phase A.4 P1 — pins the version; subsequent admin edits don't drift the in-flight cycle)
- `:94-112` — snapshot every CHECKLIST node's `ChecklistProfile.version` into `checklistVersionPins` JSONB on the cycle row (Phase A.1)
- `:151-175` — `tx.cleaningCycle.create({ data: { cycleCode, filterId, profileId, profileVersion, cleaningReasonKey, equipmentGroupVersionPin, checklistVersionPins, status: 'IN_PROGRESS', ... } })`
- `:177-187` — `tx.filterEvent.create({ data: { eventType: 'CYCLE_STARTED', clientOpId, checksum, ipAddress, ... } })`
- `:190-194` — `tx.filterDetails.upsert({ where: { assetInstanceId: filterId }, ... currentCycleId: newCycle.id })`

#### Audit + response
- `auditLog({ action: 'CYCLE_STARTED', targetType: 'cleaning_cycle', targetId: cycle.id, afterValue: { cycleCode, cleaningReasonKey, filterId } })`
- 201 with cycle metadata. FE then calls `/current-state` to get the fresh tape.

### 5.2 advance

#### Frontend
- `filter-operations.tsx` — handlers per stage (`handleAdvance`, dryer-specific handlers)
- For DRY_IN: 2-step flow (SET_DURATION → wait timer → SUBMIT_READINGS). Persists countdown panel state in IDB cache.

#### Backend impl: `cycle-write/advance.ts:22-349`

#### Guards (in order)
1. `:33` — clientOpId dedup
2. `:38` — `loadLocalContext`
3. `:39` — `assertCycleActive`
4. `:42-44` — cycle status === IN_PROGRESS check
5. `:49-52` — `validateOfflinePerformedAt({ isReplay, cycleStartedAt: cycle.startedAt })`
6. `:54` — `assertTapeVersionFresh(localCtx, data.tapeVersion)` — 409 STALE_TAPE if mismatch
7. `:55-56` — `assertProfileAssigned` + `assertProfileActive`
8. `:67` — `assertChecklistGatePassed` — block advance if pending checklist for the current stage hasn't been submitted
9. `:74-78` — compute `reachableStages` + `hasEndNext` from pipeline graph; `assertNotCycleComplete`
10. `:81-91` — `assertTargetStateReachable` (honors flowMode + dryer-in-place exception) + `assertTargetStateExists`
11. `:97-99` — `assertParametersRequired` + `assertParametersInRange` (PARAM_CAPTURE pure validation)
12. `:104-110` — equipment-group existence + isActive check (server I/O), `assertEquipmentGroupValid`
13. `:113-130` — dryer guards: `assertDryerActionValid`, `assertDryerDurationValid`, `assertInDryInForReadings`, `assertDryerStarted`, `assertDryerHalfTimeElapsed`, `assertDryerHalfTimeBeforeLeavingDryIn`
14. `:134-214` — instrument readings: per-instrument `assertInstrumentReadingRequired`/`Valid`/`InRange` against the **pinned** `EquipmentGroupVersion` snapshot (P1 fallback to live row if pin matches)

#### In-tx block (`:252-339`)
- `:257` — `lockAndVerifyFilterState(tx, filterId, currentState, cycle.id)` — SELECT … FOR UPDATE on filter_details + recheck `(currentLifecycleState, currentCycleId)` tuple. 409 STATE_CHANGED / CYCLE_CHANGED on mismatch.
- `:260-265` — bind equipment group if first time
- `:268-289` — if `dryerAction === 'SET_DURATION'`: persist `dryerDurationMinutes` + `dryerStartedAt`, emit a synthetic `DRYER_STARTED`-flagged STATE_TRANSITION event
- `:291-299` — `tx.filterEvent.create({ data: { eventType: 'STATE_TRANSITION', fromState, toState, attributes: { ...parameters, instrumentReadings? }, checksum, ipAddress, performedAt: offlineTime ?? default } })`
- `:302-307` — if `dryerAction === 'SUBMIT_READINGS'`: flip `dryerReadingsSubmitted=true` (cycle stays in DRY_IN; user advances to DRY_OUT later)
- `:310-313` — `tx.filterDetails.update({ currentLifecycleState: targetState })`
- **Auto-complete on END:** `:315-338` — if `targetState`'s outgoing path leads to END with no more STAGE nodes:
  - `:316-319` — `tx.cleaningCycle.update({ status: 'COMPLETED', completedAt: offlineTime ?? new Date() })`
  - `:321-324` — clear FilterDetails: `currentCycleId: null, currentLifecycleState: null`
  - `:326-337` — emit `CYCLE_COMPLETED` event

#### Audit + response
- `auditLog({ action: 'STATE_TRANSITION', beforeValue: { state: fromState }, afterValue: { state: targetState } })`
- Returns `service.getCurrentState(ctx, filterId)` — full snapshot + new tape

### 5.3 submit-checklist

#### Frontend
- Triggered automatically after an `advance` lands on a CHECKLIST node — UI opens a modal with the question set
- POSTs `{ answers: { qId: value, ... }, expectedProfileVersions, tapeVersion }`

#### Backend impl: `cycle-write/submit-checklist.ts`
- Same load-context + tape staleness + cycle-active guards
- **C3 fix this branch (line 160-area):** `attributes: { path: ['afterStage'], equals: currentState ?? null }` (Prisma JSON match — `equals: null` is the explicit-null match, not "drop the filter" which `undefined` produces)
- **Schema-drift detection:** `assertChecklistSchemaFresh(localCtx, expectedProfileVersions, resolvedChecklists)` — if the operator's cached question version differs from the cycle's pinned version, reject with a clear error
- **Required-answer + key-validity:** `assertRequiredChecklistAnswered` + `assertChecklistAnswerKeysValid`
- Inserts `CHECKLIST_COMPLETED` FilterEvent with per-profile snapshot in `attributes.checklists`

### 5.4 bypass

#### Frontend
- "Bypass" button on each stage card (only enabled when `flowMode === 'BYPASS_ENABLED'` per profile)
- Modal forces a justification (min length enforced server-side too)

#### Backend impl: `cycle-write/bypass.ts:20-104`
- Same idempotency + load-context guard chain
- `:47` — `assertBypassAllowed(localCtx, cp.flowMode)` — 400 if profile flowMode !== `BYPASS_ENABLED`
- `:49` — `assertBypassTargetStateValid` — target must exist in pipeline
- `:50` — `assertJustificationValid({ kind: 'bypass' })` — min length / non-empty
- `:65-88` — in tx, lock the row, emit `BYPASS_DEVIATION` FilterEvent with `deviationDetails: { type: 'BYPASS', fromState, toState, justification }`, update `currentLifecycleState` to target

### 5.5 terminate-cycle

#### Frontend
- Currently **no UI caller** in this branch (P0 #5 — UI placement decision pending). Backend route is live and reauth-gated.

#### Backend impl: `cycle-write/terminate-cycle.ts:18-83`
- Same load-context + idempotency
- `:39-41` — `assertJustificationValid({ kind: 'terminate' })`
- `:48-73` — in tx:
  - `lockAndVerifyFilterState`
  - `tx.cleaningCycle.update({ status: 'TERMINATED', completedAt: now })`
  - clear FilterDetails (`currentCycleId: null, currentLifecycleState: null`)
  - emit `CYCLE_TERMINATED` FilterEvent

### 5.6 getCurrentState (the FE refresh fetch)

#### Backend: `current-state.ts:59-520`

The FE calls this after every cycle write to refresh the snapshot + get the next `tapeVersion`.

#### What it returns
```ts
{
  filterId, filterName, currentState,
  currentCycle,                      // CleaningCycle row or null
  nextBlocks, pipelineStages,        // for FE rendering
  pipelineGraph: { stages, connections, flowMode },  // full graph for offline reconstruction
  profile: { name, flowMode },
  filterSet, totalCycles,
  equipmentGroup,                    // FROZEN-pinned snapshot, falling back to live
  blockEquipmentGroups,              // selector list
  homeBlock, blockChangeStatus,      // 'MATCH' | 'APPROVED' | 'REQUIRED' | null
  isPmDue, pmReasonKey,              // PM-due auto-reason
  profileSyncWarning,                // L2 — admin reassigned profile mid-cycle
  equipmentGroupSyncWarning,         // L3 — admin edited equipment group mid-cycle
  stageLookup,                       // B7 — per-stage { nextStages, pendingChecklistProfileIds, leadsToEnd } for offline
  actions,                           // decision tape — list of { type, label, ... } the FE renders
  tapeVersion,                       // monotonic counter — client sends back on next write
}
```

#### Tape generation
- `:449-493` — `generateTape({ cycle, filter, pinnedProfile, pinnedEquipmentGroup, pinnedChecklistProfiles, recentChecklistEvents, filterEventCount, now })`
- `tapeVersion` = monotonic counter derived from `(profileVersion, filterEventCount)` per cycle
- Clients send `tapeVersion` back on the next write; server rejects with 409 STALE_TAPE if it doesn't match — closes the read-then-write race when two devices race on the same filter

---

## 6. Filter walk-through — OFFLINE + sync-back

The same UI handlers route through `executeOrQueue()` which decides per-call: online → HTTP, offline → IndexedDB. When connectivity returns, the sync engine drains the queue.

### 6.1 Master cache populated at login

- **File:** `apps/web/src/lib/offline-sync-service.ts:46-214`
- Called once after successful login
- Caches 9 datasets into IndexedDB so the operator can work fully offline:
  1. Templates (`/api/assets/templates`)
  2. Filter instances (`/api/assets/instances`)
  3. Filter states — batch via `/api/filters/batch-states` (falls back to per-filter `/current-state`)
  4. Cleaning reasons (`/api/filters/reasons`)
  5. Equipment groups + instruments (`/api/equipment-groups`)
  6. Identifier map (RFID/barcode → filterId)
  7. PM due tasks (`/api/pm-schedules/due`)
  8. Checklist profiles + questions (`/api/checklist-profiles?expand=questions`)
  9. Cleaning profiles + per-profile pipeline (`/api/filter-cleaning-profiles/{id}`)
- **Audit fix #2 this branch:** soft failures tracked in `softFailures[]` and surfaced via `SyncProgress.partialFailures` field instead of silent green check.

### 6.2 executeOrQueue decision logic

- **File:** `apps/web/src/hooks/use-offline.ts:93-198`
- For cycle-bound ops (`advance` | `submit-checklist` | `bypass` | `terminate`), it first reads the cached `tapeVersion` from `getCachedData('filter-state-{filterId}')` so the queued row carries it (`:108-115`)
- **Try online first** (`:122-166`): standard `apiClient.post(...)` for the appropriate route
- **Catch network or REAUTH errors** (`:167-182`): `isNetErr` check + `isReauthErr` check — only network/reauth errors fall through to the queue. Real validation/conflict errors throw as-is.
- **Queue path** (`:184-197`): `queueOperation({ type, filterId, filterName, payload, tapeVersion })` writes to IDB. `optimisticState` parameter triggers `updateFilterStateLocally()` to immediately reflect the new lifecycle state in the cached `filter-state-{filterId}` row so the UI refreshes without waiting for sync.

### 6.3 IndexedDB schema (`offline-store.ts`)

- **DB name:** `digilog-offline`
- **Current version:** 5 (`offline-store.ts:7`)
- **Per-version migrations** include: v3→v4 normalizes pre-tapeVersion ops to `tapeVersion: null`; v4→v5 adds 6 sync stores for the `/api/sync/since` versioned cache
- **Stores:**
  - `operations` — queued cycle-write ops (shape below)
  - `tombstones` — queued deletes/cycle-terminations
  - `cache` — generic key/value cache with TTL + LRU
  - `filters` — per-filter cached snapshot
  - `syncFilterCleaningProfiles` / `syncFilterProfiles` / `syncEquipmentGroups` / `syncChecklistProfiles` / `syncAssetTemplates` / `syncFilters` / `syncVersionState` — versioned `sync-since` stores

### 6.4 Per-op queue shape

`OfflineOperation` interface (`offline-store.ts:46-73`):
```ts
{
  id: string;
  clientOpId: string;            // sent as x-client-op-id; backend dedup key
  type: 'advance' | 'start-cycle' | 'submit-checklist' | 'bypass' | 'terminate' | 'start-and-advance';
  filterId: string;
  filterName: string;
  payload: Record<string, any>;  // op-specific body (the same body sent online)
  createdAt: string;             // ISO timestamp — used as offlinePerformedAt on replay
  status: 'pending' | 'syncing' | 'synced' | 'failed';
  error?: string;
  retryCount: number;
  syncedAt?: string;
  tapeVersion: number | null;    // captured at queue time; null = no staleness check
}
```

### 6.5 Tombstone queue shape

`Tombstone` interface (`offline-store.ts:75-108`):
```ts
{
  id: string;
  clientOpId: string;
  entityType: 'cycle' | 'block-change-request';
  entityId: string;
  payload?: Record<string, any>;
  createdAt: string;
  status, error, retryCount;
  tapeVersion?: number | null;   // required for cycle terminations on replay (server schema mandates it)
}
```

Tombstones drain BEFORE operations so deletes/terminations apply in audit-correct order.

### 6.6 Sync engine main loop

- **File:** `apps/web/src/lib/sync-engine.ts:241-369` (`syncPendingOperations()`)
- **Triggered:** by `onConnectivityChange` (Capacitor connectivity engine fires false→true), 60s polling, visibility change, manual button

#### Step 1 — JWT refresh (`:262-266`)
- Calls `apiClient.refreshToken()` — centralized via the audit fix this branch (in-flight Promise dedup; uses `VITE_API_URL` so it actually reaches the API on Capacitor APK; previously a relative-URL `fetch()` was a silent no-op on tablet)
- If refresh fails, surface `Token refresh failed: <reason>. Re-login required to sync.` and bail with `{synced:0, failed:0}` — the queue stays intact

#### Step 2 — drain tombstones (`:269` → `syncTombstones()` `:170-219`)
- For each pending tombstone: `updateTombstoneStatus(t.id, 'syncing')` → POST with `x-offline-replay-token` + `x-client-op-id` headers
- For cycle tombstones: `POST /api/filters/{filterId}/terminate-cycle` with body `{ justification, tapeVersion?, clientOpId }`
- For block-change-request tombstones: `DELETE /api/block-change-requests/{entityId}`
- Status flipped to `'synced'`, then `clearSyncedTombstones()` removes them after retention

#### Step 3 — drain operations (`:287-355`)
- For each pending op:
  - **Pre-replay cycle check** (`ensureCycleAlive` `:81-97`) — only for cycle-bound ops (`advance`/`bypass`/`submit-checklist`/`terminate`). Fetches `/current-state` and throws `CYCLE_ENDED` (with `stranded: true` flag) if `currentCycle == null`. Marks the op `'failed'` with a clear "Cycle is no longer active" message instead of letting the replay land a confusing 400.
  - **Update status to `'syncing'`**
  - **Build replay request** (`executeOperation` `:79-143`):
    - Headers: `'x-offline-replay-token': <grant>` (from `getOfflineReplayHeader()` `:42-45`) + `'x-client-op-id': clientOpId` (so backend dedup catches retries)
    - Body: `{ ...payload, tapeVersion?, offlinePerformedAt: createdAt, clientOpId }` (tapeVersion only for cycle-bound ops, omitted when null)
  - For `start-and-advance`: runs start first; if start returns `CYCLE_ACTIVE` (benign race — start succeeded earlier), continues to advance. Then re-fetches `/current-state` to get the fresh tape for the advance leg (advance requires `tapeVersion`).
  - On success: `updateOperationStatus(op.id, 'synced', undefined, syncedAt)`. After all sync, `clearSyncedOperations()` retires them past the retention window.
  - On failure: increment `retryCount`; status `'pending'` if `< MAX_RETRIES (5)`, else `'failed'`.

#### Step 4 — compaction + LRU
- `compactSyncedOperations()` — drops `synced` rows older than `SYNCED_OP_RETENTION_MS (7d)`
- `evictLruCache()` — caps `cache` store at `CACHE_LRU_CAP (1000)` entries; filter-state-* and identifier-map exempt

### 6.7 Replay headers — end-to-end

| Header | Set by | Verified by |
|---|---|---|
| `Authorization: Bearer <jwt>` | `apiClient.request()` (api-client.ts) | `auth.ts` plugin onRequest |
| `x-offline-replay-token: <jwt-grant>` | `sync-engine.getOfflineReplayHeader()` | `auth.ts:177-205` — `verifyOfflineReplayToken()` decorates `req.offlineReplayVerified = true`. Bare legacy `x-offline-replay: true` returns 401 `OFFLINE_REPLAY_HEADER_DEPRECATED` |
| `x-client-op-id: <uuid>` | `sync-engine.executeOperation()` | `findExistingByClientOpId(filterId, clientOpId)` in cycle-write impls — short-circuits with current state if dup |
| `body.offlinePerformedAt: <ISO>` | sync-engine forwards `op.createdAt` | `validateOfflinePerformedAt()` (`offline-time-window.ts:78-126`) |

### 6.8 Backend idempotency

- **File:** `apps/api/src/lib/idempotency.ts`
- `findExistingByClientOpId(filterId, clientOpId)` looks up `FilterEvent.attributes.clientOpId` for that filter (and optionally cycle for cycle-scoped dedup)
- Each cycle-write impl calls this FIRST after sanitization (e.g., `start-cycle.ts:38`, `advance.ts:33`)
- If found → return `service.getCurrentState(ctx, filterId)` (idempotent reply — same state the prior accept would have returned)
- If not → proceed; the new row's `attributes.clientOpId` makes the next replay idempotent too

### 6.9 Server-side offlinePerformedAt validation

- **File:** `apps/api/src/lib/offline-time-window.ts:78-126`
- **Purpose:** tablet wall-clock IS the source of truth for offline action time, but server enforces sanity
- **Constants:**
  - `FUTURE_SKEW_TOLERANCE_MS = 5 * 60 * 1000` (5 minutes)
  - `MAX_STALENESS_MS = 30 * 24 * 60 * 60 * 1000` (30 days)
- **Rules:**
  1. `isReplay === false` → silently return `undefined` (server uses its own clock for online requests; can't be tricked by an online forger sending the field)
  2. `now > t + FUTURE_SKEW_TOLERANCE_MS` → throw `OFFLINE_TIME_FUTURE`
  3. `now - t > MAX_STALENESS_MS` → throw `OFFLINE_TIME_TOO_STALE`
  4. `cycleStartedAt && t < cycleStartedAt` → throw `OFFLINE_TIME_BEFORE_CYCLE`
  5. Garbage string → `OFFLINE_TIME_INVALID`
- All errors map to HTTP 400 with stable codes via the global error handler (`apps/api/src/app.ts`)

### 6.10 Offline-replay grant lifecycle

- **Issue at login:** `apps/web/src/hooks/use-auth.ts:88-99`
  - After successful `POST /api/auth/login`, the FE immediately POSTs `/api/auth/offline-grant` with `{ _currentPassword: <password just typed> }`
  - On success: stores the returned `token` + `expiresAt` in `sessionStorage` (`offline_replay_token` + `offline_replay_expires`) AND `localStorage` backup (`offline_replay_token_backup` + `offline_replay_expires_backup`)
  - Best-effort — if the grant fetch fails, login still succeeds; replay is just unavailable until manual reauth

- **Issue endpoint:** `apps/api/src/modules/auth/routes.ts` (POST `/offline-grant`)
  - **Hard-requires password** (NOT routed through configurable `enforceReauth` registry) — if operators could disable this check, the entire C1 fix collapses
  - Verifies password via `verifyPassword(password, user.passwordHash)`
  - Calls `signOfflineReplayToken(req.user.sub, req.user.sessionId)` to issue a 24h JWT
  - Audited as `GRANT_OFFLINE_REPLAY` event with `targetType: 'session', targetId: sessionId`

- **Token shape (`apps/api/src/lib/offline-replay-token.ts`):**
  - JWT signed with HS256 + dedicated `OFFLINE_REPLAY_SECRET` env var (key-separated from `JWT_SECRET`)
  - Claims: `{ sub: userId, sid: sessionId, typ: 'offline-replay', iat, exp }`
  - Default TTL 24h

- **Verify on every replay request:** `apps/api/src/plugins/auth.ts:177-205`
  - onRequest hook reads `x-offline-replay-token` header
  - Calls `verifyOfflineReplayToken(token, req.user.sub, req.user.sessionId)`:
    - JWT signature must verify under `OFFLINE_REPLAY_SECRET`
    - `claims.sub` must match the JWT user (stolen JWT alone insufficient)
    - `claims.sid` must match the JWT session (logged-out sessions invalidate all their grants)
    - `claims.typ` must be `'offline-replay'`
    - Not expired
  - On success → `req.offlineReplayVerified = true`. `enforceReauth()` (`reauth-check.ts`) reads this flag; if true, skips the per-action password challenge.
  - On failure → 401 with one of: `OFFLINE_REPLAY_TOKEN_MISSING/INVALID/EXPIRED/USER_MISMATCH/SESSION_MISMATCH/WRONG_TYPE`

- **Legacy header rejected:** if request has `x-offline-replay: true` and NO `x-offline-replay-token` → 401 `OFFLINE_REPLAY_HEADER_DEPRECATED`. Pre-upgrade tablets fail loud, not silent.

- **Logout:** `use-auth.ts logout()` clears all 4 storage keys so a subsequent shared-workstation user doesn't inherit the prior user's offline-mode authorization.

### 6.11 Retry / failure semantics

- **MAX_RETRIES = 5** (`sync-engine.ts:30`)
- On replay error: `updateOperationStatus(op.id, op.retryCount >= MAX_RETRIES - 1 ? 'failed' : 'pending', errMsg)` — increments `retryCount` and re-queues for next sync tick OR gives up
- `'failed'` ops are surfaced to the operator via the offline-status UI; they must be re-performed manually

### 6.12 Stranded ops (CYCLE_ENDED)

- `ensureCycleAlive()` in `sync-engine.ts:81-97` runs BEFORE the replay POST for any cycle-bound op
- If `currentCycle == null` on the server (cycle ended remotely while tablet was offline), throws `{ code: 'CYCLE_ENDED', stranded: true }`
- Op is marked `'failed'` with message "Cycle is no longer active for this filter — operation cannot be replayed"
- Better than letting the replay 400 with confusing `NO_CYCLE` — operator gets a clear "you're stranded" indicator

---

## Cross-cutting: 21 CFR Part 11 audit chain

Every operation in this doc writes through `auditLog()` (`apps/api/src/lib/audit.ts`) which:
1. Acquires `pg_advisory_xact_lock(7421151037)` — serializes audit writes across all backends
2. Reads the latest chain row's checksum
3. Computes new row's checksum INCLUDING `previousChecksum` (chain link)
4. Inserts via `$executeRaw` with `chain_position BIGSERIAL` auto-increment

`GET /api/audit/verify-chain` (SUPER_ADMIN only) walks the chain in `chain_position` order and reports anomalies: `PER_ROW_CHECKSUM_MISMATCH` (in-place mutation), `CHAIN_LINK_MISMATCH` (insertion/deletion), `CHAIN_POSITION_GAP` (interior row deleted).

Backup restore (`apps/api/src/modules/backup/backup.repository.ts`) verifies the source backup's audit chain BEFORE installing it; tampered backups return 400 `BACKUP_AUDIT_CHAIN_INVALID` unless operator explicitly passes `force=true` (audited as `forced=true` on the resulting `BACKUP_RESTORED` row).

---

## Reference index

| Concern | File |
|---|---|
| Block/Area/Filter create routes | `apps/api/src/modules/assets/routes/instance.routes.ts:213-334` |
| Asset instance service (transactions, sidecar, relationships) | `apps/api/src/modules/assets/services/instance.service.ts:71-189` |
| Bulk filter upload (filterSet/filterProfileId persisted) | `apps/api/src/modules/assets/services/bulk-upload-filter.service.ts:240-242` |
| Cleaning profile editor | `apps/web/src/routes/filter-management/cleaning-profile-editor.tsx` |
| Cleaning profile routes | `apps/api/src/modules/cleaning-profiles/routes.ts:68-165` |
| Cleaning profile lineage versioning | `apps/api/src/modules/cleaning-profiles/cleaning-profile.service.ts:84-265` |
| filter-operations.tsx (web walk-through UI) | `apps/web/src/routes/filter-management/filter-operations.tsx` |
| mobile-operations.tsx (tablet walk-through UI) | `apps/web/src/routes/mobile/mobile-operations.tsx` |
| Cycle-write routes | `apps/api/src/modules/filter-operations/routes.ts:134-300+` |
| start-cycle impl | `apps/api/src/modules/filter-operations/cycle-write/start-cycle.ts` |
| advance impl (incl. auto-complete on END) | `apps/api/src/modules/filter-operations/cycle-write/advance.ts` |
| submit-checklist impl | `apps/api/src/modules/filter-operations/cycle-write/submit-checklist.ts` |
| bypass impl | `apps/api/src/modules/filter-operations/cycle-write/bypass.ts` |
| terminate-cycle impl | `apps/api/src/modules/filter-operations/cycle-write/terminate-cycle.ts` |
| Locking helper (FOR UPDATE + recheck) | `apps/api/src/modules/filter-operations/cycle-write/locking.ts` |
| Pure guards (shared executor) | `packages/shared/src/types/...` (executor exports) |
| Tape generator | `apps/api/src/modules/filter-operations/tape/tape-generator.ts` |
| getCurrentState read | `apps/api/src/modules/filter-operations/current-state.ts` |
| Idempotency lookup | `apps/api/src/lib/idempotency.ts` |
| Offline-time validator | `apps/api/src/lib/offline-time-window.ts:78-126` |
| Offline-replay token issue/verify | `apps/api/src/lib/offline-replay-token.ts` |
| Offline-replay grant verify on request | `apps/api/src/plugins/auth.ts:177-205` |
| reauth gate (reads `req.offlineReplayVerified`) | `apps/api/src/lib/reauth-check.ts` |
| Audit chain write + verify | `apps/api/src/lib/audit.ts`, `apps/api/src/lib/audit-verify.ts` |
| FE offline queue + cache | `apps/web/src/lib/offline-store.ts` |
| FE executeOrQueue | `apps/web/src/hooks/use-offline.ts:93-198` |
| FE sync-engine main loop | `apps/web/src/lib/sync-engine.ts:241-369` |
| FE master cache build at login | `apps/web/src/lib/offline-sync-service.ts:46-214` |
| FE login + grant fetch | `apps/web/src/hooks/use-auth.ts:88-99` |
| Capacitor connectivity engine | `apps/web/src/lib/connectivity.ts` |
