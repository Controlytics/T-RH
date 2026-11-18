/**
 * Performance audit 2026-11-17, P-01 — the audit chain head is read through the index.
 *
 * Every audit write reads the chain head under the global chain lock. With
 * `ORDER BY chain_position DESC NULLS LAST` the ascending
 * `audit_trail_chain_position_idx` could not serve it (read backwards it yields
 * DESC NULLS FIRST), so each write sequentially scanned the whole trail: 49 ms at
 * 107k rows on the perf copy, growing with the trail, for every audited action.
 *
 * The plan is checked with `enable_seqscan = off` (transaction-local): on a small
 * test database the planner may legitimately prefer a seq scan even when the
 * index is usable, so a plain EXPLAIN would be flaky. With seq scans
 * discouraged, an order the index CAN serve plans as an index scan, and the old
 * `NULLS LAST` order still plans as a Seq Scan (Postgres falls back to it when
 * nothing else can produce the order) — which is what the second case pins.
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { AUDIT_CHAIN_HEAD_SQL } from '../lib/audit.js';

async function planOf(query: Prisma.Sql): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    const rows = await tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>(Prisma.sql`EXPLAIN ${query}`);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });
}

describe('P-01: the audit chain head', () => {
  it('is read through an index, never by scanning the trail', async () => {
    const plan = await planOf(AUDIT_CHAIN_HEAD_SQL);
    expect(plan).toMatch(/Index (Only )?Scan( Backward)? using audit_trail_chain_position_idx/);
    expect(plan).not.toMatch(/Seq Scan/);
  });

  it('(control) the old NULLS LAST order cannot use that index', async () => {
    const plan = await planOf(Prisma.sql`SELECT checksum FROM audit_trail ORDER BY chain_position DESC NULLS LAST LIMIT 1`);
    expect(plan).toMatch(/Seq Scan on audit_trail/);
  });

  it('returns the checksum of the highest chain position', async () => {
    const [head] = await prisma.$queryRaw<Array<{ checksum: string | null }>>(AUDIT_CHAIN_HEAD_SQL);
    const [expected] = await prisma.$queryRaw<Array<{ checksum: string | null }>>`
      SELECT checksum FROM audit_trail WHERE chain_position = (SELECT MAX(chain_position) FROM audit_trail)`;
    expect(head?.checksum).toBe(expected?.checksum);
  });
});
