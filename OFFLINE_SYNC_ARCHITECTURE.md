# DigiLog — Offline Sync Architecture

## Overview

The tablet APK and web browser run the **same React codebase**. The APK is a Capacitor wrapper that loads the built SPA inside an Android WebView. Both connect to the same Fastify API on the local network. The tablet adds offline support via IndexedDB queuing — operations performed without network are stored locally and replayed when connectivity returns.

---

## 1. How APK and Web Connect

```
apps/web/src/  ← Same React source code
     │
     ├── npx vite (dev)       → http://localhost:5175      (WEB browser)
     │
     └── npx vite build       → apps/web/dist/             (static files)
              │
              ├── Fastify API serves dist/ on https://server-ip:3000   (WEB browser)
              │   (a reverse proxy in front is optional / customer-choice
              │    after Phase 4 of the windows-friendly-rewrite)
              │
              └── Capacitor copies dist/ into APK
                  apps/android/android/app/src/main/
                  assets/public/  ← same built files
                  → DigiLog-FilterOps.apk                   (TABLET)
```

**Web browser:** API calls hit `https://<server>:3000/api/*` directly. In dev, the Vite dev server (`http://localhost:5175`) makes browser-allowed `http → https` fetches to `https://localhost:3000`.

**Tablet APK:** API calls use absolute URL baked at build time (`VITE_API_URL=https://192.168.1.22:3000`), because the APK's origin is `capacitor://localhost`.

---

## 2. Network Architecture

```
┌──── Web Browser ────┐       ┌──── Tablet APK ──────┐
│ https://server:3000 │       │ capacitor://localhost │
│ /api/* direct       │       │ VITE_API_URL baked in │
└────────┬────────────┘       └────────┬─────────────┘
         │  HTTPS (LAN)                │  HTTPS (WiFi)
         ▼                             ▼
┌──────────────────────────────────────────────────────┐
│              Fastify API (:3000)                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐  │
│  │ 37 Route │ │  Auth    │ │  Reauth Check        │  │
│  │ Modules  │ │  Plugin  │ │  (x-offline-replay)  │  │
│  └────┬─────┘ └──────────┘ └──────────────────────┘  │
│       │                                               │
│  ┌────┴─────────────────────────────────────────┐     │
│  │  PostgreSQL (digilog_db) — 69 models         │     │
│  │  graphile-worker on Postgres — job queues    │     │
│  │  Mosquitto 2.0 — MQTT broker for IoT devices │     │
│  │  (Phase 4 — Redis retired; pub/sub is in-process)│     │
│  └──────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────┘
```

---

## 3. Mobile Page vs Desktop Page

| Aspect | Desktop (`filter-operations.tsx`) | Tablet (`mobile-operations.tsx`) |
|---|---|---|
| Route | `/filters` | `/m` |
| Scan mode | Batch queue (multiple filters) | Single-filter scan |
| Dialogs | Separate components (imported) | Inline JSX (self-contained) |
| API calls | Direct `apiClient.post()` | `executeOrQueue()` (offline-aware) |
| Offline support | None | Full (IndexedDB queue + sync) |
| Reauth | Password dialog for sensitive ops | Skipped for offline replay |

Both pages call the **same API endpoints** and record the **same data** in PostgreSQL.

---

## 4. IndexedDB Offline Storage

Database name: `digilog-offline`, version: 1

### Store: `operations` (Pending API Calls Queue)

```
keyPath: "id"
indexes: status, createdAt

Each record:
{
  id:         "op-1713178200000-abc123",      // unique ID
  type:       "start-and-advance" |            // compound: start cycle + advance
              "advance" |                      // stage transition
              "submit-checklist" |             // checklist answers
              "bypass" |                       // stage bypass (deviation)
              "terminate",                     // terminate cycle
  filterId:   "3d0da0b0-...",                 // target filter UUID
  filterName: "CWH/F04/00-01",               // for display
  payload: {
    // For start-and-advance:
    cyclePayload: {
      cleaningReasonKey: "Type-C",
      cleaningJustification: "optional text",
      cleaningAreaId: "block-uuid"
    },
    advancePayload: {
      targetState: "WASH_IN",
      cleaningAreaId: "block-uuid",
      equipmentGroupId: "group-uuid",
      instrumentReadings: { "inst-uuid-1": 51.1, "inst-uuid-2": 91.5 },
      remarks: "Wash In - CWH/F04/00-01"
    }
    // For advance:
    //   targetState, cleaningAreaId, equipmentGroupId,
    //   instrumentReadings, dryerAction, dryerDurationMinutes, remarks
    // For submit-checklist:
    //   answers: { "question-uuid": "Yes", ... }
  },
  createdAt:  "2026-04-15T08:00:00.000Z",    // when user performed action (OFFLINE TIME)
  status:     "pending" | "syncing" | "synced" | "failed",
  retryCount: 0,
  error:      null | "error message"
}
```

