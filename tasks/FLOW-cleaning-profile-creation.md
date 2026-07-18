# Cleaning Profile Creation Flow (Full End-to-End Trace)

## Cleaning Profile Creation

A cleaning profile is a directed acyclic pipeline graph stored immutably per version (Phase A.2). On first create, a `lineageId` UUID is set; all subsequent updates archive the prior row and create a new row with `version+1` carrying the same `lineageId`, ensuring audit-trail integrity and version replay capability.

The pipeline consists of:
- **START** node (entry point, no input port, has output port)
- **STAGE** nodes (WASH_IN, WASH_OUT, DRY_IN, DRY_OUT, STORAGE_IN, STORAGE_OUT) — each references a `stateKey`
- **CHECKLIST** nodes — each references a `checklistProfileId` via the `configuration.checklistProfileId` field
- **END** node (exit point, has input port, no output port)
- **Connections** wired between nodes via `FilterPipelineConnection` table

Profile metadata:
- `name`, `description`, `flowMode` (STRICT | BYPASS_ENABLED)
- `alarmOnForwardSkip`, `alarmOnBackwardJump`, `alarmOnOutOfSequence` (when flowMode=BYPASS_ENABLED)
- `cleaningReasons` — JSONB array of reason objects; loaded from config at editor load + persisted on every save
- **No dedicated `applicableTemplates` join** — the legacy JSONB array was removed; cleaning profiles are **filter-assignment-agnostic** (not template-scoped). FilterProfile links a filter to a cleaning profile; multiple profiles can coexist.

### Frontend entry

**File:** `apps/web/src/routes/filter-management/cleaning-profile-editor.tsx` (585 lines)

The editor is a full-screen visual ReactFlow-style pipeline designer:
- **Route:** `/filter-cleaning-profiles/:id/edit` (id="new" for create, or UUID for edit)
- **Entry point:** `CleaningProfileEditorPage` component (line 44)
- **Data fetch:** 
  - GET `/api/filter-cleaning-profiles/:id` if edit mode (line 49, via SWR)
  - GET `/api/checklist-profiles?limit=500&isActive=true` to populate checklist dropdown (line 50)
- **Cleaning reasons** are NOT explicitly loaded into the editor — the profile record carries the `cleaningReasons` JSONB array, which is passed through to the API on save (line 207, `cleaningReasons` is never read from a separate endpoint in the editor UI).

### Frontend state model (nodes, edges, profile metadata)

**State structure:**

```typescript
// Profile-level state
const [name, setName] = useState('');
const [flowMode, setFlowMode] = useState<'STRICT' | 'BYPASS_ENABLED'>('STRICT');
const [alarmFlags, setAlarmFlags] = useState({ forwardSkip: true, backwardJump: true, outOfSequence: true });

// Pipeline graph
const [nodes, setNodes] = useState<PipelineNode[]>([]);
const [connections, setConnections] = useState<Connection[]>([]);

// UI selection
const [selectedNode, setSelectedNode] = useState<number | null>(null);
const [selectedConn, setSelectedConn] = useState<number | null>(null);
```

**Node shape** (line 19–21):
```typescript
interface PipelineNode {
  id?: string; // DB id (undefined until persisted)
  stateKey: string | null; // Stage key (WASH_IN, etc.) or null for START/END/CHECKLIST
  nodeType: string; // START | END | STAGE | CHECKLIST
  configuration: any; // { checklistProfileId, checklistProfileName, questionCount } for CHECKLIST
  positionX: number; positionY: number; // Canvas position
  sortOrder: number; // Order in pipeline
}
```

**Connection shape** (line 23–25):
```typescript
interface Connection {
  id?: string; // DB id (undefined until persisted)
  fromIndex: number; // Array index of source node
  toIndex: number; // Array index of target node
  label: string; // "Next" (default)
}
```

**Initialization on load** (lines 73–91):
- If editing an existing profile: unpack profile.stages + profile.connections, map DB ids to array indices
- If creating new: initialize with START + END nodes pre-placed at canonical positions
- On profile load, nodes are mapped: `profile.stages.map((s) => ({ id: s.id, stateKey: s.stateKey, nodeType: s.nodeType, ... }))`
- Connections are remapped from stage IDs to array indices: `fromIndex: profile.stages.findIndex(s => s.id === c.fromStageId)`

**Checklist configuration** (lines 486–510):
When a CHECKLIST node is selected, the right sidebar shows a dropdown of active checklist profiles. Selecting one populates `configuration`:
```typescript
configuration: { 
  checklistProfileId: cpId, 
  checklistProfileName: cp.name, 
  questionCount: cp.questionCount 
}
```

**Serialization on save** (lines 206–211):
```typescript
const body = {
  name, flowMode,
  alarmOnForwardSkip: alarmFlags.forwardSkip, 
  alarmOnBackwardJump: alarmFlags.backwardJump, 
  alarmOnOutOfSequence: alarmFlags.outOfSequence,
  stages: nodes.map((n, i) => ({ ...n, sortOrder: i })), // Recalculate sortOrder
  connections: connections.map(c => ({ fromIndex: c.fromIndex, toIndex: c.toIndex, label: c.label })),
};
```
**Note:** `cleaningReasons` is NOT sent — it's only persisted on the backend if present in the profile record (never mutated from the editor).

