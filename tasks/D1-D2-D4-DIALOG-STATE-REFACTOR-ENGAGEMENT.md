# D1/D2/D4 — Filter-Operations Dialog State Machine Refactor

**Status:** Scheduled engagement, not started
**Created:** 2026-05-17
**Estimated effort:** 3–5 engineer-days, plus 1–2 days QA
**Owner:** Unassigned — schedule with the next operator-facing UI-capable engineer
**Branch:** Start a fresh branch from `RFID` after commit `ec1fcb8` (or successor)
**Scaffold already in place:** `apps/web/src/lib/filter-ops/dialog-state.ts` + tests

---

## 1. The deliverable in one sentence

Lift `apps/web/src/routes/mobile/mobile-operations.tsx` (2490 lines) and
`apps/web/src/routes/filter-management/filter-operations.tsx` (1766 lines)
onto a single `useFilterOperationsCore()` hook whose `DialogState` tagged
union is the sole source of truth for "which dialog is open", so the type
system rejects the imperative `setChecklistDialog` / `setEquipDialog` /
`setReasonDialog` clobber-races that cause "wrong checklist position" bugs.

## 2. Why this engagement exists

From `tasks/STRICT-AUDIT-2026-05-16.md` lineage and the 2026-05-17 deep
code review of `mobile-operations.tsx`. Three defects bundled because
they share one root cause:

- **D1** — Six independent "should I open the checklist dialog?" call
  sites (three per page × two pages) calling `resolvePendingChecklistDialog`
  with inconsistent inputs. No enforced invariant.
- **D2** — Cache row holds three storage shapes for "what comes next":
  `pendingChecklist[]`, `nextAllowedStages[]`, `actions[]`. They can
  disagree because writes update them separately.
- **D4** — ~30 useState hooks per mobile page, no state machine. Each
  dialog has its own open flag + form data + clear logic scattered
  across the file. Race between setChecklistDialog / setEquipDialog /
  close effects.

The full review is in the conversation history of session 2026-05-17.
Quick-fix defects (D3 + D6) and verification-only defects (D5 + D7)
already landed in commit `<add-after-this-commit>`.

## 3. Acceptance criteria

A reviewer should be able to confirm ALL of these before merging:

1. **No imperative dialog setters in page files.** Grep returns 0 hits
   for `setChecklistDialog(` / `setEquipDialog(` / `setReasonDialog(`
   / `setDryerDialog(` / `setBlockChangeDialog(` in both
   `mobile-operations.tsx` and `filter-operations.tsx`. All transitions
   go through the hook's `dispatch(...)`.

2. **Cache row schema collapsed.** `CachedFilterState` in
   `apps/web/src/lib/offline-cache.ts` holds ONLY `{ actions[],
   currentCycle, profile, equipmentGroup, stageLookup, pipelineGraph,
   pipelineStages, homeBlock, blockChangeStatus, isPmDue, pmReasonKey }`.
   Fields removed: `pendingChecklist[]`, `nextAllowedStages[]`. Add a
   one-time migration in `offline-store.ts` that drops these keys from
   existing IDB rows on schema-version bump (avoid orphan keys
   confusing the loader).

3. **`local-context.ts:466` no longer reads `pendingChecklist`.**
   `CHECKLIST_COMPLETED` synthesis derives from action history, not
   from cache field mutation.

4. **Action tape is the sole tape-of-truth.** All gate decisions in
   both pages route through `actions[]`. No fallback reads of the
   legacy fields. The `validateOfflineGate` helper at
   `lib/filter-ops/validate-offline-gate.ts` takes `actions[]`-only
   inputs; the `hasPendingChecklist` parameter is computed by the
   caller via `hasActionKind(actions, 'SUBMIT_CHECKLIST')`.

5. **All tests in `lib/filter-ops/__tests__/dialog-state.test.ts`
   still pass** plus the page-component tests asserting:
   - "Scanning a filter with pending checklist opens checklist dialog,
     then submitting it transitions to none, then advance to next stage
     re-opens checklist dialog if the next stage also has a CHECKLIST node."
   - "Equipment dialog cannot open while checklist dialog is open
     (transition error surfaced as operator toast)."
   - "Batch checklist queue: 3 filters with pending checklists, all 3
     dialogs surface in sequence, none silently skipped."

6. **Zero new failures in the API suite** (baseline as of merge).

