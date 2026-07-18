/**
 * C2 — Reauth gates on retire / replace / bulk-upload-filters.
 *
 * Verifies the C2 fix from `tasks/AUDIT-2026-05-04-linkage-review.md`.
 * Three mutating endpoints used to bypass the reauth gate:
 *
 *   POST /api/filters/:id/retire
 *   POST /api/filters/:id/replace
 *   POST /api/assets/instances/bulk-upload-filters
 *
 * Each is now wrapped in `enforceReauth(...)` against a dedicated reauth
 * action constant (`RETIRE_FILTER`, `REPLACE_FILTER`, `BULK_UPLOAD_FILTERS`).
 * This file proves both halves of the contract for each route:
 *
 *   - WITHOUT password → 401 REAUTH_REQUIRED + the audit-correct action key
 *     in the response body.
 *   - WITH valid `x-reauth-password` header → request flows past the reauth
 *     gate (downstream validation may still 4xx because the test fixtures
 *     are minimal — we assert the gate state, not the route's full happy
 *     path).
 *
 * Test isolation (per `apps/api/CLAUDE.md`):
 *   - Provisions a dedicated SUPER_ADMIN (`c2_filter_admin`) so the shared
 *     `admin` user used by other suites is unaffected under both single-fork
 *     and multi-fork vitest pools.
 *   - Snapshots and restores the `action-reauth` systemConfig row.
 *   - Uses an inline buildApp variant because `test-helper.buildApp()` does
 *     not register `filter-operations` routes (they're registered by
 *     `app.ts` for production but not by the lean test harness). Mirrors
 *     the pattern in `phase4-perms-themes-reports.test.ts`.
 *   - The seed in `prisma/seed.ts` writes a NESTED `{ actions: [...] }`
 *     shape that the runtime helper does not understand (it reads
 *     `config[action]` as `Record<string, string[]>`). That is a
 *     pre-existing seed bug; this file writes the FLAT shape directly so
 *     the gate actually fires.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import { invalidateReauthCache } from '../lib/reauth-check.js';
import { AppError } from '../lib/errors.js';

const TEST_USERNAME = 'c2_filter_admin';
const TEST_PASSWORD = 'C2Filter@Test1';
// A syntactically valid UUID for routes that take :id. The reauth gate runs
// before the service touches the DB, so the filter-not-found case is never
// reached on the without-password branch and is a 4xx (not 401) on the
// with-password branch.
const DUMMY_FILTER_ID = '00000000-0000-4000-8000-000000c2f001';
const DUMMY_AHU_ID = '00000000-0000-4000-8000-000000c2a001';

async function buildC2App(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { keywords: ['example'] } },
  });

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

describe('C2 — Retire / Replace / Bulk-Upload reauth gates', () => {
  let app: FastifyInstance;
  let token: string;
  let testUserId: string;
  let originalReauthRow: { configValue: any; configType: string; requiresReauth: boolean } | null = null;

  beforeAll(async () => {
    app = await buildC2App();

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const upserted = await prisma.user.upsert({
      where: { username: TEST_USERNAME },
      update: {
        passwordHash,
        fullName: 'C2 Filter Test Admin',
        email: 'c2-filter-test@example.test',
        role: 'SUPER_ADMIN',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        failedLoginAttempts: 0,
        lockedAt: null,
        lockoutUntil: null,
      },
      create: {
        username: TEST_USERNAME,
        passwordHash,
        fullName: 'C2 Filter Test Admin',
        email: 'c2-filter-test@example.test',
        role: 'SUPER_ADMIN',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
      },
    });
    testUserId = upserted.id;

    const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
    if (existing) {
      originalReauthRow = {
        configValue: existing.configValue,
        configType: existing.configType,
        requiresReauth: existing.requiresReauth,
      };
    }

    // Write the flat shape with all three new C2 actions enabled for SUPER_ADMIN.
    await prisma.systemConfig.upsert({
      where: { configKey: 'action-reauth' },
      update: {
        configValue: {
          RETIRE_FILTER: ['SUPER_ADMIN'],
          REPLACE_FILTER: ['SUPER_ADMIN'],
          BULK_UPLOAD_FILTERS: ['SUPER_ADMIN'],
        } as any,
        configType: 'security',
        requiresReauth: false,
      },
      create: {
        configKey: 'action-reauth',
        configValue: {
          RETIRE_FILTER: ['SUPER_ADMIN'],
          REPLACE_FILTER: ['SUPER_ADMIN'],
          BULK_UPLOAD_FILTERS: ['SUPER_ADMIN'],
        } as any,
        configType: 'security',
        requiresReauth: false,
      },
    });
    invalidateReauthCache();

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD, force: true },
    });
    const body = JSON.parse(loginRes.body);
    if (!body.token) {
      throw new Error(`Login failed for ${TEST_USERNAME}: ${loginRes.body}`);
    }
    token = body.token;
  });

  afterAll(async () => {
    if (originalReauthRow) {
      await prisma.systemConfig.update({
        where: { configKey: 'action-reauth' },
        data: {
          configValue: originalReauthRow.configValue,
          configType: originalReauthRow.configType,
          requiresReauth: originalReauthRow.requiresReauth,
        },
      });
    } else {
      await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
    }
    invalidateReauthCache();

    await prisma.session.updateMany({
      where: { userId: testUserId },
      data: { isActive: false, terminationReason: 'c2_test_cleanup' },
    });
    try {
      await prisma.user.delete({ where: { id: testUserId } });
    } catch {
      // FK to audit trail can block delete — fall back to disable + email
      // rotation so the user is unique on the next run.
      await prisma.user.update({
        where: { id: testUserId },
        data: { status: 'DISABLED', email: `disabled-${testUserId}@example.test` },
      });
    }

    await app.close();
  });

  beforeEach(() => {
    invalidateReauthCache();
  });

  // =========================================================================
  // POST /api/filters/:id/retire
  // =========================================================================
  describe('POST /api/filters/:id/retire', () => {
    it('returns 401 REAUTH_REQUIRED when no password is supplied', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/filters/${DUMMY_FILTER_ID}/retire`,
        headers: { authorization: `Bearer ${token}` },
        payload: { remarks: 'c2 retire without password' },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('REAUTH_REQUIRED');
      expect(body.action).toBe('RETIRE_FILTER');
    });

    it('passes the reauth gate when correct x-reauth-password is supplied', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/filters/${DUMMY_FILTER_ID}/retire`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-reauth-password': TEST_PASSWORD,
        },
        payload: { remarks: 'c2 retire with password' },
      });

      // Status MUST NOT be 401 (reauth-gate signal). Filter doesn't exist so
      // downstream is typically 404; some service paths may surface 400/500.
      // The point of THIS test is the gate, not the service body.
      expect(res.statusCode).not.toBe(401);
      expect([400, 404, 422, 500]).toContain(res.statusCode);
    });
  });

  // =========================================================================
  // POST /api/filters/:id/replace
  // =========================================================================
  describe('POST /api/filters/:id/replace', () => {
    it('returns 401 REAUTH_REQUIRED when no password is supplied', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/filters/${DUMMY_FILTER_ID}/replace`,
        headers: { authorization: `Bearer ${token}` },
        payload: { remarks: 'c2 replace without password' },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('REAUTH_REQUIRED');
      expect(body.action).toBe('REPLACE_FILTER');
    });

    it('passes the reauth gate when correct x-reauth-password is supplied', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/filters/${DUMMY_FILTER_ID}/replace`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-reauth-password': TEST_PASSWORD,
        },
        payload: { remarks: 'c2 replace with password' },
      });

      expect(res.statusCode).not.toBe(401);
      expect([400, 404, 422, 500]).toContain(res.statusCode);
    });
  });

  // =========================================================================
  // POST /api/assets/instances/bulk-upload-filters (multipart)
  //
  // The bulk-upload route is multipart/form-data — `req.body` is undefined,
  // so `enforceReauth` can only read the password from the
  // `x-reauth-password` header. The gate runs BEFORE `req.parts()` consumes
  // the stream so this works in either order.
  // =========================================================================
  describe('POST /api/assets/instances/bulk-upload-filters', () => {
    // Build a minimal multipart body inline. fastify's inject can take a
    // payload + headers; we craft the multipart frame manually so we don't
    // need a third-party form-data dependency.
    const BOUNDARY = '----c2reauthboundary';
    const csv = 'name,filterSet\nC2-F-001,A\n';
    const multipartPayload = [
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; name="file"; filename="filters.csv"',
      'Content-Type: text/csv',
      '',
      csv,
      `--${BOUNDARY}`,
      `Content-Disposition: form-data; name="ahuId"`,
      '',
      DUMMY_AHU_ID,
      `--${BOUNDARY}--`,
      '',
    ].join('\r\n');
    const multipartHeaders = {
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    };

    it('returns 401 REAUTH_REQUIRED when no password is supplied', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/assets/instances/bulk-upload-filters',
        headers: {
          authorization: `Bearer ${token}`,
          ...multipartHeaders,
        },
        payload: multipartPayload,
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('REAUTH_REQUIRED');
      expect(body.action).toBe('BULK_UPLOAD_FILTERS');
    });

    it('passes the reauth gate when correct x-reauth-password is supplied', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/assets/instances/bulk-upload-filters',
        headers: {
          authorization: `Bearer ${token}`,
          'x-reauth-password': TEST_PASSWORD,
          ...multipartHeaders,
        },
        payload: multipartPayload,
      });

      // Past the reauth gate, the service runs against a non-existent AHU
      // UUID and returns a row-level error (200 with failed:1) or a 4xx
      // depending on validation order. The signal we care about is "not
      // 401 REAUTH_REQUIRED". Accept any non-reauth response.
      expect(res.statusCode).not.toBe(401);
      // 200 (results array with per-row failures) or 4xx are both acceptable.
      expect([200, 400, 404, 422, 500]).toContain(res.statusCode);
    });
  });
});