### API call (create + update both)

**Method 1: Create (POST)**

- **URL:** `/api/filter-cleaning-profiles`
- **Method:** POST
- **Auth:** Bearer token + re-auth via `x-reauth-password` header + `_currentPassword` field in body
- **Frontend call** (line 214–215):
  ```typescript
  const result = password
    ? await apiClient.postWithReauth('/api/filter-cleaning-profiles', body, password)
    : await apiClient.post('/api/filter-cleaning-profiles', body);
  ```
- **Body shape:**
  ```json
  {
    "name": "Wash Cycle Profile",
    "description": "...",
    "flowMode": "STRICT",
    "alarmOnForwardSkip": true,
    "alarmOnBackwardJump": true,
    "alarmOnOutOfSequence": true,
    "cleaningReasons": null or [array],
    "stages": [
      { "stateKey": null, "nodeType": "START", "configuration": {}, "positionX": 60, "positionY": 220, "sortOrder": 0 },
      { "stateKey": "WASH_IN", "nodeType": "STAGE", "configuration": {}, "positionX": ..., "positionY": ..., "sortOrder": 1 },
      ...
    ],
    "connections": [
      { "fromIndex": 0, "toIndex": 1, "label": "Next" },
      ...
    ]
  }
  ```
- **Response:** 201 Created, returns the full created profile (including id, lineageId, version=1)
- **Frontend side effect:** Navigate to `/filter-cleaning-profiles/{newId}/edit` (line 216)

**Method 2: Update (PUT)**

- **URL:** `/api/filter-cleaning-profiles/:id`
- **Method:** PUT
- **Auth:** Same as POST (re-auth required)
- **Frontend call** (line 219–220):
  ```typescript
  const result = password
    ? await apiClient.putWithReauth(`/api/filter-cleaning-profiles/${id}`, body, password)
    : await apiClient.put(`/api/filter-cleaning-profiles/${id}`, body);
  ```
- **Body:** Same shape as POST (but with modified stages/connections)
- **Response:** 200 OK, returns the new version (with id=new row id, version bumped)
- **Frontend side effect:** (line 221–223)
  - If response.id differs from current id, navigate to the new ID (versioned)
  - Otherwise, mutate the SWR cache for the current profile

### Backend handler (file:line)

**POST Create Route Handler:**
- **File:** `apps/api/src/modules/cleaning-profiles/routes.ts`
- **Lines:** 68–127
- **PreHandlers:**
  - `app.requireAnyPermission('FCP_CREATE', 'CP_PAGE_CREATE')` (line 70)
  - `enforceReauth('CREATE_CLEANING_PROFILE', req, reply)` (line 122)
- **Handler (lines 121–127):**
  ```typescript
  async (req, reply) => {
    const { ok } = await enforceReauth('CREATE_CLEANING_PROFILE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const result = await service.create(ctx, req.body);
    return reply.code(201).send(result);
  }
  ```

**PUT Update Route Handler:**
- **File:** `apps/api/src/modules/cleaning-profiles/routes.ts`
- **Lines:** 129–165
- **PreHandlers:**
  - `app.requireAnyPermission('FCP_UPDATE', 'CP_PAGE_EDIT')` (line 131)
  - `enforceReauth('UPDATE_CLEANING_PROFILE', req, reply)` (line 160)
- **Handler (lines 159–165):**
  ```typescript
  async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_CLEANING_PROFILE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.update(ctx, id, req.body);
  }
  ```

### Service / DB writes (including lineage versioning)

**File:** `apps/api/src/modules/cleaning-profiles/cleaning-profile.service.ts`

#### CREATE (lines 84–145)

On first create, `lineageId` is set to a fresh UUID (line 92: `randomUUID()`). All stages and connections are created in a single nested create operation. The profile row defaults to `version=1`, `status='ACTIVE'`.

#### UPDATE (lines 147–265)

Update implements the snapshot-then-bump pattern:

1. **Archive old version** — Update the existing row to `status='ARCHIVED'` (lines 157–161)
2. **Create new version** — Insert a new row with the same `lineageId`, bumped `version` (lines 164–189)
3. **Remap connections** — Map old stage IDs to new stage IDs via `sortOrder` (lines 191–231)
4. **Migrate references** — Update all FilterProfile rows from old profile ID to new (lines 234–237)
5. **Update config rules** — If cleaning-profile-assignment config references the old ID, update it (lines 240–250)
6. **Transactional** — All updates wrapped in `prisma.$transaction()` for consistency

#### Cleaning Reasons Persistence

The `cleaningReasons` JSONB field is stored on the profile row. It is NOT loaded from a separate endpoint in the editor. If the operator wants to edit cleaning reasons, they use the config page (`/config/filter-cleaning-reasons`), which maintains a global list via `/api/config/dynamic/filter-cleaning-reasons`.

