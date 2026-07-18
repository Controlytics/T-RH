# Plan — Step 8: Decision-tape architecture (full)

**Branch:** `feature/phase5-verification` (current HEAD `f72c7ab`)
**Owner:** controller (subagent-driven-development)
**Scope:** server tape generator + FE renderer rewrite + offline replay + APK rebuild
**User auth (2026-05-02):** "do change tab code or offline code also accordingly. deeply fix with proper testing." Tablet/APK ban LIFTED for this work.
**Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`

## Why phased

Step 8 is atomic in one sense (the contract changes) but the implementation has natural cutover points. Five phases:

| # | Phase | Risk | Cutover |
|---|---|---|---|
| **8.0** | Server tape generator + feature flag + parallel validation | Low — additive, flag default OFF | None — both paths active |
| **8.1** | FE action-renderer skeleton (action-type → component dispatch) | Low — new file, no consumers yet | None |
| **8.2** | Per-action-type renderers (advance / submit-checklist / submit-readings / set-dryer-duration / bypass / terminate) | Medium — many UI surfaces | None — old UI still active |
| **8.3** | Offline replay tape-versioning + sync engine update | Medium — touches IndexedDB schema | None |
| **8.4** | Cutover: feature flag flips ON, FE consumes tape, old graph-walking removed | **HIGH** — breaking | One-shot cutover; `git revert` is rollback |
| **8.5** | APK rebuild + tablet field QA + production rollout | Coordination only | Tablet release |

Each phase ships independently with full test coverage. Cutover is **only at 8.4** — until then both paths run side-by-side.

## Phase 8.0 — Server tape generator (this batch)

### Goal

A new module `apps/api/src/modules/filter-operations/tape/` that consumes the same inputs `getCurrentState()` reads (cycle, pinned profile, pinned equipment group, filter events, checklist pins) and returns an `ActionTape: { state, actions: Action[], tapeVersion }` structure. The current `getCurrentState()` is **unchanged**; the tape is exposed as an additional response field gated by an env flag (`TAPE_PARALLEL=true`).

A parallel-validation harness runs the tape generator against every fixture the existing test suite has and asserts that the generated actions match the existing `nextAllowedStages` / `pendingChecklist` / button-enable invariants byte-for-byte.

### Touchpoints

- **NEW** `apps/api/src/modules/filter-operations/tape/types.ts` — `Action`, `ActionTape`, `ActionKind` types.
- **NEW** `apps/api/src/modules/filter-operations/tape/tape-generator.ts` — pure function `generateTape(input: TapeInput): ActionTape`. Input is the resolved cycle state + pinned profile + pinned equipment group + filter events + checklist pins (i.e., everything `getCurrentState()` already gathers). Output is the action list.
- **NEW** `apps/api/src/modules/filter-operations/tape/__tests__/tape-generator.test.ts` — vitest unit tests covering the 7 action types listed below + edge cases (cycle complete, pending checklist, dryer not ready, no equipment group bound, etc.).
- **EDIT** `apps/api/src/modules/filter-operations/filter-operations.service.ts:579-679` — at the end of `getCurrentState()`, if `process.env.TAPE_PARALLEL === 'true'`, call `generateTape(...)` and include `actions` + `tapeVersion` in the response. Otherwise omit. **Do NOT remove the existing fields.**
- **EDIT** `apps/api/src/modules/filter-operations/routes.ts:51-100` — extend the response schema (additive properties for `actions`, `tapeVersion`) so Fastify doesn't strip them. Default `additionalProperties: true` should already allow it; verify.
- **EDIT** `CHANGELOG.md` — top entry for 8.0.

### Action types for v1

7 action types matching the existing operator surface:

1. **`ADVANCE_TO_STAGE`** — params `{ targetState, requiresInstrumentReadings?: string[] }`. Validations: instrument readings required for stages with WASH_IN/DRY_IN instruments.
2. **`SUBMIT_CHECKLIST`** — params `{ checklistProfileId, versionPin, afterStage }`. Validations: returns the question list inline so the FE doesn't need a separate fetch.
3. **`SUBMIT_DRYER_READINGS`** — params `{ instrumentIds }`. Validations: `dryerStartedAt + halfDuration` must elapse; readings must satisfy operating ranges from pinned snapshot.
4. **`SET_DRYER_DURATION`** — params `{ minRange, maxRange }`. Only when `targetState === 'DRY_IN'` and dryer not yet started.
5. **`BYPASS_STAGE`** — params `{ targetState }`. Requires `requiresJustification: true, minLength: 10`.
6. **`TERMINATE_CYCLE`** — params `{}`. Requires `requiresJustification: true`.
7. **`COMPLETE_CYCLE`** — emitted when next stage leads to END. Server auto-advances on accept; FE just shows the button.

For v1, **no** action types for retire / replace / RFID-scan / batch-flow — those stay on the existing routes. We're only modeling the in-cycle-stage-advance surface.

### Tape input shape

```ts
interface TapeInput {
  cycle: CleaningCycle | null;
  filter: { id, currentLifecycleState };
  pinnedProfile: FilterCleaningProfile | null;  // resolved from cycle.profileId
  pinnedEquipmentGroup: { snapshot: ... } | null;  // L1: snapshot or live based on pin
  pinnedChecklistProfiles: Map<profileId, version>;  // A.1
  recentChecklistEvents: FilterEvent[];  // for "is this stage's checklist done?"
  dryerState: { startedAt, durationMinutes, readingsSubmitted };
}
```

The tape generator is a **pure function** — no I/O, no side effects, no prisma. Same input always produces same output. This is the property that makes it testable and that lets us cache it offline.

### Output shape

```ts
interface ActionTape {
  state: string;  // current cycle state ('WASH_IN' / 'DRY_IN' / etc.)
  actions: Action[];
  tapeVersion: number;  // monotonic per-cycle, derived from FilterEvent count + cycle.profileVersion
  // Future fields (Phase 8.4+): "blockedBy" — explanation when actions list is empty
}

