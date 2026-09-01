import { z } from 'zod';

/**
 * Legacy in-app notification payload. Nothing enqueues this shape any more — it is kept
 * so the handler can still recognise and drain stale `graphile_worker.jobs` rows left
 * over from the 2026-05-17 rule-chain / alarm removal.
 */
export const notificationJobSchema = z.object({
  type: z.string(),
  entityId: z.string().uuid().optional(),
  targetUserId: z.string().optional(),
  targetRole: z.string().optional(),
  title: z.string(),
  message: z.string(),
  metadata: z.record(z.unknown()).optional(),
});
export type NotificationJob = z.infer<typeof notificationJobSchema>;

/**
 * Event-driven notification payload (2026-08-14, project C4) — what the alarm evaluator
 * enqueues on raise and clear. The handler feeds it to `dispatchNotification`, which
 * matches it against the configured notification rules.
 *
 * Enqueued rather than dispatched inline because the evaluator runs every minute: a slow
 * SMTP send inside that loop would delay detecting the next excursion.
 */
export const notificationEventJobSchema = z.object({
  eventType: z.string().min(1),
  /** Matched against NotificationRule.conditions, e.g. {"metric":["TEMPERATURE"]}. */
  context: z.record(z.unknown()).default({}),
  /** Template variables. Strings only — the template engine does no coercion. */
  variables: z.record(z.string()).default({}),
});
export type NotificationEventJob = z.infer<typeof notificationEventJobSchema>;

/**
 * Alarm webhook (hooter) job — what the evaluator and the acknowledge route enqueue.
 *
 * Enqueued with maxAttempts: 1 on purpose. Retry is BOUNDED INSIDE the job (3 attempts,
 * ~2s apart) because graphile-worker's exponential backoff could otherwise sound a
 * buzzer twenty minutes after the excursion cleared — announcing a condition that no
 * longer exists, which is worse than not announcing at all.
 */
export const alarmWebhookJobSchema = z.object({
  event: z.enum(['RAISED', 'CLEARED', 'ACKNOWLEDGED']),
  alarmId: z.string().min(1),
  instrumentId: z.string().min(1),
  // No `severity` since 2026-09-01. Removed from the schema in the same change as
  // the enqueue: a required field the producer stopped sending would fail every
  // job. `z.object` strips unknown keys, so a job already on the queue that still
  // carries one parses unchanged.
  /** Template variables. Strings only — the renderer does no coercion. */
  variables: z.record(z.string()).default({}),
});
export type AlarmWebhookJob = z.infer<typeof alarmWebhookJobSchema>;
