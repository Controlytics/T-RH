import { describe, it, expect } from 'vitest';
import {
  computeBackupChecksum,
  escapeSqlValue,
  escapeCsvValue,
  generateSqlInserts,
  generateCsv,
} from '../backup.helpers.js';

// Note: DB_TABLES and PRISMA_TO_DB were removed when the backup module
// switched to dynamic table discovery via pg_tables (see
// backup.repository.ts → getAllTables, and the dynamic-backup project
// note in memory). Coverage for the dynamic discovery lives in
// backup.repository.test.ts.

describe('backup.helpers', () => {
  describe('computeBackupChecksum', () => {
    it('returns a hex SHA-256 hash', () => {
      const result = computeBackupChecksum({ users: [{ id: '1' }] });
      expect(result).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is deterministic for same input', () => {
      const data = { users: [{ id: '1' }], roles: [{ name: 'ADMIN' }] };
      expect(computeBackupChecksum(data)).toBe(computeBackupChecksum(data));
    });

    it('sorts keys for consistent output regardless of insertion order', () => {
      const a = computeBackupChecksum({ z: [1], a: [2] });
      const b = computeBackupChecksum({ a: [2], z: [1] });
      expect(a).toBe(b);
    });

    it('produces different hashes for different data', () => {
      const a = computeBackupChecksum({ users: [{ id: '1' }] });
      const b = computeBackupChecksum({ users: [{ id: '2' }] });
      expect(a).not.toBe(b);
    });
  });

  describe('escapeSqlValue', () => {
    it('returns NULL for null/undefined', () => {
      expect(escapeSqlValue(null)).toBe('NULL');
      expect(escapeSqlValue(undefined)).toBe('NULL');
    });

    it('returns TRUE/FALSE for booleans', () => {
      expect(escapeSqlValue(true)).toBe('TRUE');
      expect(escapeSqlValue(false)).toBe('FALSE');
    });

    it('returns number as string', () => {
      expect(escapeSqlValue(42)).toBe('42');
      expect(escapeSqlValue(3.14)).toBe('3.14');
    });

    it('escapes strings with single quotes', () => {
      const result = escapeSqlValue("hello");
      expect(result).toContain("'hello'");
    });

    it('escapes single quotes in strings by doubling', () => {
      const result = escapeSqlValue("it's");
      expect(result).toContain("it''s");
    });

    it('handles Date objects', () => {
      const d = new Date('2026-01-01T00:00:00Z');
      const result = escapeSqlValue(d);
      expect(result).toContain('2026-01-01');
    });

    it('handles objects as JSONB', () => {
      const result = escapeSqlValue({ key: 'value' });
      expect(result).toContain('jsonb');
      expect(result).toContain('key');
    });
  });

  describe('escapeCsvValue', () => {
    it('returns empty string for null/undefined', () => {
      expect(escapeCsvValue(null)).toBe('');
      expect(escapeCsvValue(undefined)).toBe('');
    });

    it('returns simple values as-is', () => {
      expect(escapeCsvValue('hello')).toBe('hello');
      expect(escapeCsvValue(42)).toBe('42');
    });

    it('quotes values containing commas', () => {
      const result = escapeCsvValue('a,b');
      expect(result).toBe('"a,b"');
    });

    it('quotes and escapes double quotes', () => {
      const result = escapeCsvValue('say "hi"');
      expect(result).toContain('""');
    });

    it('handles Date objects as ISO strings', () => {
      const d = new Date('2026-01-01T00:00:00Z');
      const result = escapeCsvValue(d);
      expect(result).toContain('2026-01-01');
    });

    it('handles objects as JSON strings', () => {
      const result = escapeCsvValue({ key: 'val' });
      expect(result).toContain('key');
    });
  });

  describe('generateSqlInserts', () => {
    it('returns comment for empty rows', () => {
      const result = generateSqlInserts('users', []);
      expect(result).toContain('-- Table: users');
      expect(result).toContain('0 rows');
    });

    it('generates INSERT statements for rows', () => {
      const rows = [{ id: 1, name: 'admin' }];
      const result = generateSqlInserts('users', rows);
      expect(result).toContain('INSERT INTO');
      expect(result).toContain('users');
      expect(result).toContain('admin');
    });

    it('handles multiple rows', () => {
      const rows = [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ];
      const result = generateSqlInserts('users', rows);
      const insertCount = (result.match(/INSERT INTO/g) || []).length;
      expect(insertCount).toBe(2);
    });
  });

  describe('generateCsv', () => {
    it('returns empty string for empty rows', () => {
      expect(generateCsv([])).toBe('');
    });

    it('generates header row from keys', () => {
      const rows = [{ id: 1, name: 'admin' }];
      const result = generateCsv(rows);
      const lines = result.split('\n');
      expect(lines[0]).toBe('id,name');
    });

    it('generates data rows', () => {
      const rows = [{ id: 1, name: 'admin' }, { id: 2, name: 'user' }];
      const result = generateCsv(rows);
      const lines = result.split('\n');
      expect(lines).toHaveLength(3); // header + 2 data rows
      expect(lines[1]).toContain('admin');
      expect(lines[2]).toContain('user');
    });
  });
});
