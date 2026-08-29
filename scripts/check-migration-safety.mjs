#!/usr/bin/env node
/**
 * CI / pre-push entry point for the migration safety guard.
 *
 * The logic lives in apps/api/src/lib/migration-guard.ts and is also asserted
 * by apps/api/src/lib/__tests__/migration-guard.test.ts, so `npm test` already
 * fails on a violation. This script exists for the case where you want the
 * check WITHOUT booting the test suite (which requires a test database):
 *
 *     node scripts/check-migration-safety.mjs
 *     npm run check:migrations
 *
 * Exits 0 when clean, 1 when a migration would drop a protected table.
 *
 * Read the header of migration-guard.ts before "fixing" a failure — the
 * obvious remedy (adding a Prisma model for the partitioned table) trades a
 * loud migration hazard for a silent runtime one.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guardSrc = path.join(repoRoot, 'apps/api/src/lib/migration-guard.ts');

// Read PROTECTED_TABLES straight out of the TypeScript source rather than
// duplicating the list here. Duplicating it would mean the guard and its CLI
// could disagree about what is protected — exactly the "parallel code paths
// that must be kept in sync" defect this repo's own conventions call out.
if (!existsSync(guardSrc)) {
  console.error(`Cannot find ${guardSrc}`);
  process.exit(1);
}
const guardText = readFileSync(guardSrc, 'utf8');
const block = /export const PROTECTED_TABLES = \[([\s\S]*?)\]/.exec(guardText);
if (!block) {
  console.error('Could not parse PROTECTED_TABLES from migration-guard.ts');
  process.exit(1);
}
const PROTECTED_TABLES = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
if (PROTECTED_TABLES.length === 0) {
  console.error('PROTECTED_TABLES parsed as empty — refusing to report success.');
  process.exit(1);
}

const stripSqlComments = (sql) =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, '');

const dir = path.join(repoRoot, 'apps/api/prisma/migrations');
if (!existsSync(dir)) {
  console.error(`No migrations directory at ${dir}`);
  process.exit(1);
}

const violations = [];
let scanned = 0;

for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const sqlPath = path.join(dir, entry.name, 'migration.sql');
  if (!existsSync(sqlPath)) continue;
  scanned++;
  const lines = stripSqlComments(readFileSync(sqlPath, 'utf8')).split('\n');
  for (const table of PROTECTED_TABLES) {
    const re = new RegExp(
      String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\s*\.\s*)?"?${table}"?\b`,
      'i',
    );
    lines.forEach((line, i) => {
      if (re.test(line)) {
        violations.push({ migration: entry.name, table, line: i + 1, statement: line.trim() });
      }
    });
  }
}

if (violations.length === 0) {
  console.log(
    `migration safety: OK — ${scanned} migration(s) scanned, `
    + `${PROTECTED_TABLES.length} protected table(s): ${PROTECTED_TABLES.join(', ')}`,
  );
  process.exit(0);
}

console.error('\nMIGRATION SAFETY CHECK FAILED\n');
console.error(`${violations.length} statement(s) would drop a protected table:\n`);
for (const v of violations) {
  console.error(`  ${v.migration}/migration.sql:${v.line}`);
  console.error(`    table: ${v.table}`);
  console.error(`    sql:   ${v.statement}\n`);
}
console.error('These tables cannot be rebuilt from anything else in the system.');
console.error('Remove the DROP by hand; do NOT add a Prisma model to silence it.');
console.error('See apps/api/src/lib/migration-guard.ts for why.\n');
process.exit(1);
