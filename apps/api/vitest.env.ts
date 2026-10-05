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
// instrument and attribute edits, alarm acknowledgements, report requests,
// config edits). audit_trail is immutable + hash-chained (21 CFR §11), so every
// e2e write against the dev database (compliance_core_db on this checkout;
// digilog_db under .env.example naming) would permanently pollute the real
// audit trail. Redirecting the whole suite onto the `<db>_test` twin
// (compliance_core_db_test) isolates all test writes from the real trail — and
// the 2026-07-25 incident narrated below is what happens when that fails.
// (Comment rewritten 2026-10-05; it used to cite filter cycles and RFID
// identifiers, which do not exist here. The code is unchanged.)
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(here, '.env'), override: false });

// Force the connection onto a dedicated TEST database, and FAIL CLOSED if that
// cannot be guaranteed.
//
// The previous implementation was:
//     if (url && !url.includes('digilog_test_db')) {
//       process.env.DATABASE_URL = url.replace('digilog_db', 'digilog_test_db');
//     }
// — a literal string replace of `digilog_db`. If DATABASE_URL named ANY other
// database the replace was a no-op, the guard silently did nothing, and the
// whole suite ran against that database. It failed OPEN.
//
// That is not hypothetical: on 2026-07-25 the dev database was renamed to
// `compliance_core_db`, which does not contain `digilog_db`. The suite then ran
// against real data — the audit hard-delete tests physically deleted rows,
// leaving 21 gaps in `chain_position` and `verify-chain: intact=false` on a
// chain that had never been tampered with. audit_trail is immutable and
// hash-chained (21 CFR §11.10(e)); those rows cannot be restored.
//
// So: derive the test database name, then ASSERT the final URL points at it.
// If it does not, throw — refusing to run is always cheaper than corrupting an
// audit trail.
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('[vitest.env] DATABASE_URL is not set — refusing to run tests.');
}

/** Does this URL already name a test database? */
const isTestUrl = (u: string) => /_test(\?|$)|test_db(\?|$)/.test(u);

// Opt-in override for a non-conventional layout, e.g. TEST_DATABASE_URL=...
const explicit = process.env.TEST_DATABASE_URL;
if (explicit) {
  process.env.DATABASE_URL = explicit;
} else if (isTestUrl(url)) {
  // Already a test database (incl. the legacy `digilog_test_db`) — leave it be.
  process.env.DATABASE_URL = url;
} else {
  // Append `_test` to whatever database the URL names, unless it already ends
  // that way. Handles digilog_db → digilog_db_test, compliance_core_db →
  // compliance_core_db_test, and leaves an already-test URL untouched.
  process.env.DATABASE_URL = url.replace(
    /\/([A-Za-z0-9_-]+?)(_test)?(\?|$)/,
    (_m, name: string, isTest: string | undefined, tail: string) =>
      `/${name}${isTest ?? '_test'}${tail}`,
  );
}

// FAIL CLOSED. If we cannot see a test marker in the final URL, stop.
const finalUrl = process.env.DATABASE_URL ?? '';
if (!/_test(\?|$)|test_db(\?|$)|digilog_test_db/.test(finalUrl)) {
  const shown = finalUrl.replace(/:\/\/[^@]*@/, '://***:***@');
  throw new Error(
    `[vitest.env] Refusing to run: DATABASE_URL does not point at a test database.\n`
    + `  resolved: ${shown}\n`
    + `  The suite performs REAL audited writes and physical audit deletions.\n`
    + `  audit_trail is immutable + hash-chained (21 CFR 11.10(e)) — running\n`
    + `  against a live database permanently corrupts it.\n`
    + `  Fix: name the database <something>_test, or set TEST_DATABASE_URL.`,
  );
}

// Ensure JWT secrets exist for tests that import lib/jwt.ts before the prisma
// client (some service tests construct tokens during fixture setup).
process.env.JWT_SECRET ??= 'TEST_JWT_SECRET_AT_LEAST_32_CHARACTERS_LONG_FOR_HS256_SUITE';
// (VERIFICATION_TOKEN_SECRET used to be set here too; nothing reads it since
// POST /api/auth/verify was removed — audit 2026-10-03, SEC-5.)
