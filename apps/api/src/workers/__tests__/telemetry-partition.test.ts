import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import {
  ensurePartitions, dropExpiredPartitions, partitionName, retentionSettings,
} from '../telemetry-partition.worker.js';

/**
 * These run against a SCRATCH partitioned table, never the real
 * `instrument_telemetry_history`.
 *
 * The first version of this file did not, and destroyed the real 2026
 * partitions in the test database: dropExpiredPartitions(1, now=2099-03-10)
 * computes a cutoff of 2099-02-01, which is later than EVERY 2026 partition, so
 * they were all "entirely outside the window". The repository and ingestion
 * suites then failed with "no partition of relation ... found for row".
 *
 * Worse, the test that was supposed to catch this — "leaves the real partitions
 * alone" — passed, because it ran after the drop and its `before` list was
 * already empty. A destructive test that also disables its own guard.
 */
const SCRATCH = 'test_partition_parent';

async function partitions(parent = SCRATCH): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT c.relname AS name
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = ${parent}
    ORDER BY c.relname`;
  return rows.map(r => r.name);
}

const AT = new Date(Date.UTC(2026, 0, 1));   // 2026-01

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${SCRATCH}" CASCADE`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${SCRATCH}" (
      "instrument_id" TEXT NOT NULL,
      "key"           TEXT NOT NULL,
      "value"         JSONB NOT NULL,
      "value_type"    TEXT NOT NULL,
      "ts"            TIMESTAMP(3) NOT NULL,
      "received_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY ("instrument_id","key","ts")
    ) PARTITION BY RANGE ("ts")`);
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${SCRATCH}" CASCADE`);
});

beforeEach(async () => {
  for (const name of await partitions()) {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${name}"`);
  }
});

describe('ensurePartitions', () => {
  it('creates the current month plus the requested months ahead', async () => {
    const created = await ensurePartitions(2, AT, SCRATCH);
    expect(created).toEqual([
      `${SCRATCH}_2026_01`, `${SCRATCH}_2026_02`, `${SCRATCH}_2026_03`,
    ]);
    expect(await partitions()).toEqual(created);
  });

  it('is idempotent — running twice does not throw', async () => {
    await ensurePartitions(2, AT, SCRATCH);
    await expect(ensurePartitions(2, AT, SCRATCH)).resolves.toBeDefined();
    expect(await partitions()).toHaveLength(3);
  });

  it('rolls over the year boundary correctly', async () => {
    const created = await ensurePartitions(1, new Date(Date.UTC(2026, 11, 15)), SCRATCH);
    expect(created).toEqual([`${SCRATCH}_2026_12`, `${SCRATCH}_2027_01`]);
  });

  it('accepts a row in a newly created partition', async () => {
    await ensurePartitions(1, AT, SCRATCH);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "${SCRATCH}" (instrument_id, key, value, value_type, ts, received_at)
      VALUES ('p', 'k', '1'::jsonb, 'int', '2026-01-15T00:00:00Z', now())`);
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "${SCRATCH}"`);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('rejects a row outside every partition — the failure mode this prevents', async () => {
    await ensurePartitions(1, AT, SCRATCH);           // 2026_01, 2026_02 only
    await expect(prisma.$executeRawUnsafe(`
      INSERT INTO "${SCRATCH}" (instrument_id, key, value, value_type, ts, received_at)
      VALUES ('p', 'k', '1'::jsonb, 'int', '2026-06-01T00:00:00Z', now())`),
    ).rejects.toThrow(/no partition of relation/i);
  });
});

describe('dropExpiredPartitions', () => {
  it('drops only months entirely outside the window', async () => {
    await ensurePartitions(2, AT, SCRATCH);           // 2026_01, _02, _03
    // Now = 2026-03, retention 1 month → cutoff 2026-02-01. Only 2026_01 ends
    // at or before that.
    const dropped = await dropExpiredPartitions(1, new Date(Date.UTC(2026, 2, 10)), SCRATCH);
    expect(dropped).toEqual([`${SCRATCH}_2026_01`]);
    expect(await partitions()).toEqual([`${SCRATCH}_2026_02`, `${SCRATCH}_2026_03`]);
  });

  it('NEVER drops the current month, even with a 1-month retention', async () => {
    await ensurePartitions(2, AT, SCRATCH);
    const current = partitionName(AT, SCRATCH);
    const dropped = await dropExpiredPartitions(1, new Date(Date.UTC(2026, 0, 20)), SCRATCH);
    expect(dropped).not.toContain(current);
    expect(await partitions()).toContain(current);
  });

  it('never drops a future partition', async () => {
    await ensurePartitions(2, AT, SCRATCH);
    const dropped = await dropExpiredPartitions(1, new Date(Date.UTC(2026, 0, 20)), SCRATCH);
    expect(dropped).toEqual([]);
  });

  it('drops nothing when everything is inside the window', async () => {
    await ensurePartitions(2, AT, SCRATCH);
    const dropped = await dropExpiredPartitions(12, new Date(Date.UTC(2026, 2, 10)), SCRATCH);
    expect(dropped).toEqual([]);
    expect(await partitions()).toHaveLength(3);
  });

  it('does not touch the real telemetry table', async () => {
    const realBefore = await partitions('instrument_telemetry_history');
    await ensurePartitions(2, AT, SCRATCH);
    await dropExpiredPartitions(1, new Date(Date.UTC(2026, 2, 10)), SCRATCH);
    expect(await partitions('instrument_telemetry_history')).toEqual(realBefore);
  });
});

describe('retentionSettings', () => {
  it('defaults safely — dropping OFF, at least two months ahead', async () => {
    const s = await retentionSettings();
    expect(s.dropEnabled).toBe(false);
    expect(s.monthsAhead).toBeGreaterThanOrEqual(2);
    expect(s.retentionMonths).toBeGreaterThanOrEqual(1);
  });
});
