import { describe, it, expect } from 'vitest';
import { alarmScopeSelectsNothing, applyAlarmScope, widgetAlarmScope, type AlarmScope } from '../alarm-scope';

const params = (scope: AlarmScope) => {
  const qs = new URLSearchParams();
  applyAlarmScope(qs, scope);
  return qs.toString();
};

describe('applyAlarmScope', () => {
  it('a location, with or without its areas', () => {
    expect(params({ functionalLocationId: 'fl-1' })).toBe('functionalLocationId=fl-1');
    expect(params({ functionalLocationId: 'fl-1', directOnly: false })).toBe('functionalLocationId=fl-1');
    expect(params({ functionalLocationId: 'fl-1', directOnly: true })).toBe('functionalLocationId=fl-1&functionalLocationDirect=true');
  });

  it('direct-only without a location says nothing', () => {
    expect(params({ directOnly: true })).toBe('');
  });

  it('a profile, a fixed list, and everything in view', () => {
    expect(params({ profileId: 'p-1' })).toBe('profileId=p-1');
    expect(params({ instrumentIds: ['a', 'b'] })).toBe('instrumentIds=a%2Cb');
    expect(params({})).toBe('');
  });

  it('an EMPTY fixed list sends no instrumentIds, and selects nothing', () => {
    expect(params({ instrumentIds: [] })).toBe('');
    expect(alarmScopeSelectsNothing({ instrumentIds: [] })).toBe(true);
    expect(alarmScopeSelectsNothing({ instrumentIds: ['a'] })).toBe(false);
    expect(alarmScopeSelectsNothing({})).toBe(false);
    expect(alarmScopeSelectsNothing(undefined)).toBe(false);
  });
});

describe('widgetAlarmScope', () => {
  it("a fixed-instruments widget asks for its own ids and nothing of the dashboard's", () => {
    expect(widgetAlarmScope({ mode: 'instruments', ids: ['a', 'b'] }, { functionalLocationId: 'fl-1', directOnly: true, profileId: 'p-1' }))
      .toEqual({ instrumentIds: ['a', 'b'] });
  });

  it("a selection widget asks for the dashboard's selection", () => {
    expect(widgetAlarmScope({ mode: 'selection' }, { functionalLocationId: 'fl-1', directOnly: true }))
      .toEqual({ functionalLocationId: 'fl-1', directOnly: true, profileId: undefined, instrumentIds: undefined });
    expect(widgetAlarmScope({ mode: 'selection' }, { directOnly: false, instrumentIds: [] }).instrumentIds).toEqual([]);
  });
});
