# Step 5b — Path A: Universal versioning for mutable checklist definitions

**Goal:** make online and offline checklist submissions identically reproducible by versioning every mutable definition. Operators always answer against a specific version; cycles pin versions at start; audit replay is byte-exact regardless of subsequent edits.

## Phase A.1 — ChecklistProfile versioning (this PR)

**In scope:** ChecklistProfile + ChecklistQuestion. Mirrors the existing AssetTemplate/AssetTemplateVersion pattern.

### Schema

```prisma
model ChecklistProfile {
  id          String   @id
  version     Int      @default(1)            // current live version pointer
  // ... existing fields stay
  versions    ChecklistProfileVersion[]
}

model ChecklistProfileVersion {
  id            String   @id
  profileId     String
  versionNumber Int
  snapshot      Json    // { name, description, isActive, questions: [...] }
  changeNotes   String?
  createdAt     DateTime @default(now())
  createdBy     String?

  profile ChecklistProfile @relation(fields: [profileId], references: [id], onDelete: Cascade)

  @@unique([profileId, versionNumber])
  @@index([profileId])
  @@map("checklist_profile_versions")
}
```

### Cycle pinning

```prisma
model CleaningCycle {
  // ... existing fields
  checklistVersionPins Json @default("{}") @map("checklist_version_pins") @db.JsonB
  //   shape: { [checklistProfileId]: versionNumber }
}
```

At cycle start, walk the pipeline graph, collect every `checklistProfileId` referenced by CHECKLIST nodes, and snapshot each profile's current version into `checklistVersionPins`. From then on, getCurrentState/submitChecklist resolve questions through the pinned version — even if the profile is edited mid-cycle.

### Edit semantics — snapshot-then-bump

Every `checklist-profile.service.ts` write path:

```ts
// inside a transaction
const before = await tx.checklistProfile.findUnique({
  where: { id }, include: { questions: { orderBy: { sortOrder: 'asc' } } }
});
await tx.checklistProfileVersion.create({
  data: {
    profileId: id,
    versionNumber: before.version,                 // freeze the *outgoing* version
    snapshot: { name, description, isActive, questions },
    changeNotes,
    createdBy: ctx.userSub,
  }
});
await tx.checklistProfile.update({
  where: { id },
  data: { ...changes, version: { increment: 1 } }
});
```

Affects: `update`, `delete` (snapshot-then-soft-delete), `addQuestion`, `updateQuestion`, `deleteQuestion`, `reorderQuestions`.

### Read semantics

- **Live editor** (`/checklist-admin/list`, `/checklist-admin/detail`) — reads live profile + live questions. Unchanged.
- **In-cycle resolution** (`getCurrentState`, `submitChecklist`) — reads pinned version from `ChecklistProfileVersion.snapshot` keyed by `(cycle.checklistVersionPins[profileId], profileId)`. Falls back to live if profile isn't pinned (cycles that started before this PR).
- **Audit replay** (cycle-history-by-id reader at filter-operations.service.ts ~1382) — same; resolves questions from the version snapshot the cycle pinned.

### Offline sync contract

- `GET /api/checklist-profiles/:id/versions/:versionNumber` — fetch a specific historical version. Cacheable forever (immutable).
- `GET /api/checklist-profiles?expand=questions` — returns live profile + version field. Tablet caches.
- `GET /api/filters/:id/current-state` — response includes the cycle's `checklistVersionPins` map. Tablet uses it to know which version to render and submit.
- `POST /api/filters/:id/submit-checklist` — body adds `expectedProfileVersions: { [profileId]: number }`. Server validates against the cycle's pinned map, NOT against live profile state.

### Migration / backfill

For every existing ChecklistProfile, create a `ChecklistProfileVersion` row with `versionNumber: 1` and snapshot = current state. Existing in-progress cycles get `checklistVersionPins: {}` (legacy fallback to live questions until they complete).

### Submit contract under versioning

```
client → POST /api/filters/:id/submit-checklist
{
  answers: { [questionId]: value },
  expectedProfileVersions: { [profileId]: versionNumber },  // what client cached
  clientOpId: "...",
  offlinePerformedAt: "...",
}
```

Server flow:
1. Resolve cycle, current stage, pinned versions (from cycle.checklistVersionPins).
2. For each profile referenced at this stage:
   - If `expectedProfileVersions[profileId]` !== `cycle.checklistVersionPins[profileId]` → 409 SCHEMA_DRIFT with diff.
3. Resolve questions from each pinned version's snapshot.
4. Validate answers (required filled, no extras).
5. Persist `CHECKLIST_COMPLETED` FilterEvent with snapshot + answers + clientOpId + offlinePerformedAt.

## Phases A.2-A.4 — Other versionable entities (separate PRs)