7. **Manual QA on the APK**: operator can complete a full cycle
   (WASH_IN → CHECKLIST → WASH_OUT → DRY_IN → DRY_OUT → STORAGE_IN)
   offline and online without any "checklist appeared at wrong time"
   or "dialog stuck" symptoms. Manual scan + advance × 5 filters in
   sequence on both tablet and desktop.

## 4. Day-by-day phasing

### Day 1 — Hook scaffold (no page changes yet)

- New file `apps/web/src/lib/filter-ops/use-core.ts`:
  ```ts
  export function useFilterOperationsCore(filterId?: string) {
    const [dialogState, dispatch] = useReducer(reduceDialogState, { kind: 'none' });
    const { online, executeOrQueue, ... } = useOffline();
    const reauth = useReauth();
    // Returns: { dialogState, dispatch, handlers: { startCycle, advance,
    //   submitChecklist, bypass, terminate, setReason, submitReadings, ... } }
  }
  ```
- The handlers wrap `executeOrQueue` + `reauth.execute` + the shared
  filter-ops lib calls. Each handler dispatches the appropriate dialog
  transition.
- New test file `lib/filter-ops/__tests__/use-core.test.ts` — exercise
  the hook with React Testing Library + mocked dependencies.
- **Gate:** the hook compiles, dialog-state tests still pass, no page
  files touched.

### Day 2 — Cache row schema collapse

- Read every consumer of `pendingChecklist` and `nextAllowedStages`.
  Likely sites: `local-context.ts`, `validate-offline-gate.ts`,
  `resolve-pending-checklist.ts`, `offline-cache.ts`, both page files.
- Replace each consumer with the `actions[]` equivalent.
- Drop the fields from `CachedFilterState`. Add an IDB migration that
  removes the keys from existing cache rows on schema bump.
- Update `cacheServerStateResponse` and `recomputeAndCacheFilterState`
  to no longer write the legacy fields.
- **Gate:** `lib/__tests__/local-context.test.ts`,
  `lib/__tests__/offline-store.test.ts`,
  `lib/__tests__/offline-cache.test.ts` all pass. Tape-derived gate
  produces identical decisions to the pre-fix legacy-field reads (add
  parity tests as needed).

### Day 3 — Mobile page migration

- Replace `mobile-operations.tsx`'s 30+ useState calls with one
  `useFilterOperationsCore()` call.
- All `setXxxDialog(...)` sites become `dispatch({ type: 'open_xxx', ... })`.
- The handler bodies (handleSubmit, handleSubmitQueue, handleReasonSubmit,
  handleEquipSubmit, handleChecklistSubmit, handleDryerSubmit) move into
  the hook OR become thin shims that call `core.handlers.xxx(...)`.
- Per-page UI (the dialog JSX, the scan input, the recent-ops list)
  stays — only the orchestration moves.
- **Gate:** APK builds, mobile-operations tsc clean, manual smoke on
  tablet: scan, start cycle, advance through 2 stages, submit checklist,
  advance to END. Offline mode: same flow with wifi off.

### Day 4 — Desktop page migration

- Same as Day 3 but for `filter-operations.tsx`.
- Reuses the same hook; no duplicate logic.
- Special attention to `handleSubmitBatch` and `advanceBatch` — the
  batch continuation queue lives in `dialogState.remainingBatch` now,
  not in a separate `postAdvanceChecklistQueue` useState.
- **Gate:** desktop tsc clean, web build clean, manual smoke in browser:
  same flow as Day 3.

### Day 5 — QA + cleanup

- End-to-end manual run on tablet AND browser of the 7 acceptance
  criteria above.
- Delete dead code: the deleted useState declarations, the obsolete
  per-page wrapper functions (`updateOfflineState`,
  `updateCachedStateAfterAdvance` — both already deprecated by D3 fix
  but their bodies become inlined dispatches in the hook),
  `postAdvanceChecklistQueue` slot, etc.
- Update memory: `feedback_unified_tablet_web.md` —
  "Both pages now share `useFilterOperationsCore()`; orchestration
  cannot drift because the dialog state machine is in one place."
- Add new memory: `project_dialog_state_machine_2026_05_xx.md`
  documenting the new architecture for future agents.
- **Gate:** all acceptance criteria checked.

## 5. Files to touch

### New (3 files)
- `apps/web/src/lib/filter-ops/use-core.ts` — the hook
- `apps/web/src/lib/filter-ops/__tests__/use-core.test.ts`
- `apps/web/src/lib/filter-ops/__tests__/page-integration.test.tsx` —
  RTL test driving the actual page components