### Store: `filters` (Cached Filter Instances)

```
keyPath: "id"

Each record:
{
  id:                    "3d0da0b0-...",
  name:                  "CWH/F04/00-01",
  templateId:            "b21490db-...",
  currentLifecycleState: "WASH_IN" | null,
  currentCycleId:        "cycle-uuid" | null,
  filterSet:             "SET_A" | "SET_B" | null,
  parentId:              "ahu-uuid" | null,
  isActive:              true,
  status:                "Active"
}

Source: cached from GET /api/assets/instances?limit=500
Updated: every 15 seconds when online, optimistically after offline operations
```

### Store: `cache` (Generic Key-Value Cache)

```
keyPath: "key"
TTL: 30 minutes (default)

Each record:
{
  key:       "identifier-map",
  data:      { ... },
  cachedAt:  "2026-04-15T08:00:00.000Z",
  expiresAt: "2026-04-15T08:30:00.000Z"
}
```

**Keys stored:**

| Key | Data | Source |
|---|---|---|
| `identifier-map` | `{ rfidTag → { filterId, filterName } }` | GET /api/assets/identifiers?limit=1000 |
| `templates` | `[{ id, name, icon, ... }]` | GET /api/assets/templates?limit=100 |
| `cleaning-reasons` | `[{ key, name, isActive, requiresJustification }]` | GET /api/filters/reasons |
| `equipment-groups` | `[{ id, name, blockId, instruments[] }]` | GET /api/equipment-groups |
| `due-tasks` | `{ tasks[], overdue[] }` | GET /api/pm-schedules/due |
| `approvals` | `[{ id, filterName, status, ... }]` | GET /api/block-change-requests |
| `filter-state-{filterId}` | Per-filter state (see below) | GET /api/filters/{id}/current-state |

**Per-filter cached state** (`filter-state-{filterId}`):

```
{
  equipmentGroup: {
    id: "group-uuid",
    name: "Block",
    instruments: [
      { id, description, stageKey, instrumentId, uom,
        instrumentMin, instrumentMax, operatingMin, operatingMax, leastCount }
    ]
  },
  pendingChecklist: [
    {
      pipelineNodeId: "node-uuid",
      checklistProfileId: "profile-uuid",
      checklistProfileName: "Post-Wash Verification",
      questions: [
        { id, question, questionType, required, section, description, options, validation, sortOrder }
      ]
    }
  ],
  pipelineStages: [
    { stateKey: "WASH_IN", nodeType: "STAGE", sortOrder: 2 }
  ],
  currentCycle: {
    id, dryerDurationMinutes, dryerStartedAt, equipmentGroupId, ...
  },
  isPmDue: false,
  pmReasonKey: null
}
```

---

## 5. Online Flow (Step by Step)