- **A.2** — `FilterCleaningProfile` ✅ **DONE 2026-05-01.** On inspection it was already immutable-rowful (update archives the old row + inserts a new row with `version+1`); cycles already pin `profileId` to a specific row. The actual gap was lineage tracking + version-history endpoints. Implemented: `lineageId UUID NOT NULL` column with `@@unique([lineageId, version])` and `@@index([lineageId])`; `create()` mints `lineageId`, `update()` propagates it; `list()` switched to `distinct: ['lineageId']` (rename-safe); routes `GET /api/filter-cleaning-profiles/:id/versions` and `GET /api/filter-cleaning-profiles/:id/versions/:n` exposed. Did **not** introduce a sidecar `FilterCleaningProfileVersion` table — the existing rowful approach is simpler and equivalent. Cycles continue to pin `profileId`; the `cleaning_cycles.profileVersion` column already records the version int at start.
- **A.3** — `FilterProfile` ✅ **DONE 2026-05-01.** Sidecar pattern (mirrors A.1 ChecklistProfile) — FilterProfile mutates in place, so `update()` snapshots the OUTGOING state into `FilterProfileVersion` then bumps `FilterProfile.version`. First version is created lazily (live row IS v1 until first edit). Endpoints `GET /api/filter-profiles/:id/versions` and `/:id/versions/:n`. **No cycle-side pin map** because cycles already pin `cleaning_cycles.profileId` to a FilterCleaningProfile row at start; FilterProfile drift cannot reach an in-flight cycle. Per-block override (originally floated for Step 7) is explicitly out of scope — user confirmed FilterProfile is uniform across all blocks. Hard-delete-with-guard preserved. Schema applied via `prisma db push` against an empty `filter_profiles` table; cascade on `FilterProfileVersion.profileId` drops version rows when the parent is deleted. Model count 66 → 67.
- **A.4** — ✅ **DONE 2026-05-02.** Two sub-targets that turned out to need different treatments:
  - **Cleaning reasons** (config def `filter-cleaning-reasons`): **no code change**. Already drift-resistant — `CleaningCycle.cleaningReasonKey` + `cleaningReasonLabel` are written at cycle start, so cycles carry their own label pin. Editing the config later affects new cycles only. Documented in BACKEND_GUIDE § Versioning + apps/api/DECISIONS.md.
  - **Equipment-group instruments**: composite sidecar versioning. `update()` mutates the parent group + all 3 instruments together inside one transaction, so the natural unit is the whole composite — same shape as A.1 ChecklistProfile + questions. Added `EquipmentGroup.version Int @default(1)` + new `EquipmentGroupVersion` sidecar with `snapshot Json` carrying `{ name, blockId, isActive, instruments[] ordered by sortOrder }`. New helper `snapshotAndBump(tx, groupId, changeNotes, ctx)` runs as the first step inside the existing `update()` transaction. New endpoints `GET /api/equipment-groups/:id/versions` and `/:id/versions/:n` gated `ASSET_READ` OR `EG_VIEW`. Cycle-side pinning intentionally deferred at A.4 ship time, **closed as P1 on 2026-05-02** (see below). Model count 67 → 68.
- **P1** — ✅ **DONE 2026-05-02.** Closes the A.4-deferred per-cycle group-version pinning gap. Added `cleaning_cycles.equipmentGroupVersionPin Int?` (nullable for legacy cycles + cycles without a group). `startCycle()` and the reading-submit lazy-bind path stamp the live group's `version` at bind time. Reading validation reads `operatingMin/Max` from the pinned `EquipmentGroupVersion.snapshot.instruments[]`, with `pin === null` fallback to the live row for backwards compatibility. Audit replay byte-correct: a reading is validated against the rules in effect when the cycle started. Tablet/offline app NOT updated this iteration — Slice B contract documented in `future/offline-version-sync-contract.md` for the next APK build cycle. P1 also fixed a latent pre-existing FK bug in `startCycle()` (was storing FilterProfile id where the FK expected FilterCleaningProfile id — masked because no FilterDetails-bound cycle had ever started in the dev DB).

**Phase 5b Path A is now complete** (A.1 + A.2 + A.3 + A.4 + P1 follow-up).

## Acceptance gates for A.1

- `prisma validate` clean; `tsc --noEmit` (api+web) exit 0
- `prisma db push` succeeds; existing data backfilled to v1
- Editor mutations create version rows + bump version
- Cycle start writes `checklistVersionPins`
- `getCurrentState` resolves from pins
- `submitChecklist` honors pinned versions for drift detection
- 409 SCHEMA_DRIFT round-trip works (rename a question between cycle start and submit; submit returns drift; client re-fetch + re-answer succeeds)
- Cycle history audit replay shows pinned-version questions, not live questions
- UI walk: edit a checklist profile, verify version increments, verify cycle started before edit still uses old questions
