/**
 * e2e tests for the Cross-Block Cleaning public-read endpoint.
 *
 * Regression cover for #168: both operator surfaces (tablet mobile-operations +
 * desktop filter-operations) read the cross-block mode to pick their flow, but
 * read it from the SUPER_ADMIN-gated `/api/config/dynamic/block-change-approval`.
 * Every non-SUPER_ADMIN caller 403'd and the client silently fell back to
 * 'CONFIRM' — so with the config set to NONE operators still got a confirm
 * dialog, and under APPROVAL they'd self-confirm then hit a server rejection
 * instead of the approval flow.
 *
 * The load-bearing assertion is the NON-SUPER_ADMIN one: an OPERATOR must get
 * 200 + the real mode from /current while still being 403'd on the admin route.
 *
 * App builder / unique-user notes follow the same pattern (and for the same
 * reasons) as ahu-completion-gate.e2e.test.ts — see its header.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import authPlugin from '../../../plugins/auth.js';
import rbacPlugin from '../../../plugins/rbac.js';
import authRoutes from '../../auth/routes.js';
import configRoutes from '../routes.js';
import dynamicConfigRoutes from '../dynamic-routes.js';
import { discoverAndRegisterConfigs } from '../../../lib/config-discovery.js';
import { prisma } from '../../../lib/prisma.js';
import { hashPassword } from '../../../lib/password.js';
import { AppError } from '../../../lib/errors.js';
import { loginAs } from '../../../e2e/test-helper.js';

const SUFFIX = Date.now().toString(36).slice(-4).toUpperCase();
const SA_USERNAME = `BCSA${SUFFIX}`.slice(0, 16).toUpperCase();
const OP_USERNAME = `BCOP${SUFFIX}`.slice(0, 16).toUpperCase();
const TEST_PASSWORD = 'BlockChg@Test#999';

async function buildBcApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ajv: { customOptions: { keywords: ['example'] } } });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(authPlugin);
  await app.register(rbacPlugin);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    const status = err.statusCode ?? 500;
    return reply.code(status).send({ error: err.message || 'Internal Server Error' });
  });

  // MUST run before dynamicConfigRoutes registers — it iterates getAll() at
  // registration time, so the def must already be in the registry.
  await discoverAndRegisterConfigs();

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(configRoutes, { prefix: '/api/config' });
  await app.register(dynamicConfigRoutes, { prefix: '/api/config' });

  await app.ready();
  return app;
}

async function provision(username: string, role: string) {
  const passwordHash = await hashPassword(TEST_PASSWORD);
  await prisma.user.upsert({
    where: { username },
    update: {
      passwordHash, role, status: 'ENABLED',
      forcePasswordChange: false, isTemporaryPassword: false,
      failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null,
    },
    create: {
      username,
      fullName: `Block Change Test ${role}`,
      email: `${username.toLowerCase()}@blockchg-test.local`,
      passwordHash, role, status: 'ENABLED',
      forcePasswordChange: false, isTemporaryPassword: false,
      createdBy: 'block-change-test',
    },
  });
}

describe('Cross-Block Cleaning — public /current mode endpoint', () => {
  let app: FastifyInstance;
  let saHeaders: Record<string, string>;
  let opHeaders: Record<string, string>;
  let originalConfig: any;

  const setMode = async (mode: string) => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/dynamic/block-change-approval',
      headers: saHeaders,
      payload: { ...(originalConfig ?? {}), mode },
    });
    expect(res.statusCode).toBe(200);
  };

  beforeAll(async () => {
    app = await buildBcApp();
    await provision(SA_USERNAME, 'SUPER_ADMIN');
    await provision(OP_USERNAME, 'OPERATOR');

    saHeaders = { authorization: `Bearer ${await loginAs(app, SA_USERNAME, TEST_PASSWORD)}` };
    opHeaders = { authorization: `Bearer ${await loginAs(app, OP_USERNAME, TEST_PASSWORD)}` };

    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'block-change-approval' } });
    originalConfig = row?.configValue ?? null;
  });

  afterAll(async () => {
    // Restore the pre-test config so the mode we set doesn't leak into other suites.
    try {
      if (originalConfig) {
        await prisma.systemConfig.update({
          where: { configKey: 'block-change-approval' },
          data: { configValue: originalConfig },
        });
      } else {
        await prisma.systemConfig.deleteMany({ where: { configKey: 'block-change-approval' } });
      }
    } catch { /* best-effort — don't mask test failures */ }
    try { await app.close(); } catch { /* swallow */ }
  });

  // ── The load-bearing case: the tablet's actual caller ──────────────────────
  it('an OPERATOR reads the real mode from /current (was 403 → silent CONFIRM default)', async () => {
    await setMode('NONE');

    const res = await app.inject({
      method: 'GET',
      url: '/api/config/block-change-approval/current',
      headers: opHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe('NONE');
  });

  it('/current tracks a mode change to APPROVAL for a non-SUPER_ADMIN caller', async () => {
    await setMode('APPROVAL');

    const res = await app.inject({
      method: 'GET',
      url: '/api/config/block-change-approval/current',
      headers: opHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe('APPROVAL');
  });

  it('/current requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/block-change-approval/current' });
    expect(res.statusCode).toBe(401);
  });

  it('exposes ONLY mode — admin fields stay behind the SUPER_ADMIN gate', async () => {
    await setMode('APPROVAL');

    const res = await app.inject({
      method: 'GET',
      url: '/api/config/block-change-approval/current',
      headers: opHeaders,
    });

    expect(Object.keys(res.json())).toEqual(['mode']);
  });

  it('the admin dynamic route stays SUPER_ADMIN-only (the /current mirror must not weaken it)', async () => {
    const opRead = await app.inject({
      method: 'GET',
      url: '/api/config/dynamic/block-change-approval',
      headers: opHeaders,
    });
    expect(opRead.statusCode).toBe(403);

    const opWrite = await app.inject({
      method: 'PUT',
      url: '/api/config/dynamic/block-change-approval',
      headers: opHeaders,
      payload: { mode: 'NONE' },
    });
    expect(opWrite.statusCode).toBe(403);

    const saRead = await app.inject({
      method: 'GET',
      url: '/api/config/dynamic/block-change-approval',
      headers: saHeaders,
    });
    expect(saRead.statusCode).toBe(200);
  });
});