```
USER SCANS FILTER (online)
        │
        ▼
resolveFilter()
  1. API lookup: GET /api/assets/identifiers/lookup/{tag}
  2. Name match: GET /api/assets/instances?search=...
  3. Cached map: IndexedDB → cache → identifier-map
        │
        ▼
GET /api/filters/{id}/current-state
  → Returns: currentCycle, pendingChecklist, equipmentGroup,
             nextAllowedStages, isPmDue, pmReasonKey, blockChangeStatus
  → ALSO: cache to IndexedDB as filter-state-{id}
        │
        ▼
DECISION TREE:
  │
  ├── pendingChecklist exists?
  │     YES → Show CHECKLIST dialog → POST /submit-checklist
  │
  ├── No active cycle?
  │     YES → Show REASON dialog (user picks Type-C, PM, etc.)
  │            │
  │            ├── WASH_IN + block selected?
  │            │     YES → Fetch equipment groups
  │            │           Show EQUIPMENT dialog (air/water pressure readings)
  │            │           POST /start-cycle + POST /advance (with readings)
  │            │
  │            └── Other stage
  │                  POST /start-cycle + POST /advance
  │
  ├── DRY_IN stage?
  │     YES → Dryer duration set?
  │            NO → Show DRYER DURATION dialog
  │                 POST /advance { dryerAction: SET_DURATION, dryerDurationMinutes }
  │            YES → Half duration elapsed?
  │                   NO → Show error "Wait X more minutes"
  │                   YES → Show EQUIPMENT dialog (temperature readings)
  │                         POST /advance { dryerAction: SUBMIT_READINGS, instrumentReadings }
  │
  └── Other stage (WASH_OUT, STORAGE_IN, STORAGE_OUT, DRY_OUT)
        POST /advance { targetState, remarks }
        │
        └── Response has pendingChecklist?
              YES → Show CHECKLIST dialog
              NO → Done (tick mark ✓)
```

---

## 6. Offline Flow (Step by Step)

```
USER SCANS FILTER (offline — no network)
        │
        ▼
resolveFilter()
  API fails → use cached data:
  1. IndexedDB → cache → identifier-map → find filterId
  2. IndexedDB → filters store → find by name/UUID
        │
        ▼
BUILD STATE FROM CACHE
  IndexedDB → filters → { currentLifecycleState, currentCycleId }
  IndexedDB → cache → filter-state-{id} → { equipmentGroup, pendingChecklist,
                                              currentCycle, isPmDue, pmReasonKey }
        │
        ▼
SAME DECISION TREE AS ONLINE
  All dialogs use cached data:
  - Reason dialog       → cached cleaning-reasons
  - Equipment dialog    → cached equipment-groups (filtered by blockId)
  - Checklist dialog    → cached pendingChecklist (with all question types)
  - Dryer dialog        → cached currentCycle.dryerDurationMinutes
        │
        ▼
executeOrQueue()
  1. Try API call first (might work if server reachable)
  2. If fails (network error or reauth block) → save to IndexedDB operations store
  3. Update cached filter state optimistically (currentLifecycleState)
  4. Show "(queued)" in recent operations list
  5. Increment pending count badge
```

---

## 7. Sync Flow (When Back Online)

```
TABLET RECONNECTS TO NETWORK
        │
        ├── Browser fires "online" event → trigger sync after 2s
        ├── 30-second periodic retry detects pending ops
        ├── User returns to app (visibilitychange) → trigger sync after 1s
        └── User taps "X pending — sync" button → manual trigger
                │
                ▼
syncPendingOperations()
        │
        ▼
  1. CHECK SERVER REACHABLE
     fetch(`${VITE_API_URL}/api/health`, timeout: 5s)
     If fails → skip, retry in 30 seconds
        │
        ▼
  2. GET PENDING OPERATIONS
     IndexedDB → operations store → status = 'pending'
     Sorted by createdAt (FIFO — chronological order)
        │
        ▼
  3. FOR EACH OPERATION (in order):
     ┌─────────────────────────────────────────────────────────┐
     │ Mark status = 'syncing' in IndexedDB                   │
     │                                                         │
     │ Add headers:                                            │
     │   x-offline-replay: true   (skips reauth on backend)   │
     │                                                         │
     │ Add to payload:                                         │
     │   offlinePerformedAt: op.createdAt  (original time)     │
     │                                                         │
     │ Execute based on type:                                  │
     │                                                         │
     │   start-and-advance:                                    │
     │     POST /start-cycle { ...cyclePayload, offlinePerformedAt }  │
     │       If CYCLE_ACTIVE error → skip (already started)    │
     │     POST /advance { ...advancePayload, offlinePerformedAt }    │
     │                                                         │
     │   advance:                                              │
     │     POST /advance { ...payload, offlinePerformedAt }    │
     │                                                         │
     │   submit-checklist:                                     │
     │     POST /submit-checklist { answers, offlinePerformedAt }     │
     │                                                         │
     │   bypass:                                               │
     │     POST /bypass { ...payload, offlinePerformedAt }     │
     │                                                         │
     │ SUCCESS → mark status = 'synced'                        │
     │ NETWORK ERROR → break loop, retry in 30s                │
     │ API ERROR → retryCount++                                │
     │   retryCount < 3 → keep as 'pending'                    │
     │   retryCount >= 3 → mark as 'failed'                    │
     └─────────────────────────────────────────────────────────┘
        │
        ▼
  4. CLEANUP
     Delete 'synced' operations from IndexedDB
        │
        ▼
  5. REFRESH UI
     Trigger SWR revalidation:
       mutate('/api/assets/instances?limit=500')
       mutate('/api/pm-schedules/due')
     → Filter list refreshes
     → Tick marks appear
     → Stage counts update
```

