import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    expect(scheduledTasks().sort()).toEqual(['password_expiry_check', 'pm_overdue_check', 'session_sweep']);
  });
});
