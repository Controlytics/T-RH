import { describe, it, expect } from 'vitest';
import {
  needsAcknowledgement, tabFor, filterByTab, conditionText, triggeredText,
  instrumentLabel, ackReasonError, MIN_ACK_REASON, MAX_ACK_REASON,
  quadrantFor, filterByQuadrant, quadrantCounts, ALARM_QUADRANTS,
  metricUnit, triggeredWithUnit, clearedWithUnit, alarmDurationText,
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
    // 0 °C is a real cold-room value; a falsy check here would erase it. Quoted at
    // the snapshot's precision, which this fixture does not carry — hence the
    // shipped default of one decimal.
    expect(triggeredText(alarm({ triggeredValue: 0 }))).toBe('0.0');
  });

  it('shows a dash when there is no value (OFFLINE has none)', () => {
    expect(triggeredText(alarm({ triggeredValue: null }))).toBe('—');
  });

  it('quotes the reading at the precision FROZEN when the alarm was raised', () => {
    // The instrument's `temp_decimals` at raise time, not its value today: an
    // attribute edited afterwards must not re-render a closed excursion.
    expect(triggeredText(alarm({
      triggeredValue: 27.44,
      ruleSnapshot: { name: 'r', decimals: 0 },
    }))).toBe('27');
    expect(triggeredText(alarm({
      triggeredValue: 27.44,
      ruleSnapshot: { name: 'r', decimals: 2 },
    }))).toBe('27.44');
  });

  it('falls back to the default for a row raised before decimals were frozen', () => {
    expect(triggeredText(alarm({ triggeredValue: 27.44, ruleSnapshot: { name: 'r' } }))).toBe('27.4');
    expect(triggeredText(alarm({ triggeredValue: 27.44, ruleSnapshot: null }))).toBe('27.4');
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
    expect(limitText(base)).toBe('> 25.0');
    expect(limitText({ ...base, limitKind: 'LOW', ruleSnapshot: { limit: 18 } })).toBe('< 18.0');
  });

  it('quotes the bound at the same precision as the reading it was compared against', () => {
    // "27 breached > 25.0" reads as a bug in the comparison. One alarm, one precision.
    expect(limitText({ ...base, ruleSnapshot: { limit: 25, decimals: 0 } })).toBe('> 25');
    expect(limitText({ ...base, ruleSnapshot: { limit: 25, decimals: 2 } })).toBe('> 25.00');
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
    }))).toBe('> 24.0');
  });

  it('renders a BELOW rule alarm from thresholdLow', () => {
    expect(limitText(ruleAlarm({
      ruleSnapshot: { name: 'Cold room low', comparison: 'BELOW', thresholdLow: 15, thresholdHigh: null },
    }))).toBe('< 15.0');
  });

  it('renders an OUTSIDE_RANGE rule alarm as a range', () => {
    expect(limitText(ruleAlarm({
      ruleSnapshot: { name: 'Cold room range', comparison: 'OUTSIDE_RANGE', thresholdLow: 18, thresholdHigh: 25 },
    }))).toBe('18.0 – 25.0');
  });

  it('still renders an em dash when the rule snapshot has no usable threshold', () => {
    expect(limitText(ruleAlarm({
      ruleSnapshot: { name: 'Broken snapshot', comparison: 'ABOVE', thresholdHigh: null, thresholdLow: null },
    }))).toBe('—');
  });
});

