import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import {
  ensurePartitions, dropExpiredPartitions, partitionName, retentionSettings, ensurePartitionsAtBoot,
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
      -- TIMESTAMPTZ, matching the real instrument_telemetry_history since
      -- migration 20260804120000. With a plain TIMESTAMP here the partition
      -- bounds carry no timezone and the UTC-anchoring bug below is invisible.
      "ts"            TIMESTAMPTZ NOT NULL,
      "received_at"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
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

  it('anchors bounds to UTC, not the session timezone', async () => {
    // A non-UTC session is the normal case on a Windows dev box and on RDS.
    // With bare-date bounds the partitions would start at 05:30 local here, so
    // 2026-01-31T20:00Z would land in a gap and be rejected. Run the whole
    // thing under a deliberately awkward zone and assert the boundary rows.
    await prisma.$executeRawUnsafe(`SET TIME ZONE 'Asia/Kolkata'`);
    try {
      await ensurePartitions(2, AT, SCRATCH);
      for (const iso of ['2026-01-01T00:00:00Z', '2026-01-31T20:00:00Z', '2026-02-01T00:00:00Z']) {
        await prisma.$executeRawUnsafe(`
          INSERT INTO "${SCRATCH}" (instrument_id, key, value, value_type, ts, received_at)
          VALUES ('p', '${iso}', '1'::jsonb, 'int', '${iso}', now())`);
      }
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "${SCRATCH}"`);
      expect(Number(rows[0].n)).toBe(3);

      // And the row exactly on the UTC month boundary must be in FEBRUARY,
      // not still in January (which is where a +05:30 bound would put it).
      const feb = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "${SCRATCH}_2026_02"`);
      expect(Number(feb[0].n)).toBe(1);
    } finally {
      await prisma.$executeRawUnsafe(`SET TIME ZONE 'UTC'`);
    }
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

/**
 * Audit 2026-10-03, INGEST-2 / DATA-2: the migrations ship `2026_08` and
 * `2026_09` by name and the cron runs on the 1st/15th with no backfill, so a
 * fresh install between those dates refused every reading. `app.ts` now calls
 * this at boot. It runs against the REAL parent on purpose — that is the table
 * a boot must prepare — and is idempotent, so the test database only gains the
 * months it should already have.
 */
describe('ensurePartitionsAtBoot', () => {
  it('creates the current month and the administered months ahead on the real parent, and reports them', async () => {
    const info: unknown[] = [];
    const names = await ensurePartitionsAtBoot({ info: (o) => info.push(o), error: () => { throw new Error('must not log an error'); } });
    const settings = await retentionSettings();
    expect(names).toHaveLength(settings.monthsAhead + 1);
    expect(names[0]).toBe(partitionName(new Date()));
    const rows = await prisma.$queryRawUnsafe<{ relname: string }[]>(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'instrument_telemetry_history'`,
    );
    for (const n of names) expect(rows.map((r) => r.relname)).toContain(n);
    expect(info).toHaveLength(1);
  });

  it('never throws — a failure is logged and the cron is left to retry', async () => {
    const errors: unknown[] = [];
    // An OWN property shadows the Prisma proxy's method; deleting it afterwards
    // hands the call back to the proxy (vi.spyOn's restore leaves it undefined).
    const client = prisma as unknown as Record<string, unknown>;
    client.$executeRawUnsafe = vi.fn().mockRejectedValueOnce(new Error('boom: no parent'));
    try {
      const names = await ensurePartitionsAtBoot({ info: () => { throw new Error('must not log success'); }, error: (o) => errors.push(o) });
      expect(names).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(String((errors[0] as { err: Error }).err.message)).toContain('boom');
    } finally {
      delete client.$executeRawUnsafe;
    }
  });
});

