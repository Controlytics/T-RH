/**
 * e2e — DELETE /api/super-admin/data/* (M49)
 *
 * The five generic data-management DELETE handlers (filter events, notifications,
 * admin requests, block-change requests, PM entries) each did:
 *
 *     await prisma.<model>.delete({ where: { id } }).catch(() => null);
 *     return { success: true };
 *
 * Every failure mode — a missing row, an FK violation, a trigger rejection —
 * was swallowed and reported to the operator as a successful deletion. On a
 * §11 system, telling an operator a record is gone while it is still in the
 * database is worse than the failure itself.
 *
 * NOTE on the original finding's rationale: it claimed "the audit row then
 * asserts a deletion that did not happen". That part is FALSE — these handlers
 * sit in the explicit "COMPREHENSIVE DATA MANAGEMENT … no audit trail" block
 * and write no audit row at all. The real defect is the false success reported
 * to the caller, which is what these tests pin.
 *
 * Notifications stand in for the set: all five now route through the shared
 * `deleteRecord` helper, so the contract is identical for each.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import authPlugin from '../plugins/auth.js';
import rbacPlugin from '../plugins/rbac.js';
import authRoutes from '../modules/auth/routes.js';
import superAdminRoutes from '../modules/super-admin/routes.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { loginAs } from './test-helper.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ajv: { customOptions: { keywords: ['example'] } } });

  await app.register(cors, { origin: true, credentials: true });
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
  await app.register(superAdminRoutes, { prefix: '/api/super-admin' });

  await app.ready();
  return app;
}

const SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// Unique SUPER_ADMIN per file — the shared `admin` user races across suites.
const SA_USERNAME = `SADEL${SUFFIX}`.slice(0, 16).toUpperCase();
const SA_PASSWORD = 'DataDelete@Test#1234';

const createdNotificationIds: string[] = [];

describe('DELETE /api/super-admin/data/notifications/:id', () => {
  let app: FastifyInstance;
  let token: string;

  const seedNotification = async (tag: string) => {
    const n = await prisma.notification.create({
      data: {
        type: 'USER_CREATED',
        title: `Data-delete test ${tag}`,
        message: 'Fixture for the super-admin delete contract.',
        createdBy: 'data-delete-test',
      },
    });
    createdNotificationIds.push(n.id);
    return n.id;
  };

  const del = (id: string) =>
    app.inject({
      method: 'DELETE',
      url: `/api/super-admin/data/notifications/${id}`,
      // Always send the correct reauth password: SUPER_ADMIN_DATA_EDIT reauth is
      // config-driven (off by default) and enforceReauth ignores the header when
      // the action isn't configured, so this is correct either way. A WRONG
      // password would trip the lockout policy and brick the test user.
      headers: { authorization: `Bearer ${token}`, 'x-reauth-password': SA_PASSWORD },
    });

  beforeAll(async () => {
    app = await buildApp();

    const passwordHash = await hashPassword(SA_PASSWORD);
    await prisma.user.upsert({
      where: { username: SA_USERNAME },
      update: {
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        failedLoginAttempts: 0,
        lockedAt: null,
        lockoutUntil: null,
      },
      create: {
        username: SA_USERNAME,
        fullName: 'Data Delete Test Admin',
        email: `${SA_USERNAME.toLowerCase()}@data-delete-test.local`,
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        createdBy: 'data-delete-test',
      },
    });
    token = await loginAs(app, SA_USERNAME, SA_PASSWORD);
  });

  afterAll(async () => {
    try {
      await prisma.notification.deleteMany({ where: { id: { in: createdNotificationIds } } });
      await prisma.session.updateMany({
        where: { user: { username: SA_USERNAME }, isActive: true },
        data: { isActive: false, terminationReason: 'data_delete_test_cleanup' },
      });
    } catch {
      // Best-effort — never mask a test failure with a cleanup failure.
    }
    await app.close();
  });

  // Positive control: proves the handler still deletes, so the 404 test below
  // isn't passing because deletion is simply broken.
  it('deletes an existing record and reports success', async () => {
    const id = await seedNotification(`ok${SUFFIX}`);

    const res = await del(id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    // The success claim is TRUE — the row is really gone.
    expect(await prisma.notification.findUnique({ where: { id } })).toBeNull();
  });

  // The regression: old code answered 200 {success:true} for a row it never
  // deleted because the row was never there.
  it('does NOT report success for a record that does not exist', async () => {
    const res = await del('00000000-0000-4000-8000-000000000000');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('does not report success for a second delete of the same record', async () => {
    const id = await seedNotification(`twice${SUFFIX}`);

    expect((await del(id)).statusCode).toBe(200);
    // The row is gone now; the repeat must not claim it deleted anything.
    const second = await del(id);
    expect(second.statusCode).toBe(404);
    expect(second.json()).not.toEqual({ success: true });
  });
});
