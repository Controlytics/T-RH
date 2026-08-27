import { describe, it, expect } from 'vitest';
import { buildWebhookVariables, describeSnapshot, decimalsFromSnapshot } from '../build-variables.js';
import { ALARM_WEBHOOK_VARIABLES } from '@digilog/shared';

const base = {
  alarmId: 'A1',
  instrumentId: 'I1',
  instrumentCode: 'DEMO-TH-361',
  instrumentName: 'Stability chamber',
  metric: 'TEMPERATURE',
  severity: 'CRITICAL',
  ruleName: 'High temperature limit',
  condition: 'above 25',
  triggeredValue: 26.456,
  decimals: 2,
  raisedAt: new Date('2026-08-27T10:00:00.000Z'),
};

describe('buildWebhookVariables', () => {
  it('produces every variable RAISED promises', () => {
    const v = buildWebhookVariables('RAISED', base);
    for (const key of ALARM_WEBHOOK_VARIABLES.RAISED) expect(v).toHaveProperty(key);
  });

  it('produces every variable CLEARED promises', () => {
    const v = buildWebhookVariables('CLEARED', { ...base, clearedAt: new Date('2026-08-27T11:30:00.000Z') });
    for (const key of ALARM_WEBHOOK_VARIABLES.CLEARED) expect(v).toHaveProperty(key);
    expect(v.duration).toBe('1 h 30 min');
  });

  it('produces every variable ACKNOWLEDGED promises', () => {
    const v = buildWebhookVariables('ACKNOWLEDGED', { ...base, acknowledgedBy: 'jdoe', acknowledgeReason: 'door left open' });
    for (const key of ALARM_WEBHOOK_VARIABLES.ACKNOWLEDGED) expect(v).toHaveProperty(key);
    expect(v.acknowledgedBy).toBe('jdoe');
    expect(v.acknowledgeReason).toBe('door left open');
  });

  // Precision must match the dashboard and the email — one excursion, one number.
  it('formats the value to the instrument decimals', () => {
    expect(buildWebhookVariables('RAISED', base).value).toBe('26.46');
    expect(buildWebhookVariables('RAISED', { ...base, decimals: 0 }).value).toBe('26');
  });

  it('renders a missing value as an em dash, but keeps a real zero', () => {
    expect(buildWebhookVariables('RAISED', { ...base, triggeredValue: null }).value).toBe('—');
    expect(buildWebhookVariables('RAISED', { ...base, triggeredValue: 0, decimals: 1 }).value).toBe('0.0');
  });

  it('falls back to the instrument id when there is no code', () => {
    expect(buildWebhookVariables('RAISED', { ...base, instrumentCode: null }).instrument).toBe('I1');
  });

  it('every value is a string', () => {
    const v = buildWebhookVariables('RAISED', base);
    for (const val of Object.values(v)) expect(typeof val).toBe('string');
  });
});

describe('describeSnapshot', () => {
  it('describes a RULE snapshot via describeRule', () => {
    const snapshot = {
      ruleId: 'r1',
      name: 'High temperature limit',
      metric: 'TEMPERATURE',
      comparison: 'ABOVE',
      thresholdLow: null,
      thresholdHigh: 25,
      delaySeconds: 0,
      severity: 'CRITICAL',
      snapshotAt: '2026-08-27T10:00:00.000Z',
    };
    expect(describeSnapshot(snapshot)).toBe('temperature above 25');
  });

  it('describes an INSTRUMENT_LIMIT snapshot via describeLimit', () => {
    const snapshot = {
      source: 'INSTRUMENT_LIMIT',
      ruleId: null,
      name: 'TEMPERATURE HIGH limit',
      metric: 'TEMPERATURE',
      limitKind: 'HIGH',
      limit: 26,
      attributeKey: 'temp_high',
      decimals: 2,
      description: 'temperature above 26',
      snapshotAt: '2026-08-27T10:00:00.000Z',
    };
    expect(describeSnapshot(snapshot)).toBe('temperature above 26');
  });

  it('returns an empty string for garbage input rather than throwing', () => {
    expect(describeSnapshot(null)).toBe('');
    expect(describeSnapshot(undefined)).toBe('');
    expect(describeSnapshot('not an object')).toBe('');
    expect(describeSnapshot(42)).toBe('');
    expect(describeSnapshot([])).toBe('');
    expect(describeSnapshot({})).toBe('');
  });
});

describe('decimalsFromSnapshot', () => {
  it('reads decimals off an INSTRUMENT_LIMIT snapshot', () => {
    const snapshot = {
      source: 'INSTRUMENT_LIMIT',
      ruleId: null,
      name: 'TEMPERATURE HIGH limit',
      metric: 'TEMPERATURE',
      limitKind: 'HIGH',
      limit: 26,
      attributeKey: 'temp_high',
      decimals: 3,
      description: 'temperature above 26',
      snapshotAt: '2026-08-27T10:00:00.000Z',
    };
    expect(decimalsFromSnapshot(snapshot)).toBe(3);
  });

  it('returns null for a RULE snapshot, which carries no decimals', () => {
    const snapshot = {
      ruleId: 'r1',
      name: 'High temperature limit',
      metric: 'TEMPERATURE',
      comparison: 'ABOVE',
      thresholdLow: null,
      thresholdHigh: 25,
      delaySeconds: 0,
      severity: 'CRITICAL',
      snapshotAt: '2026-08-27T10:00:00.000Z',
    };
    expect(decimalsFromSnapshot(snapshot)).toBeNull();
  });

  it('returns null for garbage input rather than throwing', () => {
    expect(decimalsFromSnapshot(null)).toBeNull();
    expect(decimalsFromSnapshot(undefined)).toBeNull();
    expect(decimalsFromSnapshot('not an object')).toBeNull();
    expect(decimalsFromSnapshot(42)).toBeNull();
    expect(decimalsFromSnapshot([])).toBeNull();
  });
});
