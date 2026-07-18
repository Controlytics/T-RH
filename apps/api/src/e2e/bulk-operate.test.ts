import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { loginAs } from './test-helper.js';
import authPlugin from '../plugins/auth.js';
import rbacPlugin from '../plugins/rbac.js';
import authRoutes from '../modules/auth/routes.js';
import { AppError } from '../lib/errors.js';

/**
 * POST /api/filters/bulk-operate — route-level e2e (Task 1 of the batch
 * cleaning-ops feature). Mirrors the harness pattern in
 * `phase2-filter-operations.test.ts`: REAL prisma + REAL auth via a manually
 * assembled Fastify instance (NOT the shared `buildApp()` helper — that
 * calls `app.ready()` internally, which blocks the post-hoc route
 * registration this file needs), with a MOCKED `FilterOperationsService` so
 * the test controls each single-op method's return and can assert dispatch.
 *
 * Nothing calls this endpoint yet (additive-only route).
 */

// Mock the service so the test controls each method's return + can assert dispatch.
// `bulkOperate` itself delegates to the REAL orchestration function (imported
// below) instead of a hand-copied duplicate of its loop — otherwise the real
// `bulkOperate()` in cycle-write/bulk-operate.ts is exercised by nothing and
// a bug in the actual dispatch/try-catch logic would never surface here.
const advance = vi.fn();
const startCycle = vi.fn();
const submitChecklist = vi.fn();
vi.mock('../modules/filter-operations/filter-operations.service.js', async () => {
  const { bulkOperate: realBulkOperate } = await import('../modules/filter-operations/cycle-write/bulk-operate.js');
  return {
    FilterOperationsService: vi.fn().mockImplementation(() => ({
      advance, startCycle, submitChecklist,
      bulkOperate: async (ctx: any, items: any[]) =>
        realBulkOperate({ advance, startCycle, submitChecklist } as any, ctx, items),
    })),
  };
});

// Routes are imported AFTER the mock. They construct `new FilterOperationsService()`
// inside `routes.ts`, which now resolves to the mocked class (vi.mock is hoisted).
import filterOperationsRoutes from '../modules/filter-operations/routes.js';

const uuid = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

describe('POST /api/filters/bulk-operate', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    // Build a minimal app inline — base `buildApp()` from test-helper doesn't
    // include filter-operations routes and calls `app.ready()` internally,
    // which prevents post-hoc `register()` calls (Fastify error: "Root plugin
    // has already booted"). Reproduce just the plugins + auth routes the
    // login flow needs, then mount the route under test.
    app = Fastify({
      logger: false,
      ajv: { customOptions: { keywords: ['example'] } },
    });

    await app.register(cors, { origin: true, credentials: true });
    await app.register(authPlugin);
    await app.register(rbacPlugin);

    // Match the global error handler in test-helper.ts so service errors map
    // to consistent HTTP shapes.
    app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({
          error: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        });
      }
      const status = err.statusCode ?? 500;
      return reply.code(status).send({ error: err.message || 'Internal Server Error' });
    });

    // Auth routes are needed so `loginAs()` can issue a real JWT.
    await app.register(authRoutes, { prefix: '/api/auth' });
    // Route under test.
    await app.register(filterOperationsRoutes, { prefix: '/api/filters' });
    await app.ready();

    token = await loginAs(app);

    advance.mockResolvedValue({ filterId: 'x', currentState: 'WASH_OUT', tapeVersion: 2, actions: [] });
    startCycle.mockResolvedValue({ id: 'cyc' });
    submitChecklist.mockResolvedValue({ filterId: 'x', currentState: 'DRY_IN', tapeVersion: 3, actions: [] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('dispatches a mixed batch and returns per-item ok results', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/filters/bulk-operate',
      headers: { authorization: `Bearer ${token}` },
      payload: { items: [
        { clientOpId: 'a', filterId: uuid(1), kind: 'advance', payload: { targetState: 'WASH_OUT', tapeVersion: 1 } },
        { clientOpId: 'b', filterId: uuid(2), kind: 'start-and-advance', cyclePayload: { cleaningReasonKey: 'ROUTINE' }, advancePayload: { targetState: 'WASH_IN', tapeVersion: 1 } },
        { clientOpId: 'c', filterId: uuid(3), kind: 'submit-checklist', payload: { answers: {}, tapeVersion: 1 } },
      ] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(3);
    expect(body.results.every((r: any) => r.status === 'ok')).toBe(true);
    expect(startCycle).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledTimes(2); // advance item + start-and-advance's advance
    expect(submitChecklist).toHaveBeenCalledTimes(1);
  });

  it('returns partial success — one failed item does not fail the batch', async () => {
    advance.mockReset();
    advance.mockImplementationOnce(async () => { const e: any = new Error('stale'); e.code = 'STALE_TAPE'; throw e; });
    advance.mockResolvedValue({ filterId: 'x', currentState: 'WASH_OUT', tapeVersion: 2, actions: [] });
    const res = await app.inject({
      method: 'POST', url: '/api/filters/bulk-operate',
      headers: { authorization: `Bearer ${token}` },
      payload: { items: [
        { clientOpId: 'a', filterId: uuid(1), kind: 'advance', payload: { targetState: 'WASH_OUT', tapeVersion: 1 } },
        { clientOpId: 'b', filterId: uuid(2), kind: 'advance', payload: { targetState: 'WASH_OUT', tapeVersion: 1 } },
      ] },
    });
    const body = res.json();
    expect(body.results[0]).toMatchObject({ status: 'failed', error: { code: 'STALE_TAPE' } });
    expect(body.results[1]).toMatchObject({ status: 'ok' });
  });

  it('rejects >200 items with 400', async () => {
    const items = Array.from({ length: 201 }, (_, i) => ({ clientOpId: `k${i}`, filterId: uuid(1), kind: 'advance', payload: { targetState: 'X', tapeVersion: 1 } }));
    const res = await app.inject({ method: 'POST', url: '/api/filters/bulk-operate', headers: { authorization: `Bearer ${token}` }, payload: { items } });
    expect(res.statusCode).toBe(400);
  });

  it('requires auth (401 without token)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/filters/bulk-operate', payload: { items: [] } });
    expect(res.statusCode).toBe(401);
  });
});
