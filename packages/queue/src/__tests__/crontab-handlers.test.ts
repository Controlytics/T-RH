import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCrontab } from 'graphile-worker';
import { ALARM_EVALUATION_QUEUE } from '../queues.js';

/**
 * Every crontab identifier must have a handler registered in app.ts's taskList.
 *
 * graphile-worker does NOT reject an unknown identifier — it enqueues the job and
 * leaves it queued forever. So a handler-less cron line is an unbounded row leak,
 * silent except for a growing table.
 *
 * This is a REPEAT of a known failure: app.ts already documents "jobs leaked into
 * graphile_worker.jobs forever" from when `notification` had no handler. That was
 * fixed at the producer and the crontab was never checked, so `dlq_check` and
 * `connectivity_check` — scheduled EVERY MINUTE for subsystems deleted in the
 * 2026-06 ingestion tear-out — quietly accrued 51,798 orphan jobs.
 *
 * Parsing app.ts by regex is crude, but the alternative (importing it) boots the
 * whole server. The drift this catches is worth the bluntness.
 */
const here = dirname(fileURLToPath(import.meta.url));
const crontabPath = resolve(here, '../../crontab.txt');
const appTsPath = resolve(here, '../../../../apps/api/src/app.ts');

function scheduledTasks(): string[] {
  return readFileSync(crontabPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    // "m h dom mon dow  task_name  ?args" — the identifier is the 6th field.
    .map((l) => l.split(/\s+/)[5])
    .filter(Boolean);
}

function registeredHandlers(): string[] {
  const src = readFileSync(appTsPath, 'utf8');
  const block = src.match(/taskList:\s*\{([\s\S]*?)\n\s*\},/);
  if (!block) throw new Error('could not locate the taskList block in app.ts');
  return [...block[1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
}

describe('crontab ↔ taskList', () => {
  it('every scheduled task has a registered handler', () => {
    const scheduled = scheduledTasks();
    const registered = registeredHandlers();
    const orphans = scheduled.filter((t) => !registered.includes(t));
    // An orphan here means: jobs enqueue every tick and never complete.
    expect(orphans, `scheduled with no handler in app.ts taskList: ${orphans.join(', ')}`).toEqual([]);
  });

  it('the deleted ingestion-era tasks are gone', () => {
    const scheduled = scheduledTasks();
    for (const dead of ['dlq_check', 'connectivity_check', 'retention_cleanup']) {
      expect(scheduled, `${dead} was removed 2026-07-15 — its subsystem no longer exists`).not.toContain(dead);
    }
  });

  it('parses the crontab at all (guards the parser itself)', () => {
    // If the format changes and this silently returns [], the first test passes
    // vacuously — which is exactly how this class of gap survives.
    expect(scheduledTasks().length).toBeGreaterThan(0);
    expect(registeredHandlers().length).toBeGreaterThan(0);
  });

  it('the surviving tasks are the expected set', () => {
    // De-duplicated: telemetry_partition_maintenance is scheduled TWICE on purpose (the
    // 1st and the 15th), so that a single missed run — the machine being off on the 1st —
    // still leaves next month's partition created. Comparing the raw list would make this
    // assertion about scheduling frequency, which is not what it is guarding.
    //
    // This pin went stale twice without anyone noticing, because the queue package's
    // suite is not part of `npm test` in apps/api or apps/web: telemetry_partition
    // _maintenance was added 2026-08-11 and alarm_evaluation on 2026-08-13, and the
    // expected set was updated for neither. The FIRST test in this file — every
    // scheduled task has a handler — is the one that actually prevents the row leak,
    // and it passed throughout.
    expect([...new Set(scheduledTasks())].sort()).toEqual([
      'alarm_evaluation',
      'password_expiry_check',
      'session_sweep',
      'telemetry_partition_maintenance',
    ]);
  });
});

/**
 * Audit 2026-10-12 #2 — the cron pass and the on-ingest pass of alarm_evaluation
 * must never run at the same time. graphile-worker runs up to `concurrency` (10)
 * jobs at once; the ONLY thing that serialises two jobs is a shared `queue_name`.
 * `max=1` is maxAttempts, not a concurrency limit, and the ingest jobKey only
 * coalesces QUEUED ingest jobs. A pass that read the overview before an excursion
 * could therefore clear an alarm a parallel pass had just raised.
 *
 * Parsed with graphile-worker's OWN parser, so this asserts what the runner
 * will actually do with the line, not what a regex thinks it says.
 */
describe('crontab options as graphile-worker parses them', () => {
  const items = parseCrontab(readFileSync(crontabPath, 'utf8'));
  const byTask = (t: string) => items.filter((i) => i.task === t);

  it('alarm_evaluation runs on the ONE serial queue the ingest enqueue also uses', () => {
    const [cron] = byTask('alarm_evaluation');
    expect(cron).toBeDefined();
    // Truthy first: undefined === undefined would pass with no queue at all.
    expect(cron.options.queueName).toBeTruthy();
    expect(cron.options.queueName).toBe(ALARM_EVALUATION_QUEUE);
  });

  it('alarm_evaluation cron ticks coalesce while the serial queue is busy (no pile-up)', () => {
    const [cron] = byTask('alarm_evaluation');
    expect(cron.options.jobKey).toBeTruthy();
    expect(cron.options.jobKeyMode).toBe('replace');
  });

  it('telemetry partition maintenance gets more than one attempt (max= is maxAttempts)', () => {
    const lines = byTask('telemetry_partition_maintenance');
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l.options.maxAttempts).toBeGreaterThan(1);
  });
});