---

## 8. Backend — How x-offline-replay Works

```
NORMAL REQUEST (online, from web or tablet):
  POST /api/filters/{id}/start-cycle
  Header: Authorization: Bearer <jwt>
  → enforceReauth('START_CLEANING_CYCLE')
  → Checks action-reauth config for user's role
  → If required: expects password in x-reauth-password header or _currentPassword body field
  → If no password: returns 401 REAUTH_REQUIRED
  → FilterEvent.performedAt = now() (database default)

OFFLINE REPLAY REQUEST (synced from tablet queue):
  POST /api/filters/{id}/start-cycle
  Header: Authorization: Bearer <jwt>
  Header: x-offline-replay: true
  Body: { cleaningReasonKey: "Type-C", offlinePerformedAt: "2026-04-15T08:00:00Z" }
  → enforceReauth() sees x-offline-replay header → SKIP password check
  → Service reads offlinePerformedAt from body
  → CleaningCycle.startedAt = offlinePerformedAt (not now())
  → FilterEvent.performedAt = offlinePerformedAt (not now())
  → Timeline shows actual action time, not sync time
```

---

## 9. What Gets Stored in PostgreSQL

### cleaning_cycles table

```
id:                    UUID (auto-generated)
cycle_code:            "CC-CAI-PFI/F02/00-001-20260415"
filter_id:             filter UUID
profile_id:            cleaning profile UUID
started_at:            offlinePerformedAt or now()    ← OFFLINE TIME
cleaning_reason_key:   "Type-C" | "PM"
cleaning_reason_label: "Type-C" | "PM"
cleaning_area_id:      block UUID
equipment_group_id:    equipment group UUID
dryer_duration_minutes: 10 (for DRY_IN)
dryer_started_at:      timestamp (for DRY_IN)
status:                IN_PROGRESS → COMPLETED
completed_at:          timestamp (when last stage done)
```

### filter_events table (immutable, SHA-256 checksummed)

Each event in a complete cleaning cycle:

| # | event_type | from → to | Key Data (attributes) |
|---|---|---|---|
| 1 | CYCLE_STARTED | — | cleaningReasonKey, cleaningReasonLabel |
| 2 | STATE_TRANSITION | null → WASH_IN | instrumentReadings: [{air: 51.1 bar}, {water: 91.5 bar}] |
| 3 | STATE_TRANSITION | WASH_IN → WASH_OUT | remarks |
| 4 | CHECKLIST_COMPLETED | — | answers: {q1: "Yes", q2: "Clear", q3: "74", q4: base64photo} |
| 5 | STATE_TRANSITION | WASH_OUT → DRY_IN | dryerDurationMinutes: 10, dryerStartedAt |
| 6 | STATE_TRANSITION | DRY_IN → DRY_OUT | instrumentReadings: [{temp: 16.5°C}] |
| 7 | CHECKLIST_COMPLETED | — | answers: {5 questions} |
| 8 | STATE_TRANSITION | DRY_OUT → STORAGE_IN | remarks |
| 9 | CHECKLIST_COMPLETED | — | answers: {4 questions} |
| 10 | STATE_TRANSITION | STORAGE_IN → STORAGE_OUT | remarks |
| 11 | CYCLE_COMPLETED | — | sequenceNumber: 1 |

Every event has:
- `performed_at`: offlinePerformedAt (actual action time) or now()
- `checksum`: SHA-256 hash (21 CFR Part 11 tamper-proof integrity)
- `performed_by`: user UUID from JWT
- `ip_address`: from request

