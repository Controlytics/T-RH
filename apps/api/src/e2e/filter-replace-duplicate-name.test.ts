/**
 * Filter replace — duplicate-name guard (2026-07-08).
 *
 * `FilterOperationsService.replace()` names the replacement by incrementing the
 * old filter's trailing numeric suffix ("…/00-00" -> "…/00-01"). When a filter
 * already OWNS that incremented name, the old code created a second filter with
 * the same name (no uniqueness check, no DB constraint on asset_instances.name).
 *
 * Per user decision: on that collision, do NOT replace — abort with 409 BEFORE
 * the old filter is retired, so nothing is mutated. This file proves:
 *   - replacing "<prefix>-00" when "<prefix>-01" already exists → 409
 *     DUPLICATE_FILTER_NAME, the old filter stays active, no new row is created.
 *
 * Isolation: provisions its own SUPER_ADMIN and creates two throwaway FILTER
 * instances (reusing the seeded FILTER template + an AHU parent), all removed in
 * afterAll. The guard runs before retire(), so no cycles / audit rows are
 * written for the collision path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import authPlugin from '../plugins/auth.js';
import rbacPlugin from '../plugins/rbac.js';
import authRoutes from '../modules/auth/routes.js';
import assetRoutes from '../modules/assets/index.js';
import filterOperationsRoutes from '../modules/filter-operations/routes.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { AppError } from '../lib/errors.js';

const TEST_USERNAME = 'dupname_filter_admin';
const TEST_PASSWORD = 'DupName@Test1';
const PREFIX = `ZZDUP-${Date.now()}`; // unique so parallel/rerun never collides

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ajv: { customOptions: { keywords: ['example'] } } });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(authPlugin);
  await app.register(rbacPlugin);
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
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(assetRoutes, { prefix: '/api/assets' });
  await app.register(filterOperationsRoutes, { prefix: '/api/filters' });
  await app.ready();
  return app;
}

describe('Filter replace — duplicate-name guard', () => {
  let app: FastifyInstance;
  let token: string;
  let testUserId: string;
  let filterA: string; // "<PREFIX>-00" — the one we try to replace (collides with B)
  let filterB: string; // "<PREFIX>-01" — the pre-existing collision target
  let filterC: string; // "<PREFIX>-90" — replaced successfully (no "<PREFIX>-91" exists)

  beforeAll(async () => {
    app = await buildTestApp();

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const user = await prisma.user.upsert({
      where: { username: TEST_USERNAME },
      update: {
        passwordHash, role: 'SUPER_ADMIN', status: 'ENABLED',
        forcePasswordChange: false, isTemporaryPassword: false,
        failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null,
      },
      create: {
        username: TEST_USERNAME, passwordHash, fullName: 'Dup Name Test Admin',
        email: 'dupname-filter-test@example.test', role: 'SUPER_ADMIN', status: 'ENABLED',
        forcePasswordChange: false, isTemporaryPassword: false,
      },
    });
    testUserId = user.id;

    const tpl = await prisma.assetTemplate.findFirst({ where: { templateKind: 'FILTER' } });
    if (!tpl) throw new Error('Test DB has no FILTER template to build on');
    const ahu = await prisma.assetInstance.findFirst({ where: { template: { templateKind: 'AHU' } } });

    const mk = async (name: string) => {
      const inst = await prisma.assetInstance.create({
        data: {
          name, templateId: tpl.id, templateVersion: tpl.version ?? 1,
          parentId: ahu?.id ?? null, attributes: {}, status: 'Active', isActive: true,
        },
      });
      return inst.id;
    };
    filterA = await mk(`${PREFIX}-00`);
    filterB = await mk(`${PREFIX}-01`);
    filterC = await mk(`${PREFIX}-90`); // increments to -91, which is free

    const loginRes = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD, force: true },
    });
    const body = JSON.parse(loginRes.body);
    if (!body.token) throw new Error(`Login failed: ${loginRes.body}`);
    token = body.token;
  });

  afterAll(async () => {
    // Delete every instance this file created (A/B + C + the "<PREFIX>-91"
    // replacement C spawns) by name prefix, plus their relationships/details.
    const mine = await prisma.assetInstance.findMany({
      where: { name: { startsWith: PREFIX } }, select: { id: true },
    });
    const ids = mine.map((m) => m.id);
    await prisma.assetRelationship.deleteMany({
      where: { OR: [{ sourceAssetId: { in: ids } }, { targetAssetId: { in: ids } }] },
    });
    await prisma.filterDetails.deleteMany({ where: { assetInstanceId: { in: ids } } });
    await prisma.assetInstance.deleteMany({ where: { id: { in: ids } } });
    await prisma.session.updateMany({ where: { userId: testUserId }, data: { isActive: false, terminationReason: 'dupname_test_cleanup' } });
    try {
      await prisma.user.delete({ where: { id: testUserId } });
    } catch {
      await prisma.user.update({ where: { id: testUserId }, data: { status: 'DISABLED', email: `disabled-${testUserId}@example.test` } });
    }
    await app.close();
  });

  it('refuses to replace when the incremented name already exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/filters/${filterA}/replace`,
      headers: { authorization: `Bearer ${token}`, 'x-reauth-password': TEST_PASSWORD },
      payload: { remarks: 'attempt replace into an existing name' },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('DUPLICATE_FILTER_NAME');
    expect(body.message).toContain(`${PREFIX}-01`);

    // Nothing mutated: old filter still active, still exactly ONE "<PREFIX>-01".
    const a = await prisma.assetInstance.findUnique({ where: { id: filterA } });
    expect(a?.isActive).toBe(true);
    expect(a?.status).toBe('Active');
    const dupes = await prisma.assetInstance.count({ where: { name: `${PREFIX}-01`, isActive: true } });
    expect(dupes).toBe(1);
  });

  it('replaces successfully when the incremented name is free', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/filters/${filterC}/replace`,
      headers: { authorization: `Bearer ${token}`, 'x-reauth-password': TEST_PASSWORD },
      payload: { remarks: 'replace into a free name' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.newFilterName).toBe(`${PREFIX}-91`);

    // Old filter retired, new filter active — exactly one active copy of the new name.
    const old = await prisma.assetInstance.findUnique({ where: { id: filterC } });
    expect(old?.isActive).toBe(false);
    expect(old?.status).toBe('Retired');
    const created = await prisma.assetInstance.findUnique({ where: { id: body.newFilterId } });
    expect(created?.name).toBe(`${PREFIX}-91`);
    expect(created?.isActive).toBe(true);
    const active91 = await prisma.assetInstance.count({ where: { name: `${PREFIX}-91`, isActive: true } });
    expect(active91).toBe(1);
  });
});
