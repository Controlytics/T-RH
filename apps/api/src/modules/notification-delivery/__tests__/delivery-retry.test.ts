/**
 * Audit 2026-10-12 #3 — email/SMS retries were `setTimeout`s inside the API
 * process: a restart (every deploy) dropped them, and nothing ever read the
 * `RETRYING` / `next_retry_at` the log row claimed. A failed send now schedules a
 * graphile-worker job (`notification_retry`, `runAt` = next_retry_at) that resends
 * from the stored log row, so a retry survives the process.
 *
 * The email channel is stubbed; the log rows are real.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const emailSend = vi.fn();
vi.mock('../channels/email-channel.js', () => ({
  emailChannel: { name: 'EMAIL', send: (...a: unknown[]) => emailSend(...a), testConnection: vi.fn() },
}));

const addJob = vi.fn();
vi.mock('@digilog/queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@digilog/queue')>()),
  getProducer: async () => ({ addJob }),
}));

import { prisma } from '../../../lib/prisma.js';
import { sendNotification } from '../delivery.service.js';
import { notificationRetryTask } from '../../../workers/notification-retry.worker.js';

const RECIPIENT = `retry-${Date.now()}@test.example`;

afterAll(async () => {
  await prisma.notificationLog.deleteMany({ where: { recipient: RECIPIENT } });
});

beforeEach(() => {
  emailSend.mockReset();
  addJob.mockReset();
  addJob.mockResolvedValue({ id: 'job' });
});

const send = () => sendNotification({
  channel: 'EMAIL', recipient: RECIPIENT, subject: 's', message: '<p>m</p>', triggeredBy: 'test',
  metadata: { probe: true },
});

const helpers = { logger: { info: vi.fn(), error: vi.fn() } } as never;

describe('durable notification retry', () => {
  it('a failed send is RETRYING with a scheduled graphile job at next_retry_at', async () => {
    emailSend.mockResolvedValue({ success: false, error: 'smtp down' });
    const before = Date.now();
    const r = await send();
    expect(r.success).toBe(false);

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { recipient: RECIPIENT }, orderBy: { createdAt: 'desc' } });
    expect(log.status).toBe('RETRYING');
    expect(log.retryCount).toBe(1);
    expect(log.nextRetryAt!.getTime()).toBeGreaterThan(before);

    expect(addJob).toHaveBeenCalledTimes(1);
    const [task, payload, opts] = addJob.mock.calls[0];
    expect(task).toBe('notification_retry');
    expect(payload).toEqual({ logId: log.id });
    expect((opts.runAt as Date).getTime()).toBe(log.nextRetryAt!.getTime());
  });

  it('the retry job resends from the stored row and records SENT', async () => {
    emailSend.mockResolvedValueOnce({ success: false, error: 'smtp down' });
    await send();
    const log = await prisma.notificationLog.findFirstOrThrow({ where: { recipient: RECIPIENT }, orderBy: { createdAt: 'desc' } });

    emailSend.mockResolvedValueOnce({ success: true, messageId: 'm-1' });
    await notificationRetryTask({ logId: log.id }, helpers);

    const after = await prisma.notificationLog.findUniqueOrThrow({ where: { id: log.id } });
    expect(after.status).toBe('SENT');
    expect(after.nextRetryAt).toBeNull();
    expect(emailSend.mock.calls[1][0]).toMatchObject({ channel: 'EMAIL', recipient: RECIPIENT, subject: 's', message: '<p>m</p>' });
  });

  it('gives up as FAILED after the last attempt and schedules nothing more', async () => {
    emailSend.mockResolvedValue({ success: false, error: 'smtp down' });
    await send();
    const log = await prisma.notificationLog.findFirstOrThrow({ where: { recipient: RECIPIENT }, orderBy: { createdAt: 'desc' } });
    await notificationRetryTask({ logId: log.id }, helpers);  // attempt 2
    await notificationRetryTask({ logId: log.id }, helpers);  // attempt 3
    const after = await prisma.notificationLog.findUniqueOrThrow({ where: { id: log.id } });
    expect(after.status).toBe('FAILED');
    expect(after.retryCount).toBe(3);
    expect(addJob).toHaveBeenCalledTimes(2); // after attempts 1 and 2 only
  });

  it('a retry job for a row that is no longer RETRYING sends nothing', async () => {
    emailSend.mockResolvedValue({ success: true, messageId: 'm' });
    await send();
    const log = await prisma.notificationLog.findFirstOrThrow({ where: { recipient: RECIPIENT }, orderBy: { createdAt: 'desc' } });
    emailSend.mockClear();
    await notificationRetryTask({ logId: log.id }, helpers);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('a channel that THROWS is a failed attempt, not a lost notification', async () => {
    emailSend.mockRejectedValue(new Error('socket hang up'));
    const r = await send();
    expect(r.success).toBe(false);
    const log = await prisma.notificationLog.findFirstOrThrow({ where: { recipient: RECIPIENT }, orderBy: { createdAt: 'desc' } });
    expect(log.status).toBe('RETRYING');
  });
});
