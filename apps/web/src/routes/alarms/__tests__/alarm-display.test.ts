import { describe, it, expect } from 'vitest';
import {
  needsAcknowledgement, tabFor, conditionText, triggeredText, clearedText,
  mapInactivityTextsResponse,
  instrumentLabel, ackReasonError, MIN_ACK_REASON, MAX_ACK_REASON,
  quadrantFor, ALARM_QUADRANTS,
  alarmDurationText,
  locationText, breachDirection, quadrantTone, QUADRANT_TONE,
  ALARM_TYPE_OPTIONS, alarmTypeOptions, localInputToIso,
  type AlarmRow,
} from '../alarm-display';

const alarm = (over: Partial<AlarmRow> = {}): AlarmRow => ({
  id: 'a1',
  instrumentCode: 'CWH-I/142',
  instrumentId: 'uuid-1',
  metric: 'TEMPERATURE',
  triggeredValue: 27.4,
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
  metric: 'TEMPERATURE', triggeredValue: 26.4,
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
  //   severity, snapshotAt }. That stored shape still carries `severity` — it is a
  //   frozen §11 snapshot and is not rewritten — even though nothing reads it now.
  //   limitText must fall back to comparison/thresholds.
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
    // Mirrors ALARM_TYPE_TOKENS in `apps/api/src/modules/alarms/list-query.ts`,
    // IN ORDER. This list is hand-copied on purpose — the web app does not import
    // the API's constant — so this assertion is the only thing standing between a
    // renamed token and a dropdown that 400s.
    const serverTokens = ['TEMP_HIGH', 'TEMP_LOW', 'RH_HIGH', 'RH_LOW', 'OFFLINE', 'RS485', 'RANGE'];
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


describe('inactivity alarms', () => {
  const inactivity = (over: Partial<AlarmRow> = {}) => alarm({
    source: 'INACTIVITY',
    metric: 'OFFLINE',
    limitKind: null,
    triggeredValue: null,
    clearedValue: null,
    ruleSnapshot: { kind: 'INACTIVITY', graceMinutes: 15, description: 'no telemetry for more than 15 minutes' },
    ...over,
  });

  /**
   * The operator asked for the NUMBER over the wording (2026-09-01): a word says
   * the instrument came back, the reading says what it came back reading. The
   * wording is not gone — it is the fallback for a clear with no number, which
   * includes every inactivity alarm cleared before the worker began recording
   * one, whose value cannot be invented after the fact on a §11 record.
   */
  describe('cleared value — the reading that ended the outage', () => {
    const resumed = (over = {}) => inactivity({
      state: 'CLEARED',
      clearedAt: '2026-08-13T05:00:00Z',
      clearedValue: 22.46,
      ruleSnapshot: {
        kind: 'INACTIVITY', graceMinutes: 15,
        clearedSlot: 'temperature', clearedKey: 'temperature', clearedDecimals: 1,
      },
      ...over,
    });

    it('prints the resuming reading instead of the wording', () => {
      // 22.46 not 22.45: the latter is stored as 22.4499... so it rounds DOWN,
      // which would make this test about float representation rather than about
      // the column showing a number at all.
      expect(clearedText(resumed())).toBe('22.5');
    });

    it('prints it at the RESUMING slot precision, not the precision it was raised with', () => {
      // A humidity resume carries humidity precision. Falling back to
      // `alarmDecimals` here would state a real number to the wrong resolution.
      const rh = resumed({
        clearedValue: 51.28,
        ruleSnapshot: {
          kind: 'INACTIVITY', graceMinutes: 15, decimals: 3,
          clearedSlot: 'humidity', clearedKey: 'humidity', clearedDecimals: 0,
        },
      });
      expect(clearedText(rh)).toBe('51');
    });

    it('falls back to the administered wording when no number was recorded', () => {
      // Every inactivity alarm cleared before 2026-09-01 is this row.
      expect(clearedText(resumed({ clearedValue: null }))).toBe('Data resumed');
      expect(clearedText(resumed({ clearedValue: null }), {
        generatedValue: 'x', limit: 'y', clearedValue: 'Back online',
      })).toBe('Back online');
    });

    it('keeps 0 as a real reading, never as "no value"', () => {
      // 0 °C is a reading. A falsy check here would print the wording over it.
      expect(clearedText(resumed({ clearedValue: 0 }))).toBe('0.0');
    });

    it('still shows a dash while the alarm is OPEN, whatever is stored', () => {
      // The instrument has not come back. Neither a number nor "resumed" is true.
      expect(clearedText(resumed({ state: 'ACTIVE', clearedAt: null }))).toBe('—');
    });
  });

  it('is called Inactivity in the Type column', () => {
    // Checked before the limit branch. Its metric is OFFLINE with no limitKind,
    // so it would otherwise fall to conditionText() and read "offline out of
    // limit" — which is not a limit and not what was asked for.
    expect(alarmTypeText(inactivity())).toBe('Inactivity');
  });

  it('states the silence it breached, not a temperature bound', () => {
    expect(limitText(inactivity())).toBe('quiet > 15m');
  });

  it('reads the grace from the FROZEN snapshot', () => {
    // Lengthening the grace today must not rewrite what a past outage says it
    // breached — the same rule as an instrument limit.
    expect(limitText(inactivity({ ruleSnapshot: { kind: 'INACTIVITY', graceMinutes: 60 } }))).toBe('quiet > 60m');
  });

  it('says nothing rather than inventing a bound when the snapshot has no grace', () => {
    expect(limitText(inactivity({ ruleSnapshot: { kind: 'INACTIVITY' } }))).toBe('—');
  });

  it('says No data rather than a dash, because it was raised by the absence of a reading', () => {
    // There is no number and never will be — `triggeredValue` is null by design.
    // A bare dash there reads as a rendering fault on a §11 table.
    expect(triggeredText(inactivity())).toBe('No data');
  });

  it('says Data resumed only once it has actually cleared', () => {
    expect(clearedText(inactivity({ state: 'CLEARED', clearedAt: '2026-08-13T05:00:00Z' }))).toBe('Data resumed');
    // Still open: the instrument has NOT come back, and "Data resumed" on an open
    // outage states the opposite of what the row means.
    expect(clearedText(inactivity())).toBe('—');
  });

  describe('the three column wordings are administered', () => {
    const texts = { generatedValue: 'Silent', limit: 'no signal {minutes}m', clearedValue: 'Back online' };

    it('uses the configured wording in all three cells', () => {
      expect(triggeredText(inactivity(), texts)).toBe('Silent');
      expect(limitText(inactivity(), texts)).toBe('no signal 15m');
      expect(clearedText(inactivity({ state: 'CLEARED', clearedAt: '2026-08-13T05:00:00Z' }), texts)).toBe('Back online');
    });

    it('substitutes the FROZEN grace, not the one configured today', () => {
      const old = inactivity({ ruleSnapshot: { kind: 'INACTIVITY', graceMinutes: 60 } });
      expect(limitText(old, texts)).toBe('no signal 60m');
    });

    it('REFUSES a Limit wording with no {minutes} placeholder', () => {
      // Honouring it would delete the threshold this alarm fired against from a
      // regulated record, by typing over it in a config box.
      expect(limitText(inactivity(), { ...texts, limit: 'no signal' })).toBe('quiet > 15m');
    });

    it('falls back to the shipped wording when a field is blank or absent', () => {
      // An admin clearing a field must not be able to put an empty cell back.
      expect(triggeredText(inactivity(), { generatedValue: '   ' })).toBe('No data');
      expect(triggeredText(inactivity(), {})).toBe('No data');
      expect(clearedText(inactivity({ state: 'CLEARED', clearedAt: '2026-08-13T05:00:00Z' }), {})).toBe('Data resumed');
      expect(limitText(inactivity(), {})).toBe('quiet > 15m');
    });

    it('leaves every other alarm source untouched', () => {
      // The texts argument is inert on a limit alarm — it must not reword a row
      // that has real numbers to show.
      const limit = alarm({
        source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH', triggeredValue: 27.4, clearedValue: 24.1,
        state: 'CLEARED', clearedAt: '2026-08-13T05:00:00Z',
        ruleSnapshot: { limit: 25, limitKind: 'HIGH', decimals: 1 },
      });
      expect(triggeredText(limit, texts)).toBe('27.4');
      expect(limitText(limit, texts)).toBe('> 25.0');
      expect(clearedText(limit, texts)).toBe('24.1');
    });

    it('maps the API payload onto the display contract', () => {
      // The ONE place the `text*`-prefixed wire keys meet the unprefixed display
      // names — a rename on either side fails here rather than silently leaving
      // every row on the shipped wording forever.
      expect(mapInactivityTextsResponse({
        textGeneratedValue: 'Silent', textLimit: 'no signal {minutes}m', textClearedValue: 'Back online',
      })).toEqual(texts);
    });
  });

  it('takes the same four state tones as every other alarm', () => {
    // The status axis is independent of the source: an outage that ended without
    // a signature is the same unfinished paperwork as an excursion that did.
    expect(quadrantTone(inactivity({ state: 'CLEARED', acknowledgedAt: null }))).toBe('warn');
    expect(quadrantTone(inactivity({ state: 'ACTIVE', acknowledgedAt: null }))).toBe('danger');
  });

  it('is reachable from the type filter under one token, with both sources', () => {
    // `OFFLINE` matches on metric, so it catches the automatic inactivity alarms
    // AND any rule-based offline alarm. Two tokens would make an operator choose
    // between two spellings of one question.
    const offline = ALARM_TYPE_OPTIONS.find((o) => o.value === 'OFFLINE')!;
    expect(offline.label).toBe('Inactivity');
  });
});

describe('RS485 sensor-failure alarms', () => {
  const rs485 = (over: Partial<AlarmRow> = {}) => alarm({
    source: 'RS485_FAILURE',
    metric: 'TEMPERATURE',
    limitKind: null,
    triggeredValue: null,
    clearedValue: null,
    ruleSnapshot: {
      kind: 'RS485', metric: 'TEMPERATURE', key: 'temperature',
      rawValue: 'NA', valueType: 'string', decimals: 1,
      description: 'temperature reported NA instead of a number',
    },
    ...over,
  });

  const rs485Humidity = (over: Partial<AlarmRow> = {}) => rs485({
    metric: 'HUMIDITY',
    ruleSnapshot: {
      kind: 'RS485', metric: 'HUMIDITY', key: 'humidity',
      rawValue: 'NA', valueType: 'string', decimals: 1,
      description: 'humidity reported NA instead of a number',
    },
    ...over,
  });

  it('names the failed sensor in the Type column', () => {
    expect(alarmTypeText(rs485())).toBe('RS485 Temperature Failure');
    expect(alarmTypeText(rs485Humidity())).toBe('RS485 Humidity Failure');
  });

  it('does NOT read as a limit breach', () => {
    // The bug this guards. An RS485 alarm's metric is TEMPERATURE — the same
    // value a limit alarm carries — so a source check that ran after the limit
    // branch would label a dead probe "High Temperature", naming a breach that
    // never happened.
    expect(alarmTypeText(rs485())).not.toContain('High');
    expect(alarmTypeText(rs485())).not.toContain('Low');
  });

  it('shows the administered failure word as the generated value', () => {
    // NOT the raw text the sensor sent. That was the original design and it was
    // reversed on 2026-08-31: the raw text is almost always `NA`, which is what
    // the dashboard ALREADY shows for a slot with no reading — so a dead probe
    // and an instrument nobody had wired up read identically in the one column
    // that exists to tell them apart.
    expect(triggeredText(rs485(), { sensorFailure: 'Error' })).toBe('Error');
    expect(triggeredText(rs485(), { sensorFailure: 'SENSOR FAULT' })).toBe('SENSOR FAULT');
  });

  it('falls back to the shipped word, never to a blank or to the raw value', () => {
    // Not loaded yet, and an admin who cleared the field: both show `Error`. An
    // empty value cell on a monitoring page reads as "nothing is wrong".
    expect(triggeredText(rs485())).toBe('Error');
    expect(triggeredText(rs485(), { sensorFailure: '   ' })).toBe('Error');
  });

  it('takes the RS485 word, not the inactivity one, from the same texts bag', () => {
    // One object carries every source's wording; each source must read its own
    // key. Crossing them would put "No data" on a failed sensor.
    const texts = {
      generatedValue: 'Silent', limit: 'x {minutes}m', clearedValue: 'Back',
      sensorFailure: 'Error',
    };
    expect(triggeredText(rs485(), texts)).toBe('Error');
    expect(triggeredText(alarm({
      source: 'INACTIVITY', metric: 'OFFLINE', triggeredValue: null,
      ruleSnapshot: { kind: 'INACTIVITY', graceMinutes: 15 },
    }), texts)).toBe('Silent');
  });

  it('does not depend on the snapshot carrying the raw value', () => {
    // The evidence still LIVES on the snapshot and is printed in the condition,
    // the notification and the webhook — but the cell no longer reads from it,
    // so a row raised before `rawValue` existed still renders the word.
    expect(triggeredText(rs485({ ruleSnapshot: { kind: 'RS485' } }), { sensorFailure: 'Error' })).toBe('Error');
  });

  it('states the expectation that was breached in the Limit column', () => {
    expect(limitText(rs485())).toBe('numeric');
    // A constant, not one of the administered inactivity wordings.
    expect(limitText(rs485(), { limit: 'no signal {minutes}m' })).toBe('numeric');
  });

  it('shows the REAL reading that cleared it, at the frozen precision', () => {
    // Unlike an inactivity alarm, this one clears because a number arrived — so
    // the Cleared Value column is a measurement, not a wording.
    const closed = rs485({ state: 'CLEARED', clearedAt: '2026-08-31T05:00:00Z', clearedValue: 21.46 });
    expect(clearedText(closed)).toBe('21.5');
  });

  it('paints the value neutrally — it broke in no direction', () => {
    expect(breachDirection(rs485())).toBe('none');
  });

  it('takes the same four state tones as every other alarm', () => {
    expect(quadrantTone(rs485({ state: 'CLEARED', acknowledgedAt: null }))).toBe('warn');
    expect(quadrantTone(rs485({ state: 'ACTIVE', acknowledgedAt: null }))).toBe('danger');
  });

  it('is reachable from the type filter under ONE token covering both metrics', () => {
    // ONE token, so its label names BOTH metrics — the option's wording is
    // derived from the two administered type names rather than hardcoded.
    const opt = ALARM_TYPE_OPTIONS.find((o) => o.value === 'RS485')!;
    expect(opt.label).toBe('RS485 Temperature Failure / RS485 Humidity Failure');
  });
});

describe('Sensor range failures — OL, and not a limit breach', () => {
  const range = (over: Partial<AlarmRow> = {}) => alarm({
    source: 'SENSOR_RANGE',
    metric: 'TEMPERATURE',
    limitKind: null,
    triggeredValue: 60,
    clearedValue: null,
    ruleSnapshot: {
      kind: 'SENSOR_RANGE', metric: 'TEMPERATURE', key: 'temperature',
      reading: 60, rangeLow: -40, rangeHigh: 50, decimals: 1,
      description: 'temperature 60.0 is outside the sensor range -40 to 50',
    },
    ...over,
  });

  it('is named Temperature Failure / Humidity Failure', () => {
    expect(alarmTypeText(range())).toBe('Temperature Failure');
    expect(alarmTypeText(range({
      metric: 'HUMIDITY',
      ruleSnapshot: { kind: 'SENSOR_RANGE', metric: 'HUMIDITY', rangeLow: 0, rangeHigh: 100 },
    }))).toBe('Humidity Failure');
  });

  it('does NOT read as a limit breach', () => {
    // The bug this guards. Its metric is TEMPERATURE and 60 really is above the
    // 25 limit — but the system deliberately declined to call that excursion,
    // so the row must not label it one.
    expect(alarmTypeText(range())).not.toContain('High');
  });

  it('shows OL, not the unusable number', () => {
    // The reading IS a number and is deliberately withheld: the finding is that
    // the sensor cannot stand behind it.
    expect(triggeredText(range(), { outOfRange: 'OL' })).toBe('OL');
    expect(triggeredText(range())).toBe('OL');
    expect(triggeredText(range(), { outOfRange: '   ' })).toBe('OL');
  });

  it('takes the range word, not the RS485 one, from the same bag', () => {
    const texts = { sensorFailure: 'Error', outOfRange: 'OL' };
    expect(triggeredText(range(), texts)).toBe('OL');
    expect(triggeredText(alarm({
      source: 'RS485_FAILURE', triggeredValue: null,
      ruleSnapshot: { kind: 'RS485', rawValue: 'NA' },
    }), texts)).toBe('Error');
  });

  it('states the SPAN it left in the Limit column, from the frozen snapshot', () => {
    expect(limitText(range())).toBe('-40 – 50');
    expect(limitText(range({
      ruleSnapshot: { kind: 'SENSOR_RANGE', rangeLow: null, rangeHigh: 50 },
    }))).toBe('> 50');
    expect(limitText(range({ ruleSnapshot: { kind: 'SENSOR_RANGE' } }))).toBe('—');
  });

  it('shows the real reading that cleared it', () => {
    const closed = range({ state: 'CLEARED', clearedAt: '2026-08-31T05:00:00Z', clearedValue: 21.46 });
    expect(clearedText(closed)).toBe('21.5');
  });

  it('is reachable from the type filter under its own token', () => {
    // Its own, not shared with RS485: "the probe is saturated" and "the probe is
    // sending nonsense" send an engineer to check different things.
    const opt = ALARM_TYPE_OPTIONS.find((o) => o.value === 'RANGE')!;
    expect(opt.label).toBe('Temperature Failure / Humidity Failure');
  });
});

describe('alarm type names are administered in ONE place', () => {
  // Renaming a type must reach the Type column, the Type filter, the trend
  // widget and the signed PDF. Before this they were four hardcoded lists.
  const names = {
    limitTemperatureHigh: 'Temp Too Hot',
    inactivity: 'Silent',
    rs485Temperature: 'Temp Probe Fault',
    rangeTemperature: 'Temp Over-range',
  };

  const of = (over: Partial<AlarmRow>) => alarm({ triggeredValue: null, ...over });

  it('renames a limit alarm in the Type column', () => {
    const a = of({ source: 'INSTRUMENT_LIMIT', metric: 'TEMPERATURE', limitKind: 'HIGH' });
    expect(alarmTypeText(a)).toBe('High Temperature');
    expect(alarmTypeText(a, { typeNames: names })).toBe('Temp Too Hot');
  });

  it('renames every other source the same way', () => {
    expect(alarmTypeText(of({ source: 'INACTIVITY', metric: 'OFFLINE' }), { typeNames: names })).toBe('Silent');
    expect(alarmTypeText(of({ source: 'RS485_FAILURE', metric: 'TEMPERATURE', limitKind: null }), { typeNames: names })).toBe('Temp Probe Fault');
    expect(alarmTypeText(of({ source: 'SENSOR_RANGE', metric: 'TEMPERATURE', limitKind: null }), { typeNames: names })).toBe('Temp Over-range');
  });

  it('leaves a bound the operator did NOT rename on its shipped name', () => {
    const low = of({ source: 'INSTRUMENT_LIMIT', metric: 'TEMPERATURE', limitKind: 'LOW' });
    expect(alarmTypeText(low, { typeNames: names })).toBe('Low Temperature');
  });

  it('falls back to the shipped name for a blank one', () => {
    const a = of({ source: 'INACTIVITY', metric: 'OFFLINE' });
    expect(alarmTypeText(a, { typeNames: { inactivity: '   ' } })).toBe('Inactivity');
  });

  it('falls back to the snapshot name for a legacy RULE row', () => {
    // Authored rules were removed 2026-08-31 and nothing raises these any more,
    // but `AlarmSource.RULE` survives in the enum (Postgres cannot drop a value),
    // so the display must still name an old row sensibly rather than blank it.
    const rule = alarm({ source: 'RULE', ruleSnapshot: { name: 'Cold room high' } });
    expect(alarmTypeText(rule, { typeNames: names })).toBe('Cold room high');
  });

  it('labels the Type FILTER from the same names', () => {
    const opts = alarmTypeOptions(names);
    expect(opts.find((o) => o.value === 'TEMP_HIGH')!.label).toBe('Temp Too Hot');
    expect(opts.find((o) => o.value === 'OFFLINE')!.label).toBe('Silent');
    // One token covers both metrics, so its label names both.
    expect(opts.find((o) => o.value === 'RS485')!.label).toContain('Temp Probe Fault');
  });

  it('still offers exactly the tokens the API recognises', () => {
    // Renaming must not be able to change the VALUES — those are the server's
    // vocabulary and an unknown one is a 400.
    expect(alarmTypeOptions(names).map((o) => o.value))
      .toEqual(['TEMP_HIGH', 'TEMP_LOW', 'RH_HIGH', 'RH_LOW', 'OFFLINE', 'RS485', 'RANGE']);
  });
});
