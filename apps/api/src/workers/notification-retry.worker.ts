/**
 * Durable email/SMS retry. graphile-worker task, registered as `notification_retry`.
 *
 * Event-driven, NOT cron: enqueued by `notification-delivery/delivery.service.ts`
 * with `runAt` = the log row's `next_retry_at` whenever an attempt fails and
 * attempts remain (audit 2026-10-12 #3 — the retries used to be in-process
 * `setTimeout`s that every restart dropped).
 */
import type { Task } from 'graphile-worker';
import { notificationRetryJobSchema } from '@digilog/queue';
import { retryNotification } from '../modules/notification-delivery/delivery.service.js';

export const notificationRetryTask = async (
  rawPayload: unknown,
  helpers: Parameters<Task>[1] | { logger: { info: (m: string) => void; error?: (m: string) => void } },
): Promise<void> => {
  const parsed = notificationRetryJobSchema.safeParse(rawPayload);
  if (!parsed.success) {
    // A payload that cannot name a log row will never become one: complete it.
    helpers.logger.info(`[notification_retry] discarding malformed payload: ${JSON.stringify(rawPayload).slice(0, 200)}`);
    return;
  }
  await retryNotification(parsed.data.logId);
};
