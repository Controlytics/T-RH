import { describe, it, expect } from 'vitest';
import {
  needsAcknowledgement, tabFor, conditionText, triggeredText,
  instrumentLabel, ackReasonError, MIN_ACK_REASON, MAX_ACK_REASON,
  quadrantFor, ALARM_QUADRANTS,
  alarmDurationText,
  locationText, breachDirection, quadrantTone, QUADRANT_TONE,
  ALARM_TYPE_OPTIONS, localInputToIso,
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

  it('assigns every alarm to exactly one of the four states', () => {
    // The server counts each state separately (modules/alarms/list-query.ts) and
    // DERIVES the total by summing them. That is only correct while the four
    // states partition the set — which this asserts on the display side too, since
    // the same four ids drive the cards.
    const rows = [
      alarm({ id: 'au' }),
      alarm({ id: 'aa', ...acked }),
      alarm({ id: 'cu', ...cleared }),
      alarm({ id: 'ca', ...cleared, ...acked }),
    ];
    const seen = rows.map((r) => quadrantFor(r));
    expect(new Set(seen).size).toBe(4);
    expect(seen.every((q) => ALARM_QUADRANTS.some((x) => x.id === q))).toBe(true);
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

describe('locationText', () => {
  it('names the functional location', () => {
    expect(locationText(alarm({ locationName: 'Blender Area' }))).toBe('Blender Area');
  });

  it('says Unassigned rather than leaving the cell blank', () => {
    // A blank cell reads as a rendering fault. An instrument with no functional
    // location is a real, normal state and should say so.
    expect(locationText(alarm({ locationName: null }))).toBe('Unassigned');
    expect(locationText(alarm({ locationName: '   ' }))).toBe('Unassigned');
  });
});

describe('breachDirection', () => {
  it('reads the direction the server recorded, for a limit alarm', () => {
    expect(breachDirection(alarm({ limitKind: 'HIGH' }))).toBe('high');
    expect(breachDirection(alarm({ limitKind: 'LOW' }))).toBe('low');
  });

  it('falls back to the frozen snapshot for a rule alarm', () => {
    expect(breachDirection(alarm({ limitKind: null, ruleSnapshot: { comparison: 'BELOW' } }))).toBe('low');
    expect(breachDirection(alarm({ limitKind: null, ruleSnapshot: { comparison: 'ABOVE' } }))).toBe('high');
  });

  it('says nothing rather than guessing when neither is recorded', () => {
    // Comparing triggeredValue against the limit here would be re-deriving a
    // decision the evaluator already made, which is how the two drift apart.
    expect(breachDirection(alarm({
      limitKind: null, triggeredValue: 99, ruleSnapshot: { comparison: 'OUTSIDE_RANGE', thresholdLow: 1, thresholdHigh: 2 },
    }))).toBe('none');
  });
});

describe('quadrantTone', () => {
  it('paints a cleared-but-unsigned alarm as a warning, not as neutral', () => {
    // The overnight excursion nobody answered for. It is the one row on the page
    // that most needs not to look finished.
    expect(quadrantTone({ state: 'CLEARED', acknowledgedAt: null })).toBe('warn');
  });

  it('reserves the loudest tone for the alarm nobody has answered yet', () => {
    expect(quadrantTone({ state: 'ACTIVE', acknowledgedAt: null })).toBe('danger');
  });

  it('gives a signed-for live alarm the calm tone, and a closed one the settled tone', () => {
    expect(quadrantTone({ state: 'ACTIVE', acknowledgedAt: '2026-08-27T10:00:00Z' })).toBe('info');
    expect(quadrantTone({ state: 'CLEARED', acknowledgedAt: '2026-08-27T10:00:00Z' })).toBe('ok');
  });

  it('gives all four states a distinct tone', () => {
    expect(new Set(ALARM_QUADRANTS.map((q) => QUADRANT_TONE[q.id])).size).toBe(4);
  });
});

describe('ALARM_TYPE_OPTIONS', () => {
  it('offers only tokens the API recognises', () => {
    // The server rejects an unknown token with a 400. A dropdown that could offer
    // one would look like the filter was broken.
    const serverTokens = ['TEMP_HIGH', 'TEMP_LOW', 'RH_HIGH', 'RH_LOW', 'OFFLINE', 'RULE'];
    expect(ALARM_TYPE_OPTIONS.map((o) => o.value)).toEqual(serverTokens);
  });

  it('labels each token the way the Type column renders it', () => {
    const high = alarm({ source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH', metric: 'TEMPERATURE' });
    expect(ALARM_TYPE_OPTIONS.find((o) => o.value === 'TEMP_HIGH')!.label).toBe(alarmTypeText(high));
  });
});

describe('localInputToIso', () => {
  it('resolves the browser wall-clock value to an instant', () => {
    // `datetime-local` yields zoneless text. Sent raw, the server would resolve it
    // in ITS timezone, so the same typed range would select a different window
    // once the API moved to another machine.
    const iso = localInputToIso('2026-08-27T00:00');
    expect(iso).toBe(new Date(2026, 7, 27, 0, 0, 0).toISOString());
  });

  it('treats an empty or unreadable value as no bound at all', () => {
    expect(localInputToIso('')).toBeUndefined();
    expect(localInputToIso('not a date')).toBeUndefined();
  });
});
