/**
 * Audit 2026-05-04 fix (queue review H1): pruned BullMQ-era options that
 * graphile-worker silently ignored.
 *
 * graphile-worker maps `attempts` -> `maxAttempts` in producer.ts (the
 * consumer of this constant). It does NOT read `backoff`,
 * `removeOnComplete`, or `removeOnFail` — those were copied wholesale
 * from the pre-Phase-2 BullMQ config and stayed even after the migration.
 * Keeping them in the type was misleading: an operator tuning retry
 * delay would edit `backoff.delay` here and see no effect at runtime.
 *
 * If retry backoff or job-row TTL becomes load-bearing in the future:
 *   - graphile-worker handles backoff internally (exponential with
 *     `worker_utils.fail_job` retries) — adjust schema task config if
 *     a fixed delay is needed
 *   - row TTL is operator-driven via the
 *     `graphile_worker.completed_jobs` cleanup cron
 */
export const QUEUES = {
  NOTIFICATION: {
    name: 'notification',
    defaultJobOptions: {
      attempts: 3,
    },
  },
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]['name'];

/**
 * The ONE graphile-worker queue every `alarm_evaluation` job runs on — the
 * one-minute cron (`packages/queue/crontab.txt`, `queue=alarm_evaluation`) and
 * the on-ingest enqueue (`apps/api/src/modules/alarms/enqueue-evaluation.ts`).
 *
 * graphile-worker runs jobs that share a `queue_name` strictly one at a time,
 * whatever the runner's `concurrency`. Nothing else serialises them: the
 * crontab's `max=` is maxAttempts and its `id=` is the cron identifier, and the
 * ingest `jobKey` only coalesces QUEUED ingest jobs. Without this, a cron pass
 * and an ingest pass ran in parallel, and a pass holding a stale reading could
 * clear an alarm the other had just raised (audit 2026-10-12 #2).
 *
 * The crontab line spells this string literally (it is a text file); the queue
 * package's crontab test pins the two together.
 */
export const ALARM_EVALUATION_QUEUE = 'alarm_evaluation';
