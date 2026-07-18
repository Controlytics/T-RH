import { describe, it, expect } from 'vitest';
import { stageProgress } from '../cleaning-cycle-report';

// Build a STATE_TRANSITION event list from a sequence of destination stages.
const tx = (...toStates: string[]) => toStates.map((toState) => ({ eventType: 'STATE_TRANSITION', toState }));

const ALL = ['WASH_IN', 'WASH_OUT', 'DRY_IN', 'DRY_OUT', 'STORAGE_IN', 'STORAGE_OUT'];

describe('stageProgress — reached set', () => {
  it('dedupes the double DRY_IN transition (SET_DURATION + SUBMIT_READINGS)', () => {
    const { reached } = stageProgress(tx('WASH_IN', 'WASH_OUT', 'DRY_IN', 'DRY_IN'), ALL, 'IN_PROGRESS');
    expect([...reached].sort()).toEqual(['DRY_IN', 'WASH_IN', 'WASH_OUT']);
  });

  it('ignores non-transition events and transitions with no toState', () => {
    const events = [
      { eventType: 'CYCLE_STARTED', toState: null },
      { eventType: 'STATE_TRANSITION', toState: 'WASH_IN' },
      { eventType: 'REMARK_ADDED', toState: null },
      { eventType: 'STATE_TRANSITION', toState: null },
    ];
    const { reached } = stageProgress(events, ALL, 'IN_PROGRESS');
    expect([...reached]).toEqual(['WASH_IN']);
  });
});

describe('stageProgress — current stage', () => {
  // M59: the regression. Counting transitions gave index 4 (STORAGE_IN) here,
  // because DRY_IN contributes two events. The real next stage is DRY_OUT.
  it('marks DRY_OUT current after the double DRY_IN transition, not STORAGE_IN', () => {
    const { current } = stageProgress(tx('WASH_IN', 'WASH_OUT', 'DRY_IN', 'DRY_IN'), ALL, 'IN_PROGRESS');
    expect(current).toBe('DRY_OUT');
  });

  it('marks the next stage current on a normal single-transition cycle', () => {
    expect(stageProgress(tx('WASH_IN'), ALL, 'IN_PROGRESS').current).toBe('WASH_OUT');
    expect(stageProgress(tx('WASH_IN', 'WASH_OUT'), ALL, 'IN_PROGRESS').current).toBe('DRY_IN');
  });

  it('skips stages that are not in the cycle profile', () => {
    // DRY_OUT is NA for this profile → the current stage jumps to STORAGE_IN.
    const profile = ['WASH_IN', 'WASH_OUT', 'DRY_IN', 'STORAGE_IN', 'STORAGE_OUT'];
    const { current } = stageProgress(tx('WASH_IN', 'WASH_OUT', 'DRY_IN', 'DRY_IN'), profile, 'IN_PROGRESS');
    expect(current).toBe('STORAGE_IN');
  });

  it('never marks an already-reached stage current (out-of-order / repeated transitions)', () => {
    // A backward transition must not make an earlier, already-reached stage current.
    const { current } = stageProgress(tx('WASH_IN', 'WASH_OUT', 'DRY_IN', 'WASH_OUT'), ALL, 'IN_PROGRESS');
    expect(current).toBe('DRY_OUT');
  });

  it('has no current stage once every stage is reached', () => {
    expect(stageProgress(tx(...ALL), ALL, 'IN_PROGRESS').current).toBeNull();
  });

  it('has no current stage before the first transition', () => {
    expect(stageProgress([], ALL, 'IN_PROGRESS').current).toBeNull();
  });

  it('has no current stage for a cycle that is not IN_PROGRESS', () => {
    const events = tx('WASH_IN', 'WASH_OUT', 'DRY_IN', 'DRY_IN');
    for (const status of ['COMPLETED', 'TERMINATED', 'RETIRED', 'REPLACED']) {
      expect(stageProgress(events, ALL, status).current).toBeNull();
    }
  });

  it('treats an unknown profile (empty profileStages) as all stages applicable', () => {
    expect(stageProgress(tx('WASH_IN'), [], 'IN_PROGRESS').current).toBe('WASH_OUT');
  });
});
