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

import {
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
}

/**
 * Boot a single graphile-worker Runner. Subsequent calls return the cached
 * instance so app.ts can call this exactly once per process without
 * accidentally starting multiple consumers.
 */
export async function startJobRunner(opts: StartJobRunnerOptions): Promise<Runner> {
  if (runner) return runner;
  const runnerOptions = getRunnerOptions(opts as DigilogRunnerOptions);
  // Bootstrap the graphile_worker schema if it doesn't exist yet. Safe on
  // repeat — graphile-worker's migration runner is itself idempotent.
  await runMigrations({ connectionString: runnerOptions.connectionString });
  runner = await run({ ...runnerOptions, noHandleSignals: true });
  return runner;
}

export async function stopJobRunner(): Promise<void> {
  if (runner) {
    await runner.stop();
    runner = null;
  }
}
