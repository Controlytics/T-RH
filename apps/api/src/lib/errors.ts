/**
 * Custom error classes for service-layer error handling.
 * Route handlers (or a global error handler) catch these and map to HTTP responses.
 */

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: string = 'CONFLICT', details?: unknown) {
    super(409, code, message, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(403, 'FORBIDDEN', message);
  }
}

/**
 * Map a Prisma client error onto an HTTP response, or null when it is not one
 * we translate (caller falls through to its generic 500 path).
 *
 * Lives here, not inline in `app.ts`, because `src/e2e/test-helper.ts` builds
 * its own Fastify instance with its own error handler. Those two used to
 * diverge: the production handler translated P2002 while the test harness did
 * not, so no e2e could observe the mapping the real server performs, and a
 * regression in it would have been invisible to the suite.
 *
 * P2002 — unique constraint violation. Two concurrent edits colliding on a
 *   unique index is a retryable CONFLICT, not a server fault; returning 500
 *   also fired a spurious SYSTEM_ERROR notification.
 *
 * P2023 — inconsistent column data. Overwhelmingly this is a malformed UUID
 *   arriving as a route param: `/api/user-groups/does-not-exist` reaches
 *   `findUnique({ where: { id } })`, Postgres cannot parse the value as a
 *   uuid, and Prisma throws before the handler's own 404 check can run. That
 *   surfaced as a 500 plus an error notification for what is simply a bad
 *   request. 400 is the honest answer: the id is not an identifier at all, so
 *   the server cannot even say whether such a record exists.
 *
 * P2025 — required record not found. Raised by `findUniqueOrThrow`,
 *   `update` and `delete` when the row is absent. Several routes rely on
 *   Prisma to signal "no such record" rather than checking first — e.g.
 *   `GET /api/notification-rules/:id` — and every one of them was answering
 *   500 for an ordinary missing record.
 *
 * P2003 — foreign key violation (audit 2026-10-03, API-20). Every RESTRICT
 *   foreign key here protects evidence — an alarm webhook's delivery rows, an
 *   alarm's instrument — and the routes that delete the parent count first
 *   and refuse with their own 409. The count and the delete are two
 *   statements, so a row inserted between them reaches the database's own
 *   refusal, which surfaced as a 500 plus a SYSTEM_ERROR notification for a
 *   request the route would have answered 409 a millisecond earlier. The
 *   database's answer is the same fact as the route's, so it gets the same
 *   status.
 */
export function prismaErrorToResponse(
  err: unknown,
): { status: number; body: { error: string; message: string } } | null {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'P2002') {
    return {
      status: 409,
      body: {
        error: 'CONFLICT',
        message: 'This record was modified concurrently. Please reload and try again.',
      },
    };
  }
  if (code === 'P2023') {
    return {
      status: 400,
      body: {
        error: 'INVALID_IDENTIFIER',
        message: 'A supplied identifier is malformed.',
      },
    };
  }
  if (code === 'P2025') {
    return {
      status: 404,
      body: {
        error: 'NOT_FOUND',
        message: 'The requested record does not exist.',
      },
    };
  }
  if (code === 'P2003') {
    return {
      status: 409,
      body: {
        error: 'REFERENCED',
        message: 'This record is referenced by other records and cannot be changed. Please reload and try again.',
      },
    };
  }
  return null;
}

/**
 * Prisma errors that mean "the database cannot serve this request right now",
 * not "this request is wrong" (performance audit 2026-11-17, P-05):
 *   P1001 can't reach the server · P1002 the server timed out ·
 *   P1008 operations timed out · P1017 the server closed the connection ·
 *   P2024 timed out waiting for a pooled connection (the pool of every route
 *   was busy — E2 measured it).
 * They used to be a 500 INTERNAL_ERROR, which told a client nothing it could
 * act on and, in development, carried Prisma's raw text — absolute file paths
 * and a source excerpt — into the browser's error toast (P-09).
 *
 * Deliberately NOT part of `prismaErrorToResponse`: the error handler still logs
 * these and still sends its rate-limited SYSTEM_ERROR notification (an
 * exhausted pool on a database that IS up is something an administrator must
 * hear about); only the final reply changes. P2028 is left out on purpose — it
 * also covers "transaction already closed", which is a bug, not an outage.
 * Connection failures can arrive as a PrismaClientInitializationError, which
 * carries the code as `errorCode`, not `code`, so both are read.
 */
const DATABASE_UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
export const DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export function databaseUnavailable(
  err: unknown,
): { status: 503; retryAfterSeconds: number; body: { error: string; message: string } } | null {
  const e = err as { code?: unknown; errorCode?: unknown; meta?: { code?: unknown; message?: unknown } | null; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : typeof e?.errorCode === 'string' ? e.errorCode : undefined;
  if (code && DATABASE_UNAVAILABLE_CODES.has(code)) return unavailable('The database is not answering right now. Please try again in a moment.');
  if (statementTimedOut(e, code)) return unavailable('The database did not answer in time. Please try again in a moment.');
  return null;
}

/**
 * A statement the database (statement_timeout, SQLSTATE 57014) or the client
 * (socket_timeout) gave up on — the time limits each connection pool carries
 * since performance audit R1, P-04 (`lib/prisma.ts`). Prisma reports them in
 * three shapes, each MEASURED on 2026-11-17 against Postgres 18 / Prisma 6:
 *   - a raw query cut by statement_timeout: P2010, `meta.code` '57014';
 *   - a raw query cut by socket_timeout: P2010, `meta.message` "Timed out during query execution.";
 *   - a MODEL query cut by statement_timeout: a PrismaClientUnknownRequestError with
 *     NO code, '57014' only in its message.
 * (A model query cut by socket_timeout is P1008, mapped above.) Any other P2010 —
 * a syntax error, a constraint in raw SQL — is a bug and stays a 500.
 */
function statementTimedOut(
  e: { meta?: { code?: unknown; message?: unknown } | null; message?: unknown } | null,
  code: string | undefined,
): boolean {
  if (code === 'P2010') {
    return e?.meta?.code === '57014' || /Timed out during query execution/i.test(String(e?.meta?.message ?? ''));
  }
  if (code === undefined && typeof e?.message === 'string') {
    return /code: "57014"|canceling statement due to statement timeout/.test(e.message);
  }
  return false;
}

function unavailable(message: string): { status: 503; retryAfterSeconds: number; body: { error: string; message: string } } {
  return {
    status: 503,
    retryAfterSeconds: DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS,
    body: { error: 'DATABASE_UNAVAILABLE', message },
  };
}
