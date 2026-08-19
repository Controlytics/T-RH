import { describe, it, expect } from 'vitest';
import {
  alarmNotificationJob, durationMinutes, formatDuration, ALARM_EVENT_VARIABLES,
  type AlarmNotificationInput,
} from '../notify.js';

const input = (over: Partial<AlarmNotificationInput> = {}): AlarmNotificationInput => ({
  alarmId: 'al-1',
  instrumentId: 'uuid-1',
  instrumentCode: 'CWH-I/142',
  instrumentName: 'Cold room probe',
  metric: 'TEMPERATURE',
  severity: 'MAJOR',
  ruleName: 'Cold room high',
  condition: 'temperature above 25',
  triggeredValue: 27.4,
  raisedAt: new Date('2026-08-14T04:00:00Z'),
  clearedAt: null,
  ...over,
});

describe('alarmNotificationJob — raised', () => {
  it('carries every variable the rules UI advertises', () => {
    const job = alarmNotificationJob('raised', input());
    expect(job.eventType).toBe('ALARM_RAISED');
    for (const key of ALARM_EVENT_VARIABLES.ALARM_RAISED) {
      expect(job.variables[key], `missing variable ${key}`).toBeTruthy();
    }
  });

  it('stamps the raise time, not now', () => {
    expect(alarmNotificationJob('raised', input()).variables.timestamp).toBe('2026-08-14T04:00:00.000Z');
  });

  it('puts severity and metric in the context a rule filters on', () => {
    // Without these a rule saying "CRITICAL only" would match everything.
    const job = alarmNotificationJob('raised', input({ severity: 'CRITICAL' }));
    expect(job.context).toMatchObject({ severity: 'CRITICAL', metric: 'TEMPERATURE' });
  });
});

describe('alarmNotificationJob — cleared', () => {
  it('reports how long the excursion lasted', () => {
    const job = alarmNotificationJob('cleared', input({
      clearedAt: new Date('2026-08-14T06:30:00Z'),
    }));
    expect(job.eventType).toBe('ALARM_CLEARED');
    expect(job.variables.duration).toBe('2 h 30 min');
    expect(job.variables.raisedAt).toBe('2026-08-14T04:00:00.000Z');
    expect(job.variables.timestamp).toBe('2026-08-14T06:30:00.000Z');
  });

  it('carries every variable the rules UI advertises', () => {
    const job = alarmNotificationJob('cleared', input({ clearedAt: new Date('2026-08-14T04:10:00Z') }));
    for (const key of ALARM_EVENT_VARIABLES.ALARM_CLEARED) {
      expect(job.variables[key], `missing variable ${key}`).toBeTruthy();
    }
  });

  it('survives a missing clear time rather than producing NaN', () => {
    const job = alarmNotificationJob('cleared', input({ clearedAt: null }));
    expect(job.variables.duration).toBe('0 min');
    expect(job.variables.timestamp).toBe('2026-08-14T04:00:00.000Z');
  });
});

describe('the reading', () => {
  it('shows zero as a reading, not as missing', () => {
    // 0 °C is a real cold-room value; a falsy check would erase it from the email.
    // Quoted at the instrument's precision; this input carries none, so the
    // shipped default of one decimal applies.
    expect(alarmNotificationJob('raised', input({ triggeredValue: 0 })).variables.value).toBe('0.0');
  });

  it("quotes the reading at the instrument's own precision, as the dashboard does", () => {
    // An email that says 27.4 for a probe whose dashboard cell says 27 is one
    // excursion described two ways in two regulated records.
    expect(alarmNotificationJob('raised', input({ triggeredValue: 27.44, decimals: 0 }))
      .variables.value).toBe('27');
    expect(alarmNotificationJob('raised', input({ triggeredValue: 27.44, decimals: 2 }))
      .variables.value).toBe('27.44');
  });

  it('falls back to the default when no precision was supplied', () => {
    expect(alarmNotificationJob('raised', input({ triggeredValue: 27.44 }))
      .variables.value).toBe('27.4');
  });

  it('shows a dash when there is no value — OFFLINE has none', () => {
    expect(alarmNotificationJob('raised', input({ metric: 'OFFLINE', triggeredValue: null })).variables.value).toBe('—');
  });
});

describe('the instrument label', () => {
  it('falls back to the id rather than sending a blank name', () => {
    const job = alarmNotificationJob('raised', input({ instrumentCode: null, instrumentName: null }));
    expect(job.variables.instrument).toBe('uuid-1');
    expect(job.variables.instrumentName).toBe('uuid-1');
  });
});

describe('duration formatting', () => {
  it('floors to whole minutes', () => {
    const a = new Date('2026-08-14T04:00:00Z');
    expect(durationMinutes(a, new Date('2026-08-14T04:00:59Z'))).toBe(0);
    expect(formatDuration(a, new Date('2026-08-14T04:00:59Z'))).toBe('0 min');
    expect(formatDuration(a, new Date('2026-08-14T05:00:00Z'))).toBe('1 h');
    expect(formatDuration(a, new Date('2026-08-14T05:01:00Z'))).toBe('1 h 1 min');
  });

  it('never reports a negative duration if the clocks disagree', () => {
    const a = new Date('2026-08-14T04:00:00Z');
    expect(formatDuration(a, new Date('2026-08-14T03:00:00Z'))).toBe('0 min');
  });
});
