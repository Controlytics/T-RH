import { describe, it, expect } from 'vitest';
import {
  needsAcknowledgement, tabFor, filterByTab, conditionText, triggeredText,
  instrumentLabel, ackReasonError, MIN_ACK_REASON, MAX_ACK_REASON,
  type AlarmRow,
} from '../alarm-display';

const alarm = (over: Partial<AlarmRow> = {}): AlarmRow => ({
  id: 'a1',
  instrumentCode: 'CWH-I/142',
  instrumentId: 'uuid-1',
  metric: 'TEMPERATURE',
  triggeredValue: 27.4,
  severity: 'MAJOR',
  state: 'ACTIVE',
  raisedAt: '2026-08-13T04:00:00Z',
  clearedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  acknowledgeReason: null,
  ruleSnapshot: { name: 'Cold room high', description: 'temperature above 25' },
  ...over,
});

describe('acknowledgement is independent of clearing', () => {
  it('a cleared but unacknowledged alarm still needs answering for', () => {
    // The overnight excursion nobody saw. If "Cleared" read as "dealt with", this row
    // would disappear from view while the record is still open.
    const a = alarm({ state: 'CLEARED', clearedAt: '2026-08-13T05:00:00Z' });
    expect(needsAcknowledgement(a)).toBe(true);
  });

  it('an acknowledged but still-active alarm does not need acknowledging again', () => {
    expect(needsAcknowledgement(alarm({ acknowledgedAt: '2026-08-13T04:30:00Z' }))).toBe(false);
  });
});

describe('tabFor', () => {
  it('splits on the CONDITION, not the paperwork', () => {
    expect(tabFor(alarm())).toBe('active');
    expect(tabFor(alarm({ state: 'CLEARED' }))).toBe('history');
    // Unacknowledged does not hold an alarm in the active tab.
    expect(tabFor(alarm({ state: 'CLEARED', acknowledgedAt: null }))).toBe('history');
  });
});

describe('filterByTab', () => {
  const rows = [
    alarm({ id: 'a', state: 'ACTIVE', acknowledgedAt: null }),
    alarm({ id: 'b', state: 'ACTIVE', acknowledgedAt: '2026-08-13T04:30:00Z' }),
    alarm({ id: 'c', state: 'CLEARED', acknowledgedAt: null }),
    alarm({ id: 'd', state: 'CLEARED', acknowledgedAt: '2026-08-13T06:00:00Z' }),
  ];

  it('returns only that tab', () => {
    expect(filterByTab(rows, 'active').map((r) => r.id)).toEqual(['a', 'b']);
    expect(filterByTab(rows, 'history').map((r) => r.id)).toEqual(['c', 'd']);
  });

  it('the unacknowledged filter works within a tab, including history', () => {
    expect(filterByTab(rows, 'active', true).map((r) => r.id)).toEqual(['a']);
    expect(filterByTab(rows, 'history', true).map((r) => r.id)).toEqual(['c']);
  });
});

describe('conditionText', () => {
  it('prefers the snapshot taken when the alarm fired', () => {
    // Editing the live rule must not change what a historical alarm says about itself.
    expect(conditionText(alarm())).toBe('temperature above 25');
  });

  it('falls back to the rule name, then to a generic phrase', () => {
    expect(conditionText(alarm({ ruleSnapshot: { name: 'Cold room high' } }))).toBe('Cold room high');
    expect(conditionText(alarm({ ruleSnapshot: null }))).toBe('temperature out of limit');
  });
});

describe('triggeredText', () => {
  it('shows zero as a reading, not as missing', () => {
    // 0 °C is a real cold-room value; a falsy check here would erase it.
    expect(triggeredText(alarm({ triggeredValue: 0 }))).toBe('0');
  });

  it('shows a dash when there is no value (OFFLINE has none)', () => {
    expect(triggeredText(alarm({ triggeredValue: null }))).toBe('—');
  });
});

describe('instrumentLabel', () => {
  it('falls back to the id rather than rendering blank', () => {
    expect(instrumentLabel(alarm({ instrumentCode: null }))).toBe('uuid-1');
  });
});

describe('ackReasonError', () => {
  it('mirrors the server bounds so the dialog refuses what the API would', () => {
    expect(ackReasonError('')).toContain(String(MIN_ACK_REASON));
    expect(ackReasonError('   ok   ')).toBeTruthy();
    expect(ackReasonError('Door left open')).toBeNull();
    expect(ackReasonError('x'.repeat(MAX_ACK_REASON + 1))).toContain(String(MAX_ACK_REASON));
  });

  it('counts trimmed length, so whitespace is not a reason', () => {
    expect(ackReasonError('        ')).toBeTruthy();
  });
});
