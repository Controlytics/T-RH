## Resume state — 2026-05-02 — Phase A.4 (EquipmentGroup composite versioning) DONE + COMMITTED; push deferred. **Phase 5b Path A is complete.**

## Where the tree is
- **Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`
- **Branch:** `feature/phase5-verification`
- **HEAD:** `6affffc` — `feat(equipment-groups): Phase A.4 — composite version sidecar + history endpoints`
- **Recent commits (top of branch):**
  - `6affffc` Phase A.4 — EquipmentGroup composite versioning
  - `5761cd6` Phase A.3 touchpoint verification note
  - `7216804` Phase A.3 resume note
  - `a818f58` Phase A.3 — FilterProfile sidecar versioning
  - `4bc9d34` Phase A.2 — FilterCleaningProfile lineage versioning
- **Origin status:** **~62 commits ahead** of `origin/docsCleaned`. GitHub `github.com:443` was unreachable for the fourth session running. Push when network returns.
- **Working tree:** clean.

## What landed this session

**Phase A.4 had two declared sub-targets that needed different treatments:**

### Cleaning reasons (config def `filter-cleaning-reasons`) — NO CODE
Already drift-resistant: `CleaningCycle.cleaningReasonKey` + `cleaningReasonLabel` (schema lines 1431-1432) are written at cycle start, so cycles carry their own label pin. Editing the config later affects only new cycles. Documented in:
- `BACKEND_GUIDE.md` § "Versioning"
- `apps/api/DECISIONS.md` § "Phase 2 Decisions"
- `apps/api/CLAUDE.md` § "Phase 2 Patterns"
- `tasks/STEP-5B-A-VERSIONING-PLAN.md` (A.4 entry)

### EquipmentGroup composite versioning — NEW SIDECAR

**Pattern decision:** EquipmentGroup is a composite — `update()` mutates the parent group + all 3 instruments together inside one transaction (lines 154-184 of equipment-groups.service.ts). The natural unit of versioning is therefore the whole composite, mirroring A.1 ChecklistProfile + questions.

#### Schema (`apps/api/prisma/schema.prisma:1503-1564`)
- `EquipmentGroup.version Int @default(1)` — monotonic counter on the live row.
- New model `EquipmentGroupVersion` — sidecar with `id`, `groupId`, `versionNumber`, `snapshot Json`, `changeNotes`, `createdAt`, `createdBy`. Cascade-deletes via `@relation onDelete: Cascade`. `@@unique([groupId, versionNumber])` + `@@index([groupId])`.
- `snapshot` carries: `{ name, blockId, isActive, instruments: [{ id, description, stageKey, serialNumber, instrumentId, uom, instrumentMin, instrumentMax, operatingMin, operatingMax, leastCount, sortOrder }] }` (instruments ordered by sortOrder).
- Applied via `npx prisma db push --skip-generate` against an empty `equipment_groups` table — no backfill needed.

#### Service (`apps/api/src/modules/equipment-groups/equipment-groups.service.ts`)
- New private `snapshotAndBump(tx, groupId, changeNotes, ctx)` helper — freezes the OUTGOING composite into `equipment_group_versions`, then `version: { increment: 1 }`. Mirrors A.1/A.3 helpers.
- `update()` calls `snapshotAndBump` as the FIRST step inside the existing transaction, before any live mutation. The existing logic (rename group + update each instrument) runs after.
- `create()` does NOT write a version row — first version is created lazily; live composite IS v1 until first edit (matches A.1/A.3).
- New `getVersions(_, id)` returns `{ groupId, currentVersion, versions[] }` newest-first with metadata only.
- New `getVersion(_, id, n)` returns the frozen composite as `{ groupId, versionNumber, name, blockId, isActive, instruments[], createdAt, createdBy, changeNotes }`.
- Hard-delete preserved (it's actually soft-delete via `isActive=false` in this module). Cascade drops version rows on hard delete.
- Audit log on update now includes `version` in `beforeValue`/`afterValue`.

#### Routes (`apps/api/src/modules/equipment-groups/routes.ts`)
- `GET /api/equipment-groups/:id/versions` (gated `ASSET_READ` OR `EG_VIEW`).
- `GET /api/equipment-groups/:id/versions/:versionNumber` (same gate).

#### Verification (per CLAUDE.md "always test API")
- `npx tsc -p apps/api/tsconfig.json --noEmit` exit 0; full compile to dist exit 0; `dist/modules/equipment-groups/routes.js` has 4 occurrences of "versions".
- `Restart-Service DigiLogAPI-Phase5` → Running; `/health` 401 (TLS up).
- End-to-end via curl on existing block `B1` (id `702149e9-…2a78c6`):
  - `POST` with 3 instruments (Air, RO, Dryer) → returned `version: 1`.
  - First `PUT` (renamed "A4 Test Group" → "A4 Test Group (renamed)" + Air `operatingMax: 6 → 7`) → `version: 2`; one row in `equipment_group_versions` carrying the v1 composite.
  - Second `PUT` (Air `serialNumber: SN-AIR-1 → SN-AIR-2`, `instrumentId: INST-AIR-001 → INST-AIR-002`) → `version: 3`; two version rows.
  - `GET /:id/versions` → `currentVersion: 3` + 2 archived versions newest-first.
  - `GET /:id/versions/1` → frozen v1 (original name, Air `operatingMax: 6`, Air SN `SN-AIR-1`).
  - `GET /:id/versions/2` → frozen v2 (renamed, Air `operatingMax: 7`, Air SN still `SN-AIR-1` — v3 SN/ID change correctly isolated).
  - `GET /:id/versions/99` → clean 404 with "Version 99 of equipment group … not found".
- Test data fully cleaned up via cascade: 0 leftover rows in `equipment_groups`, `equipment_group_instruments`, `equipment_group_versions`. All `tmp_*.json/sql/txt` files removed.

#### Doc sync (21 docs touched)
- Root: `CLAUDE.md`, `AGENTS.md`, `BACKEND_GUIDE.md`, `PROJECT_ARCHITECTURE.md`, `PROJECT_SUMMARY.md`, `README.md`, `OFFLINE_SYNC_ARCHITECTURE.md`, `LOCAL_SETUP_WINDOWS.md`, `windowsIssues.md`, `API_REFERENCE.md` (new "Equipment Groups" section), `CHANGELOG.md` (new Phase A.4 entry), `PHASE_5_RECENT_WORK.md` (gap closed; Path A complete).
- Per-package: `apps/api/CLAUDE.md` (key endpoints + pattern note), `apps/api/DECISIONS.md`, `packages/shared/CLAUDE.md`.
- Reference: `docs/index.md`, `docs/getting-started/{system-requirements,what-is-digilog}.md`, `docs/user-guide/entities/entities-and-hierarchy.md`, `future/overview/CODEBASE_SUMMARY.md`.
- Plan + audit log: `tasks/STEP-5B-A-VERSIONING-PLAN.md` (A.4 marked DONE; "Phase 5b Path A is now complete"), `tasks/todo.md` (audit-log entry).

#### Live counts after this batch
- **68 models** (was 67 → 68 after Phase A.4)
- **23 enums** (unchanged)
- 105 permissions, 89 feature privileges, 81 reauth actions, 25 sidebar items
- 36 API modules, 30 config defs, 27 config pages

## Phase 5b Path A is complete

| Phase | Target | Pattern | Status |
|---|---|---|---|
| A.1 | ChecklistProfile + questions | Sidecar + cycle pin | ✅ DONE 2026-05-01 |
| A.2 | FilterCleaningProfile | Rowful immutable + lineageId | ✅ DONE 2026-05-01 |
| A.3 | FilterProfile | Sidecar (no cycle pin needed) | ✅ DONE 2026-05-01 |
| A.4 | EquipmentGroup composite | Sidecar (no cycle pin needed) | ✅ DONE 2026-05-02 |
| A.4 | Cleaning reasons | No code (already pinned) | ✅ DONE 2026-05-02 |

Every mutable definition that feeds a cleaning cycle now has byte-exact audit replay either via cycle-start pinning, immutable event snapshots, or admin-edit history sidecars.

## Touchpoint verification (per CLAUDE.md "test all touchpoints")
- **Backend mutation sites for EquipmentGroup** — only `equipment-groups.service.ts` (`create`, `update`, `delete`). No other module mutates `prisma.equipmentGroup` or `prisma.equipmentGroupInstrument` (verified via grep — only one matching file under `apps/api/src`).
- **Backend read sites mid-cycle** — `filter-operations.service.ts:1093-1124` reads `equipmentGroup.findUnique` with `instruments` include only when operators submit instrument readings. Snapshot of submitted values lands in `FilterEvent.attributes.instrumentReadings` (immutable). Reading validation against operating-range reads the LIVE row — known narrow drift, deferred.
- **Frontend touchpoints** — none updated. `EquipmentGroup` type was not bumped on the FE; the additive `version` field is structurally compatible with existing TS interfaces (TypeScript structural typing ignores extra fields).
- **FRONTEND_GUIDE.md** — clean of EquipmentGroup or model-count refs (no edits needed).

## Next-session checklist

1. **Sanity check on resume** —
   ```powershell
   git -C "C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification" status --short    # expect: empty
   git -C "C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification" log --oneline -2  # expect: 6affffc, 5761cd6
   Get-Service DigiLogAPI-Phase5, DigiLogWeb-Phase5                                                  # expect: both Running
   curl.exe -sk -o NUL -w "%{http_code}`n" https://localhost:3000/health                             # expect: 401 (auth-gated; TLS up)
   ```

2. **Push** (GitHub was unreachable last four sessions):
   ```
   git push origin feature/phase5-verification
   ```
   ~62 commits will land on origin once the network returns.

3. **Phase 5b Path A is complete.** No more A.x phases planned. Remaining open items (out of A-track):
   - **Per-cycle group-version pinning** — would lock reading-validation operating-range to a pinned EquipmentGroupVersion at cycle-start. Requires design call: "pin at cycle-start" vs "pin at first-reading" semantics.
   - **Step 7** (per-block multi-version pipeline rollout) — explicitly deprioritized 2026-05-01 per user clarification.
   - **Step 8** (decision-tape architecture) — 2-4 weeks; biggest remaining architectural item.
   - **Step 9** (cycle as event fold) — depends on #8.
   - **Phase 5+ proper Windows-service launcher** full automation — still pending.

## Known network constraint
GitHub `github.com:443` unreachable for entire four-session run (Phase A.1 + A.2 + A.3 + A.4 + bus). All commits stay safe locally on `feature/phase5-verification`. ~62 commits ahead of `origin/docsCleaned` once Phase A.4 commit lands on origin.
