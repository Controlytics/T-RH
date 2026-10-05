/**
 * Per-target error isolation and the cooldown claim for the alarm webhook
 * annunciator.
 *
 * `attemptTarget` is tested at its seam — it takes an injectable `deliver`
 * function precisely so a stub can throw without a database. `runAlarmWebhookJob`
 * is driven over a MOCKED prisma (the three reads it makes are plain lookups),
 * with the same injected `deliver`, because the cooldown rule it enforces —
 * claim before sending, hand the claim back when every attempt failed (audit
 * 2026-10-03, INGEST-12) — lives in the job's loop and nowhere a pure test could
 * reach.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const targets: unknown[] = [];
vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    instrument: { findUnique: vi.fn(async () => ({ functionalLocationId: null })) },
    alarmWebhookTarget: { findMany: vi.fn(async () => targets) },
    functionalLocation: { findMany: vi.fn(async () => []) },
  },
}));

import { attemptTarget, runAlarmWebhookJob } from '../alarm-webhook.worker.js';
import { resetCooldowns } from '../../modules/alarm-webhooks/cooldown.js';

const target = {
  id: 'T1',
  url: 'https://hooter.example/fire',
  method: 'POST',
  headers: {},
  contentType: 'application/json',
  bodyTemplate: '{}',
  successRegex: null,
  timeoutMs: 1000,
};

describe('attemptTarget error isolation', () => {
  it('returns false, not throws, when delivery throws', async () => {
    const deliver = vi.fn().mockRejectedValue(new Error('insert failed: connection reset'));
    await expect(attemptTarget(target, 'RAISED', 'alarm-1', {}, deliver)).resolves.toBe(false);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('returns whatever the delivery resolved to when it does not throw', async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    await expect(attemptTarget(target, 'RAISED', 'alarm-1', {}, deliver)).resolves.toBe(true);
  });

  // The defect under test: one target throwing must not stop a second target from
  // being attempted. `runAlarmWebhookJob`'s loop is `for (const t of targets) { ...
  // await attemptTarget(...) }` with nothing else fallible in between — so proving
  // attemptTarget never throws for target A, and is still reached for target B, is
  // exactly what the loop's isolation depends on.
  it('a throwing target does not prevent a later matching target from being attempted', async () => {
    const deliverA = vi.fn().mockRejectedValue(new Error('DB down'));
    const deliverB = vi.fn().mockResolvedValue(true);

    const resultA = await attemptTarget({ ...target, id: 'A' }, 'RAISED', 'alarm-1', {}, deliverA);
    // In the real loop this `continue`s to the next iteration regardless of resultA;
    // the assertion that matters is that reaching target B never depended on A's
    // outcome, i.e. no exception propagated out of A's attempt.
    const resultB = await attemptTarget({ ...target, id: 'B' }, 'RAISED', 'alarm-1', {}, deliverB);

    expect(resultA).toBe(false);
    expect(resultB).toBe(true);
    expect(deliverB).toHaveBeenCalledTimes(1);
  });
});

describe('runAlarmWebhookJob and the cooldown claim', () => {
  const row = {
    ...target,
    isActive: true,
    fireOnRaised: true, fireOnCleared: true, fireOnAcknowledged: false,
    scopeLocationIds: [], scopeInstrumentIds: ['I1'],
    cooldownSeconds: 60,
  };
  const job = { event: 'RAISED' as const, alarmId: 'A1', instrumentId: 'I1', variables: {} };

  beforeEach(() => {
    resetCooldowns();
    targets.length = 0;
    targets.push(row);
  });

  it('a raise that SOUNDED holds the window: the next raise inside it is suppressed', async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    expect(await runAlarmWebhookJob(job, 0, deliver)).toEqual({ targets: 1, sent: 1, failed: 0 });
    expect(await runAlarmWebhookJob(job, 10_000, deliver)).toEqual({ targets: 1, sent: 0, failed: 0 });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a raise whose every attempt FAILED hands the claim back: the next raise inside the window fires', async () => {
    // The hooter unplugged at the first excursion, plugged back in before the second.
    const deliver = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await runAlarmWebhookJob(job, 0, deliver)).toEqual({ targets: 1, sent: 0, failed: 1 });
    expect(await runAlarmWebhookJob(job, 10_000, deliver)).toEqual({ targets: 1, sent: 1, failed: 0 });
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('a delivery that THREW is a failure too, and releases the claim', async () => {
    const deliver = vi.fn().mockRejectedValueOnce(new Error('insert failed')).mockResolvedValue(true);
    expect(await runAlarmWebhookJob(job, 0, deliver)).toEqual({ targets: 1, sent: 0, failed: 1 });
    expect(await runAlarmWebhookJob(job, 10_000, deliver)).toEqual({ targets: 1, sent: 1, failed: 0 });
  });

  it('a failed CLEARED releases nothing — it never claimed, and the RAISED window stands', async () => {
    const deliver = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await runAlarmWebhookJob(job, 0, deliver)).toMatchObject({ sent: 1 });
    expect(await runAlarmWebhookJob({ ...job, event: 'CLEARED' }, 5_000, deliver)).toMatchObject({ failed: 1 });
    expect(await runAlarmWebhookJob(job, 10_000, deliver)).toEqual({ targets: 1, sent: 0, failed: 0 });
  });
});
