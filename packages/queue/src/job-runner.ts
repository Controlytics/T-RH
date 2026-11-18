/**
 * Single graphile-worker Runner for the entire API process.
 *
 * Phase 2 of the windows-friendly rewrite (see docs/plans/2026-04-29-windows-friendly-rewrite.md
 * § Task 2.8) replaces the two BullMQ Workers (ingestion + maintenance) with one
 * graphile-worker `Runner` that registers all task identifiers — `ingestion`,
 * `dlq_check`, `connectivity_check`, `retention_cleanup` — plus the crontab.
 *
 * Schema bootstrap (`runMigrations`) happens here on first call so callers don't
 * need to remember to do it; idempotent on repeat calls because the singleton
 * guard short-circuits.
 *
 * `noHandleSignals: true` keeps signal handling in `app.ts` so its existing
 * shutdown sequence (telemetry batcher, MQTT, Redis, etc.) stays in charge.
 */

import { ALARM_EVALUATION_QUEUE, RULE_ENGINE_QUEUE_PREFIX } from './queues.js';
import {
  makeWorkerUtils,
  run,
  runMigrations,
  type TaskList,
  type Runner,
} from 'graphile-worker';
import { getRunnerOptions, type DigilogRunnerOptions } from './connection.js';

let runner: Runner | null = null;

export interface StartJobRunnerOptions {
  taskList: TaskList;
  concurrency?: number;
  /** Optional absolute path to a crontab file (see `packages/queue/crontab.txt`). */
  crontabPath?: string;
  /**
   * Called when the RUNNING runner dies — its `promise` rejects (audit 2026-11-07,
   * S2-H1: that rejection was unhandled and nothing noticed the runner was gone).
   * A graceful `stopJobRunner()` resolves the promise and does not call it. The
   * cached runner is cleared first, so the next `startJobRunner` starts a new one.
   * Reachable only with the root `patches/graphile-worker+0.16.6.patch` applied:
   * unpatched, graphile's own `.finally()` on its cron / worker-pool promise left
   * an unhandled rejection that exited the process first — see the API's
   * `lib/job-runner-supervisor.ts` and `src/e2e/job-runner-db-drop.e2e.test.ts`.
   */
  onExit?: (err: unknown) => void;
}

/**
 * Boot a single graphile-worker Runner. Subsequent calls return the cached
 * instance so app.ts can call this exactly once per process without
 * accidentally starting multiple consumers.
 */
/**
 * Free the named queues (and any job locked in them) that a DEAD worker left
 * locked. Called before EVERY start — at boot, and before a supervisor retry in
 * the same process (the API's `lib/job-runner-supervisor.ts`), when this process's
 * previous runner failed to start or is gone.
 *
 * WHY. `alarm_evaluation` runs on one serial named queue (ALARM_EVALUATION_QUEUE,
 * audit 2026-10-12 #2). graphile-worker frees a queue whose worker died only
 * after FOUR HOURS (`locked_at < now() - interval '4 hours'`, sql/000016) — and
 * `scripts/stop-app.ps1` stops the API with `Stop-Process -Force`, which never
 * reaches the graceful `stopJobRunner()`. Without this, a restart in the middle
 * of a pass would leave every alarm pass, OFFLINE detection included, blocked
 * for four hours. Before the queue existed a dead pass stranded only its own row.
 *
 * SAFE ONLY BECAUSE this install runs ONE API process per database: at boot no
 * live worker can hold these locks. A second process on the same database
 * starting mid-pass would release the first's lock and allow one overlapping
 * pass — the pre-fix behaviour, bounded by the clear claim and the unique indexes.
 */
export async function releaseQueueLocks(
  connectionString: string,
  queueNames: readonly string[],
  /** Queue-name PREFIXES freed as well (rule chains: `rule-engine:` — one queue per originator). */
  queuePrefixes: readonly string[] = [],
): Promise<void> {
  if (queueNames.length === 0 && queuePrefixes.length === 0) return;
  // A prefix is matched literally: LIKE's own wildcards in it are escaped.
  const patterns = queuePrefixes.map((p) => `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const utils = await makeWorkerUtils({ connectionString });
  try {
    await utils.withPgClient(async (client) => {
      await client.query(
        `update graphile_worker._private_jobs as jobs
            set locked_at = null, locked_by = null
           from graphile_worker._private_job_queues as q
          where jobs.job_queue_id = q.id and (q.queue_name = any($1::text[]) or q.queue_name like any($2::text[]))
            and jobs.locked_at is not null`,
        [queueNames, patterns],
      );
      await client.query(
        `update graphile_worker._private_job_queues
            set locked_at = null, locked_by = null
          where (queue_name = any($1::text[]) or queue_name like any($2::text[])) and locked_at is not null`,
        [queueNames, patterns],
      );
    });
  } finally {
    await utils.release();
  }
}

export async function startJobRunner(opts: StartJobRunnerOptions): Promise<Runner> {
  if (runner) return runner;
  const runnerOptions = getRunnerOptions(opts as DigilogRunnerOptions);
  // Bootstrap the graphile_worker schema if it doesn't exist yet. Safe on
  // repeat — graphile-worker's migration runner is itself idempotent.
  await runMigrations({ connectionString: runnerOptions.connectionString });
  // A force-killed previous process must not block the serial alarm queue — or
  // an originator's durable rule-engine queue (a Delay, a Checkpoint) — for
  // graphile's four-hour stale-lock window. See releaseQueueLocks.
  await releaseQueueLocks(runnerOptions.connectionString!, [ALARM_EVALUATION_QUEUE], [RULE_ENGINE_QUEUE_PREFIX]);
  const started = await run({ ...runnerOptions, noHandleSignals: true });
  runner = started;
  started.promise.then(
    () => undefined,
    (err: unknown) => {
      if (runner === started) runner = null;
      opts.onExit?.(err);
    },
  );
  return started;
}

export async function stopJobRunner(): Promise<void> {
  if (runner) {
    await runner.stop();
    runner = null;
  }
}
