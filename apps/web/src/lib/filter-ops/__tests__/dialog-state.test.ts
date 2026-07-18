import { describe, it, expect } from 'vitest';

import { reduceDialogState, deriveDialogKindFromTape, type DialogState } from '../dialog-state';

/**
 * Deep-review scaffolding tests (2026-05-17) — D1 / D2 / D4.
 *
 * Locks the dialog-state invariants that the future refactor will lift the
 * existing pages onto. Today's pages don't use this state machine yet; these
 * tests are a contract for the migration to consume.
 */

describe('reduceDialogState — D4 invariant: at most one dialog open, illegal transitions throw', () => {
  it('opens checklist from idle', () => {
    const next = reduceDialogState(
      { kind: 'none' },
      { type: 'open_checklist', filterId: 'f1', filterName: 'F-1', checklists: [] },
    );
    expect(next.kind).toBe('awaiting_checklist');
  });

  it('throws when opening checklist over an open dryer dialog', () => {
    expect(() =>
      reduceDialogState(
        { kind: 'awaiting_dryer', filterId: 'f1', filterName: 'F-1' },
        { type: 'open_checklist', filterId: 'f1', filterName: 'F-1', checklists: [] },
      ),
    ).toThrow(/Cannot open dialog from state "awaiting_dryer"/);
  });

  it('throws when opening equipment over an open checklist', () => {
    expect(() =>
      reduceDialogState(
        { kind: 'awaiting_checklist', filterId: 'f1', filterName: 'F-1', checklists: [] },
        { type: 'open_equipment', filterId: 'f1', filterName: 'F-1', stage: 'WASH_IN', groups: [] },
      ),
    ).toThrow(/Cannot open dialog from state "awaiting_checklist"/);
  });

  it('allows reason → equipment chain (cycle-start wash-in flow)', () => {
    const afterReason = reduceDialogState(
      { kind: 'none' },
      { type: 'open_reason', filterId: 'f1', filterName: 'F-1', stage: 'WASH_IN' },
    );
    const afterEquipment = reduceDialogState(afterReason, {
      type: 'open_equipment',
      filterId: 'f1',
      filterName: 'F-1',
      stage: 'WASH_IN',
      groups: [{ id: 'g1' }],
    });
    expect(afterEquipment.kind).toBe('awaiting_equipment');
  });

  it('allows equipment → checklist chain (post-readings continuation)', () => {
    const eq: DialogState = {
      kind: 'awaiting_equipment',
      filterId: 'f1',
      filterName: 'F-1',
      stage: 'WASH_IN',
      groups: [],
    };
    const next = reduceDialogState(eq, {
      type: 'open_checklist',
      filterId: 'f1',
      filterName: 'F-1',
      checklists: [{ id: 'cl1' }],
    });
    expect(next.kind).toBe('awaiting_checklist');
  });

  it('close always returns to idle from any state', () => {
    const states: DialogState[] = [
      { kind: 'none' },
      { kind: 'awaiting_reason', filterId: 'f1', filterName: 'F-1', stage: 'WASH_IN' },
      { kind: 'awaiting_dryer', filterId: 'f1', filterName: 'F-1' },
      { kind: 'awaiting_checklist', filterId: 'f1', filterName: 'F-1', checklists: [] },
    ];
    for (const s of states) {
      expect(reduceDialogState(s, { type: 'close' })).toEqual({ kind: 'none' });
    }
  });

  it('advance_batch throws from non-checklist state', () => {
    expect(() =>
      reduceDialogState({ kind: 'none' }, { type: 'advance_batch' }),
    ).toThrow(/advance_batch invalid from state none/);
  });

  it('advance_batch returns to idle when checklist queue is empty', () => {
    const next = reduceDialogState(
      { kind: 'awaiting_checklist', filterId: 'f1', filterName: 'F-1', checklists: [], remainingBatch: [] },
      { type: 'advance_batch' },
    );
    expect(next.kind).toBe('none');
  });
});

describe('deriveDialogKindFromTape — D1/D2: derive dialog state from action tape', () => {
  it('returns "awaiting_checklist" when the head action is SUBMIT_CHECKLIST', () => {
    expect(
      deriveDialogKindFromTape([
        { type: 'SUBMIT_CHECKLIST', params: { checklistProfileId: 'cl1', filterId: 'f1' } } as any,
        { type: 'ADVANCE_TO_STAGE', params: { targetState: 'WASH_OUT' } } as any,
      ]),
    ).toBe('awaiting_checklist');
  });

  it('returns "awaiting_dryer" when the head action is SET_DRYER_DURATION', () => {
    expect(
      deriveDialogKindFromTape([
        { type: 'SET_DRYER_DURATION', params: { dryerDurationMinutes: 60 } } as any,
      ]),
    ).toBe('awaiting_dryer');
  });

  it('returns "none" when the head action is ADVANCE_TO_STAGE (operator-triggered, no dialog gate)', () => {
    expect(
      deriveDialogKindFromTape([
        { type: 'ADVANCE_TO_STAGE', params: { targetState: 'WASH_OUT' } } as any,
      ]),
    ).toBe('none');
  });

  it('returns "none" when the tape is empty', () => {
    expect(deriveDialogKindFromTape([])).toBe('none');
  });
});
