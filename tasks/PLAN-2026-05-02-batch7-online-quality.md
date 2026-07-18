# Plan — Batch 7: server-side online-quality follow-ups (2026-05-02)

**Owner:** controller (subagent-driven-development)
**Branch:** `feature/phase5-verification` (already on origin; HEAD `a42fa54`)
**Constraint:** server-side / online-only per user direction. NO tablet/android/APK touch. NO offline replay logic changes.
**Working directory:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`

## Why this plan

L1-L5 closed the operator-visible drift surfaces uncovered in the audit. Batch 7 is the next layer of online-quality polish — none of these are biting users today, but each closes a real architectural gap or test-coverage hole that would bite us later. Each task is a clean, scoped piece of work that maps well to a subagent dispatch with two-stage review.

## Scope and tasks

Tasks are sequenced for safety: setup first (test infrastructure), then code-quality fixes, then additive features. No two tasks edit the same file region simultaneously.

---

### Task B7.1 — Vitest setup for `apps/web` + first regression test

**Goal:** Stand up `apps/web` Vitest config and write the first real regression test against `apps/web/src/routes/version-history/index.tsx` — specifically the `diffSnapshots()` engine added in VHv3 (`d31ed37`). Today that engine has zero coverage; a regression in the diff logic would silently break the Version History UI.

**Why this first:** every later FE task will benefit from being able to write FE unit tests. Sets up the foundation.

**Touchpoints (must list before editing):**
- `apps/web/package.json` — add `vitest`, `@vitest/ui` (optional), `jsdom`, `@testing-library/react`, `@testing-library/jest-dom` to devDependencies. Add `"test": "vitest run"` and `"test:watch": "vitest"` scripts.
- New `apps/web/vitest.config.ts` — vite-config-derived, `environment: 'jsdom'`, alias config that mirrors existing tsconfig path aliases (`@`, `@digilog/shared`).
- New `apps/web/src/test-setup.ts` — sets up `@testing-library/jest-dom` matchers.
- New `apps/web/src/routes/version-history/__tests__/diff.test.ts` — extracts `diffSnapshots()` and helper utilities into pure functions if needed (or imports them via `export` from `index.tsx`); covers: scalar change, keyed array add/remove/change, set-style field add/remove, meta-field filtering, no-change case.
- `apps/web/src/routes/version-history/index.tsx` — minimal change: `export` the diff utilities so they're test-importable. Don't restructure.
- `apps/web/CLAUDE.md` — add a brief "Testing" section pointing at the new commands.
- `tasks/SERVER-ONLINE-WORKLIST.md` — mark L6 ✅ DONE.
- `CHANGELOG.md` — new `[Unreleased]` entry.

**Acceptance criteria:**
- `cd apps/web && npx vitest run` exits 0.
- At least 6 `it` blocks in `diff.test.ts` covering each diff branch.
- `apps/web/package.json#scripts.test` runs the suite.
- `tsc --noEmit` in `apps/web` still exit 0.
- No change to runtime behavior of the Version History page.

**Out of scope:**
- Don't add tests for any other FE file in this task. Keep the scope tight — the goal is infrastructure + one regression suite, not coverage push.

---

### Task B7.2 — Apply the structured-409 pattern (S4UX shape) to the `BLOCK_CHANGE_REQUIRED` 409

**Goal:** `validateBlockChange()` in `filter-operations.service.ts:192-217` already returns a structured `details` payload (`{filterId, homeBlockId, homeBlockName, requestedBlockId, requestedBlockName}`) on its 409. But `mobile-operations.tsx` and `filter-operations.tsx` currently render this as a string toast — same UX gap S4UX fixed for `TEMPLATE_IN_USE`.

**Why:** Symmetrical fix. Operators today get a one-line toast; they should see "this filter belongs to Block X, but you tried to clean it in Block Y. Request approval to clean here." with a button that deep-links to the block-change request page.

**Touchpoints:**
- `apps/web/src/lib/api-client.ts:67` already maps `err.details → err.connectionInfo`. Confirm with grep — should not need editing.
- `apps/web/src/routes/mobile/mobile-operations.tsx` — find where `BLOCK_CHANGE_REQUIRED` errors are caught (they currently fall through to the generic error handling). Add a structured render path mirroring S4UX's shape: detect `err.code === 'BLOCK_CHANGE_REQUIRED'`, read `err.connectionInfo`, render an inline card with the block names and a "Request approval" link.
- `apps/web/src/routes/filter-management/filter-operations.tsx` — same change in the desktop equivalent.
- Find which route the "Request approval" link should target — search for `block-change-request` routes in `apps/web/src/main.tsx`.
- `CHANGELOG.md` — entry.

**Acceptance criteria:**
- Triggering a `BLOCK_CHANGE_REQUIRED` 409 (curl test: filter in Block A, attempt to clean in Block B without approval) renders a structured card on both desktop + mobile pages.
- Card carries home block name, requested block name, and a deep-link to the block-change-request creation flow.
- Existing functionality unchanged for non-409 paths.
- `tsc --noEmit` clean for both web and api.

