import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Migration safety guard — refuses migrations that would destroy a table the
 * application cannot rebuild.
 *
 * WHY THIS EXISTS
 * ---------------
 * `instrument_telemetry_history` is created and partitioned by hand-written
 * SQL (`migrations/20260804120000_instruments_p1/migration.sql`) because
 * Prisma cannot express `PARTITION BY RANGE`. It therefore does NOT appear in
 * `schema.prisma`.
 *
 * Prisma treats any table absent from the schema as drift to be removed. Run
 * `prisma migrate dev` or `prisma db push` and the generated migration will
 * contain `DROP TABLE "instrument_telemetry_history"` — taking every stored
 * reading with it. That is the entire §11 telemetry record, and it is not
 * recoverable from anything else in the system.
 *
 * The obvious "fix" — adding a Prisma model — is a trap and is deliberately
 * NOT what this guard encourages. A model would stop the DROP, but Prisma
 * would then emit a plain `CREATE TABLE` for a fresh environment, silently
 * producing an UNPARTITIONED table. Ingest would then work for exactly as
 * long as it took to reach a month boundary, at which point every insert
 * whose `ts` falls outside a partition range is rejected by Postgres and
 * device ingestion stops dead. Swapping a loud, one-off migration hazard for
 * a quiet, recurring runtime one is a bad trade.
 *
 * So the table stays out of the schema, and this guard makes the omission
 * safe by failing the build if a migration ever tries to drop it.
 *
 * WHAT THIS GUARD DOES NOT DO
 * ---------------------------
 * `prisma migrate dev` CREATES AND APPLIES in one step. By the time this
 * guard runs, a developer's LOCAL database may already be gone. This guard
 * stops the damage reaching the repository, CI, and production — it is not a
 * substitute for the workflow rule, which is: generate migrations with
 * `prisma migrate diff` against a shadow database, review the SQL, and strip
 * any DROP of a protected table by hand before applying.
 */

/**
 * Tables that no migration may drop.
 *
 * `instrument_telemetry_history` is the one this guard was written for. The
 * other two are here because they are equally unrecoverable and equally
 * catastrophic, and a guard that protects one irreplaceable table but not its
 * neighbours invites the question "why not?" at exactly the wrong moment.
 */
export const PROTECTED_TABLES = [
  'instrument_telemetry_history',
  'instrument_telemetry_latest',
  'audit_trail',
  // 2026-10-12: where audit_trail.chain_position comes from. Dropping it stops
  // every audit write, and recreating it from MAX(chain_position) would hide a
  // deletion of the newest rows. No Prisma model, so `migrate diff` will
  // propose dropping it — strip that, as for the telemetry table.
  'audit_chain_counter',
] as const;

/**
 * Tables that live in the database but deliberately have no Prisma model.
 * Asserted by the test suite so that "someone added a model" is a decision
 * that gets noticed and re-argued, not a silent change — see the trap
 * described above.
 */
export const UNMODELLED_TABLES = ['instrument_telemetry_history', 'audit_chain_counter'] as const;

export interface MigrationViolation {
  migration: string;
  table: string;
  line: number;
  statement: string;
}

/**
 * Strip SQL comments so a `DROP TABLE` mentioned in prose does not trip the
 * guard. Block comments are replaced with newlines rather than removed
 * outright, to keep line numbers honest in the violation report.
 */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, '');
}

/**
 * Find every `DROP TABLE` in one migration's SQL that names a protected
 * table. Matches the table with or without double quotes, with or without a
 * `public.` qualifier, and with or without `IF EXISTS` — a guard that only
 * recognised the exact spelling Prisma happens to emit today would be worth
 * very little.
 */
export function findViolations(
  migrationName: string,
  sql: string,
  protectedTables: readonly string[] = PROTECTED_TABLES,
): MigrationViolation[] {
  const violations: MigrationViolation[] = [];
  const lines = stripSqlComments(sql).split('\n');

  for (const table of protectedTables) {
    // DROP TABLE [IF EXISTS] [public.]["]<table>["]
    const re = new RegExp(
      String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\s*\.\s*)?"?${table}"?\b`,
      'i',
    );
    lines.forEach((line, i) => {
      if (re.test(line)) {
        violations.push({
          migration: migrationName,
          table,
          line: i + 1,
          statement: line.trim(),
        });
      }
    });
  }

  return violations;
}

/** Absolute path to the Prisma migrations directory. */
export function migrationsDir(apiRoot: string): string {
  return path.join(apiRoot, 'prisma', 'migrations');
}

/**
 * Scan every committed migration. Returns all violations found; an empty
 * array means the tree is safe.
 */
export function scanMigrations(
  apiRoot: string,
  protectedTables: readonly string[] = PROTECTED_TABLES,
): MigrationViolation[] {
  const dir = migrationsDir(apiRoot);
  if (!existsSync(dir)) return [];

  const violations: MigrationViolation[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sqlPath = path.join(dir, entry.name, 'migration.sql');
    if (!existsSync(sqlPath)) continue;
    violations.push(
      ...findViolations(entry.name, readFileSync(sqlPath, 'utf8'), protectedTables),
    );
  }
  return violations;
}

/** Human-readable report for the CLI and for test failure output. */
export function formatViolations(violations: MigrationViolation[]): string {
  const lines = [
    '',
    'MIGRATION SAFETY CHECK FAILED',
    '',
    `${violations.length} migration statement(s) would drop a protected table:`,
    '',
  ];
  for (const v of violations) {
    lines.push(`  ${v.migration}/migration.sql:${v.line}`);
    lines.push(`    table: ${v.table}`);
    lines.push(`    sql:   ${v.statement}`);
    lines.push('');
  }
  lines.push(
    'These tables cannot be rebuilt from anything else in the system.',
    '',
    'If Prisma generated this, it is because the table has no model in',
    'schema.prisma (it cannot express PARTITION BY). Do NOT add a model to',
    'silence it — see the comment at the top of src/lib/migration-guard.ts.',
    'Remove the DROP statement from the migration by hand.',
    '',
  );
  return lines.join('\n');
}
