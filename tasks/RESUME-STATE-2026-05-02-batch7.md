# Resume state — 2026-05-02 — Batch 7 done; full L1 → B7.5 server-side / online-quality run closed

## Where the tree is

- **Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`
- **Branch:** `feature/phase5-verification` — fully pushed; `origin/feature/phase5-verification` exists and matches local HEAD (0 ahead, 0 behind).
- **HEAD before this commit:** `1d6ec6b` — `B7.4: render equipmentGroupSyncWarning advisory on operator pages`
- **HEAD after this commit:** the B7.5 doc-sync commit that wrote this note (amended to correct push-state staleness; resolve the SHA via `git rev-parse HEAD`).
- **Origin status:** feature branch fully pushed to origin (`origin/feature/phase5-verification` matches local HEAD). 82 commits ahead of `origin/docsCleaned` (this number includes the B7.5 commit); merge target per CLAUDE.md is `DigitalFMS`. Push has succeeded — GitHub network constraint that bit Batches 4-6 has cleared.
- **Working tree at start of B7.5:** clean except for the planned doc edits this task introduces. Will be clean again post-commit.
- **Services (from prior session):** `DigiLogAPI-Phase5` and `DigiLogWeb-Phase5` were Running. `https://localhost:3000/health` returned 401 (auth-gated; TLS up). Worktree is doc-only this session — services not strictly required.

## Live counts (verified post-B7.5 via grep/ls — all match Batch 6 baseline)

```
69 Prisma models, 23 enums                       (apps/api/prisma/schema.prisma)
106 permissions                                  (packages/shared/src/types/permissions.ts)
90 feature privileges                            (packages/shared/src/types/feature-privileges.ts via shared CLAUDE inventory)
81 reauth actions                                (packages/shared/src/types/reauth-actions.ts)
26 sidebar items                                 (packages/shared/src/types/sidebar-items.ts via shared CLAUDE inventory)
36 API modules                                   (apps/api/src/modules/)
30 config defs                                   (apps/api/src/modules/config/defs/*.def.ts)
27 config pages                                  (apps/web/src/routes/config/*.tsx)
82 frontend <Route> defs                         (apps/web/src/main.tsx)
```

**Batch 7 was correctly invariant on all eight tracked counts.** No new schema / permission / privilege / sidebar / module / config / route additions — Batch 7 only added test infrastructure (B7.1 + B7.3), FE error / advisory rendering (B7.2 + B7.4), and closing-commit cross-refs in docs (B7.5).

## Sanity check on resume

```powershell
git -C "C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification" status --short
# expect: empty

git -C "C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification" log --oneline -8
# expect (top-down):
#   <amended HEAD SHA>   B7.5: final doc sync after Batch 7 (server-side / online-quality run closed)  (this commit; resolve SHA via `git rev-parse HEAD`)
#   1d6ec6b   B7.4: render equipmentGroupSyncWarning advisory on operator pages
#   0b2821f   B7.3: vitest unit tests for getCurrentState() L1+L2 invariants
#   7a2f3b4   B7.2: handle BLOCK_CHANGE_REQUIRED 409 in equipment-dialog + PM auto-start flows
#   1ab2a05   B7.1: stand up apps/web vitest + diffSnapshots() regression suite
#   a42fa54   docs: L4 audit closed -- advance() reading validation path is correct, no code change
#   d7026ce   feat(filter-operations): L3 -- equipmentGroupSyncWarning on getCurrentState
#   63101d5   feat(filter-operations): L2 -- getCurrentState renders cycle-pinned cleaning profile pipeline

git -C "C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification" rev-list --count origin/docsCleaned..HEAD
# expect: 82

# Verify origin still in sync (should be 0 — feature branch was fully pushed at the close of B7.5):
git -C "C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification" rev-list --count origin/feature/phase5-verification..HEAD
# expect: 0

# Counts spot-check (should match the 8 above):
grep -cE "^model " apps/api/prisma/schema.prisma                  # 69
grep -cE "^enum "  apps/api/prisma/schema.prisma                  # 23
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts  # 106
grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts   # 81
ls apps/api/src/modules/                       | wc -l            # 36
ls apps/api/src/modules/config/defs/*.def.ts   | wc -l            # 30
ls apps/web/src/routes/config/*.tsx            | wc -l            # 27
grep -cE "<Route" apps/web/src/main.tsx                           # 82
```

