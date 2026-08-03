import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskList } from '../task-list.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRONTAB = path.resolve(__dirname, '../../../../../packages/queue/crontab.txt');

/** Cron line shape: `m h dom mon dow  task_name  ?opts` — 5 time fields then the id. */
function crontabTaskIds(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
    .map(l => l.split(/\s+/)[5])
    .filter((id): id is string => Boolean(id));
}

describe('crontab / taskList registration', () => {
  it('every crontab identifier has a handler', () => {
    const ids = crontabTaskIds(readFileSync(CRONTAB, 'utf8'));
    expect(ids.length).toBeGreaterThan(0);   // guards against a bad parse silently passing

    // graphile-worker does NOT reject an unknown identifier — it enqueues the
    // job and leaves it queued forever. This repo reached 51,798 orphan rows
    // from three such entries. See the header of crontab.txt.
    const unhandled = [...new Set(ids)].filter(id => !(id in taskList));
    expect(unhandled).toEqual([]);
  });
});
