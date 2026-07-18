## Resume state — 2026-05-01 — Phase A.3 (FilterProfile sidecar versioning) DONE + COMMITTED; push deferred

## Where the tree is
- **Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`
- **Branch:** `feature/phase5-verification`
- **HEAD:** `a818f58` — `feat(filter-profile): Phase A.3 — version sidecar + history endpoints`
- **Previous commit:** `4bc9d34` — `feat(cleaning-profile): Phase A.2 — lineageId + version history endpoints`
- **Origin status:** **~61 commits ahead** of `origin/docsCleaned`. GitHub `github.com:443` was unreachable for the third session running. Push when network returns.
- **Working tree:** clean (no modified, no untracked).

## What landed this session

### Phase A.2 (sanity-check + commit + push)
- Sanity-check on resume — 15 modified + 2 untracked exactly as the prior resume note expected. Both `DigiLogAPI-Phase5` and `DigiLogWeb-Phase5` services Running. `/health` returns 401 (auth-gated) — TLS up.
- Committed Phase A.2 as `4bc9d34` (17 files, 429 +, 35 -).
- Push attempt failed — GitHub unreachable.

### Phase A.3 (FilterProfile sidecar versioning)
**Goal:** add per-FilterProfile version history so audit replay can reconstruct the mapping that was active at any historical moment. **Per-block override capability is explicitly OUT of scope** (user confirmed FilterProfile is uniform across all blocks; Step 7 deprioritized).

**Pattern decision:** FilterProfile mutates in place (no `version` field, plain `prisma.filterProfile.update`), so it follows the **A.1 ChecklistProfile sidecar pattern** rather than the A.2 FilterCleaningProfile rowful-immutable pattern. Two patterns now coexist intentionally and are documented in `BACKEND_GUIDE.md` § "Versioning" + `apps/api/DECISIONS.md` § "Phase 2 Decisions" + `apps/api/CLAUDE.md` § "Phase 2 Patterns."

#### Schema (`apps/api/prisma/schema.prisma:1363-1411`)
- `FilterProfile.version Int @default(1)` — monotonic counter on the live row.
- New model `FilterProfileVersion` — sidecar with `id`, `profileId`, `versionNumber`, `snapshot Json`, `changeNotes`, `createdAt`, `createdBy`. Cascade-deletes via `@relation onDelete: Cascade`. `@@unique([profileId, versionNumber])` + `@@index([profileId])`.
- Applied via `npx prisma db push --skip-generate` (table empty → no backfill needed). Verified: `\d filter_profile_versions` lists all columns; `version` column present on `filter_profiles`.
- Prisma client regenerated after stopping `DigiLogAPI-Phase5` to free the DLL, then restarted.

#### Service (`apps/api/src/modules/filter-profiles/filter-profile.service.ts`)
- New `snapshotAndBump(tx, profileId, changeNotes, ctx)` helper — freezes the OUTGOING row's full state into `filter_profile_versions`, then `version: { increment: 1 }`.
- `update()` now wraps the mutation in `prisma.$transaction(async (tx) => { … })` with `snapshotAndBump` first.
- `create()` does NOT write a version row — first version is created lazily; live row IS v1 until first edit (mirrors A.1).
- New `getVersions(_, id)` returns `{ profileId, currentVersion, versions[] }` newest-first with metadata only.
- New `getVersion(_, id, n)` returns the frozen snapshot (`{ profileId, versionNumber, …snapshot fields, createdAt, createdBy, changeNotes }`).
- Hard-delete-with-guard preserved (rejects if any FilterDetails still reference). Cascade drops version rows.
- Audit log on update now includes `version` in `beforeValue`/`afterValue`.

#### Routes (`apps/api/src/modules/filter-profiles/routes.ts`)
- `GET /api/filter-profiles/:id/versions` (gated `FP_READ`).
- `GET /api/filter-profiles/:id/versions/:versionNumber` (gated `FP_READ`).

#### Verification (per CLAUDE.md "always test API")
- `npx tsc -p apps/api/tsconfig.json --noEmit` exit 0.
- `npx tsc -p apps/api/tsconfig.json` (compile to dist) exit 0; new endpoints emit 4 occurrences of "versions" in `dist/modules/filter-profiles/routes.js`.
- `Restart-Service DigiLogAPI-Phase5` → Running; `/health` 401 (TLS up).
- End-to-end via curl with file-based JSON bodies (PowerShell mangles inline JSON):
  - Seeded `filter_cleaning_profiles` row id `…0a301` (psql, since the create endpoint requires reauth + a full pipeline graph).
  - `POST /api/filter-profiles` → returned `version: 1`.
  - `PUT` (rename) → `version: 2`; one row in `filter_profile_versions` carrying the v1 snapshot.
  - Second `PUT` (changed `description` and `blockRestriction` to `ANY_BLOCK`) → `version: 3`; two version rows.
  - `GET /:id/versions` → `currentVersion: 3` + 2 archived versions newest-first.
  - `GET /:id/versions/1` → frozen v1 snapshot (original name, original description, `OWN_BLOCK_ONLY`).
  - `GET /:id/versions/2` → frozen v2 snapshot (renamed, first-edit description, still `OWN_BLOCK_ONLY` — v3 changes correctly isolated).
  - `GET /:id/versions/99` → clean 404 with "Version 99 of filter profile … not found".
- Test data fully cleaned up — `0` leftover rows in `filter_profiles`, `filter_profile_versions`, and the seeded `filter_cleaning_profiles` row. All `tmp_*.json/sql/txt` files removed.

#### Doc sync (22 docs touched + new commit metadata)
- Root: `README.md`, `CLAUDE.md`, `AGENTS.md`, `CHANGELOG.md`, `PROJECT_SUMMARY.md`, `PROJECT_ARCHITECTURE.md`, `API_REFERENCE.md` (new "Filter Profiles" section), `BACKEND_GUIDE.md`, `OFFLINE_SYNC_ARCHITECTURE.md`, `PHASE_5_RECENT_WORK.md` (closed gap), `LOCAL_SETUP_WINDOWS.md`, `windowsIssues.md`.
- Per-package: `apps/api/CLAUDE.md`, `apps/api/DECISIONS.md`, `packages/shared/CLAUDE.md`.
- Reference: `docs/index.md`, `docs/getting-started/{system-requirements,what-is-digilog}.md`, `docs/user-guide/entities/entities-and-hierarchy.md`, `future/overview/CODEBASE_SUMMARY.md`, `future/architectural-refactor-9-steps.md` (Step 7 deprioritized).
- Plan + audit log: `tasks/STEP-5B-A-VERSIONING-PLAN.md` (A.3 marked DONE), `tasks/todo.md` (audit-log entry).

#### Live counts after this batch
- **67 models** (was 66 → 67 after Phase A.3)
- **23 enums** (unchanged)
- 105 permissions, 89 feature privileges, 81 reauth actions, 25 sidebar items
- 36 API modules, 30 config defs, 27 config pages

## Next-session checklist

1. **Sanity check on resume** —
   ```powershell
   git -C "C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification" status --short    # expect: empty
   git -C "C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification" log --oneline -2  # expect: a818f58, 4bc9d34
   Get-Service DigiLogAPI-Phase5, DigiLogWeb-Phase5                                                  # expect: both Running
   curl.exe -sk -o NUL -w "%{http_code}`n" https://localhost:3000/health                             # expect: 401 (auth-gated; TLS up)
   ```

2. **Push** (GitHub was unreachable last three sessions):
   ```
   git push origin feature/phase5-verification
   ```
   ~61 commits will land on origin once the network returns.

3. **Continue to Phase A.4 (lower priority)** — versioning for cleaning reasons (config def values) and equipment-group instruments. Both are different shapes from A.1/A.2/A.3:
   - **Cleaning reasons** live in a `SystemConfig` row (`configKey: 'cleaning-reasons'`) — JSON array of `{ key, label }`. Cycles store `cleaningReasonKey` + `cleaningReasonLabel` directly on `CleaningCycle` so historical cycles already keep their own label snapshot. Versioning would mean snapshotting the JSON config on each edit. Probably a sidecar on SystemConfig generally, not a one-off.
   - **Equipment-group instruments** — `EquipmentGroupInstrument` rows. Likely sidecar pattern. Need to check whether any cycle/event references them.
   - Verify scope with the user before starting — A.4 was tagged "lower priority" in the original plan and may not be worth the surface area.

4. **Phase 5+ open items still pending** (not part of A.x rollout):
   - Step 7 (per-block multi-version pipeline rollout) — **deprioritized** 2026-05-01 per user.
   - Step 8 (decision-tape architecture) — 2-4 weeks; biggest remaining architectural item.
   - Step 9 (cycle as event fold) — depends on #8.
   - Phase 5+ proper Windows-service launcher full automation — still pending.

## Touchpoint verification (per CLAUDE.md "test all touchpoints")

- **Backend mutation sites for FilterProfile** — only `apps/api/src/modules/filter-profiles/filter-profile.service.ts` (`create`, `update`, `delete`, `assign`). Verified via grep. No other module mutates `prisma.filterProfile`.
- **Backend read sites for FilterProfile mid-cycle** — `apps/api/src/modules/filter-operations/filter-operations.service.ts` reads FilterProfile only at cycle start (to derive a CleaningProfile, which is then pinned via `cleaning_cycles.profileId`). No mid-cycle FilterProfile reads. **Conclusion:** no cycle-side pin map needed; in-flight cycles cannot drift.
- **Frontend touchpoints** — single site `apps/web/src/routes/filter-management/filter-profile-list.tsx:7` calls `GET /api/filter-profiles?page=…`. The list-response shape is unchanged (just adds an additive `version` field that the existing TypeScript interface in `apps/web/src/types/filter.ts:51-62` simply ignores — TS structural types don't reject extras). The new `/versions` endpoints have no current FE consumer; that's a future UI task, not part of A.3.
- **FRONTEND_GUIDE.md** — verified clean of stale FilterProfile and model-count refs (no edits needed).

## Known network constraint
GitHub `github.com:443` unreachable for entire three-session run (Phase A.1 + A.2 + A.3 + Phase 4 bus). All commits stay safe locally on `feature/phase5-verification`. ~61 commits ahead of `origin/docsCleaned` once Phase A.3 commit lands on origin.

## Key files
- Phase A.3 commit: `a818f58`
- Phase A.2 commit: `4bc9d34`
- Plan: `tasks/STEP-5B-A-VERSIONING-PLAN.md`
- Audit log: `tasks/todo.md` (top — "2026-05-01 — Phase A.3" entry)
