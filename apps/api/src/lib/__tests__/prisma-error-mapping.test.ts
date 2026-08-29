import { describe, it, expect } from 'vitest';
import { prismaErrorToResponse } from '../errors.js';

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

  // Returning null is what lets the caller fall through to its generic 500 +
  // SYSTEM_ERROR notification. Mapping something we do not understand would
  // suppress that signal.
  it.each(['P1001', 'P2003', 'P2034', 'P9999'])(
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
