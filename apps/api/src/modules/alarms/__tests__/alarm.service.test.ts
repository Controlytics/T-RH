import { describe, it, expect, vi, beforeEach } from 'vitest';

const repo = {
  loadThresholdCache: vi.fn(),
  loadOpenAlarms: vi.fn(),
  raiseAlarm: vi.fn(),
  rebreachAlarm: vi.fn(),
  resolveAlarm: vi.fn(),
  touchLiveness: vi.fn(),
};
const dispatch = vi.fn();
const audit = vi.fn();

// Spread the REAL module first so `seriesKey` / `alarmKey` keep their genuine
// implementations — the service imports them from here, and re-deriving the key
// format inside the mock would stop these tests from detecting a format change.
// The fixture cache below is keyed 'i1|temp', i.e. exactly seriesKey('i1','temp').
vi.mock('../alarm.repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../alarm.repository.js')>();
  return { ...actual, ...repo };
});
vi.mock('../../notification-delivery/notification-dispatcher.js', () => ({
  dispatchNotification: dispatch,
}));
vi.mock('../../../lib/audit.js', () => ({ auditLog: audit }));

const { evaluateFlush } = await import('../alarm.service.js');

const TS = new Date('2026-08-03T10:00:00.000Z');
const reading = (key: string, value: unknown) => ({ key, value, valueType: 'number' as const, ts: TS });

beforeEach(() => {
  vi.clearAllMocks();
  repo.loadOpenAlarms.mockResolvedValue(new Map());
  repo.raiseAlarm.mockResolvedValue({ id: 'a1' });
  repo.touchLiveness.mockResolvedValue(undefined);
  repo.loadThresholdCache.mockResolvedValue(new Map([
    ['i1|temp', [{ id: 't1', key: 'temp', operator: 'GT', limit: 100, limitLow: null, limitHigh: null, hysteresis: 0, severity: 'MAJOR' }]],
  ]));
});

describe('evaluateFlush', () => {
  it('raises an alarm and dispatches ALARM_RAISED', async () => {
    const res = await evaluateFlush([{ instrumentId: 'i1', readings: [reading('temp', 101)] }], TS);
    expect(res.raised).toBe(1);
    expect(repo.raiseAlarm).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ALARM_RAISED' }));
  });

  it('does not dispatch when the raise lost the unique-index race', async () => {
    repo.raiseAlarm.mockResolvedValue(null);
    const res = await evaluateFlush([{ instrumentId: 'i1', readings: [reading('temp', 101)] }], TS);
    expect(res.raised).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('skips readings with no threshold without touching the repository', async () => {
    await evaluateFlush([{ instrumentId: 'i1', readings: [reading('humidity', 999)] }], TS);
    expect(repo.raiseAlarm).not.toHaveBeenCalled();
  });

  it('skips non-numeric readings rather than coercing them', async () => {
    await evaluateFlush([{ instrumentId: 'i1', readings: [reading('temp', false)] }], TS);
    expect(repo.raiseAlarm).not.toHaveBeenCalled();
  });

  it('records last-seen for every instrument in the flush', async () => {
    await evaluateFlush([{ instrumentId: 'i1', readings: [reading('temp', 5)] }], TS);
    expect(repo.touchLiveness).toHaveBeenCalledWith(['i1'], TS);
  });

  it('raises SEPARATE alarms for a high and a low threshold on the same key', async () => {
    // Regression: with the alarm series keyed on (instrument, key) alone, a
    // reading of 105 raises on the GT spec and then satisfies the LT spec's
    // recovery test (105 >= 10) in the very same pass — resolving the alarm it
    // had just raised. The series must include the threshold.
    repo.loadThresholdCache.mockResolvedValue(new Map([
      ['i1|temp', [
        { id: 't1', key: 'temp', operator: 'GT', limit: 100, limitLow: null, limitHigh: null, hysteresis: 0, severity: 'MAJOR' },
        { id: 't2', key: 'temp', operator: 'LT', limit: 10, limitLow: null, limitHigh: null, hysteresis: 0, severity: 'CRITICAL' },
      ]],
    ]));

    const res = await evaluateFlush([{ instrumentId: 'i1', readings: [reading('temp', 105)] }], TS);
    expect(res.raised).toBe(1);
    expect(res.resolved).toBe(0);          // the LT spec must NOT resolve the GT alarm
    expect(repo.resolveAlarm).not.toHaveBeenCalled();

    // And a genuine low breach raises its OWN alarm rather than being swallowed.
    repo.raiseAlarm.mockResolvedValue({ id: 'a2' });
    const low = await evaluateFlush([{ instrumentId: 'i1', readings: [reading('temp', 5)] }], TS);
    expect(low.raised).toBe(1);
  });

  it('raises ONE alarm when a flush contains many breaches of the same series', async () => {
    // Within a single flush the cache says "no open alarm" for every reading.
    // Without in-flush bookkeeping this raises N times and N-1 of them lose the
    // unique-index race, producing N-1 pointless round-trips and zero counter bumps.
    await evaluateFlush([{
      instrumentId: 'i1',
      readings: [reading('temp', 101), reading('temp', 102), reading('temp', 103)],
    }], TS);
    expect(repo.raiseAlarm).toHaveBeenCalledOnce();
    expect(repo.rebreachAlarm).toHaveBeenCalledTimes(2);
  });
});