If any of those don't match, don't proceed — investigate first.

## What this multi-session run covered (newest → oldest)

The audit + plan that opened this run is `tasks/SERVER-ONLINE-WORKLIST.md` (5 server-side / online items L1-L5 + a stand-alone L6 vitest setup), followed by the Batch 7 plan at `tasks/PLAN-2026-05-02-batch7-online-quality.md` (5 follow-up tasks B7.1-B7.5). Strict server-side / online-only — no tablet, android, APK touch.

### Server-side worklist (L1 → L6)

| Item | Final commit | Summary |
|---|---|---|
| **L1** | `dbce282` | `getCurrentState()` returns the pinned `EquipmentGroupVersion.snapshot` when `cycle.equipmentGroupVersionPin` is set; lazy-first-version (`pin === live.version` and no archived row yet) and legacy null-pin paths preserved. Closes the only actively-biting online drift surface — operator's tablet now sees the same operating ranges the server validates against. |
| **L2** | `63101d5` | Same pinned-snapshot semantics extended to the `pipelineGraph` / `pipelineStages` fields. `getProfilePipeline()` now reads from `currentCycle.profileId` when a cycle is in progress; falls back to live `resolveFilterProfile()` only for the pre-cycle preview. Operator no longer sees a stage layout that doesn't match what `advance()` enforces. |
| **L3** | `d7026ce` (server) + `1d6ec6b` (FE in B7.4) | New advisory field `equipmentGroupSyncWarning` on the `getCurrentState()` response — symmetric to the existing `profileSyncWarning`. Fires when `cycle.equipmentGroupVersionPin !== null` AND the live group's `version > pin`. Carries `{ groupId, pinnedVersion, liveVersion, recommendation: 'CONTINUE_OR_TERMINATE_AND_RESTART' }`. Read-only — operator is *not* blocked. FE rendering closed in B7.4. |
| **L4** | `a42fa54` — NO CHANGE | Defense-in-depth audit of `advance()` reading-validation snapshot/lazy/legacy paths. Finding: instrument IDs are stable across edits because `equipment-groups.service.ts:163-178` updates by id rather than replace. `instrumentReadings[inst.id]` lookups stay correct under all three branches. Auto-bind at submit is race-free in the synchronous online flow. Narrow offline-batch case is exactly Slice B's territory — out of scope. |
| **L5** | OPEN | Manual browser smoke of the Version History page on a live cycle. Never run in this worktree (no seeded data). Carry over to next session if the user wants visual verification. |
| **L6** | `1ab2a05` (B7.1) | `apps/web` vitest setup — see B7.1 below. |

### Batch 7 follow-ups (B7.1 → B7.5)