**Out of scope:**
- Don't refactor the generic error handler. Add the new branch alongside.
- Don't change the API response shape — server already emits the right structure.

---

### Task B7.3 — Server-side test for `getCurrentState()` snapshot/live/legacy paths (L1+L2 regression)

**Goal:** L1 + L2 changed `getCurrentState()` to return cycle-pinned data instead of live data. We verified end-to-end via curl, but there's no automated test asserting these paths stay correct. A future refactor could silently regress L1 (returning live group again) and we wouldn't notice until an operator complained.

**Why:** Cheap insurance. The `filter-operations.service.ts` module has zero unit tests today (verified by grep — no `__tests__` folder exists for the module). Adding the L1+L2 invariants is the highest-value first test.

**Touchpoints:**
- New `apps/api/src/modules/filter-operations/__tests__/get-current-state.test.ts` — vitest unit test. Mocks prisma à la `template.service.test.ts` (uses `vi.hoisted` + `vi.mock`).
- Test cases:
  1. Pin set + snapshot row exists → returned `equipmentGroup` matches snapshot fields, `version === pin`.
  2. Pin set + no snapshot row + live.version === pin → returned `equipmentGroup` matches live row.
  3. Pin set + no snapshot row + live.version !== pin → returned live row + warns to console.
  4. Pin null (legacy) → returned `equipmentGroup` matches live row.
  5. No cycle group at all → block-fallback live group returned.
  6. L2: `currentCycle.profileId !== resolvedProfileId` → `getProfilePipeline` called with the cycle's profileId, NOT the resolved live one.
- Possibly extract `resolveEquipmentGroupForResponse()` and `resolveProfileForRender()` helpers into a small module if `getCurrentState()` is too large to test in one shot — but ONLY if needed. Don't refactor for refactor's sake.
- `CHANGELOG.md` — entry.

**Acceptance criteria:**
- `cd apps/api && npx vitest run src/modules/filter-operations` exits 0 with at least 6 tests passing.
- Each test case above is asserted explicitly.
- Existing 14 vitest files in `apps/api` continue to pass.
- No production code change beyond minimal `export` if helpers need extraction.

**Out of scope:**
- Don't add tests for `advance()`, `start-cycle`, etc. — single-method coverage push for L1+L2 only.
- Don't run integration tests; vitest mocks are sufficient.

---

### Task B7.4 — `equipmentGroupSyncWarning` FE rendering (operator-facing)

**Goal:** L3 added the field on the API response but no FE consumer reads it. Operator gets no signal today that admin edited their pinned group mid-cycle. Render an inline yellow advisory on `mobile-operations.tsx` and `filter-operations.tsx` when the warning is present.

**Why:** Closes the L3 advisory loop end-to-end. Read-only — operator can dismiss; functional behavior unchanged.

**Touchpoints:**
- `apps/web/src/routes/mobile/mobile-operations.tsx` — locate the existing `profileSyncWarning` render block (around line 921 per the audit). Add a sibling render for `equipmentGroupSyncWarning`. Different copy: "Equipment group has been updated by admin (you started on v{pin}, current is v{live}). Your readings will continue to validate against the version you started with — terminate-and-restart only if you need the new ranges."
- `apps/web/src/routes/filter-management/filter-operations.tsx` — same change.
- `apps/web/src/types/filter.ts` — add the field to a relevant type if it has a `CurrentStateResponse` interface; or just type as `any` access at the call site if no shared type exists. Don't add a type just for this.
- `CHANGELOG.md` — entry.

**Acceptance criteria:**
- When the API returns a non-null `equipmentGroupSyncWarning`, both pages show a yellow advisory card with copy as above.
- When null, no card.
- `tsc --noEmit` clean.

**Out of scope:**
- Don't add a "View pinned snapshot" button (that's CHVH territory; the chips are already there on the cycle timeline page).
- Don't change the warning's recommendation semantics.

---

### Task B7.5 — Doc + handover sync after batch 7

**Goal:** Final sweep after B7.1-B7.4 land. Mark items DONE in the worklist, update active doc-set counts if anything moved, fresh resume note.

**Touchpoints:**
- `tasks/SERVER-ONLINE-WORKLIST.md` — mark L6 ✅ DONE (B7.1 closes it).
- `tasks/PLAN-2026-05-02-batch7-online-quality.md` (this file) — append a "## Outcome" section at end.
- `tasks/RESUME-STATE-2026-05-02-batch7.md` — new resume note covering everything from L1 → B7.4.
- `CHANGELOG.md` — already has per-task entries; add a top-level batch summary above them.
- Live-count regex sweep: probably unchanged (no new model / permission / sidebar item / route in this batch). Verify.
- `tasks/todo.md` — audit-log entries.

**Acceptance criteria:**
- Working tree clean after this task.
- Resume note self-contained (anyone can pick up cold).
- Final commit pushed to origin.

---

## Sequencing

B7.1 → B7.2 → B7.3 → B7.4 → B7.5. Strict order — each task may rely on infrastructure or context from the previous. No parallelization.

