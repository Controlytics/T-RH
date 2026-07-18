import { describe, it, expect, beforeEach, vi } from 'vitest';
import { gunzipSync, gzipSync } from 'zlib';

const { mockFetchPrisma, mockFetchRaw, mockRestoreFromBackup, mockAuditLog, mockComputeChecksum } = vi.hoisted(() => ({
  mockFetchPrisma: vi.fn(),
  mockFetchRaw: vi.fn(),
  mockRestoreFromBackup: vi.fn(),
  mockAuditLog: vi.fn(),
  mockComputeChecksum: vi.fn(),
}));

vi.mock('../backup.repository.js', () => ({
  fetchAllTablesPrisma: mockFetchPrisma,
  fetchAllTablesRaw: mockFetchRaw,
  restoreFromBackup: mockRestoreFromBackup,
}));

vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));

vi.mock('../backup.helpers.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    computeBackupChecksum: mockComputeChecksum,
  };
});

import { validate, restore } from '../backup.service.js';

const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' };

function makeBackup(overrides: Record<string, any> = {}) {
  return {
    metadata: {
      version: '1.0',
      timestamp: '2026-01-01T00:00:00Z',
      generatedBy: 'admin',
      tableCount: 2,
      checksum: 'abc123',
      format: 'json',
      ...overrides,
    },
    data: { roles: [{ name: 'ADMIN' }], users: [{ id: 'u1' }] },
  };
}