| Task | Final commit | Summary |
|---|---|---|
| **B7.1** | `1ab2a05` | New `apps/web/vitest.config.ts` (jsdom env, fresh `defineConfig` from `vitest/config` — intentionally NOT derived from `vite.config.ts` because it loads HTTPS certs at module load and registers VitePWA / Tailwind plugins that explode under unit-test runners). New `apps/web/src/test-setup.ts` (jest-dom matcher registration). `vitest.workspace.ts` extended (touchpoint not in original spec; flagged in commit body — without it, `npm test` at root would skip the new project). DevDeps `vitest`, `jsdom`, `@testing-library/{react,jest-dom}` + `test`/`test:watch` scripts. New 10-test suite at `apps/web/src/routes/version-history/__tests__/diff.test.ts` covering each branch of `diffSnapshots()` — scalar change, keyed-array add/remove/recursive change, set-style add/remove, meta-field filtering, no-change deep-equal, plus checklist-profile + equipment-group cross-kind cases. Minimal `export` of `diffSnapshots`/`DiffChange`/`EntityKind` from `routes/version-history/index.tsx`; no runtime change. Verification: `npx vitest run` → 10/10; `tsc --noEmit` exit 0. |
| **B7.2** | `7a2f3b4` | `BLOCK_CHANGE_REQUIRED` 409 now pops the structured block-change modal on **all four** previously-unguarded `start-cycle`/`start-and-advance` catch sites: mobile `handleEquipSubmit` (~1245), desktop `handleEquipmentSubmit` single (~1283) + batch (~1232), and the desktop **PM auto-start loop** (~721 — the only one without an inner try/catch; reviewer-fix iteration). Closure-stale `if (!blockChangeDialog)` guards inside sync `for/await` loops replaced with local `blockChangePopped` flags so the modal pops once on first hit and other items continue. `&& !blockChangePopped` symmetric guards added on post-loop `setPopupError` calls so the generic toast doesn't fire when the structured modal is already up. No API change — `validateBlockChange()` already emits the right shape. Full audit of every catch site recorded in CHANGELOG entry. |
| **B7.3** | `0b2821f` | New `apps/api/src/modules/filter-operations/__tests__/get-current-state.test.ts` — 7 tests across 2 describe groups. **L1 group**: case 1 — pin + snapshot exists → snapshot returned (live-row stub poisoned to make a regression that reads it instead fail loudly); case 2 — pin + no snapshot + `live.version === pin` → live returned, no warn; case 3 — pin + no snapshot + `live.version !== pin` → live returned + single `console.warn` carrying pin/groupId/cycleId; case 4 — null pin (legacy) → live returned, `equipmentGroupVersion.findUnique` NEVER called (negative assertion); case 5 — no cycle group → block-fallback live group returned. **L2 group**: case 6 — cycle's `profileId !== resolvedLiveProfileId` → `getProfilePipeline` called with the cycle's `profileId`; case 7 control — pre-cycle path → live binding rendered. Mocks prisma à la `instance.service.test.ts`; spies on private `getProfilePipeline` after instance construction. No production-code change beyond the new test file. |
| **B7.4** | `1d6ec6b` | Amber persistent advisory card on both `mobile-operations.tsx` and `filter-operations.tsx` when the API returns non-null `equipmentGroupSyncWarning`. State set after each `getCurrentState` fetch and cleared in: `goHome`, `openStage`, `closeDialog`, `clearScanState`, the URL-stage-sync `useEffect`, `handleBlockSelect`, both desktop `onChangeBlock` handlers, the mobile in-place block-chip "Change" button, and `performTask`. Reviewer Issue #1 (intra-stage state leak when operator changes block within the same stage) closed in fix iteration. Visual: `bg-amber-50 border-amber-200 text-amber-800` — distinct from the red error banner so operator sees both at once if both fire; persistent (no auto-clear timer). Recommendation `CONTINUE_OR_TERMINATE_AND_RESTART` — non-blocking. |
| **B7.5** | (this commit) | Doc + handover sync. Worklist marked DONE with closing-commit cross-refs; "Status snapshot" + "Deferred follow-ups" sections added. Plan file got an "Outcome" section. CHANGELOG got a top-level batch-summary entry above the 4 per-task entries. `tasks/todo.md` got audit-log entries for L1-L4 + B7.1-B7.5. This resume note created. Live-count regex sweep re-run — all 8 counts unchanged from Batch 6 baseline. |

## Current state map (across the multi-session run)

### Phase 5b Path A (universal versioning rollout) — ✅ COMPLETE (closed earlier in the run; carrying forward)

