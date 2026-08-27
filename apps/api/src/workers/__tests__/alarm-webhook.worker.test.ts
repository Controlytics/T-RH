/**
 * Per-target error isolation for the alarm webhook annunciator.
 *
 * Tests at the `attemptTarget` seam, not `runAlarmWebhookJob` — the job function's
 * other work (`prisma.instrument.findUnique`, `prisma.alarmWebhookTarget.findMany`,
 * `prisma.functionalLocation.findMany`) needs a database and adds nothing to what
 * this defect is about. `attemptTarget` is where the try/catch lives, and it takes
 * an injectable `deliver` function precisely so a stub can throw without a database
 * or a `vi.mock` of `../lib/prisma.js`. Everything between it and the loop
 * (`targetMatches`, `shouldFire`) is pure and already covered by
 * `target-scope.test.ts` / `cooldown.test.ts` — there is no other place inside the
 * per-target step where a real exception could escape.
 */
import { describe, it, expect, vi } from 'vitest';
import { attemptTarget } from '../alarm-webhook.worker.js';

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
