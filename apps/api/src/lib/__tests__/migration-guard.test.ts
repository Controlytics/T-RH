import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROTECTED_TABLES,
  UNMODELLED_TABLES,
  findViolations,
  migrationsDir,
  scanMigrations,
  stripSqlComments,
} from '../migration-guard.js';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('migration guard — the real tree', () => {
  // THE POINT OF THIS FILE. `prisma migrate dev` / `db push` will happily
  // generate `DROP TABLE "instrument_telemetry_history"`, because that table
  // has no Prisma model (Prisma cannot express PARTITION BY RANGE). Measured
  // 2026-08-29 the table held 226,582 readings; there is no other copy.
  it('no committed migration drops a protected table', () => {
    const violations = scanMigrations(apiRoot);
    expect(violations).toEqual([]);
  });

  it('protects the partitioned telemetry history table', () => {
    expect(PROTECTED_TABLES).toContain('instrument_telemetry_history');
  });

  // NON-VACUITY PROOF. The test above passes on an empty result, which is
  // also what a broken scanner returns. This asserts the scanner really is
  // reading these files and that comment-stripping is what makes them pass.
  //
  // The committed migrations contain FIFTEEN occurrences of
  // `DROP TABLE ... instrument_telemetry_history`, every one of them inside a
  // `--` comment left by an author who had just stripped Prisma's generated
  // DROP by hand. That is the clearest possible evidence this hazard is real
  // and recurring: it has been generated and manually removed on essentially
  // every migration since 2026-08-08. It only has to be missed once.
  it('reads the real migration files (comment-stripping is doing the work)', () => {
    const dir = migrationsDir(apiRoot);
    const withCommentedDrops = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name, 'migration.sql'))
      .filter((p) => existsSync(p))
      .filter((p) => /DROP\s+TABLE[^\n]*instrument_telemetry_history/i.test(
        readFileSync(p, 'utf8'),
      ));

    // If this ever hits 0, either the migrations changed or the fixture moved
    // — and the clean scan above would then be proving nothing.
    expect(withCommentedDrops.length).toBeGreaterThan(0);

    // Every one of them must be a comment, not a live statement.
    for (const file of withCommentedDrops) {
      expect(findViolations(file, readFileSync(file, 'utf8'))).toEqual([]);
    }
  });

  // Prove the scanner reports a violation when one genuinely exists, using
  // the real directory and a protected-table list chosen to match live SQL.
  it('flags a live DROP when one exists in a scanned file', () => {
    const sql = 'CREATE TABLE "x" (id text);\nDROP TABLE "audit_trail";';
    expect(findViolations('synthetic', sql)).toHaveLength(1);
  });
});

describe('migration guard — schema.prisma invariants', () => {
  const schemaPath = path.join(apiRoot, 'prisma', 'schema.prisma');

  it('finds schema.prisma where expected', () => {
    expect(existsSync(schemaPath)).toBe(true);
  });

  // If this test fails because someone ADDED a model for
  // instrument_telemetry_history, that is not automatically wrong — but it is
  // a decision that must be made deliberately, because Prisma would then emit
  // a plain CREATE TABLE for a fresh environment and produce an UNPARTITIONED
  // table. Ingest then dies at the first month boundary, when Postgres
  // rejects any row whose `ts` falls outside a partition range.
  // Read src/lib/migration-guard.ts before changing this.
  //
  // Matches the DECLARATION, not the bare table name. A substring check would
  // fail the moment anyone writes a COMMENT naming the table — and the audit's
  // own cleanup plan recommends adding exactly such a comment beside
  // InstrumentTelemetryLatest. The natural response to that spurious failure
  // would be to delete the assertion, removing the guard on a §11 table. So
  // look for `@@map("<table>")` or a model whose name maps to it.
  it.each(UNMODELLED_TABLES)(
    'table %s has no Prisma model in schema.prisma',
    (table) => {
      const schema = readFileSync(schemaPath, 'utf8');
      expect(schema).not.toMatch(
        new RegExp(String.raw`@@map\(\s*"${table}"\s*\)`),
      );
    },
  );

  // Proves the assertion above is not vacuous: the same matcher DOES find a
  // table that is modelled.
  it('the @@map matcher finds a table that IS modelled', () => {
    const schema = readFileSync(schemaPath, 'utf8');
    expect(schema).toMatch(/@@map\(\s*"instrument_telemetry_latest"\s*\)/);
  });
});

describe('findViolations', () => {
  const DROPS = [
    'DROP TABLE "instrument_telemetry_history";',
    'DROP TABLE instrument_telemetry_history;',
    'DROP TABLE IF EXISTS "instrument_telemetry_history";',
    'DROP TABLE IF EXISTS instrument_telemetry_history CASCADE;',
    'drop table "instrument_telemetry_history";',
    'DROP TABLE "public"."instrument_telemetry_history";',
    'DROP TABLE public.instrument_telemetry_history;',
    'DROP   TABLE\tIF   EXISTS  "instrument_telemetry_history";',
  ];

  it.each(DROPS)('catches %s', (sql) => {
    const found = findViolations('m', sql);
    expect(found).toHaveLength(1);
    expect(found[0].table).toBe('instrument_telemetry_history');
  });

  it('catches a drop of audit_trail', () => {
    expect(findViolations('m', 'DROP TABLE "audit_trail";')).toHaveLength(1);
  });

  it('reports the line number', () => {
    const sql = 'SELECT 1;\nSELECT 2;\nDROP TABLE "audit_trail";';
    expect(findViolations('m', sql)[0].line).toBe(3);
  });

  // Guard against over-matching. A migration that drops a DIFFERENT table
  // whose name merely starts with a protected name must not be flagged, or
  // the guard becomes noise and gets disabled.
  it('does not flag a different table with a shared prefix', () => {
    expect(findViolations('m', 'DROP TABLE "audit_trail_archive";')).toEqual([]);
    expect(
      findViolations('m', 'DROP TABLE "instrument_telemetry_history_2026_08";'),
    ).toEqual([]);
  });

  it('does not flag CREATE or ALTER of a protected table', () => {
    expect(findViolations('m', 'CREATE TABLE "audit_trail" (id text);')).toEqual([]);
    expect(
      findViolations('m', 'ALTER TABLE "instrument_telemetry_history" ADD COLUMN x int;'),
    ).toEqual([]);
    expect(
      findViolations('m', 'ALTER TABLE "audit_trail" DISABLE TRIGGER "t";'),
    ).toEqual([]);
  });

  it('ignores a DROP mentioned in a line comment', () => {
    const sql = '-- we used to DROP TABLE "audit_trail" here\nSELECT 1;';
    expect(findViolations('m', sql)).toEqual([]);
  });

  it('ignores a DROP inside a block comment', () => {
    const sql = '/* DROP TABLE "audit_trail"; */\nSELECT 1;';
    expect(findViolations('m', sql)).toEqual([]);
  });

  it('still catches a real drop on the line after a comment', () => {
    const sql = '-- harmless\nDROP TABLE "audit_trail";';
    const found = findViolations('m', sql);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
  });
});

describe('stripSqlComments', () => {
  it('preserves line count so reported line numbers stay correct', () => {
    const sql = 'a\n/* x\ny\nz */\nb';
    expect(stripSqlComments(sql).split('\n')).toHaveLength(sql.split('\n').length);
  });
});