| Phase | Target | Pattern | Commit |
|---|---|---|---|
| A.1 | ChecklistProfile + questions | Sidecar + cycle pin | (older) |
| A.2 | FilterCleaningProfile | Rowful immutable + lineageId | `4bc9d34` |
| A.3 | FilterProfile | Sidecar (no cycle pin needed) | `a818f58` |
| A.4 | EquipmentGroup composite | Sidecar | `6affffc` |
| A.4 | Cleaning reasons | No code (already pinned) | `6affffc` |
| P1 | EquipmentGroup cycle pinning | `cleaning_cycles.equipmentGroupVersionPin Int?` | `1581c6b` |

### Operator-visible drift surfaces — ✅ ALL CLOSED (server-side run L1-L4 + Batch 7)

| Surface | Was | Now |
|---|---|---|
| Reading-range validation against pinned snapshot | Closed at P1 — `advance()` reads from `EquipmentGroupVersion.snapshot.instruments[]` when pin is set. | (unchanged in B7) |
| `getCurrentState()` returns pinned EquipmentGroup ranges | Live ranges (drift) | Pinned snapshot (L1) |
| `getCurrentState()` returns pinned profile pipeline | Live binding (drift) | Cycle-pinned (L2) |
| Operator gets advisory when admin edits group mid-cycle | Silent | API field (L3) + amber card on mobile + desktop (B7.4) |
| `advance()` reading-validation IDs match `instrumentReadings` keys | Audited (L4) — IDs stable across edits, no risk | (no change) |
| `getCurrentState()` regression coverage | Zero (no `__tests__` folder) | 7 unit tests (B7.3) |
| `diffSnapshots()` regression coverage | Zero (no FE test setup) | 10 unit tests + vitest infra (B7.1) |
| `BLOCK_CHANGE_REQUIRED` 409 actionable on equipment-dialog + PM auto-start | Generic toast (gap) | Structured modal everywhere (B7.2) |

### 9-step architectural refactor (carrying forward — Batch 7 did not touch any item)

| # | Item | Status |
|---|---|---|
| 1 | templateKind enum → admin-editable lookup | ✅ DONE 2026-04-30 |
| 2 | relationshipType enum + bidirectional check | ✅ DONE 2026-05-01 |
| 3 | AssetInstance.organizationId NOT NULL | ❌ OBSOLETE (MT removal) |
| 4 | applicableTemplates JSONB → join table | ✅ DONE 2026-05-02 (`e857fea` + `08799d1`) |
| 5 | Investigate two checklist systems | ✅ NO-OP 2026-04-30 |
| 6 | FilterDetails 1:1 split | ✅ DONE 2026-05-01 |
| 7 | Multi-version pipeline rollout (per-block) | ❌ DEPRIORITIZED (per user) |
| 8 | Decision-tape architecture | ⏳ pending — touches APK rebuild — out of scope per user |
| 9 | Cycle as event fold | ⏳ blocked on #8 |

## Bug-fixes caught + resolved during this run (deep-fix per CLAUDE.md)

1. **Latent FK bug** — `filter-operations.service.ts:877` storing FilterProfile id into `cleaning_cycles.profile_id` (FKs to FilterCleaningProfile id). Masked since no FilterDetails-bound cycle had ever run. Fixed inline in `1581c6b`.
2. **`ConflictError` couldn't carry structured details** — pre-existing API limitation. Extended in Batch 6 (`d31ed37`).
3. **`template.service.test.ts` hermeticity** — Step 4's first cut hit prisma directly from a mocked-repo test. Refactored to go through the repo layer in `08799d1`.
4. **Doc count drift** — 9 stale references caught in Batch 6 sweep; all bumped.
5. **Em-dash chars in PS scripts** — broke PS 5.1 tokenization. Caught by AST parser; replaced with `--`.
6. **Closure-stale guards inside sync `for/await` loops** — found in B7.2 reviewer fix; React doesn't flush state between iterations of a sync loop, so the closure-captured `blockChangeDialog` is always the entry-time value. Replaced with local `blockChangePopped` flag pattern in B7.2's loops.
7. **Intra-stage state leak on block-change** — found in B7.4 reviewer Issue #1; advisory was not cleared when operator changed block within the same stage screen. Fixed in B7.4 fix iteration by adding `setEquipmentGroupSyncWarning(null)` to all stage-transition / block-change paths.

