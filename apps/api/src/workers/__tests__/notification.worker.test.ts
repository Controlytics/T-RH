import { describe, it, expect, vi, beforeEach } from 'vitest';

const dispatch = vi.fn();
vi.mock('../../modules/notification-delivery/notification-dispatcher.js', () => ({
  dispatchNotification: (...args: unknown[]) => dispatch(...args),
}));

const { notificationTask } = await import('../notification.worker.js');
const { EVENT_TYPE_META } = await import('../../modules/notification-rules/routes.js');
const { ALARM_EVENT_VARIABLES, alarmNotificationJob } = await import('../../modules/alarms/notify.js');

const helpers = () => ({ logger: { info: vi.fn(), error: vi.fn() } });

beforeEach(() => dispatch.mockReset());

describe('notificationTask', () => {
  it('dispatches an event payload', async () => {
    const job = alarmNotificationJob('raised', {
      alarmId: 'a1', instrumentId: 'i1', instrumentCode: 'CWH-I/142',
      metric: 'TEMPERATURE', severity: 'MAJOR', ruleName: 'Cold room high',
      condition: 'temperature above 25', triggeredValue: 27.4,
      raisedAt: new Date('2026-08-14T04:00:00Z'),
    });
    await notificationTask(job, helpers() as never, {} as never);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ eventType: 'ALARM_RAISED' });
  });

  it('DRAINS a legacy payload instead of failing it', async () => {
    // Rows from before the 2026-05-17 rule-chain/alarm removal may still be queued.
    // Throwing would retry three times and then park them forever.
    const h = helpers();
    await notificationTask(
      { type: 'ALARM_CREATED', title: 'old', message: 'stale row' },
      h as never, {} as never,
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.logger.info).toHaveBeenCalled();
  });

  it('drains junk rather than throwing', async () => {
    await notificationTask({ nonsense: true }, helpers() as never, {} as never);
    await notificationTask(null, helpers() as never, {} as never);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('lets a dispatch failure THROW so graphile-worker retries it', async () => {
    // Moving delivery onto the queue is pointless if the handler swallows failures —
    // a dropped alarm notification is what this feature exists to prevent.
    dispatch.mockRejectedValueOnce(new Error('smtp down'));
    await expect(
      notificationTask({ eventType: 'ALARM_RAISED', context: {}, variables: {} }, helpers() as never, {} as never),
    ).rejects.toThrow('smtp down');
  });
});

describe('the alarm event types are registered consistently', () => {
  it('appear in EVENT_TYPE_META, which drives the rules picker', () => {
    // Without this a rule simply cannot be created for an alarm, and the whole feature
    // is unreachable from the UI.
    expect(EVENT_TYPE_META.ALARM_RAISED).toBeDefined();
    expect(EVENT_TYPE_META.ALARM_CLEARED).toBeDefined();
    expect(EVENT_TYPE_META.ALARM_RAISED.module).toBe('alarms');
  });

  it('promise exactly the variables the payload actually produces', () => {
    // The registries are hand-written in five places. A variable advertised here but
    // never produced renders as an empty cell in the email an inspector reads.
    for (const [eventType, promised] of Object.entries(ALARM_EVENT_VARIABLES)) {
      expect(EVENT_TYPE_META[eventType].variables.slice().sort()).toEqual([...promised].sort());
    }
  });

  it('every promised variable is non-empty in a real payload', () => {
    const raised = alarmNotificationJob('raised', {
      alarmId: 'a1', instrumentId: 'i1', instrumentCode: 'C1', metric: 'TEMPERATURE',
      severity: 'MAJOR', ruleName: 'r', condition: 'temperature above 25',
      triggeredValue: 27, raisedAt: new Date('2026-08-14T04:00:00Z'),
    });
    for (const key of EVENT_TYPE_META.ALARM_RAISED.variables) {
      expect(raised.variables[key], `ALARM_RAISED.${key}`).toBeTruthy();
    }
  });
});
