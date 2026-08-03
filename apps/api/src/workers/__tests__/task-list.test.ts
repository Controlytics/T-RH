import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCrontab } from 'graphile-worker';
import { taskList } from '../task-list.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRONTAB = path.resolve(__dirname, '../../../../../packages/queue/crontab.txt');

describe('crontab / taskList registration', () => {
  // Regression: two `telemetry_partition_maintenance` lines both carried
  // `?id=telemetry_partition_maintenance` (not unique — graphile-worker
  // requires `?id=` to be unique PER CRON ITEM, not per task). That made
  // parseCrontab() throw "Invalid crontab; duplicate identifiers found",
  // which rejects the ENTIRE crontab and kills the job runner outright — no
  // cron job of any kind runs, not just the offending one. The prior version
  // of this test only checked `taskList` coverage of a hand-rolled parse of
  // column 5 (the task name), so it never noticed the crontab itself was
  // structurally invalid; it happily passed while graphile-worker's own
  // parser would have rejected the file at boot.
  //
  // Use graphile-worker's REAL parseCrontab() — the exact function
  // `apps/api/src/app.ts` runs at startup — instead of reimplementing its
  // validation. If this throws, the job runner does not start.
  it('parses as a valid graphile-worker crontab (identifiers unique, syntax valid)', () => {
    const text = readFileSync(CRONTAB, 'utf8');
    expect(() => parseCrontab(text)).not.toThrow();
  });

  it('every crontab task has a handler', () => {
    const text = readFileSync(CRONTAB, 'utf8');
    const items = parseCrontab(text);
    expect(items.length).toBeGreaterThan(0);   // guards against a bad parse silently passing

    // graphile-worker does NOT reject an unknown TASK identifier at parse
    // time — it enqueues the job and leaves it queued forever. This repo
    // reached 51,798 orphan rows from three such entries. See the header of
    // crontab.txt.
    const taskNames = [...new Set(items.map(i => i.task))];
    const unhandled = taskNames.filter(name => !(name in taskList));
    expect(unhandled).toEqual([]);
  });
});
