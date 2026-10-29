import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp, loginAs } from '../../../e2e/test-helper.js';
import { prisma } from '../../../lib/prisma.js';
import { hashPassword } from '../../../lib/password.js';
import { updateDashboardBody } from '../schemas.js';

/**
 * Mass-assignment guard for `PUT /api/dashboards/:id`.
 *
 * The mechanism is subtle enough that two separate audit findings stated it
 * WRONG (one claimed the AJV instance lacks `removeAdditional`). The truth,
 * established empirically: Fastify enables removeAdditional by DEFAULT, but it
 * only strips unknown keys when the schema declares `additionalProperties:
 * false`. Omit that, and every key the client sends flows into the handler.
 *
 * Two halves:
 *   - the mechanism, on a bare Fastify with THIS repo's ajv options (app.ts)
 *     and the route's REAL body schema, because the question is what the real
 *     validator does with the real schema;
 *   - the route itself (2026-10-29 rewrite): a PUT carrying `createdBy`,
 *     `isDefault`, `createdAt` or `isActive` changes the title it was sent to
 *     change and leaves every one of those columns as it was.
 */
const ajvOptions = { customOptions: { keywords: ['example'] } };

function bareApp() {
  const app = Fastify({ ajv: ajvOptions });
  const guarded = updateDashboardBody;
  const unguarded = { ...updateDashboardBody } as Record<string, unknown>;
  delete unguarded.additionalProperties;
  app.put('/guarded', { schema: { body: guarded } }, async (req) => ({ received: req.body }));
  app.put('/unguarded', { schema: { body: unguarded } }, async (req) => ({ received: req.body }));
  return app;
}

const EXPECTED = '2026-10-29T00:00:00.000Z';
const attack = { title: 'ok', expectedUpdatedAt: EXPECTED, createdBy: 'attacker', createdAt: '1990-01-01T00:00:00.000Z', isDefault: true };

describe('the PUT body schema — mass assignment', () => {
  let bare: ReturnType<typeof bareApp>;
  beforeAll(async () => { bare = bareApp(); await bare.ready(); });
  afterAll(async () => { await bare.close(); });

  it('additionalProperties:false strips every unknown key before it reaches the handler', async () => {
    const res = await bare.inject({ method: 'PUT', url: '/guarded', payload: attack });
    expect(res.statusCode).toBe(200);
    expect(res.json().received).toEqual({ title: 'ok', expectedUpdatedAt: EXPECTED });
  });

  it('proves the vulnerability is real: without it, forged keys reach the handler', async () => {
    // If this ever starts stripping, the guard above passes for the wrong reason.
    const res = await bare.inject({ method: 'PUT', url: '/unguarded', payload: attack });
    expect(res.statusCode).toBe(200);
    expect(res.json().received).toMatchObject({ createdBy: 'attacker', isDefault: true });
  });

  it('expectedUpdatedAt is required', async () => {
    const res = await bare.inject({ method: 'PUT', url: '/guarded', payload: { title: 'x' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/dashboards/:id — the provenance columns are not writable', () => {
  const S = Date.now().toString(36).toUpperCase();
  const USER = `dbm_ma_${S.toLowerCase()}`;
  const PW = 'Dashb0ard@Passw0rd';
  const author = randomUUID();
  let app: FastifyInstance;
  let sa: Record<string, string>;
  let userId = '';
  let dashboardId = '';

  beforeAll(async () => {
    app = await buildApp();
    userId = (await prisma.user.create({
      data: {
        username: USER, fullName: USER, role: 'SUPER_ADMIN', status: 'ENABLED', passwordHash: await hashPassword(PW),
        passwordChangedAt: new Date(), isTemporaryPassword: false, forcePasswordChange: false,
      },
    })).id;
    sa = { authorization: `Bearer ${await loginAs(app, USER, PW)}` };
    dashboardId = (await prisma.dashboard.create({
      data: { title: `MA ${S}`, createdBy: author, isDefault: false, createdAt: new Date('2026-01-01T00:00:00.000Z') },
    })).id;
  });

  afterAll(async () => {
    try { await prisma.dashboard.deleteMany({ where: { id: dashboardId } }); } catch (e) { console.error('cleanup dashboard', e); }
    try {
      await prisma.userConfig.deleteMany({ where: { userId } });
      await prisma.session.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    } catch (e) { console.error('cleanup user', e); }
    await app.close();
  });

  it('changes the title and nothing it was not asked to', async () => {
    const before = await prisma.dashboard.findUniqueOrThrow({ where: { id: dashboardId } });
    const res = await app.inject({
      method: 'PUT', url: `/api/dashboards/${dashboardId}`, headers: sa,
      payload: {
        title: `MA changed ${S}`, expectedUpdatedAt: before.updatedAt.toISOString(),
        createdBy: randomUUID(), isDefault: true, createdAt: '1990-01-01T00:00:00.000Z', isActive: false,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await prisma.dashboard.findUniqueOrThrow({ where: { id: dashboardId } });
    expect(after.title).toBe(`MA changed ${S}`);
    expect(after.createdBy).toBe(author);
    expect(after.isDefault).toBe(false);
    expect(after.isActive).toBe(true);
    expect(after.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(res.json()).not.toHaveProperty('isDefault');
    expect(res.json()).not.toHaveProperty('createdBy');
  });
});