describe('alarm quadrants — the four filter boxes', () => {
  const cleared = { state: 'CLEARED', clearedAt: '2026-08-13T05:00:00Z' } as Partial<AlarmRow>;
  const acked = { acknowledgedAt: '2026-08-13T04:30:00Z' } as Partial<AlarmRow>;

  it('places an alarm by CONDITION and PAPERWORK independently', () => {
    expect(quadrantFor(alarm())).toBe('active-unack');
    expect(quadrantFor(alarm(acked))).toBe('active-ack');
    expect(quadrantFor(alarm(cleared))).toBe('cleared-unack');
    expect(quadrantFor(alarm({ ...cleared, ...acked }))).toBe('cleared-ack');
  });

  it('keeps the overnight excursion visible as its own state', () => {
    // Cleared but never signed for. If this collapsed into "cleared" it would
    // read as finished, which is the whole reason the two axes stay separate.
    expect(quadrantFor(alarm(cleared))).toBe('cleared-unack');
  });

  it('shows EVERYTHING when no box is chosen, not nothing', () => {
    const rows = [alarm({ id: 'a' }), alarm({ id: 'b', ...cleared })];
    expect(filterByQuadrant(rows, null).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('filters to exactly one state when a box is chosen', () => {
    const rows = [
      alarm({ id: 'au' }),
      alarm({ id: 'aa', ...acked }),
      alarm({ id: 'cu', ...cleared }),
      alarm({ id: 'ca', ...cleared, ...acked }),
    ];
    expect(filterByQuadrant(rows, 'active-unack').map((r) => r.id)).toEqual(['au']);
    expect(filterByQuadrant(rows, 'active-ack').map((r) => r.id)).toEqual(['aa']);
    expect(filterByQuadrant(rows, 'cleared-unack').map((r) => r.id)).toEqual(['cu']);
    expect(filterByQuadrant(rows, 'cleared-ack').map((r) => r.id)).toEqual(['ca']);
  });

  it('counts every row into exactly one box, so the tiles sum to the total', () => {
    const rows = [
      alarm({ id: 'au' }),
      alarm({ id: 'aa', ...acked }),
      alarm({ id: 'cu', ...cleared }),
      alarm({ id: 'ca', ...cleared, ...acked }),
      alarm({ id: 'au2' }),
    ];
    const counts = quadrantCounts(rows);
    expect(counts).toEqual({ 'active-ack': 1, 'active-unack': 2, 'cleared-ack': 1, 'cleared-unack': 1 });
    const total = ALARM_QUADRANTS.reduce((n, q) => n + counts[q.id], 0);
    expect(total).toBe(rows.length);
  });
});

describe('readings carry their unit', () => {
  it('uses the metric to pick the symbol', () => {
    expect(metricUnit('TEMPERATURE')).toBe('°C');
    expect(metricUnit('HUMIDITY')).toBe('%RH');
    expect(metricUnit('PRESSURE')).toBe('');
  });

  it('brackets the unit after the value', () => {
    expect(triggeredWithUnit(alarm({ triggeredValue: 28 }))).toBe('28.0 (°C)');
    expect(triggeredWithUnit(alarm({ metric: 'HUMIDITY', triggeredValue: 47 }))).toBe('47.0 (%RH)');
  });

  it('does the same for the reading that CLEARED it', () => {
    expect(clearedWithUnit(alarm({ clearedValue: 24.2 }))).toBe('24.2 (°C)');
    expect(clearedWithUnit(alarm({ metric: 'HUMIDITY', clearedValue: 55 }))).toBe('55.0 (%RH)');
  });

  it('leaves the em dash alone rather than bracketing a missing reading', () => {
    // "— (°C)" would read as a unit attached to nothing.
    expect(triggeredWithUnit(alarm({ triggeredValue: null }))).toBe('—');
    expect(clearedWithUnit(alarm({ clearedValue: null }))).toBe('—');
  });

  it('keeps a metric with no known unit unbracketed', () => {
    expect(triggeredWithUnit(alarm({ metric: 'PRESSURE', triggeredValue: 3 }))).toBe('3.0');
  });
});

describe('alarm duration', () => {
  const span = (raisedAt: string, clearedAt: string | null) =>
    alarmDurationText({ raisedAt, clearedAt });

  it('reads as minutes under an hour', () => {
    expect(span('2026-08-13T04:00:00Z', '2026-08-13T04:01:00Z')).toBe('00:01M');
    expect(span('2026-08-13T04:00:00Z', '2026-08-13T04:59:00Z')).toBe('00:59M');
  });

  it('switches to hours at exactly one hour', () => {
    expect(span('2026-08-13T04:00:00Z', '2026-08-13T05:00:00Z')).toBe('01:00H');
    expect(span('2026-08-13T04:00:00Z', '2026-08-13T05:22:00Z')).toBe('01:22H');
  });

  it('NEVER rolls into days — a three-day excursion is 72 hours', () => {
    // Deliberate: an hour count stays comparable between rows, "3d 04:00" does not.
    expect(span('2026-08-10T04:00:00Z', '2026-08-13T04:00:00Z')).toBe('72:00H');
    expect(span('2026-08-10T04:00:00Z', '2026-08-13T08:30:00Z')).toBe('76:30H');
  });

  it('floors partial minutes rather than rounding up to a minute that did not pass', () => {
    expect(span('2026-08-13T04:00:00Z', '2026-08-13T04:00:59Z')).toBe('00:00M');
  });

  it('says nothing for an alarm that has not cleared', () => {
    // There is no span to state yet; a running total would look settled.
    expect(span('2026-08-13T04:00:00Z', null)).toBe('—');
  });

  it('refuses reversed or unparseable timestamps instead of showing a negative', () => {
    expect(span('2026-08-13T05:00:00Z', '2026-08-13T04:00:00Z')).toBe('—');
    expect(span('not-a-date', '2026-08-13T04:00:00Z')).toBe('—');
  });
});