## Out of scope for batch 7 (do NOT pick up)

- Anything tablet/android/APK.
- Slice B (offline-version-sync contract for tablet).
- Step 8 (decision-tape) / Step 9 (cycle-as-event-fold).
- Step 7 (per-block versioned profiles) — explicitly deprioritized.
- Refactoring `filter-operations.service.ts` beyond what B7.3 minimally requires.

## Standing rules (from CLAUDE.md)

- List all touchpoints before editing.
- Test all touchpoints after.
- Find root causes; deep-fix bugs caught in any task even if out of scope.
- Run tsc + restart service + smoke `/health` after every API change.
- No silent test bypass / no commented-out assertions / no swallowed exceptions.
- Implementer subagents follow TDD where the task says "write a test first."

---

## Outcome (recorded 2026-05-02 at B7.5 close)

All five Batch 7 tasks landed on `feature/phase5-verification`. Sequencing was strict B7.1 → B7.5 as planned; no parallelization, no scope creep into tablet/android/APK territory.

| Task | Status | Final commit | Summary |
|---|---|---|---|
| **B7.1** — Vitest setup for `apps/web` + first regression test | DONE | `1ab2a05` | New `apps/web/vitest.config.ts` (jsdom, fresh defineConfig — intentionally NOT derived from `vite.config.ts`), `src/test-setup.ts`, `vitest.workspace.ts` extension, devDeps (`vitest`, `jsdom`, `@testing-library/{react,jest-dom}`), `test`/`test:watch` scripts. New 10-test `diffSnapshots()` regression suite at `apps/web/src/routes/version-history/__tests__/diff.test.ts`. Closes L6. |
| **B7.2** — `BLOCK_CHANGE_REQUIRED` 409 handling on equipment-dialog + PM auto-start flows | DONE | `7a2f3b4` | Four catch sites that delegated to a generic toast now pop the existing structured block-change modal: mobile `handleEquipSubmit`, desktop `handleEquipmentSubmit` (single + batch), and the previously-unguarded desktop **PM auto-start loop**. Closure-stale `if (!blockChangeDialog)` replaced with local `blockChangePopped` flags inside loops to ensure the modal pops once on first hit and other items continue. No API change — `validateBlockChange()` already emits the right shape. |
| **B7.3** — vitest unit test for `getCurrentState()` L1+L2 invariants | DONE | `0b2821f` | New `apps/api/src/modules/filter-operations/__tests__/get-current-state.test.ts` — 7 tests across 2 describe groups asserting all five L1 paths (snapshot hit, lazy-first-version live fallback, divergent-live defensive log, legacy null-pin live, no-cycle-group block-fallback) plus L2 cycle-pinned profile pipeline (positive + control). Mocks prisma directly per the canonical pattern in `instance.service.test.ts`. No production-code change beyond the new test file. |
| **B7.4** — `equipmentGroupSyncWarning` FE rendering on operator pages | DONE | `1d6ec6b` | Amber persistent advisory card on both `mobile-operations.tsx` and `filter-operations.tsx`, rendered when the API field is non-null. State set after each `getCurrentState` fetch and cleared in all stage-transition / block-change / scan-clear paths (reviewer Issue #1 fix). Distinct from the red error banner so operator can see both at once. Recommendation `CONTINUE_OR_TERMINATE_AND_RESTART` — non-blocking. |
| **B7.5** — Doc + handover sync after Batch 7 | DONE | (this commit) | Worklist marked DONE with closing-commit cross-refs; "Status snapshot" + "Deferred follow-ups" sections added. Plan file gets this Outcome section. New `tasks/RESUME-STATE-2026-05-02-batch7.md` (self-contained — full L1→B7.4 history). Top-level CHANGELOG batch-summary entry inserted above the four per-task entries. `tasks/todo.md` audit-log entries for all four B7.x commits. |

### Live counts re-verified at B7.5

```
69 Prisma models, 23 enums                       (unchanged from Batch 6)
106 permissions, 90 feature privileges,
  81 reauth actions, 26 sidebar items            (unchanged)
36 API modules, 30 config defs, 27 config pages  (unchanged)
82 frontend <Route> defs in apps/web/src/main.tsx (unchanged)
```

Batch 7 was correctly invariant on all eight tracked counts — no new schema/perm/route/sidebar additions, only test infrastructure + FE error/advisory rendering + closing-commit cross-references in docs.

### Out-of-scope items deferred (do not pick up without explicit re-approval)

- **B7.2 M1** — pre-existing closure-stale guard in `advanceBatch:422` (cosmetic; not a B7-introduced regression).
- **B7.4 Issue #2** — `DryingFiltersPanel`'s 15s SWR poller does not surface the new advisory.
- **L5** — manual browser smoke of Version History on a live cycle (no seeded data in this worktree).
- Slice B (offline-version-sync contract for tablet) — APK rebuild required.
- Step 8 (decision-tape) / Step 9 (cycle-as-event-fold).
- Step 7 (per-block versioned profiles) — explicitly deprioritized.