## Skipped per user direction (do not pick up without explicit re-approval)

- **Slice B — offline-version-sync contract for tablet** (`expected<Entity>Version` + 409 SCHEMA_DRIFT + tablet self-heal flow). Documented in `future/offline-version-sync-contract.md`. Touches APK rebuild + tablet QA. After L1 the primary motivation evaporated for the *online* path; offline replay still needs it.
- **Step 8 (decision-tape) + Step 9 (cycle-as-event-fold)** — same reason; APK rebuild + 2-4 week scope.
- **Step 7 (per-block versioned profiles)** — explicitly deprioritized; pharma SOPs require uniform recipe.

## Deferred follow-ups (recorded; do not pick up without re-approval)

- **B7.2 reviewer M1** — pre-existing `advanceBatch:422` closure-stale guard (`if (!blockChangeDialog)` inside a sync `for/await` loop) in `apps/web/src/routes/filter-management/filter-operations.tsx`. Cosmetically identical risk profile to the four sites fixed in B7.2 but **not a B7-introduced regression** — this guard predates Batch 7. Track as cleanup; same `blockChangePopped` local-flag pattern applies.
- **B7.4 reviewer Issue #2** — `DryingFiltersPanel`'s 15s SWR poller in `apps/web/src/routes/mobile/mobile-operations.tsx` (and the desktop mirror) does not consume the `equipmentGroupSyncWarning` field. The panel polls `/current-state` every 15s for in-progress DRY_IN cycles but only uses the dryer-countdown shape. An admin who edits the EquipmentGroup while the operator is parked on the DRY_IN screen would not see the advisory until they scan the next filter. Documented in B7.4's CHANGELOG entry as a "known limit". Defer until either CHVH-style chip rendering on the panel or a wider DRY_IN panel refactor lands.
- **L5** — manual browser smoke of Version History on a live cycle (no seeded data in this worktree).

## Next-session checklist

1. **Sanity check** — the four commands at top of this note. Branch is fully pushed; the origin-sync check should report `0`.

