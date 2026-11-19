/**
 * Performance audit 2026-11-17, P-04 — three database pools, chosen per request.
 *
 * One pool of 9 served everything: under a slow database the dashboard, alarm and
 * bell polls held every connection and sign-in, health and acknowledgement failed
 * with a pool timeout (E2). `lib/prisma.ts` now keeps a RESERVED `critical` pool
 * and an unlimited `long` pool beside `general`, and `prisma` is the client of the
 * pool the current request runs in.
 */
import { describe, it, expect, afterAll } from 'vitest';
import Fastify from 'fastify';
import { prisma, runOnPool, currentDbPool, registerDbPoolHook, type DbPool } from '../lib/prisma.js';
import { buildApp, routeDbPools } from './test-helper.js';

async function sessionSettings(): Promise<{ statementTimeout: string; applicationName: string }> {
  const [st] = await prisma.$queryRaw<Array<{ statement_timeout: string }>>`SHOW statement_timeout`;
  const [an] = await prisma.$queryRaw<Array<{ application_name: string }>>`SHOW application_name`;
  return { statementTimeout: st!.statement_timeout, applicationName: an!.application_name };
}

describe('P-04: each pool connects with its own limits', () => {
  it.each([
    ['general', '5min'],
    ['critical', '5min'],
    ['long', '0'],
  ] as const)('%s: statement_timeout %s, named in pg_stat_activity', async (pool, timeout) => {
    const s = await runOnPool(pool, sessionSettings);
    expect(s.statementTimeout).toBe(timeout);
    expect(s.applicationName).toBe(`compliance-core:${pool}`);
  });

  it('outside any request or task, `prisma` is the general pool', async () => {
    expect(currentDbPool()).toBe('general');
    expect((await sessionSettings()).applicationName).toBe('compliance-core:general');
  });
});

describe('P-04: a route runs — session check included — on the pool its config names', () => {
  const app = Fastify({ logger: false });
  registerDbPoolHook(app);
  // A stand-in for the auth plugin's onRequest hook: registered AFTER the pool hook,
  // as app.ts and the test helper register the real one.
  app.addHook('onRequest', async (req) => { (req as unknown as { hookPool: DbPool }).hookPool = currentDbPool(); });
  const handler = async (req: unknown) => ({
    hookPool: (req as { hookPool: DbPool }).hookPool,
    handlerPool: currentDbPool(),
    connection: (await sessionSettings()).applicationName,
  });
  app.get('/critical', { config: { dbPool: 'critical' } }, handler);
  app.get('/long', { config: { dbPool: 'long' } }, handler);
  app.get('/plain', handler);
  afterAll(async () => { await app.close(); });

  it.each([
    ['/critical', 'critical'],
    ['/long', 'long'],
    ['/plain', 'general'],
  ] as const)('%s → %s, in the hook, the handler and the database connection', async (url, pool) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hookPool: pool, handlerPool: pool, connection: `compliance-core:${pool}` });
  });
});

describe('P-04: the real routes carry the right pool', () => {
  let pools: Map<string, string>;
  afterAll(async () => { /* the app is closed below */ });

  it('sign-in, session, health and acknowledgement are critical; backup and chain verification are long', async () => {
    const app = await buildApp();
    pools = routeDbPools.get(app)!;
    try {
      for (const route of [
        'POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/auth/refresh',
        'POST /api/auth/beacon-logout', 'GET /api/auth/me', 'POST /api/alarms/:id/acknowledge',
        // The real health route since 2026-11-19 (lib/health-route.ts) — the helper's stand-in
        // carried no pool, so the title's "health" went unasserted until then.
        'GET /api/health',
      ]) expect([route, pools.get(route)]).toEqual([route, 'critical']);
      for (const route of [
        'GET /api/backup/export', 'POST /api/backup/restore', 'POST /api/backup/validate', 'GET /api/audit/verify-chain',
      ]) expect([route, pools.get(route)]).toEqual([route, 'long']);
      // Everything else stays general — the reserved pool is small on purpose.
      const critical = [...pools].filter(([, p]) => p === 'critical').map(([r]) => r).sort();
      // (Fastify adds a HEAD route for every GET, with the GET's config.)
      expect(critical).toEqual([
        'POST /api/alarms/:id/acknowledge', 'GET /api/auth/me', 'HEAD /api/auth/me', 'POST /api/auth/beacon-logout',
        'POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/auth/refresh',
        'GET /api/health', 'HEAD /api/health',
      ].sort());
    } finally {
      await app.close();
    }
  });
});