type Action =
  | { type: 'ADVANCE_TO_STAGE'; label: string; params: { targetState: string; requiresInstrumentReadings?: string[] }; validations: { ... } }
  | { type: 'SUBMIT_CHECKLIST'; label: string; params: { checklistProfileId; versionPin; questions: Question[] }; blocking: true }
  | { type: 'SUBMIT_DRYER_READINGS'; label: string; params: { instrumentIds: string[] }; validations: { halfDurationMs, operatingRanges } }
  | { type: 'SET_DRYER_DURATION'; label: string; params: { minMinutes; maxMinutes } }
  | { type: 'BYPASS_STAGE'; label: string; params: { targetState }; requiresJustification: true }
  | { type: 'TERMINATE_CYCLE'; label: string; requiresJustification: true }
  | { type: 'COMPLETE_CYCLE'; label: string };
```

### Parallel-validation harness

A second test file `tape-parity.test.ts` that:
1. Sets up the same fixture data the existing `getCurrentState()` tests use (or fixtures from `B7.3 get-current-state.test.ts`).
2. Calls `getCurrentState()` (gets old shape).
3. Calls `generateTape()` with the same inputs (gets new shape).
4. Asserts: every `nextAllowedStage` in the old response corresponds to an `ADVANCE_TO_STAGE` action in the tape with matching `targetState`. Every `pendingChecklist` entry corresponds to a `SUBMIT_CHECKLIST` action with matching `checklistProfileId + versionPin`. Etc.
5. The harness IS the regression-test gate for Phase 8.4 cutover. If parity holds across all fixtures, we can flip the flag with confidence.

### Acceptance criteria for Phase 8.0

- New tape module exists with 7 action types modeled.
- Pure-function tape generator (no I/O).
- ≥15 unit tests in `tape-generator.test.ts` covering each action type's emit conditions + edge cases.
- ≥6 parity tests in `tape-parity.test.ts` proving tape ⊇ existing shape on representative fixtures.
- `TAPE_PARALLEL=true` env flag adds `actions` + `tapeVersion` to `getCurrentState()` response without breaking existing fields.
- Default flag is OFF — existing behavior unchanged in production.
- `tsc --noEmit` clean.
- `vitest run` for `apps/api/src/modules/filter-operations` passes (B7.3's 7 tests + new ones).
- Full apps/api vitest suite still passes (modulo the 2 known pre-existing e2e failures).

### Out of scope for Phase 8.0

- FE consumption of the tape (Phase 8.1+).
- Offline replay (Phase 8.3).
- Removing existing fields from `getCurrentState()` (Phase 8.4 cutover).
- APK changes (Phase 8.5).

## Phase 8.0 review follow-ups (deferred from approval — not blockers)

Recorded by code-quality reviewer on commit `1889289`. None blocked Phase 8.0 approval but each gets folded into a later phase.

- **M1 ✅ closed in 8.2 (2026-05-02):** BYPASS_STAGE emit-set expanded to every pipeline `STAGE` node except the current state, matching the server's `bypass()` route validation (`filter-operations.service.ts:1548-1556`). Step-back targets (earlier pipeline stages) are now emitted. 3 tape-generator tests added (21–23) covering 4-stage forward set, step-back, and fresh-cycle edge cases.
- **M3 (defer to 8.4 cutover):** `tapeVersion = profileVersion * 1000 + filterEventCount`. Collides if `filterEventCount >= 1000`. Implausible in practice (cycles have dozens of events) but worth tightening before cutover. Options: `BigInt`, or `(profileVersion << 32) | eventCount`. Pick when 8.4 is scoped.
- **M4 ✅ closed in 8.1 (2026-05-02):** added `beforeEach(() => { nextId = 0; })` inside the `generateTape()` describe block. Defense-in-depth — the helpers already reset on entry — but makes the file safe under `test.concurrent`.
- **M6 ✅ closed in 8.1 (2026-05-02):** service.ts flag-on block now reads recent CHECKLIST_COMPLETED events + total event count via `Promise.all([...])`. One less DB round-trip when the flag is on; behaviorally identical.

## Phase 8.1 ✅ DONE — FE action-renderer skeleton + shared types + M4/M6 (2026-05-02)

Three parts shipped in one batch:

### Part (a) — Action-tape types extracted to `@digilog/shared`

- **NEW** `packages/shared/src/types/action-tape.ts` (lifted from `apps/api/src/modules/filter-operations/tape/types.ts`).
- **EDIT** `packages/shared/src/index.ts` re-exports the 21 action-tape types.
- **EDIT** `apps/api/src/modules/filter-operations/tape/types.ts` reduced to a re-export shim (`export type { ... } from '@digilog/shared'`) so server-side imports of `./types.js` continue to resolve unchanged. Picked the shim over deleting the file because deletion would force three additional unrelated edits to update import paths in `tape-generator.ts`, `tape-generator.test.ts`, and `filter-operations.service.ts:13` for purely cosmetic gain. The shim is one line of indirection the typechecker sees through and the bundler tree-shakes (purely `export type`).

### Part (b) — FE action-renderer skeleton (stubs only — no live consumers)

- **NEW** `apps/web/src/lib/action-tape/types.ts` — convenience re-export of shared types so action-tape FE imports stay co-located with renderer code.
- **NEW** `apps/web/src/lib/action-tape/ActionRenderer.tsx` — top-level dispatcher that takes one `Action` + `onSubmit` callback, switches on `action.type`, and renders the right child stub. Owns `useState` for in-flight `loading`; passes `disabled` to the active child during the pending submit. Honors a caller-provided `disabled` prop. Includes an `ActionTapeRenderer` convenience wrapper that takes the whole `actions[]` and shares a loading-lock across siblings (one click disables the rest until settled). Exhaustiveness guard via `_exhaustive: never`.
- **NEW** `apps/web/src/lib/action-tape/components/base-action-button.tsx` — visual primitive with 4 variants (primary / success / warning / danger).
- **NEW** 7 stub action components in `apps/web/src/lib/action-tape/components/`:
  - `AdvanceToStageButton.tsx` (primary)
  - `SubmitChecklistButton.tsx` (primary)
  - `SubmitDryerReadingsButton.tsx` (primary)
  - `SetDryerDurationButton.tsx` (primary)
  - `BypassStageButton.tsx` (warning)
  - `TerminateCycleButton.tsx` (danger)
  - `CompleteCycleButton.tsx` (success)
- **NEW** `apps/web/src/lib/action-tape/__tests__/ActionRenderer.test.tsx` — 11 tests: 7 per-type dispatch cases, 1 caller-disabled case, 1 in-flight loading case (deferred-resolve promise), 2 `ActionTapeRenderer` cases (shared loading-lock + empty-state slot).

### Part (c) — M4 + M6 closures (see above)

### Verification (Phase 8.1)

- `cd packages/shared && npx tsc` → builds new artifacts.
- `cd apps/api && npx tsc --noEmit` → exit 0.
- `cd apps/web && npx tsc --noEmit` → exit 0.
- `cd apps/api && npx vitest run src/modules/filter-operations` → 3 files, 35 tests pass.
- `cd apps/web && npx vitest run` → 2 files, 21 tests pass (B7.1's 10 + B8.1's 11).

### Out of scope (Phase 8.1)

- FE consumption of the tape — Phase 8.4 cutover.
- Per-action-type full UI (dialogs, forms, validation rendering, countdown gates) — Phase 8.2.
- Offline replay tape-versioning — Phase 8.3.
- APK changes — Phase 8.5.

## Phase 8.2 ✅ DONE — full per-action-type renderers + M1 closure (2026-05-02)

Replaced the 7 Phase-8.1 stub renderers with full-functionality components (dialogs / validation / typed payloads) and closed M1.

### Part (a) — Full renderers + shared dialog primitive

- **NEW** `apps/web/src/lib/action-tape/components/action-dialog.tsx` — shared modal primitive for the 4 dialog-bearing renderers. Light theme, gradient header, role="dialog" + aria-modal, backdrop-click dismiss, primary/success/warning/danger header+submit variants.
- **EDIT** `apps/web/src/lib/action-tape/ActionRenderer.tsx` — child contract changed from `onClick: () => void` to `onSubmit: (payload: ActionPayload) => Promise<void>`. New `ActionPayload` discriminated union mirrors what each server route accepts so Phase 8.4 cutover can plug the dispatcher into existing routes without translation.
- **EDIT** all 7 components: `CompleteCycleButton` (immediate submit, no dialog), `AdvanceToStageButton` (immediate when no readings, dialog when `requiresInstrumentReadings` non-empty), `BypassStageButton` (justification dialog, amber/warning), `TerminateCycleButton` (justification dialog, red/danger), `SetDryerDurationButton` (min/max number inputs, `1 ≤ min ≤ max ≤ 1440`), `SubmitDryerReadingsButton` (one numeric input per instrument id), `SubmitChecklistButton` (YES/NO/N/A radios + optional remarks per question, required-question gate).

### Part (b) — Tests

- **EDIT** `apps/web/src/lib/action-tape/__tests__/ActionRenderer.test.tsx` — 11 → **33 tests**. Covers per-type dispatch, immediate-submit, dialog-flow validation (justification min-length, required questions, dryer min/max bounds), readings-input numeric coercion, loading lock under the new contract, and 3 close-on-success / stay-open-on-error tests.

### Dialog UX — close on success, stay open on error

All 5 dialog renderers `await onSubmit(...)` and use try/catch:
- On resolve → close dialog + reset form state.
- On reject → keep dialog open + surface parent error inside the dialog (operator can fix and retry without losing context).

### Part (c) — M1 follow-up

- **EDIT** `apps/api/src/modules/filter-operations/tape/tape-generator.ts` — BYPASS emit-set now covers every pipeline `STAGE` node except current state. Matches the server's `bypass()` route validation surface.
- **EDIT** `apps/api/src/modules/filter-operations/tape/__tests__/tape-generator.test.ts` — 20 → **23 tests** (added 21–23 for 4-stage bypass set, step-back, fresh-cycle).

### Verification (Phase 8.2)

- `cd packages/shared && npx tsc` → exit 0 (untouched).
- `cd apps/api && npx tsc -p tsconfig.json --noEmit` → exit 0.
- `cd apps/web && npx tsc --noEmit` → exit 0.
- `cd apps/api && npx vitest run src/modules/filter-operations` → 3 files, 38 tests pass.
- `cd apps/web && npx vitest run` → 2 files, 43 tests pass.

### Out of scope (Phase 8.2)

- FE consumption of the tape — Phase 8.4 cutover.
- Offline replay tape-versioning — Phase 8.3.
- APK changes — Phase 8.5.

## Phase 8.3-8.5

Skip detail until 8.2 ships.

## Standing rules

- List all touchpoints before editing.
- Test all touchpoints after.
- Find root causes; deep-fix bugs caught even if out of scope.
- No silent test bypass.
- Commit after each task with full message + push.
- Implementer subagents follow TDD where the task says "write a test first."
