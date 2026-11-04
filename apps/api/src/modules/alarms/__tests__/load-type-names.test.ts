import { describe, it, expect } from 'vitest';
import { ALARM_TYPE_NAME_DEFAULT } from '@digilog/shared';
import { alarmDisplayName } from '../load-type-names.js';

/**
 * The name an alarm is ANNOUNCED under (email, SMS, hooter). A RULE alarm
 * raised by a rule chain's Create alarm node (2026-11-03) is announced under
 * its own `ruleSnapshot.alarmType` — the same name the Alarms page shows
 * (shared `ruleAlarmTypeName`) — never as its metric, `CUSTOM`.
 */
const names: Record<string, string> = { ...ALARM_TYPE_NAME_DEFAULT, limitTemperatureHigh: 'Temp Too Hot' };

describe('alarmDisplayName', () => {
  it('a RULE alarm is announced under its snapshot alarmType', () => {
    expect(alarmDisplayName(names, 'RULE', 'CUSTOM', null, { alarmType: 'Door open', nodeId: 'n', chainId: 'c', details: {} }))
      .toBe('Door open');
  });

  it('a RULE alarm without a usable alarmType keeps the old fallback (its metric)', () => {
    expect(alarmDisplayName(names, 'RULE', 'CUSTOM', null, { name: 'Cold room' })).toBe('CUSTOM');
    expect(alarmDisplayName(names, 'RULE', 'CUSTOM', null)).toBe('CUSTOM');
  });

  it('the snapshot never renames another source', () => {
    expect(alarmDisplayName(names, 'INSTRUMENT_LIMIT', 'TEMPERATURE', 'HIGH', { alarmType: 'Door open' })).toBe('Temp Too Hot');
    expect(alarmDisplayName(names, 'INACTIVITY', 'OFFLINE', null, { alarmType: 'Door open' })).toBe(ALARM_TYPE_NAME_DEFAULT.inactivity);
  });

  it('callers that pass no snapshot are unchanged', () => {
    expect(alarmDisplayName(names, 'INSTRUMENT_LIMIT', 'HUMIDITY', 'LOW')).toBe(ALARM_TYPE_NAME_DEFAULT.limitHumidityLow);
  });
});
