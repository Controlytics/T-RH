# Resume State — 2026-05-01 — Phase A.2 (FilterCleaningProfile lineage versioning) DONE; uncommitted

## Where the tree is
- **Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`
- **Branch:** `feature/phase5-verification`
- **HEAD:** `19a5454` — `docs: full sync after Phase 4 — Redis fully retired`
- **Working tree:** **8 modified files, NOT YET COMMITTED.** Next session, restart in elevated cmd, then commit.

## Modified files (verified via `git status`)
```
 M API_REFERENCE.md                                                        (Phase A.2 doc sync — full route table refresh)
 M BACKEND_GUIDE.md                                                        (Phase A.2 doc sync — endpoint count 9→11, two-pattern note)
 M CHANGELOG.md                                                            (Phase A.2 entry)
 M CLAUDE.md                                                               (Phase A.2 endpoints in Key API Endpoints block)
 M PHASE_5_RECENT_WORK.md                                                  (closed the "cleaning-profile version pinning" outstanding item)
 M PROJECT_ARCHITECTURE.md                                                 (FilterCleaningProfile lineage + ChecklistProfileVersion in entity diagram)
 M PROJECT_SUMMARY.md                                                      (66-models row updated to mention lineageId)
 M README.md                                                               (66-models paragraph updated)
 M apps/api/CLAUDE.md                                                      (Key API Endpoints + versioning pattern note)
 M apps/api/DECISIONS.md                                                   (versioning decision expanded with two-pattern explanation)
 M apps/api/prisma/schema.prisma                                           (lineageId column + indexes)
 M apps/api/src/modules/cleaning-profiles/cleaning-profile.service.ts      (lineageId in create/update + getVersions/getVersion/deleteProfile)
 M apps/api/src/modules/cleaning-profiles/routes.ts                        (two new GET routes)
 M tasks/STEP-5B-A-VERSIONING-PLAN.md                                      (Phase A.2 marked DONE with design-deviation note)
 M tasks/todo.md                                                           (audit log entry)
