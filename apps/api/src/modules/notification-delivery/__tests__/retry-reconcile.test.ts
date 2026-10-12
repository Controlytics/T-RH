/**
 * Boot-time reconciliation of email/SMS retries (audit 2026-10-12 #3 follow-up).
 *
 * Retries became graphile jobs on 2026-10-12, but rows already RETRYING before
 * that (their setTimeout died with the process) — or whose job was lost with a
 * failed enqueue — have nothing that will ever run them. At boot every RETRYING
 * row without a pending job gets one (or is marked FAILED if its attempts are
 * spent). Idempotent: it can run on every start.
 *
 * Real graphile-worker queue in the test database; the channel is never called.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import { reconcileNotificationRetries, MAX_ATTEMPTS } from '../delivery.service.js';

const RECIPIENT = `reconcile-${Date.now()}@test.example`;
const keyOf = (id: string) => `notification_retry:${id}`;

const jobsFor = (ids: string[]) => prisma.$queryRaw<{ key: string; run_at: Date }[]>`
  SELECT key, run_at FROM graphile_worker.jobs WHERE key = ANY(${ids.map(keyOf)}::text[])`;

const created: string[] = [];
const row = async (retryCount: number, nextRetryAt: Date | null) => {
  const r = await prisma.notificationLog.create({
    data: { channel: 'EMAIL', recipient: RECIPIENT, subject: 's', message: 'm', status: 'RETRYING', retryCount, maxRetries: 3, nextRetryAt },
  });
  created.push(r.id);
  return r.id;
};

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM graphile_worker._private_jobs WHERE key = ANY(${created.map(keyOf)}::text[])`;
  await prisma.notificationLog.deleteMany({ where: { recipient: RECIPIENT } });
});

describe('reconcileNotificationRetries', () => {
  it('schedules an orphaned RETRYING row, marks an exhausted one FAILED, and is idempotent', async () => {
    const past = new Date(Date.now() - 60_000);
    const orphan = await row(1, past);
    const exhausted = await row(MAX_ATTEMPTS, past);

    await reconcileNotificationRetries();

    let jobs = await jobsFor([orphan, exhausted]);
    expect(jobs.map((j) => j.key)).toEqual([keyOf(orphan)]);
    const firstRunAt = jobs[0].run_at.getTime();
    const ex = await prisma.notificationLog.findUniqueOrThrow({ where: { id: exhausted } });
    expect(ex.status).toBe('FAILED');
    expect(ex.nextRetryAt).toBeNull();

    // Every boot runs it again: still ONE job, its run time unchanged.
    await reconcileNotificationRetries();
    jobs = await jobsFor([orphan]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].run_at.getTime()).toBe(firstRunAt);
  });

  it('leaves a row that already has its pending job alone (run time preserved)', async () => {
    const future = new Date(Date.now() + 30 * 60_000);
    const id = await row(1, future);
    await reconcileNotificationRetries();
    const before = (await jobsFor([id]))[0].run_at.getTime();
    expect(Math.abs(before - future.getTime())).toBeLessThan(1000);
    await reconcileNotificationRetries();
    expect((await jobsFor([id]))[0].run_at.getTime()).toBe(before);
  });
});
