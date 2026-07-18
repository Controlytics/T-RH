/**
 * Pipeline-executor parity tests (Phase 8.5 Commit 4).
 *
 * For each canonical scenario from `fixtures.ts`, call
 * `computeNextActions(ctx)` and assert the resulting `actions[]` carries the
 * action types the inventory says belong to that state. These are not deep
 * snapshots — they assert the SHAPE of the tape (which action types appear,
 * which don't), not exact label strings. Combined with the per-module unit
 * tests (transitions / checklist / dryer / …), they catch executor regressions
 * that change WHICH actions emit per scenario.
 *
 * Note: the `lockedContext` fixture's flowMode='LOCKED' is synthetic — the
 * live schema uses 'STRICT' / 'SEQUENTIAL'. Anything not 'BYPASS_ENABLED'
 * triggers the bypass-forbidden guard, so the fixture's executor output is
 * indistinguishable from a SEQUENTIAL flow at the action-tape level. We
 * include it here to exercise the non-BYPASS branch of the executor.
 */
import { describe, it, expect } from 'vitest';
import {
  bypassEnabledContext,
  dryInActiveContext,
  dryOutAwaitingReadingsContext,
  emptyCycleContext,
  lockedContext,
  midWashContext,
  pendingChecklistContext,
  terminatedContext,
} from './fixtures.js';
import { computeNextActions } from '../actions.js';
import type { ChecklistProfileSlice, LocalContext } from '../index.js';

// Type-narrowing helper — pulls action `type` strings out for set comparisons.
function actionTypes(ctx: LocalContext, options?: { checklistProfilesById?: Map<string, ChecklistProfileSlice> }) {
  const tape = computeNextActions(ctx, options ?? {});
  return {
    types: new Set(tape.actions.map(a => a.type)),
    actions: tape.actions,
    tapeVersion: tape.tapeVersion,
  };
}

describe('pipeline-executor parity (Phase 8.5 Commit 4)', () => {
  // ── Scenario 1: empty cycle (state=NEW) ─────────────────────────────────
  it('emptyCycleContext — no in-progress cycle => no actions', () => {
    const { types, actions, tapeVersion } = actionTypes(emptyCycleContext());
    expect(actions).toHaveLength(0);
    expect(types.size).toBe(0);
    // tapeVersion still computed deterministically.
    expect(typeof tapeVersion).toBe('number');
  });

  // ── Scenario 2: mid-WASH cycle ──────────────────────────────────────────
  it('midWashContext — cycle at WASH_IN should emit ADVANCE_TO_STAGE + TERMINATE_CYCLE', () => {
    const { types, actions } = actionTypes(midWashContext());
    expect(types.has('ADVANCE_TO_STAGE')).toBe(true);
    expect(types.has('TERMINATE_CYCLE')).toBe(true);
    // No checklist pending, no dryer, no completion gate yet.
    expect(types.has('SUBMIT_CHECKLIST')).toBe(false);
    expect(types.has('SET_DRYER_DURATION')).toBe(false);
    expect(types.has('SUBMIT_DRYER_READINGS')).toBe(false);
    expect(types.has('COMPLETE_CYCLE')).toBe(false);
    // Specifically: the only ADVANCE target from WASH_IN is WASH_OUT.
    const advance = actions.find(a => a.type === 'ADVANCE_TO_STAGE');
    expect(advance).toBeDefined();
    if (advance && advance.type === 'ADVANCE_TO_STAGE') {
      expect(advance.params.targetState).toBe('WASH_OUT');
    }
  });

  // ── Scenario 3: pending checklist gate ─────────────────────────────────
  it('pendingChecklistContext — pending CHECKLIST blocks advance, emits SUBMIT_CHECKLIST + TERMINATE_CYCLE', () => {
    // Provide a populated checklistProfilesById (so the SUBMIT_CHECKLIST emits).
    const fixture = pendingChecklistContext();
    const checklistProfilesById = new Map<string, ChecklistProfileSlice>([
      ['cl-prof-1', {
        id: 'cl-prof-1',
        name: 'Post-Wash Verification',
        isActive: true,
        version: 2,
        questions: [
          {
            id: 'q-1',
            question: 'Drain valve closed?',
            questionType: 'YES_NO',
            required: true,
            section: 'Pre-checks',
            description: null,
            options: [],
            validation: {},
            sortOrder: 0,
          },
        ],
      }],
    ]);
    const { types } = actionTypes(fixture, { checklistProfilesById });
    expect(types.has('SUBMIT_CHECKLIST')).toBe(true);
    expect(types.has('TERMINATE_CYCLE')).toBe(true);
    // Critically: ADVANCE_TO_STAGE must NOT appear while checklist is pending.
    expect(types.has('ADVANCE_TO_STAGE')).toBe(false);
  });

  // ── Scenario 4: DRY_IN with countdown active ────────────────────────────
  it('dryInActiveContext — half-time elapsed, no readings yet => SUBMIT_DRYER_READINGS visible', () => {
    const fixture = dryInActiveContext();
    // Need an equipment group that has DRY_IN-stage instruments for
    // SUBMIT_DRYER_READINGS to emit. Default fixture uses DRY_OUT instruments;
    // override to DRY_IN.
    fixture.equipmentGroup = fixture.equipmentGroup
      ? {
          ...fixture.equipmentGroup,
          instruments: fixture.equipmentGroup.instruments.map(i => ({ ...i, stageKey: 'DRY_IN' })),
        }
      : null;
    const { types } = actionTypes(fixture);
    expect(types.has('SUBMIT_DRYER_READINGS')).toBe(true);
    expect(types.has('TERMINATE_CYCLE')).toBe(true);
  });

  // ── Scenario 5: DRY_OUT awaiting readings ──────────────────────────────
  it('dryOutAwaitingReadingsContext — DRY_OUT is the last stage, leadsToEnd => COMPLETE_CYCLE', () => {
    const { types, actions } = actionTypes(dryOutAwaitingReadingsContext());
    // Last stage in profile leads to END.
    expect(types.has('COMPLETE_CYCLE')).toBe(true);
    expect(types.has('TERMINATE_CYCLE')).toBe(true);
    const complete = actions.find(a => a.type === 'COMPLETE_CYCLE');
    expect(complete).toBeDefined();
  });

  // ── Scenario 6: BYPASS_ENABLED flow ─────────────────────────────────────
  it('bypassEnabledContext — flowMode=BYPASS_ENABLED expands surface to BYPASS_STAGE actions', () => {
    const { types } = actionTypes(bypassEnabledContext());
    expect(types.has('BYPASS_STAGE')).toBe(true);
    expect(types.has('ADVANCE_TO_STAGE')).toBe(true);
    expect(types.has('TERMINATE_CYCLE')).toBe(true);
  });

  // ── Bonus #7: lockedContext (synthetic LOCKED flowMode) ─────────────────
  it('lockedContext — non-BYPASS flowMode emits ADVANCE_TO_STAGE only (no BYPASS_STAGE)', () => {
    const { types } = actionTypes(lockedContext());
    expect(types.has('ADVANCE_TO_STAGE')).toBe(true);
    expect(types.has('BYPASS_STAGE')).toBe(false);
    expect(types.has('TERMINATE_CYCLE')).toBe(true);
  });

  // ── Bonus #8: terminatedContext ─────────────────────────────────────────
  it('terminatedContext — cycle.status=TERMINATED => no actions', () => {
    const { actions } = actionTypes(terminatedContext());
    expect(actions).toHaveLength(0);
  });
});
