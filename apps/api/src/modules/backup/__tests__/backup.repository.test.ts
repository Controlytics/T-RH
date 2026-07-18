import { describe, it, expect, beforeEach, vi } from 'vitest';

// fetchAllTablesRaw discovers tables via pg_tables, then queries each. We
// stub $queryRawUnsafe with two response shapes:
//   1. The pg_tables / information_schema introspection queries return rows
//      describing the schema (table list + FK list).
//   2. Subsequent SELECT * FROM "<table>" queries return [].
// To keep the stub simple and intent-revealing, mockResolvedValueOnce()
// chains the responses in order.
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRawUnsafe: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import {
  fetchAllTablesRaw,
  resyncSequencesAfterRestore,
  getAllTables,
  restoreFromBackup,
} from '../backup.repository.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('backup.repository', () => {
  /**
   * Restore TRUNCATEs every table but repopulates only those the backup carries,
   * so an omitted table is destroyed and never comes back. Nothing caught this:
   * the chain check is skipped entirely when audit_trail is absent (its
   * `length > 0` guard is false), so a JSON without an audit_trail key silently
   * annihilated all 21 CFR history and returned 200.
   */
  describe('restoreFromBackup — omitted-table guard', () => {
    // getAllTables() does two introspection queries: pg_tables, then FKs.
    const stubSchema = (tables: string[]) => {
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce(tables.map((t) => ({ tablename: t })))
        .mockResolvedValueOnce([]) // no FKs
        .mockResolvedValueOnce([]); // self-ref columns
    };

    it('refuses a backup that omits audit_trail, naming the §11 consequence', async () => {
      stubSchema(['users', 'audit_trail']);
      await expect(
        restoreFromBackup({ data: { users: [] } } as any),
      ).rejects.toMatchObject({ code: 'BACKUP_INCOMPLETE' });
      // Nothing may be truncated when we refuse.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('names every omitted table so the operator can tell what would be lost', async () => {
      stubSchema(['users', 'audit_trail', 'filters']);
      await expect(restoreFromBackup({ data: { users: [] } } as any))
        .rejects.toThrow(/audit_trail.*filters|filters.*audit_trail/s);
    });

    it('force=true is the explicit escape hatch and proceeds', async () => {
      stubSchema(['users', 'audit_trail']);
      mockPrisma.$transaction.mockResolvedValueOnce(undefined);
      await restoreFromBackup({ data: { users: [] } } as any, { force: true });
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('a complete backup restores without the guard firing', async () => {
      stubSchema(['users', 'audit_trail']);
      mockPrisma.$transaction.mockResolvedValueOnce(undefined);
      await restoreFromBackup({ data: { users: [], audit_trail: [] } } as any);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('ignores _prisma_migrations — excluded, never restored, must not trip the guard', async () => {
      stubSchema(['users', '_prisma_migrations']);
      mockPrisma.$transaction.mockResolvedValueOnce(undefined);
      await restoreFromBackup({ data: { users: [] } } as any);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('getAllTables', () => {
    it('lists public tables in topological FK order, excluding the excluded set', async () => {
      // pg_tables → 3 tables; FK introspection → users -> roles
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([
          { tablename: 'roles' },
          { tablename: 'users' },
          { tablename: '_prisma_migrations' }, // EXCLUDED — should be filtered
        ])
        .mockResolvedValueOnce([
          { table_name: 'users', referenced_table: 'roles' },
        ]);

      const tables = await getAllTables();

      expect(tables).not.toContain('_prisma_migrations');
      expect(tables).toContain('roles');
      expect(tables).toContain('users');
      // roles has no deps, users depends on roles → roles must come first
      expect(tables.indexOf('roles')).toBeLessThan(tables.indexOf('users'));
    });
  });

  describe('fetchAllTablesRaw', () => {
    it('queries every discovered table via $queryRawUnsafe', async () => {
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([{ tablename: 'roles' }, { tablename: 'users' }]) // pg_tables
        .mockResolvedValueOnce([])            // foreign-keys (no FKs found)
        .mockResolvedValueOnce([{ c: 0n }])  // COUNT(*) "roles" (pre-flight size guard)
        .mockResolvedValueOnce([{ c: 0n }])  // COUNT(*) "users" (pre-flight size guard)
        .mockResolvedValueOnce([{ id: 1 }])  // SELECT * FROM "roles"
        .mockResolvedValueOnce([{ id: 2 }]); // SELECT * FROM "users"

      const result = await fetchAllTablesRaw();

      expect(result).toHaveProperty('roles');
      expect(result).toHaveProperty('users');
      // 1 pg_tables + 1 FKs + 2 COUNTs (pre-flight) + 2 SELECTs
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(6);
    });

    it('orders the audit_trail SELECT by id ASC for byte-for-byte reproducible backups', async () => {
      mockPrisma.$queryRawUnsafe
        .mockResolvedValueOnce([{ tablename: 'audit_trail' }, { tablename: 'roles' }]) // pg_tables
        .mockResolvedValueOnce([])            // foreign-keys
        .mockResolvedValueOnce([{ c: 0n }])  // COUNT(*) "audit_trail" (pre-flight size guard)
        .mockResolvedValueOnce([{ c: 0n }])  // COUNT(*) "roles" (pre-flight size guard)
        .mockResolvedValueOnce([])           // SELECT * FROM "audit_trail"
        .mockResolvedValueOnce([]);          // SELECT * FROM "roles"

      await fetchAllTablesRaw();

      const auditCall = mockPrisma.$queryRawUnsafe.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('audit_trail') && (call[0] as string).startsWith('SELECT *'),
      );
      expect(auditCall).toBeDefined();
      expect(auditCall![0] as string).toContain('ORDER BY id ASC');
    });
  });

  /**
   * Replaces a test that asserted `resetAuditSequence` "is a no-op: audit_trail
   * PK is a UUID with no sequence to reset". The premise was false — the PK is a
   * UUID, but `chain_position` is a BIGSERIAL with its own sequence — so the
   * test was locking in the bug: nothing realigned sequences after a restore,
   * which collided deviation numbers and broke hash-chain verification.
   */
  describe('resyncSequencesAfterRestore', () => {
    const tx = () => ({ $executeRawUnsafe: vi.fn().mockResolvedValue(undefined) });

    it('realigns all three manual sequences when their tables were restored', async () => {
      const t = tx();
      await resyncSequencesAfterRestore(t, ['audit_trail', 'deviations', 'quality_notifications', 'users']);
      const sql = t.$executeRawUnsafe.mock.calls.map((c: any[]) => c[0] as string).join('\n');
      expect(sql).toContain('audit_trail_chain_position_seq');
      expect(sql).toContain('deviation_number_seq');
      expect(sql).toContain('qnn_seq');
      expect(t.$executeRawUnsafe).toHaveBeenCalledTimes(3);
    });

    it('skips a sequence whose table was not in the backup', async () => {
      const t = tx();
      await resyncSequencesAfterRestore(t, ['users']);
      expect(t.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('derives chain_position from MAX so new rows continue after restored history', async () => {
      const t = tx();
      await resyncSequencesAfterRestore(t, ['audit_trail']);
      const sql = t.$executeRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain('MAX(chain_position)');
      // COALESCE(...,0)+1 with is_called=false → next nextval is 1 on an empty
      // table (setval rejects anything below the sequence minimum).
      expect(sql).toContain('COALESCE');
      expect(sql).toMatch(/,\s*false\s*\)/);
    });

    it('parses the numeric suffix of deviation numbers and ignores malformed values', async () => {
      const t = tx();
      await resyncSequencesAfterRestore(t, ['deviations']);
      const sql = t.$executeRawUnsafe.mock.calls[0][0] as string;
      // 'DEV-000042' -> 42
      expect(sql).toContain("substring(deviation_number FROM '([0-9]+)$')");
      // A hand-edited row without a numeric suffix must not NULL out the MAX.
      expect(sql).toContain("deviation_number ~ '[0-9]+$'");
    });

    it('parses the numeric suffix of QNNs (sequence is global, not per-year)', async () => {
      const t = tx();
      await resyncSequencesAfterRestore(t, ['quality_notifications']);
      const sql = t.$executeRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain("substring(qnn FROM '([0-9]+)$')");
      expect(sql).toContain("qnn ~ '[0-9]+$'");
    });
  });
});
