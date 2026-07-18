import { describe, it, expect } from 'vitest';
import { validateOfflineGate, type GateInput } from '../validate-offline-gate';

const base: GateInput = {
  activeStageKey: 'WASH_IN', activeStageLabel: 'Wash In', online: true,
  currentLifecycle: null, actions: [], hasGraph: false, hasLinearPipeline: false,
  pipelineGraph: null, cycleInProgress: false, hasPendingChecklist: false,
};

describe('validateOfflineGate — replacementBlocked', () => {
  it('refuses a cycle START when the filter is replacement-blocked', () => {
    const r = validateOfflineGate({ ...base, replacementBlocked: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/replacement overdue/i);
  });

  it('does NOT refuse an in-progress cycle even if flagged (running cycles finish)', () => {
    const r = validateOfflineGate({
      ...base, replacementBlocked: true, cycleInProgress: true,
      actions: [{ type: 'ADVANCE_TO_STAGE', params: { targetState: 'WASH_OUT' } } as any],
      currentLifecycle: 'WASH_IN', activeStageKey: 'WASH_OUT', activeStageLabel: 'Wash Out',
    });
    expect(r.ok).toBe(true);
  });

  it('does not affect a normal start when not flagged', () => {
    const r = validateOfflineGate({ ...base });
    expect(r.ok).toBe(true);
  });
});