?? tasks/RESUME-STATE-2026-05-01-phase4-bus.md                             (prior resume note)
?? tasks/RESUME-STATE-2026-05-01-phaseA2.md                                (this resume note)
```

## What landed in this session (Phase A.2)
**Goal:** lineage-track FilterCleaningProfile so renames don't break the version chain, and expose version history endpoints. Discovery: the underlying versioning was already immutable-rowful (update archives old + inserts new with `version+1`); cycles already pin `profileId` at start. The actual gap was lineage tracking.

### Schema (`apps/api/prisma/schema.prisma:1301-1326`)
- Added `lineageId String @map("lineage_id") @db.Uuid` (NOT NULL).
- Added `@@unique([lineageId, version])`.
- Added `@@index([lineageId])`.
- Applied to live DB **directly via psql** (table was empty; no backfill needed):
  ```sql
  ALTER TABLE filter_cleaning_profiles ADD COLUMN lineage_id uuid NOT NULL DEFAULT gen_random_uuid();
  ALTER TABLE filter_cleaning_profiles ALTER COLUMN lineage_id DROP DEFAULT;
  CREATE UNIQUE INDEX filter_cleaning_profiles_lineage_id_version_key ON filter_cleaning_profiles(lineage_id, version);
  CREATE INDEX filter_cleaning_profiles_lineage_id_idx ON filter_cleaning_profiles(lineage_id);
  ```
- `npx prisma db push --skip-generate` reports "already in sync."
- Prisma client regenerated (after stopping `DigiLogAPI-Phase5` to free the DLL, then restart).

### Service (`apps/api/src/modules/cleaning-profiles/cleaning-profile.service.ts`)
- `create()` mints `lineageId: randomUUID()` from `node:crypto`.
- `update()` propagates `lineageId: existing.lineageId` to new version row.
- `list()` switched from `distinct: ['name']` → `distinct: ['lineageId']` (rename-safe).
- New `getVersions(_ctx, id)`: returns `{ lineageId, versions[] }` ordered version DESC.
- New `getVersion(_ctx, id, n)`: returns frozen snapshot at version n; uses `lineageId_version` compound unique.
- New `deleteProfile(ctx, id)`: blocks if cycles or filter-profile assignments reference; returns 409 with helpful message before relying on DB FK.

### Routes (`apps/api/src/modules/cleaning-profiles/routes.ts`)
- `GET /api/filter-cleaning-profiles/:id/versions` (gated `FCP_READ` or `CP_TOGGLE`).
- `GET /api/filter-cleaning-profiles/:id/versions/:versionNumber` (same gate).
- Existing `DELETE /:id` remains soft-archive — new hard-delete service method NOT wired to a route.

### Verification done
- `npx tsc -p apps/api/tsconfig.json --noEmit` exit 0.
- `npx tsc -p apps/api/tsconfig.json` (compile to dist) exit 0; new endpoints emit 6 occurrences of "versions" in `dist/modules/cleaning-profiles/routes.js`.
- `Restart-Service DigiLogAPI-Phase5` — running.
- Synthetic seed of two versions sharing one `lineageId` (lineage `8e15b41d-...`, v1 ARCHIVED, v2 ACTIVE):
  - `GET ?page=1&limit=5` → `total: 1` (collapse correct).
  - `GET /:v2/versions` → both versions, latest first.
  - `GET /:v1/versions` → identical lineage response anchored on archived row.
  - `GET /:v1/versions/2` → frozen v2 with stages/connections.
  - `GET /:v1/versions/99` → clean `404 NOT_FOUND` "Version 99 not found in lineage ...".
- Seed cleaned up (`DELETE FROM filter_cleaning_profiles WHERE name = 'Test Lineage Profile';` → DELETE 2).
- `tmp_seed_versions.sql` removed.

### Doc updates
- `CLAUDE.md` — added 2 new endpoints to "Key API Endpoints" block.
- `apps/api/CLAUDE.md` — added 3 lines under Phase 2 endpoints + a "FilterCleaningProfile versioning" pattern note.
- `CHANGELOG.md` — new "[Unreleased] — Phase A.2: FilterCleaningProfile lineage-based versioning (2026-05-01)" section with full background/changes/verification.
- `tasks/STEP-5B-A-VERSIONING-PLAN.md` — Phase A.2 marked DONE with the design-deviation note (no sidecar table — rowful immutability already there).
- `tasks/RESUME-STATE-2026-05-01-phase4-bus.md` — A.2 line crossed out.
- `tasks/todo.md` — audit-log entry for 2026-05-01 Phase A.2.

## Next-session checklist (in elevated cmd)

1. **Verify nothing changed** — `git status --short` should show the same 8 files. If anything else appears, investigate before committing.
2. **Commit Phase A.2** (15 modified + 2 untracked resume notes — `git add -A` is fine here, no other untracked files):
   ```
   git add API_REFERENCE.md BACKEND_GUIDE.md CHANGELOG.md CLAUDE.md PHASE_5_RECENT_WORK.md PROJECT_ARCHITECTURE.md PROJECT_SUMMARY.md README.md apps/api/CLAUDE.md apps/api/DECISIONS.md apps/api/prisma/schema.prisma apps/api/src/modules/cleaning-profiles/cleaning-profile.service.ts apps/api/src/modules/cleaning-profiles/routes.ts tasks/STEP-5B-A-VERSIONING-PLAN.md tasks/todo.md tasks/RESUME-STATE-2026-05-01-phase4-bus.md tasks/RESUME-STATE-2026-05-01-phaseA2.md
   git commit -m "feat(cleaning-profile): Phase A.2 — lineageId + version history endpoints"
   ```
3. **Push** (GitHub was unreachable last session):
   ```
   git push origin feature/phase5-verification
   ```
   If still unreachable: defer; commits stay safe locally.
4. **Continue to Phase A.3** — FilterProfile versioning. FilterProfile is the per-block mapping that pins which cleaning profile a block uses. Per-block override capability is needed for Step 7 (multi-version pipeline rollout). Same pattern as A.2 likely applies — check whether FilterProfile already has rowful immutability or needs a sidecar.

## Known network constraint
GitHub `github.com:443` was unreachable for the entire previous + current session. ~30-31 commits will be ahead of `origin/docsCleaned` once Phase A.2 commit lands. Push when network returns.

## Sanity check on resume
```powershell
Get-Service DigiLogAPI-Phase5, DigiLogWeb-Phase5
curl.exe -sk -o NUL -w "%{http_code}`n" https://localhost:3000/health
git status --short
```
Expect: both Running, 200, the 8 modified files (or 8+ this resume note).