### Modified — high-volume (2 files, ~50% of lines)
- `apps/web/src/routes/mobile/mobile-operations.tsx`
- `apps/web/src/routes/filter-management/filter-operations.tsx`

### Modified — medium (5 files)
- `apps/web/src/lib/offline-cache.ts` — drop legacy fields from
  `CachedFilterState`, update writer
- `apps/web/src/lib/local-context.ts` — replace `pendingChecklist` read
- `apps/web/src/lib/filter-ops/validate-offline-gate.ts` — accept
  `actions[]` only
- `apps/web/src/lib/filter-ops/resolve-pending-checklist.ts` — derive
  from tape exclusively
- `apps/web/src/lib/offline-store.ts` — schema version bump + migration

### Modified — low (~5 files)
- `apps/web/src/lib/filter-ops/index.ts` — export the new hook + types
- `apps/web/src/lib/filter-ops/dialog-state.ts` — extend if new
  transitions are needed during migration
- `apps/web/src/hooks/use-offline.ts` — `recomputeAndCacheFilterState`
  caller may need adjustment
- Test files that mock `CachedFilterState` (existing fixtures)
- `CHANGELOG.md` + `apps/web/CLAUDE.md` doc updates

## 6. Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Operator-visible behavior change between old + new orchestration | High | Phase 3 + 4 must do per-flow manual QA before moving to the next. Acceptance criterion 7 is non-negotiable. |
| Mobile-only batch-state preload path becomes inconsistent with hook | Medium | The hook owns the cache writes. Batch-state preload calls `cacheServerStateResponse` directly — no orchestration change needed. Verify in Phase 2. |
| Offline cache schema migration data loss | Medium | IDB migration drops only the unused legacy fields, not the row. Operator's queued mutations are untouched. Add a backup-snapshot step before bump if paranoid. |
| Reauth dialog double-fire if hook + page both wrap `reauth.execute` | Low | Hook owns reauth wrapping; page never calls `reauth.execute` directly. Audit grep on Day 3 + 4. |
| Type errors cascade across the 4256-line surface | High | Day 1 + 2 land before any page change. Use git worktree per phase so each day is independently revertable. |
| 21 CFR Part 11 checklist enforcement regression | Critical | Property test on Day 5: generate random profile graphs with random CHECKLIST node placements, assert dialog sequence matches graph sequence. |

## 7. Rollback strategy

Each Day is a separate commit. Before starting, tag the pre-engagement
state: `git tag pre-dialog-state-refactor`. Days 1–2 are non-breaking
(additive scaffolding + cache schema migration). Days 3–4 break
backward-compat with the existing page state shape — these must be
behind a feature flag or rolled as a single deploy.

Recommended: `git revert` per day if a regression surfaces; full
`git reset --hard pre-dialog-state-refactor` if a fundamental design
flaw is found mid-engagement.

## 8. Sign-off requirements

- **Compliance:** 21 CFR Part 11 — confirm the property test in §7 risk
  table is in place before merging.
- **QA:** manual e2e on tablet + browser per acceptance criterion 7.
- **Operator stakeholder:** at least one cleanroom operator (or
  supervisor) signs off on the manual e2e session.

## 9. Out of scope for this engagement

- Server-side actions[] emission (`TAPE_PARALLEL=true`) — separate Wave.
- AssetInstance / AssetTemplate removal — separate ongoing Wave 4+ work
  (see `tasks/ENTITY-REMOVAL-IMPACT-ANALYSIS.md`).
- Permission rename `ASSET_*` → `BLOCK_*`/`AREA_*`/`AHU_*`/`FILTER_*`
  — wait for Wave 5+ cutover.
- Mobile-wrapper 6-view shell rewrite — outside filter-operations scope.

## 10. Scaffold already in place

The contract is locked. The next engineer starts here, not from scratch:

- `apps/web/src/lib/filter-ops/dialog-state.ts` — `DialogState` tagged
  union + `reduceDialogState` reducer (invariant-enforcing) +
  `deriveDialogKindFromTape` stub. 95 lines.
- `apps/web/src/lib/filter-ops/__tests__/dialog-state.test.ts` — 12
  passing tests asserting legal/illegal transitions.

Begin Day 1 by writing `use-core.ts` against this scaffold. The
reducer's `throw` calls will catch any illegal dispatch during
migration, surfacing drift early.
