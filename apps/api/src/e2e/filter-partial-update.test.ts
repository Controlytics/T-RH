/**
 * Filter partial-update attributes contract (#221, 2026-07-15).
 *
 * `PUT /api/hierarchy/filters/:id` used to REPLACE the attributes JSON with
 * whatever the caller sent, so a partial body (`{"name":"X"}`) silently
 * destroyed ahuType / filterType / micronSize / filterSize / lastCleaningDate —
 * regulated 21 CFR data — and the audit row recorded the wipe as an intentional
 * change. It was latent only because the edit dialog always resent every field.
 *
 * The contract is now: an ABSENT field means "don't touch"; a field sent EMPTY
 * ('' / null) means "clear it".
 *
 * This file exists to prove the contract survives the WIRE, which the
 * filter.service unit tests structurally cannot: between the client and the
 * service sit Fastify body validation (`additionalProperties: false`) and the
 * sanitize layer. If either dropped an empty-string key, the service would read
 * the field as "absent", the merge would preserve the old value, and clearing
 * would break in production with every unit test still green.
 *
 * Isolation: provisions its own SUPER_ADMIN and one throwaway typed filter on a
 * seeded AHU; both removed in afterAll. Only `ahuType` (which has live master
 * data) + the free-text `filterSize` + `lastCleaningDate` are exercised —
 * filterType / micronSize have empty option lists in the test DB, so any value
 * would fail validation for reasons unrelated to this contract.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import authPlugin from '../plugins/auth.js';
import rbacPlugin from '../plugins/rbac.js';
import authRoutes from '../modules/auth/routes.js';
import hierarchyRoutes from '../modules/hierarchy/routes.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { AppError } from '../lib/errors.js';

const TEST_USERNAME = 'partial_update_filter_admin';
const TEST_PASSWORD = 'Partial@Test1';
const PREFIX = `ZZPARTIAL-${Date.now()}`;

// The full attribute set the filter starts with — every one of these is a
// regulated field a partial PUT must not destroy.
const SEEDED_ATTRS = { ahuType: 'Process', filterSize: '610x610x292mm', lastCleaningDate: '2026-01-02' };

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ajv: { customOptions: { keywords: ['example'] } } });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(authPlugin);
  await app.register(rbacPlugin);
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    return reply.code(err.statusCode ?? 500).send({ error: err.message || 'Internal Server Error' });
  });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(hierarchyRoutes, { prefix: '/api/hierarchy' });
  await app.ready();
  return app;
}

describe('Filter partial update — attributes are merged, not replaced', () => {
  let app: FastifyInstance;
  let token: string;
  let testUserId: string;
  let filterId: string;

  const putFilter = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'PUT', url: `/api/hierarchy/filters/${filterId}`,
      headers: { authorization: `Bearer ${token}`, 'x-reauth-password': TEST_PASSWORD },
      payload,
    });

  const readAttrs = async () =>
    (await prisma.filter.findUnique({ where: { id: filterId }, select: { attributes: true } }))?.attributes as Record<string, unknown>;

  // Each test re-seeds the full attribute set so the cases are order-independent.
  const resetAttrs = () => prisma.filter.update({ where: { id: filterId }, data: { attributes: { ...SEEDED_ATTRS } } as any });

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
        username: TEST_USERNAME, passwordHash, fullName: 'Partial Update Test Admin',
        email: 'partial-update-filter-test@example.test', role: 'SUPER_ADMIN', status: 'ENABLED',
        forcePasswordChange: false, isTemporaryPassword: false,
      },
    });
    testUserId = user.id;

    const ahu = await prisma.ahu.findFirst({ select: { id: true } });
    if (!ahu) throw new Error('Test DB has no AHU to hang a filter on');
    const created = await prisma.filter.create({
      data: { id: crypto.randomUUID(), ahuId: ahu.id, name: `${PREFIX}-F1`, status: 'Active', attributes: { ...SEEDED_ATTRS } } as any,
    });
    filterId = created.id;

    const loginRes = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD, force: true },
    });
    const body = JSON.parse(loginRes.body);
    if (!body.token) throw new Error(`Login failed: ${loginRes.body}`);
    token = body.token;
  });

  afterAll(async () => {
    const mine = await prisma.filter.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
    const ids = mine.map((m) => m.id);
    await prisma.filterDetails.deleteMany({ where: { assetInstanceId: { in: ids } } });
    await prisma.assetIdentifier.deleteMany({ where: { assetId: { in: ids } } });
    await prisma.assetRelationship.deleteMany({ where: { OR: [{ sourceAssetId: { in: ids } }, { targetAssetId: { in: ids } }] } });
    await prisma.filter.deleteMany({ where: { id: { in: ids } } });
    await prisma.assetInstance.deleteMany({ where: { id: { in: ids } } }); // reverse-mirror rows
    await prisma.session.updateMany({ where: { userId: testUserId }, data: { isActive: false, terminationReason: 'partial_update_test_cleanup' } });
    try {
      await prisma.user.delete({ where: { id: testUserId } });
    } catch {
      await prisma.user.update({ where: { id: testUserId }, data: { status: 'DISABLED', email: `disabled-${testUserId}@example.test` } });
    }
    await app.close();
  });

  it('a name-only PUT preserves every regulated attribute (#221)', async () => {
    await resetAttrs();
    const res = await putFilter({ name: `${PREFIX}-F1-renamed` });
    expect(res.statusCode).toBe(200);
    expect(await readAttrs()).toEqual(SEEDED_ATTRS);
  });

  it('a single-field PUT overlays that field and leaves the rest intact', async () => {
    await resetAttrs();
    const res = await putFilter({ filterSize: '305x305x150mm' });
    expect(res.statusCode).toBe(200);
    expect(await readAttrs()).toEqual({ ...SEEDED_ATTRS, filterSize: '305x305x150mm' });
  });

  // THE SEAM: proves an explicit '' survives Fastify validation + sanitize and
  // reaches the service as a PRESENT key, so clearing still works end-to-end.
  it("an explicit '' clears the field over the wire (dropdown + free text + date)", async () => {
    await resetAttrs();
    const res = await putFilter({ ahuType: '', filterSize: '', lastCleaningDate: '' });
    expect(res.statusCode).toBe(200);
    expect(await readAttrs()).toEqual({});
  });

  it("clearing one field via '' does not disturb the fields sent alongside it", async () => {
    await resetAttrs();
    const res = await putFilter({ ahuType: 'Process', filterSize: '', lastCleaningDate: '2026-03-04' });
    expect(res.statusCode).toBe(200);
    expect(await readAttrs()).toEqual({ ahuType: 'Process', lastCleaningDate: '2026-03-04' });
  });
});
