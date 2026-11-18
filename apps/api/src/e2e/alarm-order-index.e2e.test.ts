/**
 * Performance audit 2026-11-17, G2-03 / G1-09 — the default alarm order is index-served.
 *
 * The Alarms page, the dashboard alarm panel and every alarm-table widget list
 * alarms of EVERY state newest first. No index led with raised_at, so each page
 * scanned and sorted the whole alarm set (121 / 183 ms at 107k alarms).
 * `alarms_raised_at_id_idx (raised_at DESC, id DESC)` serves the order
 * `buildAlarmOrderBy('raisedAt', …)` produces, in both directions.
 *
 * Checked with seq scans, bitmap scans, sorts and incremental sorts discouraged
 * (transaction-local): on a small test database the planner may legitimately
 * prefer a seq scan — or, as it did on 2026-11-18 once the test database's
 * statistics said "22 alarms", a BITMAP scan of this very index plus a sort of
 * those 22 rows, which failed a check that discouraged only seq scans. Under
 * these settings an order the index CAN produce plans as an ordered index walk,
 * and one it cannot still sorts — the control case pins that.
 */
import { describe, it, expect } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { buildAlarmOrderBy } from '../modules/alarms/list-query.js';

async function planOf(sql: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    for (const setting of ['enable_seqscan', 'enable_bitmapscan', 'enable_sort', 'enable_incremental_sort']) {
      await tx.$executeRawUnsafe(`SET LOCAL ${setting} = off`);
    }
    const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN ${sql}`);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });
}

describe('G2-03: the default alarm order', () => {
  it('is the order the index holds: raisedAt, then the unique id, same direction', () => {
    expect(buildAlarmOrderBy('raisedAt', 'desc')).toEqual([{ raisedAt: 'desc' }, { id: 'desc' }]);
  });

  it.each([
    ['newest first', 'DESC'],
    ['oldest first', 'ASC'],
  ])('%s is read from alarms_raised_at_id_idx, with no sort step', async (_label, dir) => {
    const plan = await planOf(`SELECT id FROM alarms ORDER BY raised_at ${dir}, id ${dir} LIMIT 25 OFFSET 50`);
    expect(plan).toMatch(/Index (Only )?Scan( Backward)? using alarms_raised_at_id_idx/);
    expect(plan).not.toMatch(/Sort/);
  });

  it('(control) an order the index cannot produce still sorts — the settings discriminate', async () => {
    // raised_at DESC with id ASC is neither the index's order nor its reverse.
    const plan = await planOf('SELECT id FROM alarms ORDER BY raised_at DESC, id ASC LIMIT 25 OFFSET 50');
    expect(plan).toMatch(/Sort/);
  });
});
