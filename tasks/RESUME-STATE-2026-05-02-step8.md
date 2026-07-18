# Resume State — Step 8 Decision-Tape Architecture (2026-05-02)

Self-contained resume note. Read this and you have everything needed to pick up.

## Where we are

**Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`
**Branch:** `feature/phase5-verification`
**HEAD:** advances after 8.6 (was `4873a7b` at end of 8.5; 8.6 added 4 commits `6653416 95b4575 e190415 <commit-4-sha>`).
**Working tree:** clean.

## Step 8 phase status

| Phase | Status | Commit | Pushed |
|---|---|---|---|
| 8.0 — Server tape generator + TAPE_PARALLEL flag | DONE | `fe79997` | YES |
| 8.1 — FE action-renderer skeleton + shared types + M4/M6 | DONE | `6c257a3` | YES |
| 8.2 — Full per-action-type renderers + ActionDialog + M1 fix | DONE | `5a6b5c4` | YES |
| 8.3 — Offline replay tape-versioning | DONE | `723799b..42c6afc` (5 commits) | YES |
| 8.4 Commit 1 — bundle 8.3 deferred fixes (I-1 + I-3 + M-3 + M3 formula) | DONE | `2af9100` | NO |
| 8.4 — Local-cache foundation (Option D Phase 1) | DONE | `a6ec6e8 e5f46cb 996d1c1 0e0e2b7 f63207c 3c7c916 98b5b3a 3c61a3b` (8 commits) | NO |
| 8.5 — Shared executor extraction | DONE | `0c8c159..4873a7b` (10 commits incl. extraction `4873a7b`, fixtures `ff10952`, prep audits `0c8c159 da756ea 64dc469 d9f52ab 2981d93 e26d4b5 8796859 115dddd`) | NO |
| 8.6 — FE consumes shared executor | **DONE** | `6653416 95b4575 e190415 099225c dc52910 1fc3e7b 85ae3e1` (7 commits incl. part 2) | YES (origin/feature/phase5-verification) |
| 8.7 — Cutover & cleanup | **DONE** (2026-05-03) | `1033aca d31f5d2 1fa84b5 2521aad f8fae1d 73a5f44 28e574c` (7 commits, 9-agent parallel dispatch) | NO |
| 8.8 — APK rebuild + tablet field QA | PENDING (`tasks/PLAN-2026-05-02-step8.8-apk-field-qa.md` plan ready, needs physical tablets) | — | — |

## What 8.6 shipped

Wired the FE — both mobile and desktop filter-operations pages — to consume the shared executor that landed in 8.5. **No app-visible behaviour changed**; the same gates fire, the same dialogs open, the offline cache shape is preserved. The 4 commits:

- **`6653416`** — `apps/web/src/lib/local-context.ts` (FE-side `loadLocalContextFromCache(filterId)` mirroring the server's prisma loader). Reads from IDB v5 sync stores + the legacy `filter-state-{filterId}` blob + `localStorage.digilog_cached_user`. Synthesizes a single `CHECKLIST_COMPLETED` event when the cached `pendingChecklist === []` AND the profile has a CHECKLIST node after `currentState` (so the executor's gate doesn't re-fire after the operator already cleared it offline). 14 unit tests covering sentinel fallbacks, the three events-synthesis branches, equipment-group projection, server-stageLookup priority, cached-user reading, and end-to-end with `computeNextActions`.
- **`95b4575`** — `mobile-operations.tsx` switch. Converts the bodies of `computeNextStages()` and `findChecklistsAfterStage()` to delegate to `sharedFindReachable()` / `sharedCollectChecklistsAfterStage()`. Tier-1 stageLookup branches preserved (server-authoritative). File delta 2486 → 2456 (-30). The deeper helpers `validateOfflineGate`, `buildOfflineChecklist`, `updateOfflineState` transitively call the converted helpers, so shared executor parity flows through every gate decision in the mobile flow.
- **`e190415`** — `filter-operations.tsx` (desktop) switch. Same pattern as mobile. Side benefit: the legacy desktop `findChecklistsAfterStage` only inspected direct outConns and silently skipped chained CHECKLIST → CHECKLIST → STAGE pipelines; converting to shared closes that gap on desktop too. File delta 2088 → 2088 (19 ins / 19 del).
- **`<commit-4-sha>`** — `assertProfileActive` fix carried over from 8.5: the guard now enforces both null-check AND `status === 'ACTIVE'`. Drops 2 redundant manual `cp.status !== 'ACTIVE'` checks from `filter-operations.service.ts` (advance + bypass paths). 2 new test cases in `transitions.test.ts`.

### Why bodies were converted, not deleted (per audit)

The original audit promised `-128 lines` via wholesale helper deletion + 6 inline call-site replacements. Per advisor review during 8.6: per-call-site shape contracts are consumed at 5+ places per helper. Rewriting 5 call sites carries more drift risk than redirecting one helper body to shared code, and the helpers transitively cover every gate path. The shared-code redirect achieves the same drift-killing goal (the actual win) at a smaller diff. The deprecated `nextAllowedStages` / `pendingChecklist` cache fields are deliberately preserved — 8.7 cutover removes them.

### Tests delta

- shared: 303 → 305 (+2 for `assertProfileActive` status branches)
- api: 1186/1188 (no change; same 2 pre-existing failures)
- web: 68 → 82 (+14 for `loadLocalContextFromCache`)
- TypeScript: clean across all three packages

## What 8.4 shipped under Option D

The original 8.4 plan (delete the FE graph walker, switch FE to consume `actions[]`) hit a wall on architectural review — the field-bucket audit on `mobile-operations.tsx` (2486 lines) and `filter-operations.tsx` (2088 lines) showed the cutover was a UX redesign + offline-state-machine rewrite, not a wiring change. The plan was rewritten as **Option D** (`tasks/PLAN-2026-05-02-step8-OPTION-D.md`): tablet becomes a versioned local replica of the server's read model for the offline-relevant slice; a shared executor (in `packages/shared/src/pipeline-executor/`) runs the same guard code on both sides. Drift becomes impossible by construction for the 35 pure guards (73% of the audit); the 8 server-only guards (17%) stay server-side and surface their failures via the existing 8.3 STALE_TAPE / clientOpId reconciliation contract.

8.4 = "Local-cache foundation (Option D Phase 1)". What landed across the 8 commits:

- **`3c61a3b`** — Adopted Option D plan in `tasks/PLAN-2026-05-02-step8-OPTION-D.md` (123-line architecture doc, 8.4 → 8.8 phase plan, 8 acceptance criteria).
- **`98b5b3a`** — Phase 8.5 guard inventory `tasks/INVENTORY-2026-05-02-step8.5-guards.md` (281 lines): full enumeration of 48 guards across the 4 write methods (35 P / 5 H / 8 S) with file:line, LocalContext inputs, output shape, and target shared function name. Drives the 8.5 extraction.
- **`f63207c`** — 8.4a: locked down ChecklistProfile snapshot-then-bump with 3 service-layer tests against mocked prisma+tx (lazy first-version, update path, addQuestion path). No schema or migration changes — Phase A.1 already shipped the versioning; this just adds the regression gate that 8.4b's local cache depends on.
- **`a6ec6e8`** — 8.4b commit 1 of 4: server `GET /api/sync/since` endpoint. New `apps/api/src/modules/sync/` module, 4 entity queries (FilterCleaningProfile, FilterProfile, EquipmentGroup, AssetInstance+FilterDetails) running under `Promise.all` with per-entity version cursors, 500-row pagination cap with `hasMore` flag, response schema declares all 6 entity arrays as required (so empty arrays don't get stripped). 16 new tests (13 service, 3 route registration). ChecklistProfile + AssetTemplate intentionally deferred to follow-up (both have version columns; 8.4a finalized the bump triggers in isolation).
- **`e5f46cb`** — 8.4b commit 2 of 4: IDB schema bump 4 → 5. 7 new stores (`syncFilterCleaningProfiles`, `syncFilterProfiles`, `syncEquipmentGroups`, `syncChecklistProfiles`, `syncAssetTemplates`, `syncFilters`, `syncVersionState`). Critical naming choice: new filter store is `syncFilters`, not `filters` — the legacy `filters` store already holds CachedFilter rows in a different shape (used by the offline ops queue). The two are now parallel additive caches; consolidation deferred to 8.5/8.6. New helpers exported: `cacheEntities`, `getCachedEntity`, `getAllCachedEntities`, `getVersionState`, `setVersionState`. 4 new shape tests.
- **`996d1c1`** — 8.4b commit 3 of 4: FE `apps/web/src/lib/sync-since.ts` consumer. `syncSince()` round-trip with single in-flight Promise dedup. `triggerSync(reason)` debounced fire-and-forget (1s coalescing). `startSyncPolling()` wires 60s timer + visibilitychange + online-event handlers, returns idempotent teardown fn. Cursor never goes backward on empty arrays. 12 new tests covering query construction, cursor advance per entity, max-of-watermarks for filters, dedup, debounce coalescing, defensive-empty on malformed responses.
- **`0e0e2b7`** — 8.4b commit 4 of 4: wired `triggerSync('app-start')` + `startSyncPolling()` into `app-layout.tsx` (desktop) and `mobile-wrapper.tsx` (Capacitor). Mobile keeps the legacy `syncAllDataForOffline` path running additively — different cache (v5 sync stores vs. legacy `cache` key/value blobs); the legacy path will be subsumed in 8.6 once the executor lands.
- **`3c7c916`** — 8.4c: scaffolded `packages/shared/src/pipeline-executor/` (10 files, 913 lines). Empty-body skeleton with greppable `NOT_IMPLEMENTED -- pipeline-executor/<module>.<fn> -- Phase 8.5` errors on every stub. LocalContext interface, slice projections (no `@prisma/client` import — shared must stay runtime-agnostic for the FE bundle), 17 stubs across 7 modules + actions/context/types + barrel index.ts. 20 smoke tests (LocalContext compile, every stub throws NOT_IMPLEMENTED, barrel exports expected symbols). Phase 8.5 fills in the bodies.

## How to resume

1. Pull this file open.
2. `git status` — expect clean working tree.
3. `git rev-parse HEAD` should be `4873a7b` or later.
4. **Canonical plan doc:** `tasks/PLAN-2026-05-02-step8-OPTION-D.md`. The original `tasks/PLAN-2026-05-02-step8-decision-tape.md` is superseded but kept for history.
5. **8.5 inventory** (drove the executor extraction): `tasks/INVENTORY-2026-05-02-step8.5-guards.md`.
6. **8.5 / 8.6 / 8.7 / 8.8 prep audits** (all produced by background subagents):
   - `tasks/AUDIT-2026-05-02-filter-operations-desktop.md` — 8.6 desktop FE audit
   - `tasks/AUDIT-2026-05-02-mobile-operations.md` — 8.6 mobile FE audit
   - `tasks/AUDIT-2026-05-02-getcurrentstate-consumers.md` — 8.7 consumer audit
   - `tasks/AUDIT-2026-05-02-concurrent-operator.md` — 8.7 collision audit
   - `tasks/AUDIT-2026-05-02-offline-sync-legacy-deprecation.md` — 8.6 legacy sync deprecation
   - `tasks/AUDIT-2026-05-02-permissions-under-option-d.md` — 8.5 permission/reauth interaction
   - `tasks/MIGRATION-DRIFT-2026-05-02.md` — 8.7 migration-drift remediation plan
   - `tasks/PLAN-2026-05-02-step8.8-apk-field-qa.md` — 8.8 APK + field-QA plan
7. **Test fixtures** for shared executor: `packages/shared/src/pipeline-executor/__tests__/fixtures.ts` (8 LocalContext scenarios) + `fixtures.test.ts`.
8. **Next move = 8.7:** server-side cutover. Remove `nextAllowedStages` + `pendingChecklist` from `getCurrentState()` schema + service return; remove the `TAPE_PARALLEL` flag (always emit `actions[]`); tighten `tapeVersion` to required on cycle-bound writes. FE-side cleanup (deleting deprecated cache reads) follows. Drive from `tasks/AUDIT-2026-05-02-getcurrentstate-consumers.md` (38 mobile + 24 desktop reads listed) and `tasks/MIGRATION-DRIFT-2026-05-02.md`. Legacy `offline-sync-service.ts` deletion is BLOCKED on 4 entities still uncovered by `/api/sync/since` — see `tasks/AUDIT-2026-05-02-offline-sync-legacy-deprecation.md`.

## What 8.0/8.1/8.2 shipped

### 8.0 (commit fe79997, pushed)
- New module `apps/api/src/modules/filter-operations/tape/` with pure-function `generateTape()` + 7 Action types (ADVANCE_TO_STAGE, SUBMIT_CHECKLIST, SUBMIT_DRYER_READINGS, SET_DRYER_DURATION, BYPASS_STAGE, TERMINATE_CYCLE, COMPLETE_CYCLE)
- 20 unit tests + 8 parity tests
- `TAPE_PARALLEL=true` env flag wraps the new fields into `getCurrentState()` response (`actions[]` + `tapeVersion`); default OFF
- Fastify route schema extended at `apps/api/src/modules/filter-operations/routes.ts:96-104`

### 8.1 (commit 6c257a3, pushed)
- **Shared types extracted**: `packages/shared/src/types/action-tape.ts` — server module re-exports from `@digilog/shared` via shim at `apps/api/src/modules/filter-operations/tape/types.ts`
- **FE skeleton**: `apps/web/src/lib/action-tape/` with `ActionRenderer.tsx`, `types.ts`, `components/base-action-button.tsx`, 7 stub components, `ActionTapeRenderer` wrapper
- **11 vitest tests** for the dispatcher
- **M4 fix**: `beforeEach(() => { nextId = 0; })` in `tape-generator.test.ts:114-119`
- **M6 fix**: `Promise.all([findMany, count])` in `filter-operations.service.ts:706-722`

### 8.2 (commit 5a6b5c4, pushed)
- **All 7 stubs replaced with full UIs** — instrument-readings dialog, checklist Q&A dialog, dryer-readings form, set-duration dialog, justification dialogs (BYPASS amber + TERMINATE red), immediate-submit COMPLETE
- **Shared dialog primitive**: `apps/web/src/lib/action-tape/components/action-dialog.tsx` — light theme, role=dialog, gradient header
- **`onSubmit(action, payload)` contract** with discriminated `ActionPayload` union mapping 1:1 to existing route bodies
- **Close-on-success / stay-open-on-error** semantics caught in advisor review
- **CHECKLIST payload** is object-keyed `Record<questionId, value>` (matches server's `INVALID_QUESTIONS` rejection at `filter-operations.service.ts:870-882`)
- **M1 fix**: `tape-generator.ts:298-329` — BYPASS_STAGE emit-set expanded to all pipeline STAGE nodes except current when `flowMode='BYPASS_ENABLED'`. Matches server bypass route at `filter-operations.service.ts:1548-1556`. 3 new tests.
- **Test counts**: api 38 (was 35); web 43 (was 21)

### 8.3 (commits 723799b, b86bef6, e02806d, 7449677, 42c6afc — pushed)
- **`computeTapeVersion(profileVersion, filterEventCount)`** extracted + exported from `tape-generator.ts:364`; called from both the generator (`tapeVersionOf`) and the new service guard. **Single source of truth for the formula** — drift impossible.
- **`assertTapeVersionFresh()`** helper at `filter-operations.service.ts:31-48` throws `AppError(409, 'STALE_TAPE', ..., { currentTapeVersion })`. Wired into all 4 write methods (advance / submitChecklist / bypass / terminateCycle) AFTER clientOpId dedup.
- **Optional** `tapeVersion: integer` on 4 route schemas (`routes.ts:207, 261, 309, 446`) for backward compat with pre-cutover callers in flight. 8.7 will tighten to required.
- **Shared:** `StaleTapeError` interface + barrel re-export.
- **FE api-client:** `(error as any).currentTapeVersion = err.details.currentTapeVersion` lift mirrors existing `attemptsRemaining` pattern.
- **FE offline-store:** `DB_VERSION` 2 -> 3; `tapeVersion?: number | null` on `OfflineOperation`; `queueOperation` defaults to `null` for shape consistency.
- **FE sync-engine:** carries `tapeVersion` only on `CYCLE_BOUND_OPS` ops (start-cycle / start-and-advance excluded). On 409 STALE_TAPE: marks op `failed` (no retry) + user-visible toast.
- **FE ActionRenderer:** `tapeVersion?: number` prop merged into payloads at the dispatcher seam — per-button components untouched. Wrapper `ActionTapeRenderer` plumbs the prop.
- **Tests:** api 1162 -> 1165 (+3 helper, +3 stale-tape service, +3 helper direct); web 43 -> 47 (+4 sync-engine).

### 8.4 Commit 1 (commit 2af9100, NOT pushed)
- **I-1**: removed all 4 `(cycle as any).X` casts in `filter-operations.service.ts`. `profileVersion` and `checklistVersionPins` are real Prisma columns; no cast needed.
- **I-3**: deduped STALE_TAPE toasts per filter per drain in `sync-engine.ts` via a `Set<filterId>` scoped to one drain run.
- **M-3**: tightened `OfflineOperation.tapeVersion` to `number | null`. Bumped IDB version 3 → 4 with `normalizeOpForV4()` migration.
- **M3**: changed tapeVersion formula `*1000` → `*1_000_000` (cap is per-cycle).
- Tests after Commit 1: api 1167; web 52.

## Current test counts (verified 2026-05-02 after 8.5 extraction `4873a7b`)

- **API**: 1186 passing (88 files passed / 2 files failed). The 2 failing files are the same pre-existing unrelated failures (`auth.test.ts > forgot-password`, `config.test.ts > PUT /api/config/action-reauth`) that predate Step 8.
- **Web**: 68 passing (6 files / 6 passed).
- **Shared** (`packages/shared`): 294 passing / 2 failing in `pipeline-executor/__tests__/smoke.test.ts`. The smoke tests assert every stub throws `NOT_IMPLEMENTED`; 8.5 extraction replaced 17 stubs with bodies, so those 2 cases now legitimately fail and the smoke file needs to be retired or rewritten as part of 8.6 wiring. Treated as a tracked follow-up (see below) — do not "fix" by reverting the bodies.
- Delta vs. 8.3 close (api 1165 / web 47): **api +21, web +21** since 8.3 close after 8.4 (+8 commits) + 8.5 prep + extraction.

## Tracked deferred follow-ups

8.3 deferred items (I-1 / I-3 / M-3 / M3) are **all resolved** by 8.4 Commit 1 (`2af9100`).

| ID | Description | Defer to |
|---|---|---|
| **8.4 hybrid-guard server deltas** | The 5 hybrid guards (audit § "Hybrid (H)") have a pure portion that moves to the shared executor and a server-only re-check that stays in `filter-operations.service.ts`. The exact split for each (e.g. STALE_TAPE on submitChecklist L860 vs. advance L1187) needs explicit code structure during 8.5 extraction. | 8.5 |
| **8.4b ChecklistProfile + AssetTemplate hydration in /sync/since** | ✅ CLOSED 2026-05-03 by commit `d31f5d2` (Phase 8.7 wave 1, agent B). Both arrays now populate via the same per-entity-cursor + 500-row pagination pattern as the existing 4 entities. ChecklistProfile rows include `questions` (orderBy sortOrder); AssetTemplate rows pass through verbatim. Tests: 17 service + 3 route = 20 (was 16). | done |
| **8.4 legacy `cache` blob path on mobile-wrapper** | `triggerSync` runs alongside the legacy `syncAllDataForOffline` — two parallel caches. Legacy path is subsumed once executor reads from v5 stores. | 8.6 |
| **8.4 legacy `filters` IDB store** | `syncFilters` (v5) and `filters` (legacy) hold the same domain in different shapes. Consolidate after 8.5/8.6. | 8.6/8.7 |
| **Smoke test drift on shared package** | ✅ CLOSED — was already retired/rewritten in 8.6 part 2. The two failing assertions now correctly target only the 2 intentional stub loaders (`loadLocalContext`, `loadLocalContextFromCache`) whose real impls live in apps/api / apps/web. Verified 2026-05-03: shared 305/306 (1 unrelated pre-existing failure). | done |
| **Server still has duplicate guard bodies** | ✅ CLOSED 2026-05-03 by 8.6 part 2 (`1fc3e7b` deleted graph walkers, helpers redirected to shared) + 8.7 wave 2 (`f8fae1d` removed TAPE_PARALLEL gate so service always uses tape generator). | done |
| **Migration-drift remediation plan** | ✅ CLOSED 2026-05-03 by commit `1033aca` (Phase 8.7 wave 1, agent C). New migration `apps/api/prisma/migrations/20260503162127_capture_schema_vs_db_drift/migration.sql` (467 lines) captures Kind B drift via `prisma migrate diff --script` against a transient shadow DB. Header documents fresh-DB-only constraint + `prisma migrate resolve --applied` workaround for already-populated environments. | done |
| **TAPE_PARALLEL flag still on parallel-validation** | ✅ CLOSED 2026-05-03 by commit `f8fae1d` (Phase 8.7 wave 2, agent F). Flag removed; `actions[]` always emitted. `process.env.TAPE_PARALLEL` references in `apps/api`: 0. `tape-parity.test.ts` rewritten without env-flag setup. | done |
| **`tapeVersion` still optional on 4 write routes** | ✅ CLOSED 2026-05-03 by commit `f8fae1d` (server schema tightened) + commit `28e574c` (Phase 8.7 wave 3, agent H — FE plumbing audited; all 9 cycle-bound caller sites confirmed sending tapeVersion; gaps fixed in `use-offline.ts`, `sync-engine.ts`, `filter-operations.tsx`). | done |
| **`nextAllowedStages` / `pendingChecklist` still in getCurrentState** | ✅ CLOSED 2026-05-03 by commit `f8fae1d` (Phase 8.7 wave 2, agent F). Both fields dropped from `getCurrentState()` response and from the 4 POST write-route response schemas; `actions[]` + `tapeVersion` added to those 4 POST responses (per agent E discovery — they emitted `pendingChecklist` but not `actions[]`). | done |
| **B7.2 M1** | Pre-existing `advanceBatch:422` closure-stale guard | future cleanup |
| **B7.4 #2** | `DryingFiltersPanel` 15s SWR poller doesn't surface `equipmentGroupSyncWarning` | future cleanup |
| **L5** | Browser visual smoke of Version History page | future test pass |

## Phase 8.3 plan (DONE — kept for reference)

**Goal:** Offline replay tape-versioning. IndexedDB queued ops carry the `tapeVersion` they were generated against; sync engine sends it; server validates and returns 409 STALE_TAPE if the tape moved on (e.g., another operator advanced the cycle on a different device).

**Touchpoints (verified before editing):**
- `apps/web/src/lib/offline/` — IndexedDB schema, sync engine, replay logic
- `apps/api/src/modules/filter-operations/filter-operations.service.ts` — advance/submit-checklist/bypass/terminate routes need a `tapeVersion` body field + tapeVersion-check guard
- `apps/api/src/modules/filter-operations/routes.ts` — request schemas need `tapeVersion` field
- `packages/shared/src/types/action-tape.ts` — `StaleTapeError` shape
- `apps/web/src/lib/api-client.ts` — surface 409 STALE_TAPE differently from generic 4xx

**New behavior:**
1. When FE submits an action, include `tapeVersion` from the most recent `getCurrentState()` snapshot in the request body
2. Server compares submitted `tapeVersion` against the freshly-computed one
3. If mismatch → 409 STALE_TAPE with body `{ code: 'STALE_TAPE', currentTapeVersion: number, message: string }`
4. FE on 409 STALE_TAPE: drop the queued op, refetch state, show toast "another operator changed this cycle"
5. Offline IndexedDB: store `tapeVersion` per queued op; replay sends it; STALE_TAPE drops the op without retry

**Acceptance criteria** (all met):
- New tapeVersion field on 4 filter-operations request schemas
- Server-side guard with 409 STALE_TAPE response
- FE state-management updates `tapeVersion` after every successful submit
- Offline IndexedDB schema migration (DB_VERSION 2 -> 3)
- Sync engine sends `tapeVersion` on replay
- Tests: server guard (3+), FE replay drop-on-stale (4+), offline schema migration covered

## Phase 8.4 plan (DONE under Option D — see "What 8.4 shipped" above)

The original (pre-pivot) 8.4 was framed as a HIGH-RISK breaking change: flip TAPE_PARALLEL default ON, wire FE to consume `actions[]`, delete the graph walker, remove old derived response fields. The audit caught that this was a UX redesign + offline-state-machine rewrite, not a wiring change. Replaced with **Option D — local-cache foundation**: versioned local replica + shared executor. The 8 commits above shipped the foundation; the actual TAPE_PARALLEL removal + derived-field cleanup is now scheduled for 8.7.

**Rollback:** `git revert` of the 8.4 commits — 8.0/8.1/8.2/8.3 stay shipped, just keeps both paths active.

## Phase 8.5 plan (DONE — commit `4873a7b`)

Goal: extract the 35 pure guards from `filter-operations.service.ts` into `packages/shared/src/pipeline-executor/`.

- 17 NOT_IMPLEMENTED stubs replaced with bodies derived from the service. Module split per inventory: `transitions.ts` (cycle/profile/target-state guards), `checklist.ts` (schema-drift + answer-shape), `dryer.ts` (SET_DURATION + SUBMIT_READINGS gates), `instruments.ts` (equipment-group + reading validation, with composite `assertAllInstrumentReadings`), `bypass.ts`, `justification.ts` (shared by bypass + terminate), `parameters.ts` (PARAM_CAPTURE block validation + `extractParameterDefs` helper). Source error codes + messages mirrored exactly so server tests + the existing `tape-version-check` test pass unchanged.
- Per-module tests added (`transitions.test.ts`, `checklist.test.ts`, `dryer.test.ts`, etc.) on top of the 8.4c smoke suite.
- The 5 hybrid guards keep their pure portion in the executor and the server-only re-check in `filter-operations.service.ts`. Wiring the service's 4 write methods to `load context → executor.canX(ctx) → 8 server-only guards → transaction` and changing the tape generator to `(ctx) => executor.computeNextActions(ctx)` follows in 8.6/8.7 — the executor is the source of truth from this commit forward, but the service still has its own copies for the moment.

Outstanding (carried into 8.6/8.7):
- Server's 4 write methods importing the shared executor and dropping their duplicated guard bodies.
- Tape generator collapsing to a delegate.
- Round-trip parity test (`server.computeActions(ctx) === executor.computeNextActions(ctx)`).

## Phase 8.6 plan (PENDING)

Goal: FE consumes shared executor.

- `mobile-operations.tsx` + `filter-operations.tsx` build LocalContext from IDB cache
- Render via `executor.computeNextActions(ctx)` directly — no server round-trip needed for online OR offline
- Delete the FE walker, delete `updateOfflineState()`, delete `nextAllowedStages` / `pendingChecklist` derivations
- Stage-card grid stays; each card filters `actions[]` by target stage
- Online still calls `getCurrentState()` to refresh cycle/events but uses local executor for action computation
- Tests: per-component integration test with seeded IDB context

Audits ready: `AUDIT-2026-05-02-filter-operations-desktop.md`, `AUDIT-2026-05-02-mobile-operations.md`, `AUDIT-2026-05-02-offline-sync-legacy-deprecation.md`.

## Phase 8.7 plan (PENDING)

Goal: cutover & cleanup.

- Remove `TAPE_PARALLEL` flag; tape always emitted
- Tighten `tapeVersion` to required on the 4 write routes
- Remove old derived response fields (`nextAllowedStages`, `pendingChecklist`)
- Update `routes.ts` response schemas
- Coordinated full smoke test: online + offline + concurrent-operator scenarios

Audits ready: `AUDIT-2026-05-02-getcurrentstate-consumers.md`, `AUDIT-2026-05-02-concurrent-operator.md`.

## Phase 8.8 plan (LAST — needs physical tablets)

- Rebuild APK with new web bundle: `cd apps/web && npx vite build && cd ../android && npx cap copy android && cd android && ./gradlew assembleDebug`
- Install on real tablet
- Field QA: full cycle (start → wash → dry → terminate; bypass; checklist; offline replay; concurrent-operator collision)
- Coordinated rollout

## Reference reading order

1. This file — orientation
2. `tasks/PLAN-2026-05-02-step8-OPTION-D.md` — canonical plan
3. `tasks/INVENTORY-2026-05-02-step8.5-guards.md` — extraction list
4. `packages/shared/src/types/action-tape.ts` — type contract
5. `packages/shared/src/pipeline-executor/` — shared executor (in progress)
6. `apps/api/src/modules/filter-operations/tape/tape-generator.ts` — server tape
7. `apps/api/src/modules/sync/` — `/api/sync/since` server
8. `apps/web/src/lib/sync-since.ts` + `apps/web/src/lib/offline-store.ts` — FE sync consumer + IDB v5 stores
9. `apps/web/src/lib/action-tape/` — FE renderer module
10. `apps/api/src/modules/filter-operations/filter-operations.service.ts` — service (TAPE_PARALLEL block at L686-791)

## Key constraints (project rules)

- List touchpoints before editing
- Test all touchpoints after
- Find root causes, deep-fix bugs even if out of scope
- No silent test bypass
- Light theme only
- PowerShell on Windows (`npx.cmd`, ASCII only — em-dashes are OK)
- App runs ONLY on local Windows
- Single-tenant (MT was removed 2026-04-30)
- 106 permissions, 90 privileges, 81 reauth, 26 sidebar items, 69 Prisma models, 23 enums (per worktree CLAUDE.md, 2026-05-02 post-Step-1 + MT removal)
- **No Redis dependency** — Phase 2 + Phase 4 of windows-friendly-rewrite removed it. Job queue is graphile-worker; pub/sub is in-process EventEmitter (`apps/api/src/lib/internal-bus.ts`).
