import { readFileSync } from 'node:fs';
import {
  makeWorkerUtils,
  type WorkerUtils,
  type RunnerOptions,
  type TaskList,
} from 'graphile-worker';

// graphile-worker producer + runner factories.
//
// Phase 2 of the windows-friendly rewrite (see docs/plans/2026-04-29-windows-friendly-rewrite.md
// § Task 2.2) replaced the legacy BullMQ-on-Redis path with a Postgres-backed job queue.
// Task 2.10 removed the BullMQ shims; graphile-worker is now the sole queue backend.

export interface DigilogRunnerOptions {
  taskList: TaskList;
  concurrency?: number;
  /**
   * Optional absolute path to a graphile-worker crontab file. When set, the
   * file is read synchronously at boot and its contents are passed through
   * as the runner's `crontab` option. Used by the maintenance migration in
   * Task 2.7 to schedule the 3 cron-style jobs (DLQ check, connectivity
   * check, retention cleanup). Reading sync is fine — the file is small and
   * static.
   */
  crontabPath?: string;
}

/**
 * Resolve the queue's Postgres connection string.
 *
 * Read lazily (i.e. each call) rather than captured at module-import time, so test code that
 * sets `process.env.DATABASE_URL` inside a `beforeAll` hook still gets picked up. This is a
 * deliberate deviation from the plan's spec (which captured the value at module scope).
 */
function getQueueDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_QUEUE ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      '[queue] DATABASE_URL_QUEUE or DATABASE_URL must be set for the graphile-worker queue connection',
    );
  }
  return url;
}

let cachedProducer: WorkerUtils | null = null;

export async function getProducer(): Promise<WorkerUtils> {
  if (!cachedProducer) {
    cachedProducer = await makeWorkerUtils({ connectionString: getQueueDatabaseUrl() });
  }
  return cachedProducer;
}

export function getRunnerOptions(input: DigilogRunnerOptions): RunnerOptions {
  return {
    connectionString: getQueueDatabaseUrl(),
    concurrency: input.concurrency ?? 10,
    pollInterval: 1000,
    taskList: input.taskList,
    crontab: input.crontabPath ? readFileSync(input.crontabPath, 'utf8') : undefined,
  };
}

export async function closeProducer(): Promise<void> {
  if (cachedProducer) {
    await cachedProducer.release();
    cachedProducer = null;
  }
}
