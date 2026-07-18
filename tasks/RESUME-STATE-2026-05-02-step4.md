## Resume state — 2026-05-02 — Step 4 (applicableTemplates JSONB → join table) DONE + COMMITTED; push deferred

## Where the tree is
- **Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`
- **Branch:** `feature/phase5-verification`
- **HEAD:** `e857fea` — `feat(filter-profile): Step 4 — applicableTemplates JSONB to join table`
- **Recent commits (top of branch):**
  - `e857fea` Step 4 — applicableTemplates → join table
  - `1700088` Phase A.4 resume note
  - `6affffc` Phase A.4 — EquipmentGroup composite versioning
  - `5761cd6` Phase A.3 touchpoint verification note
  - `7216804` Phase A.3 resume note
  - `a818f58` Phase A.3 — FilterProfile sidecar versioning
  - `4bc9d34` Phase A.2 — FilterCleaningProfile lineage versioning
- **Origin status:** **~65 commits ahead** of `origin/docsCleaned`. GitHub `github.com:443` was unreachable for the fifth session running. Push when network returns.
- **Working tree:** clean.

## What landed this session

### Step 4 of the 9-step architectural refactor — DONE
Removes the long-standing dangling-FK-via-JSON foot-gun: FilterProfile templates were a JSONB array of UUIDs with no FK enforcement; deleting an AssetTemplate left orphan UUIDs that the JOIN-via-IN-clause silently dropped, with no audit trail.

#### Schema (`apps/api/prisma/schema.prisma`)
- **Dropped** `FilterProfile.applicableTemplates Json` column.
- **Added** `FilterProfileApplicableTemplate` model — composite PK `(profileId, templateId)`, both FKs `onDelete: Cascade`, `@@index([templateId])`, `@@map("filter_profile_applicable_templates")`.
- Reverse relations on both `FilterProfile.applicableTemplates: FilterProfileApplicableTemplate[]` and `AssetTemplate.filterProfileBindings: FilterProfileApplicableTemplate[]`.
- Applied via `prisma db push --skip-generate` against an empty `filter_profiles` table — no backfill needed.

#### Service (`apps/api/src/modules/filter-profiles/filter-profile.service.ts`)
- `create()` wraps in `prisma.$transaction`: creates the FilterProfile row, then `createMany` the join rows. Pre-flight verifies all incoming template IDs exist (returns `400 VALIDATION_ERROR` listing missing IDs) before opening the transaction.
- `update()` rewrites the join set inside the existing snapshot-then-bump transaction (`deleteMany` + `createMany`). Same upfront ID-existence check.
- `list()` and `getById()` use `include: { applicableTemplates: { select: { templateId: true } } }` then flatten via a small `flattenApplicableTemplates()` helper to keep the wire shape `applicableTemplates: string[]` — **no FE change**.
- **A.3 snapshot fix:** `snapshotAndBump()` now reads the live join rows inside the same transaction and freezes them as `string[]` in `FilterProfileVersion.snapshot.applicableTemplates`, so historical replay stays byte-correct.

#### AssetTemplate delete guard (`apps/api/src/modules/assets/services/template.service.ts`)
- Before `softDelete()`, count `filterProfileApplicableTemplate` rows for `templateId`. If > 0, throw `ConflictError` (`409 IN_USE`) listing the binding profiles by name. The cascade FK on the join table is the safety net for hard deletes (super-admin / backup-restore); this guard is the user-facing path. Matches the existing FilterProfile delete-guard against FilterDetails references.

#### Verification (per CLAUDE.md "always test API")
- `npx tsc -p apps/api/tsconfig.json --noEmit` exit 0; full compile to dist exit 0.
- `prisma db push --skip-generate` reports schema in sync; `\d filter_profile_applicable_templates` confirms columns + cascade FKs; `applicable_templates` column gone from `filter_profiles`.
- `Restart-Service DigiLogAPI-Phase5` clean; `/health` 401 (TLS up).
- End-to-end via curl:
  - Seeded one ACTIVE FilterCleaningProfile (id `…0401`) so a FilterProfile could reference one.
  - `POST` with two real template UUIDs → response carries `applicableTemplates: ["…", "…"]` as `string[]`. Profile starts at `version: 1`.
  - `POST` with a bogus template UUID → clean `400 VALIDATION_ERROR` listing the unknown ID.
  - `PUT` removing one template → response shows the shorter array; `version` bumped to 2.
  - `GET /:id/versions/1` → frozen v1 snapshot still has BOTH templates as `string[]` — snapshot-fix verified byte-correct.
  - `DELETE /api/assets/templates/<bound-template-id>` → `409 CONFLICT` with `Cannot delete template "Block-T": still bound by 1 filter profile(s) [S4 Test Filter Profile]. Remove these bindings first.`.
  - `DELETE /api/assets/templates/<unbound-template-id>` (the second template, after PUT detached it) → `200 success`.
- Test data fully cleaned up — 0 leftover rows in `filter_profiles`, `filter_profile_versions`, `filter_profile_applicable_templates`; the seeded cleaning profile dropped; the unbound template restored to `is_active = true` so the dev DB stays usable.

#### Doc sync (21 docs touched)
- Root: `CLAUDE.md`, `AGENTS.md`, `BACKEND_GUIDE.md`, `PROJECT_ARCHITECTURE.md`, `PROJECT_SUMMARY.md`, `README.md`, `OFFLINE_SYNC_ARCHITECTURE.md`, `LOCAL_SETUP_WINDOWS.md`, `windowsIssues.md`, `CHANGELOG.md` (new Step 4 entry).
- Per-package: `apps/api/CLAUDE.md`, `apps/api/DECISIONS.md` (new entry §23: "FilterProfile applicable-templates: join table over JSONB array"), `packages/shared/CLAUDE.md`.
- Reference: `docs/index.md`, `docs/getting-started/{system-requirements,what-is-digilog}.md`, `docs/user-guide/entities/entities-and-hierarchy.md`, `future/overview/CODEBASE_SUMMARY.md`, `future/architectural-refactor-9-steps.md` (Step 4 marked DONE in the table + section rewritten).
- Audit log: `tasks/todo.md` (Step 4 entry).

#### Live counts after this batch
- **69 models** (was 68 → 69 after Step 4)
- **23 enums** (unchanged)
- 105 permissions, 89 feature privileges, 81 reauth actions, 25 sidebar items
- 36 API modules, 30 config defs, 27 config pages

## 9-step refactor status
| Step | Item | Status |
|---|---|---|
| 1 | templateKind enum → admin-editable lookup table | ✅ DONE 2026-04-30 |
| 2 | relationshipType enum + bidirectional check | ✅ DONE 2026-05-01 |
| 3 | AssetInstance.organizationId NOT NULL | ❌ OBSOLETE (MT removal) |
| 4 | applicableTemplates JSONB → join table | ✅ DONE 2026-05-02 |
| 5 | Investigate two checklist systems | ✅ NO-OP 2026-04-30 |
| 6 | FilterDetails 1:1 split | ✅ DONE 2026-05-01 |
| 7 | Multi-version pipeline rollout (per-block) | ❌ DEPRIORITIZED 2026-05-01 |
| 8 | Decision-tape architecture | ⏳ pending — biggest (2-4 weeks) |
| 9 | Cycle as event fold | ⏳ blocked on #8 |

**Tally:** 5 done (1, 2, 4, 5, 6) · 2 closed-without-work (3 obsolete, 7 deprioritized) · **2 still actually pending** (8 and its dependent 9).

Phase 5b Path A versioning rollout is also fully complete (A.1+A.2+A.3+A.4).

## Touchpoint verification
- **Backend mutation sites for FilterProfile.applicableTemplates** — only `filter-profile.service.ts` (`create`, `update`, `snapshotAndBump`). Only `template.service.ts` checks for bindings during delete. No other module touches the field (verified via grep across `apps/api/src`).
- **Backend reads** — none use the deleted column directly anymore. The Prisma client now exposes `applicableTemplates` as the relation, which only `filter-profile.service.ts` includes + flattens.
- **Frontend touchpoints** — none. `grep "applicableTemplates"` across `apps/web/src` returns no matches; the FE doesn't read or send the field today. The wire-shape preservation means even if FE consumers exist in the future they see no change.

## Next-session checklist

1. **Sanity check on resume** —
   ```powershell
   git -C "C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification" status --short    # expect: empty
   git -C "C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification" log --oneline -2  # expect: e857fea, 1700088
   Get-Service DigiLogAPI-Phase5, DigiLogWeb-Phase5                                                  # expect: both Running
   curl.exe -sk -o NUL -w "%{http_code}`n" https://localhost:3000/health                             # expect: 401 (auth-gated; TLS up)
   ```

2. **Push** (GitHub was unreachable last five sessions):
   ```
   git push origin feature/phase5-verification
   ```
   ~65 commits will land on origin once the network returns.

3. **What's actually pending in the 9-step plan:**
   - **Step 8** — Decision-tape architecture. 2-4 weeks. Server emits ordered `actions[]` per filter; client has zero pipeline logic. Eliminates the entire client/server pipeline-drift bug class. Touches: new server tape generator, full FE renderer rewrite, offline replay against cached tape, APK rebuild + versioned tape contract.
   - **Step 9** — Cycle as event fold. Blocked on #8.
   - **Out of band:** per-cycle EquipmentGroup-version pinning (design call), AWS SNS shell-out replacement, Windows-service launcher full automation.

## Known network constraint
GitHub `github.com:443` unreachable for the entire five-session run. All commits stay safe locally on `feature/phase5-verification`. ~65 commits ahead of `origin/docsCleaned` once Step 4 commit lands on origin.
