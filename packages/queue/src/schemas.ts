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
 * One durable retry of one email/SMS delivery (audit 2026-10-12 #3). Enqueued by
 * `notification-delivery/delivery.service.ts` with `runAt` = the log row's
 * `next_retry_at`; the `notification_retry` task resends from the stored
 * `notification_logs` row. Replaces in-process `setTimeout` retries, which every
 * restart dropped while the row went on claiming RETRYING.
 */
export const notificationRetryJobSchema = z.object({
  logId: z.string().uuid(),
});
export type NotificationRetryJob = z.infer<typeof notificationRetryJobSchema>;

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

/** A node id / chain id: the loose 8-4-4-4-12 hex the rule-chain document accepts. */
const ruleId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/**
 * A rule-engine message handed to the DURABLE path (rule chains, 2026-11-03;
 * spec §6, ruling S-4) — by the Checkpoint node, and by the Delay node with
 * `runAt`. Enqueued with `queueName: rule-engine:<originatorId>`, so one
 * originator's messages run in order. The `rule_engine_message` task
 * re-injects the message at the connections AFTER `resumeAfterNodeId` under
 * `relation` (Success). The originator type is checked by the task against
 * the shared vocabulary (this package does not depend on @digilog/shared).
 */
export const ruleEngineMessageJobSchema = z.object({
  message: z.object({
    id: z.string().min(1).max(64),
    type: z.string().min(1).max(255),
    originator: z.object({
      type: z.string().min(1),
      id: z.string().min(1),
      code: z.string().optional(),
    }),
    metadata: z.record(z.string()).default({}),
    data: z.unknown(),
    _stack: z.array(z.object({ chainId: ruleId, nodeId: ruleId })).optional(),
  }),
  chainId: ruleId,
  resumeAfterNodeId: ruleId,
  relation: z.string().min(1).max(128).default('Success'),
});
export type RuleEngineMessageJob = z.infer<typeof ruleEngineMessageJobSchema>;

/**
 * The hourly debug-event sweep (`rule_engine_debug_sweep`, crontab): no
 * payload — the age and per-node cap are read from Configuration → Rule
 * Engine when it runs. Unknown keys (graphile's cron `_cron` stamp) pass.
 */
export const ruleEngineDebugSweepJobSchema = z.object({}).passthrough();
export type RuleEngineDebugSweepJob = z.infer<typeof ruleEngineDebugSweepJobSchema>;
