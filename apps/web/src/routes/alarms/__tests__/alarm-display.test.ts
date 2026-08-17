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

import { statusText, alarmTypeText, limitText, mapStatusTextsResponse, type AlarmRow as AlarmRowT } from '../alarm-display';

const base: AlarmRowT = {
  id: 'a1', instrumentCode: 'CWH-01', instrumentId: 'i1',
  metric: 'TEMPERATURE', triggeredValue: 26.4, severity: 'CRITICAL',
  state: 'ACTIVE', raisedAt: '2026-08-17T09:00:00Z', clearedAt: null,
  acknowledgedAt: null, acknowledgedBy: null, acknowledgeReason: null,
  source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH', clearedValue: null,
  ruleSnapshot: { limit: 25, metric: 'TEMPERATURE', limitKind: 'HIGH', description: 'temperature above 25' },
};

describe('statusText', () => {
  it('covers all four combinations of condition and signature', () => {
    expect(statusText({ state: 'ACTIVE', acknowledgedAt: null })).toBe('Still pending Unacknowledged');
    expect(statusText({ state: 'ACTIVE', acknowledgedAt: '2026-08-17T10:00:00Z' })).toBe('Active — Acknowledged');
    expect(statusText({ state: 'CLEARED', acknowledgedAt: null })).toBe('Cleared — Unacknowledged');
    expect(statusText({ state: 'CLEARED', acknowledgedAt: '2026-08-17T10:00:00Z' })).toBe('Cleared');
  });

  it('never lets cleared-unacknowledged read as finished', () => {
    // The overnight excursion nobody answered for must not look like Cleared.
    expect(statusText({ state: 'CLEARED', acknowledgedAt: null }))
      .not.toBe(statusText({ state: 'CLEARED', acknowledgedAt: 'x' }));
  });

  it('uses the configured wording when provided', () => {
    expect(statusText({ state: 'ACTIVE', acknowledgedAt: null }, { activeUnack: 'OPEN' })).toBe('OPEN');
  });

  it('falls back to the default when a configured text is blank', () => {
    // A blank setting must not render an empty status cell.
    expect(statusText({ state: 'ACTIVE', acknowledgedAt: null }, { activeUnack: '   ' }))
      .toBe('Still pending Unacknowledged');
  });
});

describe('mapStatusTextsResponse', () => {
  it('carries the API\'s status*-prefixed payload through to configured wording, not the fallback', () => {
    // This is the boundary the earlier bug lived at: the route returns
    // status*-prefixed keys, statusText() reads unprefixed ones. A test that
    // hands statusText() an already-correct object (as 'uses the configured
    // wording' above does) cannot catch a broken mapping — this one starts
    // from the real API shape and would fail if the mapping silently dropped
    // back to identity or mismatched a field.
    const apiResponse = {
      statusActiveUnack: 'Custom breach wording',
      statusActiveAck: 'Custom ack wording',
      statusClearedUnack: 'Custom cleared-unack wording',
      statusClearedAck: 'Custom cleared-ack wording',
    };
    const mapped = mapStatusTextsResponse(apiResponse);
    expect(statusText({ state: 'ACTIVE', acknowledgedAt: null }, mapped)).toBe('Custom breach wording');
    expect(statusText({ state: 'ACTIVE', acknowledgedAt: '2026-08-17T10:00:00Z' }, mapped)).toBe('Custom ack wording');
    expect(statusText({ state: 'CLEARED', acknowledgedAt: null }, mapped)).toBe('Custom cleared-unack wording');
    expect(statusText({ state: 'CLEARED', acknowledgedAt: '2026-08-17T10:00:00Z' }, mapped)).toBe('Custom cleared-ack wording');
  });
});

describe('alarmTypeText', () => {
  it('names the bound for a limit alarm', () => {
    expect(alarmTypeText(base)).toBe('High Temperature');
    expect(alarmTypeText({ ...base, metric: 'HUMIDITY', limitKind: 'LOW' })).toBe('Low Humidity');
  });

  it('falls back to the rule name for a rule alarm', () => {
    expect(alarmTypeText({ ...base, source: 'RULE', limitKind: null, ruleSnapshot: { name: 'Cold room' } }))
      .toBe('Cold room');
  });
});

describe('limitText', () => {
  it('reads the FROZEN limit, never the live attribute', () => {
    expect(limitText(base)).toBe('> 25');
    expect(limitText({ ...base, limitKind: 'LOW', ruleSnapshot: { limit: 18 } })).toBe('< 18');
  });

  it('renders an em dash when the snapshot carries no limit', () => {
    expect(limitText({ ...base, ruleSnapshot: {} })).toBe('—');
  });

  // A RULE alarm's snapshot has no `limit` field at all — it is the real shape
  // `ruleSnapshot()` produces in apps/api/src/modules/alarms/decide.ts:117-129:
  // { ruleId, name, metric, comparison, thresholdLow, thresholdHigh, delaySeconds,
  //   severity, snapshotAt }. limitText must fall back to comparison/thresholds.
  const ruleAlarm = (over: Partial<AlarmRowT> = {}): AlarmRowT => ({
    ...base,
    source: 'RULE',
    limitKind: null,
    ruleSnapshot: {
      name: 'Cold room high',
      metric: 'TEMPERATURE',
      comparison: undefined,
      thresholdLow: null,
      thresholdHigh: null,
    },
    ...over,
  });

  it('renders an ABOVE rule alarm from thresholdHigh', () => {
    expect(limitText(ruleAlarm({
      ruleSnapshot: { name: 'Cold room high', comparison: 'ABOVE', thresholdHigh: 24, thresholdLow: null },
    }))).toBe('> 24');
  });

  it('renders a BELOW rule alarm from thresholdLow', () => {
    expect(limitText(ruleAlarm({
      ruleSnapshot: { name: 'Cold room low', comparison: 'BELOW', thresholdLow: 15, thresholdHigh: null },
    }))).toBe('< 15');
  });

  it('renders an OUTSIDE_RANGE rule alarm as a range', () => {
    expect(limitText(ruleAlarm({
      ruleSnapshot: { name: 'Cold room range', comparison: 'OUTSIDE_RANGE', thresholdLow: 18, thresholdHigh: 25 },
    }))).toBe('18 – 25');
  });

  it('still renders an em dash when the rule snapshot has no usable threshold', () => {
    expect(limitText(ruleAlarm({
      ruleSnapshot: { name: 'Broken snapshot', comparison: 'ABOVE', thresholdHigh: null, thresholdLow: null },
    }))).toBe('—');
  });
});