2. **What's actually pending** (sorted by readiness):

   **Ready, no design call:**
   - **None left from the L1-L5 + B7.1-B7.5 worklist.** Everything in the planned scope is closed.

   **Possible follow-ups, only if the user re-asks:**
   - **L5 browser smoke** — half hour once data is seeded.
   - **B7.2 M1 cleanup** — `advanceBatch:422` closure-stale guard. ~30 min including the same local-flag fix + a single regression test if FE state-leak coverage grows.
   - **B7.4 Issue #2** — DryingFiltersPanel poller advisory rendering. ~1-2h depending on whether the user wants amber-card or chip.
   - **Real cycle replay test for P1** — start a cycle on a profile with a real pipeline graph, edit the equipment group operating-range mid-cycle, advance through WASH_IN with a reading at the boundary. Heavy setup (~1-2h).
   - **MEMORY.md** review — the claude-mem folder at `C:\Users\hello\.claude\projects\C--Users-hello-21cfrlogbook-DigitalFMS\memory\` may benefit from new entries based on Batch 7 (closure-stale loops, vitest workspace extension, intra-stage state leaks).

   **Skipped per user (re-confirm before reviving):**
   - Slice B (`future/offline-version-sync-contract.md`).
   - Step 8 (decision-tape).
   - Step 9.
   - Step 7.

## File-by-file state of new things added in Batch 7

| File | Status | Notes |
|---|---|---|
| `apps/web/vitest.config.ts` | NEW (B7.1) | jsdom env, fresh `defineConfig` from `vitest/config`, NOT derived from `vite.config.ts`. |
| `apps/web/src/test-setup.ts` | NEW (B7.1) | `@testing-library/jest-dom/vitest` matcher registration. |
| `apps/web/src/routes/version-history/__tests__/diff.test.ts` | NEW (B7.1) | 10 tests against `diffSnapshots()`. |
| `apps/web/src/routes/version-history/index.tsx` | M (B7.1) | Three `export` keyword additions; no runtime change. |
| `apps/web/package.json` | M (B7.1) | `vitest`, `jsdom`, `@testing-library/{react,jest-dom}` devDeps + `test`/`test:watch` scripts. |
| `vitest.workspace.ts` | M (B7.1) | Added `apps/web/vitest.config.ts` to workspace. |
| `apps/web/CLAUDE.md` | M (B7.1) | Testing section added. |
| `apps/web/src/routes/mobile/mobile-operations.tsx` | M (B7.2 + B7.4) | `BLOCK_CHANGE_REQUIRED` 409 catch in `handleEquipSubmit`; `equipmentGroupSyncWarning` state + render + clear paths. |
| `apps/web/src/routes/filter-management/filter-operations.tsx` | M (B7.2 + B7.4) | Same plus desktop PM auto-start loop fix; advisory render + clear paths on every block-change site. |
| `apps/api/src/modules/filter-operations/__tests__/get-current-state.test.ts` | NEW (B7.3) | 7 vitest unit tests covering L1+L2 invariants. |
| `tasks/SERVER-ONLINE-WORKLIST.md` | M (this commit) | All items marked DONE with closing-commit cross-refs; status snapshot + deferred follow-ups added. |
| `tasks/PLAN-2026-05-02-batch7-online-quality.md` | M (this commit) | Outcome section appended. |
| `tasks/RESUME-STATE-2026-05-02-batch7.md` | NEW (this commit) | This note. |
| `CHANGELOG.md` | M (every B7 task) | Top-level batch summary above the four per-task `[Unreleased]` entries (this commit). |
| `tasks/todo.md` | M (this commit) | L1-L4 + B7.1-B7.5 audit-log entries appended. |

## Network constraint — RESOLVED at this commit

GitHub `github.com:443` was unreachable for 6 consecutive sessions through Batch 6 (carried forward as a known constraint). The network cleared at the close of B7.5: `feature/phase5-verification` was pushed to origin (matching local HEAD), shipping the full backlog (Batches 4-7 plus the B7.5 doc-sync amendment). Local and remote are in lockstep — 0 ahead, 0 behind. No further push action required at session start; the sanity-check origin-sync command at the top of this note will confirm.

## Memory entries that may be worth adding (not yet written)

- `feedback_closure_stale_for_await_loops` — React does not flush state between iterations of a sync `for/await` loop; the closure-captured value is always entry-time. Use a local flag (e.g. `blockChangePopped`) when you need "set on first hit only" semantics inside a loop. Caught in B7.2.
- `feedback_vitest_workspace_extension_required` — when adding a new vitest project under a workspace-driven monorepo, the project's `vitest.config.ts` must be added to the root `vitest.workspace.ts`; otherwise `npm test` skips it. Caught in B7.1.
- `feedback_intra_stage_state_leak` — FE component state set after a fetch must be cleared in EVERY transition path (block change, stage transition, dialog close, scan clear, URL sync), not just the obvious ones. Caught in B7.4 reviewer iteration.
- `project_l1_l4_b7_complete_2026_05_02` — server-side / online-quality run closed: all operator-visible drift surfaces (L1, L2, L3) closed; defense-in-depth audit (L4) found no risk; test infrastructure (L6 / B7.1, B7.3) covers the diff engine + L1+L2 invariants; structured 409 UX (B7.2) and amber advisory (B7.4) round out the FE.

(Decide whether to write these on resume, or after the push lands.)

---

Recorded 2026-05-02 at the close of B7.5. Self-contained — anyone resuming should be able to pick up cold from sanity-check + push attempt without reading anything else.
