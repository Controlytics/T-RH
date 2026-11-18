/**
 * Performance audit G1-05 (2026-11-18) — the merged history's page and count are served by the time-ordered index
 * `instrument_telemetry_history_ts_instrument_idx` (ts DESC, instrument_id), migration 20261118120000.
 *
 * On the perf copy (30 instruments x 30 days, 1.25 M instants) the page went 4.2 s -> 1.7 ms. The COUNT is the
 * fragile half: grouped `instrument_id, ts` it took a backward scan + incremental sort with this index (5.4 -> 9.0 s);
 * grouped `ts, instrument_id` with the `ORDER BY` in its subquery it is an index-only scan with no sort (2.3 s). That
 * `ORDER BY` is a planner hint, not semantics — this file is what stops a tidy-up from removing it.
 *
 * The plans are read from the SHIPPED text (`historyPageSql` / `historyCountSql`), with seq scans, sorts, incremental
 * sorts and hash aggregates discouraged (transaction-local): on a small test database the planner may legitimately
 * prefer a sort of a few rows, so a plain EXPLAIN would prove nothing. Under these settings a statement that CAN be
 * served in index order plans without a Sort node, and one that cannot still sorts — the control case pins that the
 * settings discriminate.
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { historyCountSql, historyPageSql } from '../modules/instruments/telemetry.repository.js';

async function planOf(query: Prisma.Sql): Promise<string> {
  return prisma.$transaction(async (tx) => {
    for (const setting of ['enable_seqscan', 'enable_sort', 'enable_incremental_sort', 'enable_hashagg']) {
      await tx.$executeRawUnsafe(`SET LOCAL ${setting} = off`);
    }
    const rows = await tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>(Prisma.sql`EXPLAIN (COSTS OFF) ${query}`);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });
}

// A dense-looking selection inside the partitions the test database holds (the last week). The ids need not exist:
// the plan is what is read.
const to = new Date();
const selection = {
  instrumentIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'],
  from: new Date(to.getTime() - 7 * 86_400_000),
  to,
};

describe('G1-05: the merged history is read through the time-ordered index', () => {
  it('a PAGE walks the index in its own order and stops — no sort of the period', async () => {
    const plan = await planOf(historyPageSql({ ...selection, limit: 50, offset: 0 }));
    expect(plan).toMatch(/Index Scan using \S*ts_instrument_id_idx/);
    expect(plan).not.toMatch(/Sort/);
  });

  it('the COUNT groups straight off the index — an index-only scan, no sort, no hash', async () => {
    const plan = await planOf(historyCountSql(selection));
    expect(plan).toMatch(/Index Only Scan using \S*ts_instrument_id_idx/);
    expect(plan).not.toMatch(/Sort/);
    expect(plan).not.toMatch(/HashAggregate/);
  });

  it('(control) the count grouped the old way cannot avoid a sort — the settings discriminate', async () => {
    const plan = await planOf(Prisma.sql`
      SELECT count(*)::bigint AS count FROM (
        SELECT 1 FROM instrument_telemetry_history
        WHERE instrument_id IN (${Prisma.join(selection.instrumentIds)}) AND ts >= ${selection.from} AND ts <= ${selection.to}
        GROUP BY instrument_id, ts
      ) AS instants`);
    expect(plan).toMatch(/Sort/);
  });
});
