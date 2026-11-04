import { describe, it, expect } from 'vitest';
import { alarmTypeKeyFor, ruleAlarmTypeName } from './alarm-type-names.js';

/**
 * A RULE alarm is named by the rule chain that raised it (rule chains,
 * 2026-11-03): its Create alarm node's `alarmType`, frozen on the row as
 * `ruleSnapshot.alarmType`. `ruleAlarmTypeName` is the ONE reader of that name;
 * the API's `alarmDisplayName` and the web's `alarmTypeText` both call it.
 */
describe('ruleAlarmTypeName', () => {
  it('reads a RULE alarm\'s snapshot alarmType, trimmed', () => {
    expect(ruleAlarmTypeName('RULE', { alarmType: 'Door open', nodeId: 'n', chainId: 'c', details: {} })).toBe('Door open');
    expect(ruleAlarmTypeName('RULE', { alarmType: '  High temp rule  ' })).toBe('High temp rule');
  });

  it('is null for every other source, whatever the snapshot carries', () => {
    for (const source of ['INSTRUMENT_LIMIT', 'INACTIVITY', 'RS485_FAILURE', 'SENSOR_RANGE', undefined]) {
      expect(ruleAlarmTypeName(source, { alarmType: 'Door open' })).toBeNull();
    }
  });

  it('is null for a RULE row without a usable alarmType (the legacy authored-rule rows carry `name`)', () => {
    expect(ruleAlarmTypeName('RULE', { name: 'Cold room high' })).toBeNull();
    expect(ruleAlarmTypeName('RULE', { alarmType: '   ' })).toBeNull();
    expect(ruleAlarmTypeName('RULE', { alarmType: 42 })).toBeNull();
    expect(ruleAlarmTypeName('RULE', null)).toBeNull();
    expect(ruleAlarmTypeName('RULE', undefined)).toBeNull();
    expect(ruleAlarmTypeName('RULE', ['Door open'])).toBeNull();
    expect(ruleAlarmTypeName('RULE', 'Door open')).toBeNull();
  });

  it('leaves the administered keys alone: a RULE alarm has no AlarmTypeKey', () => {
    expect(alarmTypeKeyFor('RULE', 'CUSTOM', null)).toBeNull();
    expect(alarmTypeKeyFor('INSTRUMENT_LIMIT', 'TEMPERATURE', 'HIGH')).toBe('limitTemperatureHigh');
  });
});
