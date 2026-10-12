/**
 * Notification task handler — drains the `notification` graphile-worker queue.
 *
 * History: this used to dispatch `ALARM_CREATED` and `RULE_CHAIN_TRIGGERED` notifications
 * from the ingestion pipeline (Stage 8 and Stage 11). Those subsystems were removed on
 * 2026-05-17, and from then until 2026-08-14 this handler was a pure drain: it logged
 * whatever arrived and acknowledged it, because nothing enqueued any more. Its own note
 * asked for a real dispatcher mapping if a future feature wired the producer back up.
 *
 * Project C4 is that feature. The alarm evaluator enqueues an event payload on every
 * raise and clear, and this handler feeds it to `dispatchNotification`, which matches it
 * against the configured notification rules.
 *
 * The old drain behaviour is KEPT for anything that is not an event payload: stale rows
 * from before the 2026-05-17 removal may still be sitting in `graphile_worker.jobs`, and
 * failing them would retry three times and then park them forever.
 */
import type { Task } from 'graphile-worker';
import { notificationEventJobSchema } from '@digilog/queue';
import { dispatchNotification } from '../modules/notification-delivery/notification-dispatcher.js';

export const notificationTask: Task = async (rawPayload, helpers) => {
  const parsed = notificationEventJobSchema.safeParse(rawPayload);

  if (!parsed.success) {
    helpers.logger.info(
      `[notification] discarding non-event payload (legacy shape, or malformed): ${JSON.stringify(rawPayload).slice(0, 200)}`,
    );
    // Returning normally marks the job complete — no retry. A payload we cannot
    // understand will never become understandable by being retried.
    return;
  }

  const { eventType, context, variables } = parsed.data;
  // Let this THROW on failure rather than swallowing it: graphile-worker retries the job,
  // which is the whole reason delivery was moved onto the queue. A dropped alarm
  // notification is the failure mode this feature exists to prevent.
  //
  // The graphile job id is stable across that job's retries, so it is the event's
  // dedup key (audit 2026-10-12 #9): a retry skips every (rule, channel, recipient)
  // the earlier attempt already wrote a log row for, instead of re-sending to them.
  const jobId = (helpers as { job?: { id?: string | number } }).job?.id;
  await dispatchNotification({
    eventType, context, variables,
    ...(jobId !== undefined && jobId !== null ? { dedupKey: `job:${jobId}` } : {}),
  });
  helpers.logger.info(`[notification] dispatched ${eventType}`);
};
