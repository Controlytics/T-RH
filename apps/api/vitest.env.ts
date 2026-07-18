import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Shared test-env bootstrap, imported for its side effects by BOTH
// vitest.setup.ts (runs per worker) and vitest.global-setup.ts (runs once in
// the main process). It MUST execute before any `../lib/prisma` import
// instantiates the PrismaClient, since Prisma reads DATABASE_URL at
// construction time.
//
// Why this exists: the API test suite performs real, audited actions (logins,
// filter cycles, RFID identifier assign/delete, config edits). audit_trail is
// immutable + hash-chained (21 CFR §11), so every e2e write against the dev
// database (digilog_db) permanently pollutes the real audit trail — e.g. the
// phase3 RFID e2e leaves orphaned ASSET_IDENTIFIER_* rows on filters it then
// deletes. Redirecting the whole suite onto digilog_test_db isolates all test
// writes from the real trail.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(here, '.env'), override: false });

// Force the connection onto the dedicated test database. Idempotent: skipped
// if DATABASE_URL already points at digilog_test_db (e.g. a worker inheriting
// the already-swapped env from the main process). 'digilog_test_db' does not
// contain 'digilog_db' as a substring, so the guard + single replace are safe.
const url = process.env.DATABASE_URL;
if (url && !url.includes('digilog_test_db')) {
  process.env.DATABASE_URL = url.replace('digilog_db', 'digilog_test_db');
}

// Ensure JWT secrets exist for tests that import lib/jwt.ts before the prisma
// client (some service tests construct tokens during fixture setup).
process.env.JWT_SECRET ??= 'TEST_JWT_SECRET_AT_LEAST_32_CHARACTERS_LONG_FOR_HS256_SUITE';
process.env.VERIFICATION_TOKEN_SECRET ??=
  'TEST_VERIFICATION_SECRET_AT_LEAST_32_CHARACTERS_LONG_FOR_HS256_SUITE';
