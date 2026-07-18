/**
 * `GET /api/replacement-schedules/blocked-filters` — returns the set of filter
 * ids blocked from starting a cleaning cycle (overdue AHU replacement).
 *
 * Task 1 (`blockedFilterIdsForCleaning` in `service.ts`) already covers the
 * membership math with its own tests, so this file only asserts the route's
 * shape + auth posture: 200, `{ filterIds: string[] }`, open to any
 * authenticated role (same posture as `/due` and `/tasks` in this module —
 * no `preHandler` permission gate).
 *
 * Test-infra mirrors `filter-operations/__tests__/advance-with-checklist-atomic.test.ts`:
 * real Fastify (in-process `inject()`), real Prisma, real auth, against
 * `digilog_test_db` (vitest.env.ts). Unique SUPER_ADMIN per file so the shared
 * `admin` login race can't touch us.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';

import authPlugin from '../../../plugins/auth.js';
import rbacPlugin from '../../../plugins/rbac.js';
import authRoutes from '../../auth/routes.js';
import replacementScheduleRoutes from '../routes.js';
import { prisma } from '../../../lib/prisma.js';
import { hashPassword } from '../../../lib/password.js';
import { AppError } from '../../../lib/errors.js';
import { loginAs } from '../../../e2e/test-helper.js';

const SUFFIX = Date.now().toString(36).slice(-4).toUpperCase();
const BF_USERNAME = `BFRT${SUFFIX}`.slice(0, 16).toUpperCase();
const BF_PASSWORD = 'BfrtTest@Digilog#7';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ajv: { customOptions: { keywords: ['example'] } } });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(authPlugin);
  await app.register(rbacPlugin);
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}),
      });
    }
    if ((err as any).code === 'FST_ERR_VALIDATION' || (err as any).validation) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: err.message });
    }
    return reply.code(err.statusCode ?? 500).send({ error: err.message || 'Internal Server Error' });
  });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(replacementScheduleRoutes, { prefix: '/api/replacement-schedules' });
  await app.ready();
  return app;
}

describe('GET /blocked-filters — blocked filter-id set for the cleaning gate', () => {
  let app: FastifyInstance;
  let authHeaders: Record<string, string>;

  beforeAll(async () => {
    const passwordHash = await hashPassword(BF_PASSWORD);
    await prisma.user.upsert({
      where: { username: BF_USERNAME },
      update: {
        passwordHash, role: 'SUPER_ADMIN', status: 'ENABLED', forcePasswordChange: false,
        isTemporaryPassword: false, failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null,
      },
      create: {
        username: BF_USERNAME, fullName: 'Blocked Filters Route Test',
        email: `${BF_USERNAME.toLowerCase()}@bfrt-test.local`, passwordHash,
        role: 'SUPER_ADMIN', status: 'ENABLED', forcePasswordChange: false,
        isTemporaryPassword: false, createdBy: 'bfrt-test',
      },
    });

    app = await buildApp();
    const token = await loginAs(app, BF_USERNAME, BF_PASSWORD);
    authHeaders = { authorization: `Bearer ${token}` };
  }, 60_000);

  afterAll(async () => {
    try { await app.close(); } catch { /* swallow */ }
  }, 30_000);

  it('returns { filterIds: [...] } to an authenticated user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/replacement-schedules/blocked-filters',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().filterIds)).toBe(true);
  });
});
