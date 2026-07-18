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
  INGESTION: {
    name: 'ingestion',
    defaultJobOptions: {
      attempts: 3,
    },
  },
  NOTIFICATION: {
    name: 'notification',
    defaultJobOptions: {
      attempts: 3,
    },
  },
  MAINTENANCE: {
    name: 'maintenance',
    defaultJobOptions: {
      attempts: 1,
    },
  },
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]['name'];
