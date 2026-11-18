/**
 * Keeps the graphile-worker job runner running (audit 2026-11-07, S2-H1).
 *
 * It used to be started ONCE at boot: a start that failed — the database not up
 * yet when the service came up — was never retried, and a runner that died later
 * was never noticed. Every alarm pass (OFFLINE detection included), notification,
 * telemetry partition and LOGOUT-writing session sweep then stopped while
 * `/api/health` went on answering 200.
 *
 * Pure and timer-driven so it can be tested without a database:
 * - a failed start is reported `failed` and retried after 5 s, 15 s, 30 s, then
 *   every 60 s (the last delay repeats) until it starts;
 * - a runner that exits (`notifyExit`, wired to the runner promise's rejection)
 *   is reported `failed` and restarted the same way;
 * - `starting` is reported once, at boot; a retry keeps reporting `failed` until
 *   the runner is actually running — nothing runs in between;
 * - `stop()` (shutdown) cancels a pending retry and ignores later exits.
 *
 * `notifyExit` DEPENDS ON A PATCHED graphile-worker. In 0.16.6 a dropped
 * database rejects the runner's cron or worker-pool promise, and graphile's own
 * `.finally(...)` on each (`dist/runner.js`) left a derived rejection unhandled:
 * Node exited the process before the runner promise's handler — and so
 * `notifyExit` — ran. A process-wide `unhandledRejection` handler would have
 * swallowed unrelated errors too, so the fix is in graphile itself:
 * `patches/graphile-worker+0.16.6.patch` adds the `.catch` graphile 0.18 has,
 * applied by the root `postinstall` (patch-package, `--error-on-fail
 * --error-on-warn`) on every `npm install` / `npm ci`, and both installer builds
 * refuse a clean room without it. `src/e2e/job-runner-db-drop.e2e.test.ts` cuts
 * the database mid-run through a proxy and proves the whole path — no unhandled
 * rejection, `failed`, then `running` again (it fails on the unpatched file).
 * Upgrading graphile past 0.16.6 makes patch-package refuse the install: drop the
 * patch then, and re-check how the new runner reports a death (0.18's
 * `promise` resolves, rather than rejects, when cron or the pool dies).
 */

export type JobRunnerStatus = 'starting' | 'running' | 'failed';

export const JOB_RUNNER_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000];

export interface JobRunnerSupervisor {
  /** Settles once the FIRST start attempt has succeeded or failed (never rejects). */
  ready: Promise<void>;
  /** The running runner exited with an error: report it and restart. */
  notifyExit(err: unknown): void;
  /** Shutdown: cancel any pending retry; nothing starts after this. */
  stop(): void;
}

export function superviseJobRunner(
  start: () => Promise<unknown>,
  onStatus: (status: JobRunnerStatus, err?: unknown) => void,
  delaysMs: readonly number[] = JOB_RUNNER_RETRY_DELAYS_MS,
): JobRunnerSupervisor {
  let stopped = false;
  let running = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRetry = (): void => {
    if (stopped || delaysMs.length === 0) return;
    const delay = delaysMs[Math.min(failures, delaysMs.length - 1)];
    failures += 1;
    timer = setTimeout(() => {
      timer = null;
      void attempt();
    }, delay);
    // A pending retry must not hold a shutting-down process open.
    (timer as { unref?: () => void }).unref?.();
  };

  async function attempt(): Promise<void> {
    if (stopped) return;
    try {
      await start();
    } catch (err) {
      if (stopped) return;
      onStatus('failed', err);
      scheduleRetry();
      return;
    }
    if (stopped) return;
    failures = 0;
    running = true;
    onStatus('running');
  }

  onStatus('starting');
  const ready = attempt();

  return {
    ready,
    notifyExit(err: unknown): void {
      if (stopped || !running) return;
      running = false;
      onStatus('failed', err);
      scheduleRetry();
    },
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
