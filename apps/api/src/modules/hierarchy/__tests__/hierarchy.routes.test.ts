/**
 * hierarchy.routes.test.ts — Wave 2 read-path tests (2026-05-17).
 *
 * Coverage:
 *   1. GET /tree returns 4 blocks with nested areas → ahus → filters
 *   2. 401 when Authorization header is missing
 *   3. ?limit=10000 is clamped to the 500 ceiling (audit §1.8)
 *
 * Why a new pattern in this repo:
 *   - assets/__tests__/instance.routes.test.ts (referenced in the task brief)
 *     does NOT exist — only repository/service unit tests live there.
 *   - sync/__tests__/sync.routes.test.ts uses a recorder-style stub that
 *     only checks registration shape, which doesn't satisfy "GET /tree
 *     returns the 4 blocks".
 *   - So this file bootstraps a real Fastify instance, mocks `prisma.*`
 *     and stubs `app.requirePermission` / global auth via a tiny shim
 *     plugin. That keeps the test focused on the routes file's behavior
 *     (schema + handler glue) without booting the full app pipeline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// 1. Hoist the prisma mock BEFORE the dynamic import of the route module.
//    vi.hoisted is the canonical pattern for prisma-mocked tests in this
//    repo (see assets/repositories/__tests__/instance.repository.test.ts).
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    block:  { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    area:   { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    ahu:    { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    filter: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    // getTree() zips FilterDetails onto nested filters (T2.2).
    filterDetails: { findMany: vi.fn(async () => []) },
    // getTree()/listFilters()/getFilter() derive lastCleanedAt via groupBys over
    // cleaning-stage filter events + completed cycles (zipLastCleaned). Default: none.
    cleaningCycle: { groupBy: vi.fn(async () => []) },
    filterEvent: { groupBy: vi.fn(async () => []) },
  },
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

// 2. Build a fixture Fastify with the two decorators the routes file needs
//    (`requirePermission`, `requireAnyPermission`) plus a stand-in auth
//    gate. We can't pull in the real plugins/auth.ts here without dragging
//    in JWT + sessions + DB; the auth-related assertion we DO need to make
//    is "401 if no Authorization header", which is trivially staged.
async function buildFixtureApp(opts: { withAuth: boolean } = { withAuth: true }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Stub the two RBAC decorators the routes file references. Both pass
  // through unconditionally — permission gating is not what these tests
  // assert. (Auth presence is asserted separately via the onRequest hook
  // below.)
  app.decorate('requirePermission', (_perm: string) => async () => { /* allow */ });
  app.decorate('requireAnyPermission', (..._perms: string[]) => async () => { /* allow */ });

  if (opts.withAuth) {
    app.addHook('onRequest', async (req, reply) => {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Missing token' });
      }
    });
  }

  const { default: hierarchyRoutes } = await import('../routes.js');
  await app.register(hierarchyRoutes, { prefix: '/api/hierarchy' });
  await app.ready();
  return app;
}