---

## 10. Checklist Question Types Supported

| Type | Online (Web + Tablet) | Offline (Tablet) | UI Element |
|---|---|---|---|
| YES_NO | Yes | Yes | Two buttons [Yes, No] |
| YES_NO_NA | Yes | Yes | Three buttons [Yes, No, N/A] |
| PASS_FAIL | Yes | Yes | Color buttons (green Pass, red Fail) |
| DROPDOWN | Yes | Yes | `<select>` with options from profile |
| MULTI_SELECT | Yes | Yes | Toggle buttons (array value) |
| NUMERIC | Yes | Yes | Number input with min/max/unit display |
| TEXT | Yes | Yes | Textarea |
| PHOTO | Yes | Yes | Camera capture (`capture="environment"`) + base64 preview |
| SIGNATURE | Web only | Placeholder | Signature pad (web), message (tablet) |

---

## 11. Cache Lifecycle

```
APP OPENS (online)
  │
  ├── SWR fetches /api/assets/instances     → cache to IndexedDB filters store
  ├── SWR fetches /api/assets/templates     → cache to IndexedDB cache store (key: templates)
  ├── SWR fetches /api/filters/reasons      → cache to IndexedDB cache store (key: cleaning-reasons)
  ├── SWR fetches /api/assets/identifiers   → build map → cache (key: identifier-map)
  ├── SWR fetches /api/equipment-groups     → cache (key: equipment-groups)
  │
  ├── User views My Tasks tab               → cache (key: due-tasks)
  ├── User views Approvals tab              → cache (key: approvals)
  │
  └── User scans a filter (online)
        GET /api/filters/{id}/current-state
        → cache (key: filter-state-{filterId})
        → includes: equipmentGroup, pendingChecklist, pipelineStages,
                    currentCycle (dryer data), isPmDue, pmReasonKey

GOES OFFLINE
  │
  └── All data served from IndexedDB cache
      TTL: 30 minutes (but stale data still used if expired — better than nothing)

COMES BACK ONLINE
  │
  ├── SWR auto-revalidates all data
  ├── Sync engine replays queued operations
  └── SWR mutate() refreshes filter list after sync
```

---

## 12. Error Handling

| Scenario | Behavior |
|---|---|
| Network error during operation | Queue to IndexedDB, show "(queued)" |
| REAUTH_REQUIRED from API | Queue to IndexedDB (sync sends x-offline-replay to skip) |
| API validation error (online) | Show error message, don't queue |
| API error during sync | Retry up to 3 times, then mark as 'failed' |
| Start-cycle returns CYCLE_ACTIVE during sync | Skip start-cycle, proceed to advance |
| Server unreachable during sync | Stop loop, retry in 30 seconds |
| Stale cached data | Used as-is offline; refreshed when back online |

---

## 13. Files Involved

| File | Purpose |
|---|---|
| `apps/web/src/routes/mobile/mobile-operations.tsx` | Tablet operations page (all dialogs, offline logic) |
| `apps/web/src/routes/filter-management/filter-operations.tsx` | Desktop operations page (reference implementation) |
| `apps/web/src/hooks/use-offline.ts` | `useOffline()` hook — executeOrQueue, sync, cache access |
| `apps/web/src/lib/offline-store.ts` | IndexedDB wrapper — operations queue, filter cache, generic cache |
| `apps/web/src/lib/sync-engine.ts` | Sync engine — periodic retry, server check, operation replay |
| `apps/web/src/lib/api-client.ts` | HTTP client — token auth, error handling, reauth support |
| `apps/api/src/lib/reauth-check.ts` | Backend reauth — x-offline-replay header bypass |
| `apps/api/src/modules/filter-operations/routes.ts` | API routes — offlinePerformedAt schema field |
| `apps/api/src/modules/filter-operations/filter-operations.service.ts` | Service — uses offlinePerformedAt for timestamps |
| `apps/android/capacitor.config.ts` | Capacitor config — HTTPS, CapacitorHttp plugin |
| `apps/web/.env.production` | `VITE_API_URL=https://192.168.1.22:3000` baked into APK |
