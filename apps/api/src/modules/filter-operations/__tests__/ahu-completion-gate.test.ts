import { describe, it, expect } from 'vitest';
import { computeFinalStageKey, reachedFinal } from '../ahu-completion-gate.js';

// Minimal graph: S1 -> S2 -> END
const nodes = [
  { id: 'n1', nodeType: 'STAGE', stateKey: 'S1' },
  { id: 'n2', nodeType: 'STAGE', stateKey: 'S2' },
  { id: 'nEnd', nodeType: 'END', stateKey: null },
];
const edges = [
  { fromStageId: 'n1', toStageId: 'n2' },
  { fromStageId: 'n2', toStageId: 'nEnd' },
];

describe('computeFinalStageKey', () => {
  it('returns the last STAGE that leads to END', () => {
    expect(computeFinalStageKey({ nodes, edges })).toBe('S2');
  });
});

describe('reachedFinal', () => {
  const finalMap = new Map<string, string | null>([['f-active', 'S2']]);
  it('active cycle parked at final stage → reached', () => {
    expect(reachedFinal({ id: 'f-active', name: 'F', currentCycleId: 'c1', currentLifecycleState: 'S2' }, finalMap)).toBe(true);
  });
  it('active cycle NOT at final → not reached', () => {
    expect(reachedFinal({ id: 'f-active', name: 'F', currentCycleId: 'c1', currentLifecycleState: 'S1' }, finalMap)).toBe(false);
  });
  it('no cycle + CLEANING_CYCLE_COMPLETED → reached', () => {
    expect(reachedFinal({ id: 'f-done', name: 'F', currentCycleId: null, currentLifecycleState: 'CLEANING_CYCLE_COMPLETED' }, finalMap)).toBe(true);
  });
  it('never started (null state) → not reached', () => {
    expect(reachedFinal({ id: 'f-idle', name: 'F', currentCycleId: null, currentLifecycleState: null }, finalMap)).toBe(false);
  });
});