The editor does NOT send `cleaningReasons` in the request body, so any existing reasons on the profile are preserved on update (line 173: `data.cleaningReasons ?? existing.cleaningReasons`).

### Response

**Create Response:**
```json
{
  "id": "<profile-uuid>",
  "lineageId": "<lineage-uuid>",
  "name": "Wash Cycle Profile",
  "version": 1,
  "status": "ACTIVE",
  "stages": [...],
  "connections": [...]
}
```

**Update Response:**
```json
{
  "id": "<new-profile-uuid>",
  "lineageId": "<same-lineage-uuid>",
  "name": "Wash Cycle Profile",
  "version": 2,
  "status": "ACTIVE",
  "stages": [...],
  "connections": [...]
}
```

### Frontend side effects

**Create Success (line 216):**
Navigate to `/filter-cleaning-profiles/{newId}/edit` to lock in the new profile ID.

**Update Success (lines 221–224):**
If response.id differs from current id (versioned), navigate to new ID. Otherwise, revalidate SWR cache.

**Toast Notification (line 225):**
Show success/error message, auto-dismiss after 3 seconds.

**Reauth Dialog (lines 581–582):**
Display password challenge if backend returns 401 REAUTH_REQUIRED.

---

## Cleaning Reasons Lifecycle

### Loading into Profile Editor

Cleaning reasons are NOT explicitly loaded into the editor. The profile's `cleaningReasons` JSONB field is returned by GET `/api/filter-cleaning-profiles/:id` but is not displayed or mutated by the editor.

### Editing (Config Page)

**File:** `apps/web/src/routes/config/filter-cleaning-reasons.tsx`

**Load:** GET `/api/config/dynamic/filter-cleaning-reasons` — returns array of CleaningReason objects

**Save:** PUT `/api/config/dynamic/filter-cleaning-reasons` with reauth (UPDATE_CONFIG_PAGE action)

Each reason has: `key`, `name`, `description`, `requiresJustification`, `isActive`, `sortOrder`

### Persistence in Cleaning Profile

Cleaning reasons are stored on the `cleaningReasons` JSONB column of the FilterCleaningProfile row. They are NOT versioned per profile — the global list is maintained via config.

---

## Database Schema (Relevant Tables)

```prisma
model FilterCleaningProfile {
  id                   String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  lineageId            String @map("lineage_id") @db.Uuid
  name                 String @db.VarChar(255)
  description          String?
  flowMode             PipelineFlowMode @default(STRICT) @map("flow_mode")
  alarmOnForwardSkip   Boolean @default(true) @map("alarm_on_forward_skip")
  alarmOnBackwardJump  Boolean @default(true) @map("alarm_on_backward_jump")
  alarmOnOutOfSequence Boolean @default(true) @map("alarm_on_out_of_sequence")
  cleaningReasons      Json? @map("cleaning_reasons") @db.JsonB
  version              Int @default(1)
  status               CleaningProfileStatus @default(DRAFT)
  createdBy            String @map("created_by") @db.Uuid
  createdAt            DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt            DateTime @updatedAt @map("updated_at") @db.Timestamptz

  stages         FilterPipelineStage[]
  connections    FilterPipelineConnection[]
  cleaningCycles CleaningCycle[]
  filterProfiles FilterProfile[]

  @@unique([lineageId, version])
  @@index([status])
  @@index([lineageId])
  @@map("filter_cleaning_profiles")
}

model FilterPipelineStage {
  id            String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  profileId     String @map("profile_id") @db.Uuid
  stateKey      String? @map("state_key") @db.VarChar(100)
  nodeType      PipelineNodeType @map("node_type")
  configuration Json @default("{}") @db.JsonB
  positionX     Float @default(0) @map("position_x")
  positionY     Float @default(0) @map("position_y")
  sortOrder     Int @default(0) @map("sort_order")
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz

  profile   FilterCleaningProfile @relation(fields: [profileId], references: [id], onDelete: Cascade)
  fromConns FilterPipelineConnection[] @relation("FromStage")
  toConns   FilterPipelineConnection[] @relation("ToStage")

  @@index([profileId, sortOrder])
  @@map("filter_pipeline_stages")
}

model FilterPipelineConnection {
  id          String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  profileId   String @map("profile_id") @db.Uuid
  fromStageId String @map("from_stage_id") @db.Uuid
  toStageId   String @map("to_stage_id") @db.Uuid
  label       String? @default("Next") @db.VarChar(100)

  profile   FilterCleaningProfile @relation(fields: [profileId], references: [id], onDelete: Cascade)
  fromStage FilterPipelineStage @relation("FromStage", fields: [fromStageId], references: [id], onDelete: Cascade)
  toStage   FilterPipelineStage @relation("ToStage", fields: [toStageId], references: [id], onDelete: Cascade)

  @@index([profileId])
  @@index([fromStageId])
  @@map("filter_pipeline_connections")
}
```
