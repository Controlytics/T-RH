import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// createFilter now delegates to filterService.create (A-01 T2.1) — the route's
// job is just body-schema validation + reauth + passing the body through +
// formatting a thrown ValidationError as 400. Field-option validation itself is
// unit-tested in filter.service.test.ts / filter-fields.service.test.ts.
const createMock = vi.fn();
vi.mock('../../assets/services/filter.service.js', () => ({
  filterService: { create: (...args: any[]) => createMock(...args) },
}));

vi.mock('../../../lib/reauth-check.js', () => ({
  enforceReauth: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../../lib/build-context.js', () => ({
  buildContext: vi.fn(() => ({ userId: 'test-user', userRole: 'SUPER_ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'test-session', isOfflineReplay: false })),
}));

const AUTH = { authorization: 'Bearer test-token' };
const AHU = '11111111-1111-1111-1111-111111111111';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('requirePermission', (_p: string) => async () => {});
  app.decorate('requireAnyPermission', (..._p: string[]) => async () => {});
  const { AppError } = await import('../../../lib/errors.js');
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: 'VALIDATION_ERROR', message: err.message });
    }
    return reply.code(500).send({ error: 'INTERNAL', message: err.message });
  });
  const { default: hierarchyRoutes } = await import('../routes.js');
  await app.register(hierarchyRoutes, { prefix: '/api/hierarchy' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue({ id: 'filter-1', name: 'F1' });
});

describe('POST /api/hierarchy/filters', () => {
  it('delegates the request body to filterService.create and returns 201', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/api/hierarchy/filters', headers: AUTH,
      payload: { name: 'F1', ahuId: AHU, filterSet: 'A', ahuType: 'process', filterType: 'HEPA', micronSize: '5', filterSize: '610×610×292mm' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ success: true, data: { id: 'filter-1', name: 'F1' } });
    expect(createMock).toHaveBeenCalledTimes(1);
    const [data] = createMock.mock.calls[0];
    // filterSize must survive the body schema (additionalProperties:false would strip an undeclared key).
    expect(data).toMatchObject({ name: 'F1', ahuId: AHU, filterSet: 'A', ahuType: 'process', filterType: 'HEPA', micronSize: '5', filterSize: '610×610×292mm' });
    await app.close();
  });

  it('surfaces a ValidationError from filterService as 400 with details', async () => {
    const { ValidationError } = await import('../../../lib/errors.js');
    createMock.mockRejectedValueOnce(new ValidationError('One or more filter fields are invalid', [{ field: 'filterType', value: 'CARBON', message: 'must be one of: HEPA, PRE' }]));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/api/hierarchy/filters', headers: AUTH,
      payload: { name: 'Bad', ahuId: AHU, filterType: 'CARBON' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('must be one of');
    await app.close();
  });

  it('rejects a missing ahuId via body schema (400, before the service)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/hierarchy/filters', headers: AUTH, payload: { name: 'F3' } });
    expect(res.statusCode).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('passes filterProfileId + lastCleaningDate through to filterService', async () => {
    const app = await buildApp();
    const PROFILE = '22222222-2222-2222-2222-222222222222';
    const res = await app.inject({
      method: 'POST', url: '/api/hierarchy/filters', headers: AUTH,
      payload: { name: 'F4', ahuId: AHU, filterProfileId: PROFILE, lastCleaningDate: '2026-01-15' },
    });
    expect(res.statusCode).toBe(201);
    const [data] = createMock.mock.calls[0];
    expect(data.filterProfileId).toBe(PROFILE);
    expect(data.lastCleaningDate).toBe('2026-01-15');
    await app.close();
  });
});
