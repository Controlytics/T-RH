/**
 * Notification task handler — drains the `notification` graphile-worker
 * queue.
 *
 * History: this used to dispatch `ALARM_CREATED` and `RULE_CHAIN_TRIGGERED`
 * notifications from the ingestion pipeline (Stage 8 and Stage 11). The
 * rule-chain + alarm subsystems were removed on 2026-05-17. The producer
 * paths (`enqueueNotificationJob`) no longer enqueue any jobs in the live
 * pipeline. The handler is retained as a drain for stale `graphile_worker
 * .jobs` rows that may exist from before the removal — anything we receive
 * is logged and acknowledged so it doesn't pile up forever.
 *
 * If a future feature wires `enqueueNotificationJob` back up, this handler
 * should be replaced with a real dispatcher mapping.
 */
import type { Task } from 'graphile-worker';

export const notificationTask: Task = async (rawPayload, helpers) => {
  helpers.logger.info(
    `[notification] received stale notification job (alarm/rule-chain subsystems removed 2026-05-17); discarding payload: ${JSON.stringify(rawPayload).slice(0, 200)}`,
  );
  // Returning normally marks the job complete — no retry.
};