const AUTH = { authorization: 'Bearer test-token' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hierarchy routes', () => {
  it('GET /api/hierarchy/tree returns 4 blocks with nested areas → ahus → filters', async () => {
    // Wave 1 backfill seeded 4 blocks / 2 areas / 2 ahus / 6 filters. We
    // synthesize a representative tree shape rather than rely on real DB
    // counts so the test is deterministic.
    const now = new Date().toISOString();
    const baseRow = (id: string, name: string) => ({
      id, name,
      description: null,
      status: 'Active',
      attributes: {},
      customAttributes: {},
      
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: 'seed',
      updatedBy: null,
    });

    const tree = [
      {
        ...baseRow('b1', 'Block-1'),
        areas: [
          {
            ...baseRow('a1', 'Area-1A'),
            blockId: 'b1',
            ahus: [
              {
                ...baseRow('ah1', 'AHU-1'),
                areaId: 'a1',
                filters: [
                  {
                    ...baseRow('f1', 'Filter-1'),
                    ahuId: 'ah1',
                    filterProfileId: null,
                    currentLifecycleState: null,
                    currentCycleId: null,
                    filterSet: null,
                  },
                ],
              },
            ],
          },
        ],
      },
      { ...baseRow('b2', 'Block-2'), areas: [] },
      { ...baseRow('b3', 'Block-3'), areas: [] },
      { ...baseRow('b4', 'Block-4'), areas: [] },
    ];

    mockPrisma.block.findMany.mockResolvedValueOnce(tree);

    const app = await buildFixtureApp();
    try {
      const res = await app.inject({
        method: 'GET', url: '/api/hierarchy/tree', headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(4);
      expect(body[0].name).toBe('Block-1');
      expect(body[0].areas).toHaveLength(1);
      expect(body[0].areas[0].ahus).toHaveLength(1);
      expect(body[0].areas[0].ahus[0].filters).toHaveLength(1);
      expect(body[0].areas[0].ahus[0].filters[0].name).toBe('Filter-1');

      // Assert the Prisma call shape used the nested include we expect.
      // We don't pin every field — that would test Prisma rather than us —
      // but we DO pin that `where.isActive` and the 3-level include happen.
      expect(mockPrisma.block.findMany).toHaveBeenCalledTimes(1);
      const arg = mockPrisma.block.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ isActive: true });
      expect(arg.include?.areas?.include?.ahus?.include?.filters).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('returns 401 when Authorization header is missing', async () => {
    const app = await buildFixtureApp({ withAuth: true });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/hierarchy/tree' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('UNAUTHORIZED');
      // Prisma was never called — the request was rejected at the auth hook.
      expect(mockPrisma.block.findMany).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a limit above the (raised) 1,000,000 ceiling', async () => {
    // 2026-07-03: record lists were uncapped for real deployments; the ceiling
    // moved 500 → 1,000,000. The JSON-schema `maximum` is still the wire gate —
    // AJV rejects anything ABOVE it with a 400 before the handler runs. Assert
    // the gate still fires just past the new ceiling.
    const app = await buildFixtureApp();
    try {
      const res = await app.inject({
        method: 'GET', url: '/api/hierarchy/blocks?limit=1000001', headers: AUTH,
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      // Fastify validation error shape: error/message + (optional) details.
      // Our global error handler isn't installed here, so the message comes
      // from Fastify directly: "querystring/limit must be <= 500".
      expect(String(body.message ?? '')).toMatch(/limit/i);
      expect(mockPrisma.block.findMany).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('handler still clamps when given a valid in-range limit', async () => {
    // Defensive second gate: even at the max (500), normalizeLimit clamps.
    // Send the upper bound and assert Prisma sees `take: 500`.
    mockPrisma.block.findMany.mockResolvedValueOnce([]);
    mockPrisma.block.count.mockResolvedValueOnce(0);

    const app = await buildFixtureApp();
    try {
      const res = await app.inject({
        method: 'GET', url: '/api/hierarchy/blocks?limit=500', headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const arg = mockPrisma.block.findMany.mock.calls[0][0];
      expect(arg.take).toBe(500);
      expect(arg.skip).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('returns ALL rows (no take) when limit is omitted — record lists uncapped', async () => {
    // 2026-07-03: record lists are uncapped. With no `limit` in the query, the
    // handler must NOT set a Prisma `take` (undefined → return every row) and
    // must NOT skip. Pre-change, the schema `default: 50` silently capped this.
    mockPrisma.block.findMany.mockResolvedValueOnce([]);
    mockPrisma.block.count.mockResolvedValueOnce(0);

    const app = await buildFixtureApp();
    try {
      const res = await app.inject({
        method: 'GET', url: '/api/hierarchy/blocks', headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const arg = mockPrisma.block.findMany.mock.calls[0][0];
      expect(arg.take).toBeUndefined();
      expect(arg.skip).toBe(0);
    } finally {
      await app.close();
    }
  });
});
