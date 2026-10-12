/**
 * Delivery Service — Core notification dispatching with logging and retry.
 * This is the main entry point for sending notifications.
 */

import { getProducer } from '@digilog/queue';
import { prisma } from '../../lib/prisma.js';
import { emailChannel } from './channels/email-channel.js';
import { smsChannel } from './channels/sms-channel.js';
import { resolveTemplate } from './template-engine.js';
import { formatConfiguredDateTime } from '../../lib/format-datetime.js';
import type { NotificationPayload, DeliveryResult, NotificationChannel } from './types.js';
import { logger } from '../../lib/logger.js';

const channels: Record<string, NotificationChannel> = {
  EMAIL: emailChannel,
  SMS: smsChannel,
};

/** Total attempts per notification: the first send plus two retries. */
export const MAX_ATTEMPTS = 3;
/** Wait before retry n (index = attempts already failed - 1). */
const RETRY_DELAYS = [5000, 15000, 45000];

/**
 * One attempt through a channel. A channel that THROWS (a socket error inside
 * nodemailer, a parse failure) is a failed attempt like any other — it must be
 * recorded and retried, never escape as an exception that leaves the log row
 * PENDING with nothing scheduled.
 */
async function attempt(channel: NotificationChannel, payload: NotificationPayload): Promise<DeliveryResult> {
  try {
    return await channel.send(payload);
  } catch (e) {
    return { success: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

/**
 * Record a failed attempt and, if attempts remain, schedule the next one as a
 * graphile-worker job (audit 2026-10-12 #3).
 *
 * WHY A JOB. Retries were `setTimeout`s in this process: every restart — every
 * deploy — dropped them, while the row went on saying RETRYING with a
 * `next_retry_at` nothing would ever read. A `notification_retry` job with
 * `runAt` = that same `next_retry_at` lives in Postgres and survives the process.
 * The jobKey makes a duplicate schedule for one row collapse into one job.
 *
 * If the job cannot be enqueued (queue down), the row is marked FAILED with the
 * reason rather than left claiming a retry that will never happen.
 */
async function recordFailure(logId: string, failedAttempts: number, error: string | undefined): Promise<void> {
  if (failedAttempts >= MAX_ATTEMPTS) {
    await prisma.notificationLog.update({
      where: { id: logId },
      data: { status: 'FAILED', errorMessage: error, retryCount: failedAttempts, nextRetryAt: null },
    });
    return;
  }
  const delay = RETRY_DELAYS[failedAttempts - 1] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
  const nextRetryAt = new Date(Date.now() + delay);
  await prisma.notificationLog.update({
    where: { id: logId },
    data: { status: 'RETRYING', errorMessage: error, retryCount: failedAttempts, nextRetryAt },
  });
  try {
    const producer = await getProducer();
    await producer.addJob('notification_retry', { logId }, {
      runAt: nextRetryAt,
      // The retry task bounds its own attempts through the row's retryCount; a
      // graphile-level retry would resend outside that count.
      maxAttempts: 1,
      jobKey: `notification_retry:${logId}`,
    });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    logger.error(`[notification-delivery] could not schedule retry for log ${logId}: ${why}`);
    await prisma.notificationLog.update({
      where: { id: logId },
      data: { status: 'FAILED', nextRetryAt: null, errorMessage: `${error ?? 'send failed'} (retry could not be scheduled: ${why})` },
    });
  }
}

/**
 * Send a notification through the specified channel with logging and retry.
 * Makes ONE attempt now; a failure is retried durably (see `recordFailure`).
 */
export async function sendNotification(payload: NotificationPayload): Promise<DeliveryResult> {
  const channel = channels[payload.channel];
  if (!channel) {
    return { success: false, error: `Unknown channel: ${payload.channel}` };
  }

  // Resolve template variables if provided
  let message = payload.message;
  let subject = payload.subject;
  if (payload.variables && Object.keys(payload.variables).length > 0) {
    message = resolveTemplate(message, payload.variables);
    if (subject) subject = resolveTemplate(subject, payload.variables);
  }

  // Create log entry
  const log = await prisma.notificationLog.create({
    data: {
      channel: payload.channel,
      recipient: payload.recipient,
      subject,
      message,
      templateId: payload.templateId,
      status: 'PENDING',
      maxRetries: MAX_ATTEMPTS,
      triggeredBy: payload.triggeredBy,
      metadata: payload.metadata as any,
    },
  });

  const result = await attempt(channel, { ...payload, message, subject });

  if (result.success) {
    await prisma.notificationLog.update({
      where: { id: log.id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        metadata: { ...(payload.metadata as any ?? {}), messageId: result.messageId } as any,
      },
    });
  } else {
    await recordFailure(log.id, 1, result.error);
  }

  return result;
}

/**
 * One durable retry, run by the `notification_retry` task. Resends EXACTLY what
 * the log row recorded (recipient, subject, already-rendered message), so a
 * template edited in between cannot change what a retry says. A row that is no
 * longer RETRYING (sent, failed, or retried by a duplicate job) is left alone.
 */
export async function retryNotification(logId: string): Promise<void> {
  const log = await prisma.notificationLog.findUnique({ where: { id: logId } });
  if (!log || log.status !== 'RETRYING') return;
  const channel = channels[log.channel];
  if (!channel) {
    await prisma.notificationLog.update({
      where: { id: logId },
      data: { status: 'FAILED', nextRetryAt: null, errorMessage: `Unknown channel: ${log.channel}` },
    });
    return;
  }
  const metadata = (log.metadata ?? {}) as Record<string, unknown>;
  const result = await attempt(channel, {
    channel: log.channel as NotificationPayload['channel'],
    recipient: log.recipient,
    subject: log.subject ?? undefined,
    message: log.message,
    triggeredBy: log.triggeredBy ?? undefined,
    metadata,
  } as NotificationPayload);

  if (result.success) {
    await prisma.notificationLog.update({
      where: { id: logId },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        errorMessage: null,
        nextRetryAt: null,
        retryCount: log.retryCount,
        metadata: { ...metadata, messageId: result.messageId } as any,
      },
    });
    return;
  }
  await recordFailure(logId, log.retryCount + 1, result.error);
}

/**
 * Test a notification channel connection/configuration.
 */
export async function testChannel(channelName: 'EMAIL' | 'SMS'): Promise<DeliveryResult> {
  const channel = channels[channelName];
  if (!channel) return { success: false, error: `Unknown channel: ${channelName}` };
  return channel.testConnection();
}

/**
 * Send a test notification to verify end-to-end delivery.
 */
export async function sendTestNotification(
  channelName: 'EMAIL' | 'SMS',
  recipient: string,
): Promise<DeliveryResult> {
  // Timestamp honours the Date/Time config (IST by default), not UTC.
  const ts = await formatConfiguredDateTime(new Date());
  return sendNotification({
    channel: channelName,
    recipient,
    subject: 'DigiLog Test Notification',
    message: channelName === 'EMAIL'
      ? `<p>This is a <strong>test notification</strong> from DigiLog.</p><p>If you received this email, your email notification settings are configured correctly.</p><p>Timestamp: ${ts}</p>`
      : `DigiLog Test: Your SMS notification is configured correctly. Timestamp: ${ts}`,
    triggeredBy: 'manual',
    metadata: { test: true },
  });
}
