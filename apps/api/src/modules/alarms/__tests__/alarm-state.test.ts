import { describe, it, expect } from 'vitest';
import { nextTransition, applyAck, type OpenAlarmView } from '../alarm-state.js';
import type { AlarmState } from '@prisma/client';

const TS = new Date('2026-08-03T10:00:00.000Z');
const open = (state: AlarmState, over: Partial<OpenAlarmView> = {}): OpenAlarmView =>
  ({ id: 'a1', state, breachCount: 1, peakValue: 101, ...over });

describe('nextTransition — raising', () => {
  it('raises when a breach arrives with no open alarm', () => {
    expect(nextTransition('BREACH', null, 'MAJOR', 101, TS))
      .toEqual({ kind: 'RAISE', severity: 'MAJOR', value: 101, ts: TS });
  });
  it('does nothing when a neutral reading arrives with no open alarm', () => {
    expect(nextTransition('NEUTRAL', null, 'MAJOR', 50, TS)).toEqual({ kind: 'NONE' });
  });
});

describe('nextTransition — re-breach', () => {
  it('bumps the counter instead of raising a second alarm', () => {
    expect(nextTransition('BREACH', open('ACTIVE'), 'MAJOR', 105, TS))
      .toEqual({ kind: 'REBREACH', alarmId: 'a1', value: 105, ts: TS, backToActive: false });
  });
  it('walks RESOLVED_UNACKED back to ACTIVE', () => {
    // A flapping sensor must not have its excursion closed out from under the
    // operator who is mid-review.
    expect(nextTransition('BREACH', open('RESOLVED_UNACKED'), 'MAJOR', 105, TS))
      .toEqual({ kind: 'REBREACH', alarmId: 'a1', value: 105, ts: TS, backToActive: true });
  });
  it('bumps without state change when already acknowledged', () => {
    expect(nextTransition('BREACH', open('ACTIVE_ACKED'), 'MAJOR', 105, TS))
      .toEqual({ kind: 'REBREACH', alarmId: 'a1', value: 105, ts: TS, backToActive: false });
  });
});

describe('nextTransition — recovery', () => {
  it('moves ACTIVE to RESOLVED_UNACKED without closing', () => {
    expect(nextTransition('RECOVERED', open('ACTIVE'), 'MAJOR', 50, TS))
      .toEqual({ kind: 'RESOLVE', alarmId: 'a1', ts: TS, close: false });
  });
  it('closes an already-acknowledged alarm on recovery', () => {
    expect(nextTransition('RECOVERED', open('ACTIVE_ACKED'), 'MAJOR', 50, TS))
      .toEqual({ kind: 'RESOLVE', alarmId: 'a1', ts: TS, close: true });
  });
  it('does nothing when an already-resolved alarm recovers again', () => {
    expect(nextTransition('RECOVERED', open('RESOLVED_UNACKED'), 'MAJOR', 50, TS))
      .toEqual({ kind: 'NONE' });
  });
});

describe('applyAck', () => {
  it('ACTIVE becomes ACTIVE_ACKED', () => {
    expect(applyAck('ACTIVE')).toBe('ACTIVE_ACKED');
  });
  it('RESOLVED_UNACKED becomes CLOSED', () => {
    expect(applyAck('RESOLVED_UNACKED')).toBe('CLOSED');
  });
  it('refuses to acknowledge an already-acknowledged or closed alarm', () => {
    // null means "reject the request" — the route turns this into a 409 rather
    // than silently re-signing a record.
    expect(applyAck('ACTIVE_ACKED')).toBeNull();
    expect(applyAck('CLOSED')).toBeNull();
  });
});

describe('invariant: CLOSED is only reachable through a human ack', () => {
  it('no verdict-driven transition closes an unacknowledged alarm', () => {
    const states: AlarmState[] = ['ACTIVE', 'RESOLVED_UNACKED'];
    for (const s of states) {
      for (const v of ['BREACH', 'RECOVERED', 'NEUTRAL'] as const) {
        const t = nextTransition(v, open(s), 'MAJOR', 50, TS);
        expect(t.kind === 'RESOLVE' && t.close).toBe(false);
      }
    }
  });
});
