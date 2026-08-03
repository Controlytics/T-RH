import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISPATCHER = path.resolve(__dirname, '../../notification-delivery/notification-dispatcher.ts');
const RULES = path.resolve(__dirname, '../../notification-rules/routes.ts');

/**
 * The variable keys the CONSUMERS expect for ALARM_RAISED, read out of their
 * source rather than restated here — a hand-copied list would drift in exactly
 * the way this test exists to prevent.
 *
 * Parsed as text because `EVENT_FIELDS` is a function-local const in
 * notification-dispatcher.ts and not importable. This mirrors the approach
 * already taken by notification-delivery/__tests__/event-type-coverage.test.ts.
 */
function dispatcherKeys(): string[] {
  const src = readFileSync(DISPATCHER, 'utf8');
  // Match only the EVENT_FIELDS entry — the array-of-pairs form. `ALARM_RAISED:`
  // also appears in EVENT_LABELS and in the email/in-app template maps.
  const line = /^\s*ALARM_RAISED:\s*\[\[.*$/m.exec(src)?.[0] ?? '';
  return [...line.matchAll(/\['[^']*','([^']*)'\]/g)].map(m => m[1]);
}

function rulesKeys(): string[] {
  const src = readFileSync(RULES, 'utf8');
  const line = /^\s*ALARM_RAISED:\s*\{.*$/m.exec(src)?.[0] ?? '';
  const arr = /variables:\s*\[([^\]]*)\]/.exec(line)?.[1] ?? '';
  return [...arr.matchAll(/'([^']+)'/g)].map(m => m[1]);
}


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
  // dispatchNotification is `async`, so the real one always returns a promise —
  // the service attaches .catch() to it. Mirror that contract here.
  dispatch.mockResolvedValue(undefined);
  repo.touchLiveness.mockResolvedValue(undefined);
  repo.loadThresholdCache.mockResolvedValue(new Map([
    ['i1|temp', [{ id: 't1', key: 'temp', instrumentName: 'Chamber A', operator: 'GT', limit: 100, limitLow: null, limitHigh: null, hysteresis: 0, severity: 'MAJOR' }]],
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
        { id: 't1', key: 'temp', instrumentName: 'Chamber A', operator: 'GT', limit: 100, limitLow: null, limitHigh: null, hysteresis: 0, severity: 'MAJOR' },
        { id: 't2', key: 'temp', instrumentName: 'Chamber A', operator: 'LT', limit: 10, limitLow: null, limitHigh: null, hysteresis: 0, severity: 'CRITICAL' },
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

  it('dispatches every variable key its consumers render', async () => {
    // Binds producer to consumer. The original defect: this service sent
    // `instrumentId` while every consumer reads `instrumentName`, so operators
    // got an email titled "[DigiLog] Alarm Raised: " and an in-app message
    // reading "Alarm on : temp = 105 (limit 100)". Nothing failed — the
    // template just interpolated a missing key to empty.
    //
    // Asserting `instrumentName` alone would not stop the NEXT divergence, so
    // this reads the consumers' own key lists and requires all of them.
    await evaluateFlush([{ instrumentId: 'i1', readings: [reading('temp', 101)] }], TS);
    const sent = dispatch.mock.calls[0][0].variables as Record<string, string>;

    const expected = [...new Set([...dispatcherKeys(), ...rulesKeys()])];
    // Guard against a silently vacuous test: if either regex stops matching,
    // `expected` empties and every assertion below passes for free.
    expect(expected).toContain('instrumentName');
    expect(expected.length).toBeGreaterThan(4);

    const missing = expected.filter(k => sent[k] === undefined || sent[k] === '');
    expect(missing).toEqual([]);
  });

  it('records last-seen even when no thresholds are configured', async () => {
    // Pins touchLiveness ahead of the `thresholds.size === 0` early return.
    // Liveness and thresholds are independent: an instrument on a site with no
    // limits configured must still be seen to be alive, or the liveness sweep
    // would report every such instrument as offline. Without this case the
    // early return could be moved above the liveness update and the existing
    // "records last-seen" test — which runs with a populated cache — would
    // still pass.
    repo.loadThresholdCache.mockResolvedValue(new Map());
    await evaluateFlush([{ instrumentId: 'i1', readings: [reading('temp', 101)] }], TS);
    expect(repo.touchLiveness).toHaveBeenCalledWith(['i1'], TS);
    expect(repo.raiseAlarm).not.toHaveBeenCalled();
  });

  it('a failing notification does not cost a later reading its alarm', async () => {
    // The batch is already written and the queue drained by the time the
    // evaluator runs, so there is no retry. If a rejecting dispatch unwound the
    // loop, a single-sample transient excursion in any reading AFTER it would
    // be lost permanently — and the dead letter would blame the evaluator
    // rather than the notifier. Losing a regulated excursion record because an
    // email failed is the wrong trade.
    repo.loadThresholdCache.mockResolvedValue(new Map([
      ['i1|temp', [{ id: 't1', key: 'temp', instrumentName: 'Chamber A', operator: 'GT', limit: 100, limitLow: null, limitHigh: null, hysteresis: 0, severity: 'MAJOR' }]],
      ['i1|press', [{ id: 't2', key: 'press', instrumentName: 'Chamber A', operator: 'GT', limit: 50, limitLow: null, limitHigh: null, hysteresis: 0, severity: 'CRITICAL' }]],
    ]));
    dispatch.mockRejectedValueOnce(new Error('smtp down'));

    const res = await evaluateFlush([{
      instrumentId: 'i1',
      readings: [reading('temp', 101), reading('press', 60)],
    }], TS);

    expect(res.raised).toBe(2);
    expect(repo.raiseAlarm).toHaveBeenCalledTimes(2);
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
