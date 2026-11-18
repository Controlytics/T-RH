import { describe, it, expect } from 'vitest';
import { databaseUnavailable, prismaErrorToResponse } from '../errors.js';

/**
 * Pins the Prisma-error → HTTP mapping.
 *
 * These translations used to be an inline branch in `app.ts` that no test
 * touched: the suite's 409 assertions all come from explicit `ConflictError`
 * throws (HAS_ALARMS, duplicate room code), not from a P2002 reaching the
 * error handler. So the mapping could have been deleted in a refactor and
 * every test would still have passed.
 *
 * The mapping is shared with `src/e2e/test-helper.ts`, which builds its own
 * Fastify instance — see the comment on `prismaErrorToResponse`.
 */
describe('prismaErrorToResponse', () => {
  it('maps P2002 (unique collision) to a retryable 409', () => {
    const res = prismaErrorToResponse({ code: 'P2002' });
    expect(res?.status).toBe(409);
    expect(res?.body.error).toBe('CONFLICT');
  });

  it('maps P2023 (malformed identifier) to 400', () => {
    const res = prismaErrorToResponse({ code: 'P2023' });
    expect(res?.status).toBe(400);
    expect(res?.body.error).toBe('INVALID_IDENTIFIER');
  });

  it('maps P2025 (required record not found) to 404', () => {
    const res = prismaErrorToResponse({ code: 'P2025' });
    expect(res?.status).toBe(404);
    expect(res?.body.error).toBe('NOT_FOUND');
  });

  // Audit 2026-10-03, API-20: a RESTRICT foreign key refusing a delete that a
  // route's own count had passed a moment earlier (a delivery row inserted
  // between the two) is the same 409 the route would have given, not a 500.
  it('maps P2003 (foreign key violation) to 409', () => {
    const res = prismaErrorToResponse({ code: 'P2003' });
    expect(res?.status).toBe(409);
    expect(res?.body.error).toBe('REFERENCED');
  });

  // Returning null is what lets the caller fall through to its generic 500 +
  // SYSTEM_ERROR notification. Mapping something we do not understand would
  // suppress that signal.
  it.each(['P1001', 'P2034', 'P9999'])(
    'returns null for unmapped code %s',
    (code) => {
      expect(prismaErrorToResponse({ code })).toBeNull();
    },
  );

  it.each([
    ['a plain Error', new Error('boom')],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'P2002'],
    ['an object with no code', {}],
  ])('returns null for %s', (_label, err) => {
    expect(prismaErrorToResponse(err)).toBeNull();
  });

  // The messages reach end users, so they must not leak column or constraint
  // names from the underlying Prisma error.
  it('does not echo the underlying Prisma message', () => {
    const res = prismaErrorToResponse({
      code: 'P2002',
      message: 'Unique constraint failed on the fields: (`secret_internal_column`)',
      meta: { target: ['secret_internal_column'] },
    });
    expect(JSON.stringify(res)).not.toContain('secret_internal_column');
  });
});

/**
 * Performance audit 2026-11-17, P-05: a database that cannot serve the request
 * is a 503 with Retry-After, not a 500. Kept OUT of prismaErrorToResponse (the
 * handler still logs and notifies), so P1001 above stays "unmapped" there.
 */
describe('databaseUnavailable', () => {
  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024'])('maps %s (as `code`) to 503 DATABASE_UNAVAILABLE', (code) => {
    const res = databaseUnavailable({ code });
    expect(res?.status).toBe(503);
    expect(res?.body.error).toBe('DATABASE_UNAVAILABLE');
    expect(res?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reads `errorCode` — how a PrismaClientInitializationError carries it', () => {
    expect(databaseUnavailable({ errorCode: 'P1001', message: "Can't reach database server" })?.status).toBe(503);
  });

  it.each(['P2028', 'P2002', 'P2025', 'P9999'])('leaves %s alone', (code) => {
    expect(databaseUnavailable({ code })).toBeNull();
  });

  it.each([null, undefined, new Error('boom'), {}, 'P1001'])('returns null for %s', (err) => {
    expect(databaseUnavailable(err)).toBeNull();
  });

  // The shapes a pool time limit produces (performance audit R1, P-04), each one
  // MEASURED against Postgres 18 / Prisma 6 on 2026-11-17.
  it.each([
    ['a raw query cut by statement_timeout', { code: 'P2010', meta: { code: '57014', message: 'ERROR: canceling statement due to statement timeout' } }],
    ['a raw query cut by socket_timeout', { code: 'P2010', meta: { code: 'N/A', message: 'Timed out during query execution.' } }],
    ['a MODEL query cut by statement_timeout (no code at all)', { message: 'Error { kind: Db, cause: Some(DbError { severity: "ERROR", parsed_severity: Some(Error), code: SqlState(E57014), message: "canceling statement due to statement timeout" }) }, transient: false }), code: "57014"' }],
    ['a MODEL query cut by socket_timeout', { code: 'P1008', meta: { modelName: 'User' } }],
  ])('%s is a 503', (_label, err) => {
    const res = databaseUnavailable(err);
    expect(res?.status).toBe(503);
    expect(res?.body.error).toBe('DATABASE_UNAVAILABLE');
  });

  it('any other raw-query failure stays a 500 (a bug, not an outage)', () => {
    expect(databaseUnavailable({ code: 'P2010', meta: { code: '42601', message: 'syntax error at or near "SELEC"' } })).toBeNull();
    expect(databaseUnavailable({ message: 'Something else went wrong' })).toBeNull();
  });

  it('never echoes the Prisma message (it carries file paths and source in development)', () => {
    const res = databaseUnavailable({
      errorCode: 'P1001',
      message: "Invalid `prisma.session.findFirst()` invocation in C:\\repo\\apps\\api\\src\\plugins\\auth.ts:112:40 Can't reach database server",
    });
    expect(JSON.stringify(res)).not.toMatch(/auth\.ts|invocation|C:\\/);
  });
});

