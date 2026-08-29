import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPut } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

/**
 * Debug traces — previously ZERO test coverage (audit finding H4).
 *
 * The module reads `audit_trail` and presents it as an operation trace. Most
 * of it is vestigial: the per-entity tracer and the pipeline tracer went with
 * the ingestion/TSDB tear-out, and two routes survive as documented no-ops.
 * Vestigial code is exactly the kind that gets refactored carelessly, which is
 * why the invariants below are worth holding.
 *
 * SHARED STATE: `PUT /operation-trace` writes `system_config['debug']`, which
 * the whole suite shares. This file snapshots that row and restores it in
 * `afterAll` — the same discipline `TOUCHED_CONFIG_KEYS` enforces in the LDAP
 * e2e, added there after a suite left `password-policy` stripped of its
 * complexity flags and silently broke three unrelated tests.
 */
describe('debug-traces e2e', () => {
  let app: FastifyInstance;
  let token: string;
  let originalDebugConfig: unknown;
  let hadDebugConfig = false;

  beforeAll(async () => {
    app = await buildApp();
    token = await loginAs(app);
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'debug' } });
    hadDebugConfig = row !== null;
    originalDebugConfig = row?.configValue ?? null;
  });

  afterAll(async () => {
    if (hadDebugConfig) {
      await prisma.systemConfig.update({
        where: { configKey: 'debug' },
        data: { configValue: originalDebugConfig as any },
      });
    } else {
      await prisma.systemConfig.deleteMany({ where: { configKey: 'debug' } });
    }
    await app.close();
  });

  describe('listing', () => {
    it('lists traces', async () => {
      const res = await authGet(app, '/api/debug/traces', token);
      expect(res.statusCode).toBe(200);
    });

    it('reports stats', async () => {
      const res = await authGet(app, '/api/debug/traces/stats', token);
      expect(res.statusCode).toBe(200);
    });
  });

  // ROUTE ORDERING INVARIANT. `GET /:id` is registered LAST, deliberately, so
  // it does not shadow the static sub-routes. Move it above them — an easy
  // thing to do while tidying — and `/stats` and `/operation-trace` start
  // being handled as trace IDs, returning 404 for a working feature. The
  // source comment says "Registered last so it doesn't shadow the static
  // sub-routes above"; this is that comment made executable.
  describe('static sub-routes are not shadowed by /:id', () => {
    it.each(['/api/debug/traces/stats', '/api/debug/traces/operation-trace'])(
      '%s resolves to its own handler',
      async (url) => {
        const res = await authGet(app, url, token);
        expect(res.statusCode).toBe(200);
        // A shadowed route would have been treated as a trace id and 404'd.
        expect(res.statusCode).not.toBe(404);
      },
    );

    it('stats returns an object, not a trace detail', async () => {
      const res = await authGet(app, '/api/debug/traces/stats', token);
      const body = JSON.parse(res.body);
      expect(body).toBeTypeOf('object');
      expect(body).not.toHaveProperty('checksum');
    });
  });

  describe('operation-trace flag', () => {
    it('round-trips false', async () => {
      const put = await authPut(app, '/api/debug/traces/operation-trace', token, {
        enabled: false,
      });
      expect(put.statusCode).toBe(200);
      expect(JSON.parse(put.body).enabled).toBe(false);

      const get = await authGet(app, '/api/debug/traces/operation-trace', token);
      expect(JSON.parse(get.body).enabled).toBe(false);
    });

    it('round-trips true', async () => {
      await authPut(app, '/api/debug/traces/operation-trace', token, { enabled: true });
      const get = await authGet(app, '/api/debug/traces/operation-trace', token);
      expect(JSON.parse(get.body).enabled).toBe(true);
    });

    // The handler does `!!body.enabled`, so a missing key means false rather
    // than "leave it alone". Pinning current behaviour so a change is a choice.
    it('treats an omitted enabled key as false', async () => {
      await authPut(app, '/api/debug/traces/operation-trace', token, { enabled: true });
      const put = await authPut(app, '/api/debug/traces/operation-trace', token, {});
      expect(JSON.parse(put.body).enabled).toBe(false);
    });
  });

  describe('vestigial per-entity toggle', () => {
    // Retired with the ingestion/TSDB removal. It must keep answering 200 —
    // the UI still calls it — and it must remain a no-op.
    it('answers 200 and says it is retired', async () => {
      const res = await authPut(app, '/api/debug/traces/entity/anything/toggle', token, {});
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.note).toMatch(/retired/i);
    });
  });

  describe('trace detail', () => {
    it('returns a real audited operation', async () => {
      const row = await prisma.auditTrail.findFirst({ orderBy: { timestamp: 'desc' } });
      if (!row) return; // empty audit trail — nothing to assert against
      const res = await authGet(app, `/api/debug/traces/${row.id}`, token);
      expect(res.statusCode).toBe(200);
    });

    it('404s on a well-formed id that names nothing', async () => {
      const res = await authGet(
        app, '/api/debug/traces/00000000-0000-4000-8000-000000000000', token,
      );
      expect(res.statusCode).toBe(404);
    });

    it('does not 500 on a malformed id', async () => {
      const res = await authGet(app, '/api/debug/traces/not-a-uuid', token);
      expect(res.statusCode).not.toBe(500);
      expect([400, 404]).toContain(res.statusCode);
    });
  });

  describe('authentication', () => {
    it.each([
      '/api/debug/traces',
      '/api/debug/traces/stats',
      '/api/debug/traces/operation-trace',
    ])('rejects unauthenticated GET %s', async (url) => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an unauthenticated flag write', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/debug/traces/operation-trace',
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
