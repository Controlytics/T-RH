/**
 * Performance audit 2026-11-17, G2-03 / G1-09 — the default alarm order is index-served.
 *
 * The Alarms page, the dashboard alarm panel and every alarm-table widget list
 * alarms of EVERY state newest first. No index led with raised_at, so each page
 * scanned and sorted the whole alarm set (121 / 183 ms at 107k alarms).
 * `alarms_raised_at_id_idx (raised_at DESC, id DESC)` serves the order
 * `buildAlarmOrderBy('raisedAt', …)` produces, in both directions.
 *
 * Checked under `enable_seqscan = off` (transaction-local): on a small test
 * database the planner may prefer a seq scan even when the index is usable.
 */
import { describe, it, expect } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { buildAlarmOrderBy } from '../modules/alarms/list-query.js';

async function planOf(sql: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
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
});