describe('backup.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditLog.mockResolvedValue(undefined);
  });

  describe('validate', () => {
    it('validates a valid JSON backup', async () => {
      const backup = makeBackup();
      const buf = Buffer.from(JSON.stringify(backup));
      mockComputeChecksum.mockReturnValue('abc123');

      const result = await validate(buf);
      expect(result.valid).toBe(true);
      expect(result.checksumValid).toBe(true);
      expect(result.metadata.version).toBe('1.0');
    });

    it('validates a gzip compressed backup', async () => {
      const backup = makeBackup({ format: 'bak' });
      const buf = gzipSync(Buffer.from(JSON.stringify(backup)));
      mockComputeChecksum.mockReturnValue('abc123');

      const result = await validate(buf);
      expect(result.valid).toBe(true);
    });

    it('detects checksum mismatch', async () => {
      const backup = makeBackup();
      const buf = Buffer.from(JSON.stringify(backup));
      mockComputeChecksum.mockReturnValue('wrong-checksum');

      const result = await validate(buf);
      expect(result.checksumValid).toBe(false);
    });

    it('returns table summary with record counts', async () => {
      const backup = makeBackup();
      const buf = Buffer.from(JSON.stringify(backup));
      mockComputeChecksum.mockReturnValue('abc123');

      const result = await validate(buf);
      expect(result.tableSummary.roles).toBe(1);
      expect(result.tableSummary.users).toBe(1);
      expect(result.totalRecords).toBe(2);
    });

    it('json/bak: checksum is a real independent check → checksumSupported true', async () => {
      const backup = makeBackup();
      const buf = Buffer.from(JSON.stringify(backup));
      mockComputeChecksum.mockReturnValue('abc123');
      const result = await validate(buf);
      expect(result.checksumSupported).toBe(true);
      expect(result.checksumValid).toBe(true);
      expect(result.valid).toBe(true);
    });

    it('#low-batch: SQL backup → checksumSupported=false, checksumValid=false, valid=true (no false VALID)', async () => {
      // SQL/CSV synthesize the checksum from the parsed data at import, so a
      // self-comparison always "passes". Report it as not-independently-verifiable
      // instead of a green VALID, but keep valid=true since the file is restorable.
      mockComputeChecksum.mockReturnValue('whatever'); // its own metadata.checksum
      const sql = [
        '-- DigiLog Database Backup',
        'TRUNCATE TABLE "roles" CASCADE;',
        `INSERT INTO "roles" ("name") VALUES ('ADMIN');`,
      ].join('\n');

      const result = await validate(Buffer.from(sql));
      expect(result.metadata.format).toBe('sql');
      expect(result.checksumSupported).toBe(false);
      expect(result.checksumValid).toBe(false);
      expect(result.valid).toBe(true); // parseable ⇒ restorable
    });

    it('rejects invalid JSON', async () => {
      const buf = Buffer.from('not json');
      await expect(validate(buf)).rejects.toThrow();
    });

    it('rejects missing metadata', async () => {
      const buf = Buffer.from(JSON.stringify({ data: {} }));
      await expect(validate(buf)).rejects.toThrow();
    });
  });

  describe('restore', () => {
    it('restores valid backup successfully', async () => {
      const backup = makeBackup();
      const buf = Buffer.from(JSON.stringify(backup));
      mockComputeChecksum.mockReturnValue('abc123');
      mockRestoreFromBackup.mockResolvedValue(undefined);

      const result = await restore(buf, ctx);
      expect(result.success).toBe(true);
      expect(result.backupVersion).toBe('1.0');
      expect(mockRestoreFromBackup).toHaveBeenCalled();
      // Sequence realignment now happens inside restoreFromBackup's transaction
      // (resyncSequencesAfterRestore), not as a separate service-level call.
      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'BACKUP_RESTORED' }));
    });

    it('rejects backup with checksum mismatch', async () => {
      const backup = makeBackup();
      const buf = Buffer.from(JSON.stringify(backup));
      mockComputeChecksum.mockReturnValue('wrong');

      await expect(restore(buf, ctx)).rejects.toThrow();
    });
  });

  describe('SQL-format restore parsing (string-aware, #audit HIGH)', () => {
    // Regression for the outer-regex data-loss bugs: the old
    // /...VALUES\s*\((.+?)\);/g dropped rows with newlines (`.` can't cross
    // `\n`), truncated rows whose value contained `);`, and re-matched an
    // `INSERT INTO ...` substring living inside a string value.
    it('preserves rows containing newlines, ");", embedded INSERTs, quotes, jsonb', async () => {
      mockRestoreFromBackup.mockResolvedValue(undefined);
      // Note: r2's value contains a REAL newline; r5 has an escaped single quote.
      const sql = [
        '-- DigiLog Database Backup',
        '-- Generated By: admin',
        'BEGIN;',
        'TRUNCATE TABLE "audit_trail" CASCADE;',
        '',
        '-- Table: audit_trail (5 rows)',
        `INSERT INTO "audit_trail" ("id", "reason") VALUES ('r1', 'cleaned filter (A); then redo');`,
        `INSERT INTO "audit_trail" ("id", "reason") VALUES ('r2', 'line one\nline two');`,
        `INSERT INTO "audit_trail" ("id", "note") VALUES ('r3', 'see INSERT INTO "x" ("a") VALUES (1); embedded');`,
        `INSERT INTO "audit_trail" ("id", "meta") VALUES ('r4', '{"a":1,"b":"c);d"}'::jsonb);`,
        `INSERT INTO "audit_trail" ("id", "reason") VALUES ('r5', 'O''Brien said hi');`,
        'COMMIT;',
      ].join('\n');

      await restore(Buffer.from(sql), ctx);

      const passed = mockRestoreFromBackup.mock.calls[0][0];
      const rows = passed.data.audit_trail as Array<Record<string, any>>;
      expect(rows).toHaveLength(5);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

      expect(byId.r1.reason).toBe('cleaned filter (A); then redo'); // old regex truncated at "(A);"
      expect(byId.r2.reason).toBe('line one\nline two');            // old regex dropped this row
      expect(byId.r3.note).toBe('see INSERT INTO "x" ("a") VALUES (1); embedded'); // no re-match
      expect(byId.r4.meta).toEqual({ a: 1, b: 'c);d' });            // jsonb with ")" inside
      expect(byId.r5.reason).toBe("O'Brien said hi");               // '' unescaped
    });

    it('seeds empty tables from TRUNCATE and stops cleanly on a truncated tail', async () => {
      mockRestoreFromBackup.mockResolvedValue(undefined);
      const sql = [
        '-- DigiLog Database Backup',
        'TRUNCATE TABLE "roles" CASCADE;',
        `INSERT INTO "roles" ("name") VALUES ('ADMIN');`,
        // Malformed/truncated final statement (no closing paren) — must not throw
        // and must not corrupt already-parsed rows.
        `INSERT INTO "roles" ("name") VALUES ('BROKEN`,
      ].join('\n');

      await restore(Buffer.from(sql), ctx);

      const passed = mockRestoreFromBackup.mock.calls[0][0];
      expect(passed.data.roles).toEqual([{ name: 'ADMIN' }]);
    });
  });
});
