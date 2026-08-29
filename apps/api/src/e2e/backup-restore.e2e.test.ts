import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import {
  getAllTables,
  fetchAllTablesRaw,
  restoreFromBackup,
} from '../modules/backup/backup.repository.js';
import type { BackupData } from '../modules/backup/backup.helpers.js';

/**
 * Backup / restore round trip.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before 2026-08-29 the backup module had 3 unit tests and NO e2e coverage,
 * despite being the disaster-recovery path of a 21 CFR Part 11 system and the
 * most raw-SQL-heavy module in the codebase (it TRUNCATEs every table,
 * disables every trigger, and reinserts in topological order).
 *
 * That gap hid a real defect. `getAllTables()` discovered tables with a bare
 * `SELECT tablename FROM pg_tables WHERE schemaname='public'`, and
 * `instrument_telemetry_history` is PARTITION BY RANGE with one child table
 * per month. `pg_tables` lists the partitioned parent AND every child, so:
 *
 *   - export dumped every telemetry reading TWICE (parent + child). Measured
 *     on the dev database 2026-08-29: 226,582 real readings, 453,164 rows in
 *     the archive.
 *   - restore inserted both copies — inserting into the parent routes the row
 *     into its child partition, then the child's own dump adds it again — so
 *     a §11 telemetry record silently DOUBLED on every restore.
 *
 * It never threw. It produced a plausible archive with corrupt contents,
 * which is the worse failure mode and precisely what an e2e round trip
 * catches and a unit test does not.
 *
 * SAFETY
 * ------
 * `restoreFromBackup` wraps TRUNCATE + reinsert in a single
 * `prisma.$transaction`, so a failure rolls the whole thing back and leaves
 * the database as it was. This suite also restores exactly the archive it
 * just exported, so a successful run is a no-op on content. Combined with
 * vitest.env.ts forcing the connection onto `*_test`, this cannot touch a
 * live audit trail.
 */

/** Row count straight from Postgres, bypassing anything the module believes. */
async function countRows(table: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
    `SELECT COUNT(*)::bigint AS c FROM "${table}"`,
  );
  return Number(rows[0]?.c ?? 0n);
}

async function partitionChildren(parent: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT c.relname::text AS name
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = $1`,
    parent,
  );
  return rows.map((r) => r.name);
}

const HISTORY = 'instrument_telemetry_history';

describe('backup: table discovery excludes partition children', () => {
  let tables: string[];
  let children: string[];

  beforeAll(async () => {
    tables = await getAllTables();
    children = await partitionChildren(HISTORY);
  });

  // If the fixture ever loses its partitions the assertions below become
  // vacuous, so assert the precondition explicitly.
  it('the telemetry history table really is partitioned in this database', () => {
    expect(children.length).toBeGreaterThan(0);
  });

  it('includes the partitioned PARENT', () => {
    // The parent must stay in the backup set: inserting into it routes each
    // row to whichever partition covers its `ts`, so an archive restores
    // cleanly into a database whose partition set has rolled forward.
    expect(tables).toContain(HISTORY);
  });

  it('excludes every partition CHILD', () => {
    for (const child of children) {
      expect(tables).not.toContain(child);
    }
  });

  it('does not return the same logical table twice', () => {
    expect(new Set(tables).size).toBe(tables.length);
  });
});

describe('backup: export does not duplicate partitioned rows', () => {
  let data: Record<string, Record<string, any>[]>;
  let historyCount: number;

  beforeAll(async () => {
    historyCount = await countRows(HISTORY);
    data = await fetchAllTablesRaw();
  }, 120_000);

  it('carries the telemetry history parent', () => {
    expect(Object.keys(data)).toContain(HISTORY);
  });

  it('carries no partition-child keys', async () => {
    const children = await partitionChildren(HISTORY);
    for (const child of children) {
      expect(Object.keys(data)).not.toContain(child);
    }
  });

  // THE REGRESSION TEST. Under the old bare-pg_tables discovery this was
  // exactly 2x (parent + the one non-empty child).
  it('exports each telemetry reading exactly once', () => {
    expect(data[HISTORY]).toHaveLength(historyCount);
  });

  it('exports no more telemetry rows than the table holds', () => {
    const exported = Object.entries(data)
      .filter(([t]) => t.startsWith('instrument_telemetry_history'))
      .reduce((sum, [, rows]) => sum + rows.length, 0);
    expect(exported).toBe(historyCount);
  });
});

describe('backup: full restore round trip', () => {
  it('restores its own export without changing row counts', async () => {
    const before: Record<string, number> = {};
    const tables = await getAllTables();
    for (const t of tables) before[t] = await countRows(t);

    const data = await fetchAllTablesRaw();
    const backup: BackupData = {
      metadata: {
        version: 'e2e',
        timestamp: new Date().toISOString(),
        generatedBy: 'backup-restore.e2e.test.ts',
        tableCount: Object.keys(data).length,
        checksum: 'e2e',
      },
      data,
    };

    // `force` skips the audit-chain pre-check. This suite is asserting the
    // TABLE DISCOVERY and row-count behaviour of restore, and the test
    // database's chain state is set by whichever suites ran before it — an
    // unrelated chain gap would otherwise fail this test for the wrong
    // reason. Chain verification has its own coverage in audit-chain.test.ts.
    await restoreFromBackup(backup, { force: true });

    for (const t of tables) {
      expect({ table: t, rows: await countRows(t) }).toEqual({ table: t, rows: before[t] });
    }
  }, 300_000);

  it('a row created after the export is gone after restoring that export', async () => {
    // Proves the restore genuinely replaced the data rather than no-opping —
    // without which the count assertions above could pass on a restore that
    // did nothing at all.
    const data = await fetchAllTablesRaw();
    const backup: BackupData = {
      metadata: {
        version: 'e2e',
        timestamp: new Date().toISOString(),
        generatedBy: 'backup-restore.e2e.test.ts',
        tableCount: Object.keys(data).length,
        checksum: 'e2e',
      },
      data,
    };

    const canaryCode = `E2E-CANARY-${Date.now()}`;
    await prisma.functionalLocation.create({
      data: { name: canaryCode, type: 'BLOCK' },
    });
    expect(
      await prisma.functionalLocation.findFirst({ where: { name: canaryCode } }),
    ).not.toBeNull();

    await restoreFromBackup(backup, { force: true });

    expect(
      await prisma.functionalLocation.findFirst({ where: { name: canaryCode } }),
    ).toBeNull();
  }, 300_000);
});
