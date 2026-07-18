/**
 * M1 + M2 — Audit-correct reauth action keys.
 *
 * Verifies the M1 + M2 fixes from `tasks/AUDIT-2026-05-04-linkage-review.md`.
 *
 * M1 — admin-request approve/reject previously fired enforceReauth('CREATE_USER',...)
 *      which logged password-reset / unlock / modify-user approvals under the
 *      misleading CREATE_USER key. Now uses APPROVE_ADMIN_REQUEST.
 *
 * M2 — manual filter lifecycle PATCH (`PATCH /api/assets/instances/:id/lifecycle-state`)
 *      previously fired enforceReauth('UPDATE_ASSET',...) which masked cleanroom
 *      lifecycle moves under the generic asset-edit key. Now uses
 *      UPDATE_FILTER_LIFECYCLE.
 *
 * Both are *audit-trail correctness* fixes (not security gaps); CREATE_USER and
 * UPDATE_ASSET remain valid actions used elsewhere. We assert two halves per
 * route:
 *
 *   - WITHOUT password → 401 REAUTH_REQUIRED with the new action key in the
 *     response body (proves the gate is wired to the new action).
 *   - WITH valid `x-reauth-password` header → request flows past the reauth
 *     gate; downstream may 4xx because the test fixtures are minimal (we only
 *     assert "not 401 REAUTH_REQUIRED").
 *
 * Test isolation (per `apps/api/CLAUDE.md`):
 *   - Provisions a dedicated SUPER_ADMIN (`m1m2_audit_admin`) so the shared
 *     `admin` user used by other suites is unaffected under both single-fork
 *     and multi-fork vitest pools.
 *   - Snapshots and restores the `action-reauth` systemConfig row.
 *   - Builds an inline minimal app (mirrors `c2-retire-replace-bulk-upload-reauth.test.ts`
 *     and `auth-profile-reauth.test.ts`).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import authPlugin from '../plugins/auth.js';
import rbacPlugin from '../plugins/rbac.js';
import authRoutes from '../modules/auth/routes.js';
import assetRoutes from '../modules/assets/index.js';
import adminRequestRoutes from '../modules/admin-requests/routes.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';
import { AppError } from '../lib/errors.js';

const TEST_USERNAME = 'm1m2_audit_admin';
const TEST_PASSWORD = 'M1M2Audit@Test1';
// Syntactically valid UUIDs; reauth gate runs before any DB hit so the
// "not found" case is never reached on the without-password branch.
const DUMMY_REQUEST_ID = '00000000-0000-4000-8000-0000000a1101';
const DUMMY_FILTER_ID = '00000000-0000-4000-8000-0000000a2201';

async function buildM1M2App(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { keywords: ['example'] } },
  });

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
  await app.register(assetRoutes, { prefix: '/api/assets' });
  await app.register(adminRequestRoutes, { prefix: '/api/admin-requests' });

  await app.ready();
  return app;
}

describe('M1 + M2 — Audit-correct reauth action keys', () => {
  let app: FastifyInstance;
  let token: string;
  let testUserId: string;
  let originalReauthRow: { configValue: any; configType: string; requiresReauth: boolean } | null = null;

  beforeAll(async () => {
    app = await buildM1M2App();

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const upserted = await prisma.user.upsert({
      where: { username: TEST_USERNAME },
      update: {
        passwordHash,
        fullName: 'M1M2 Audit Test Admin',
        email: 'm1m2-audit-test@example.test',
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
        fullName: 'M1M2 Audit Test Admin',
        email: 'm1m2-audit-test@example.test',
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

    // Flat shape with the two new M1+M2 actions enabled for SUPER_ADMIN.
    // (See `auth-profile-reauth.test.ts` for the seed-shape rationale.)
    await prisma.systemConfig.upsert({
      where: { configKey: 'action-reauth' },
      update: {
        configValue: {
          APPROVE_ADMIN_REQUEST: ['SUPER_ADMIN'],
          UPDATE_FILTER_LIFECYCLE: ['SUPER_ADMIN'],
        } as any,
        configType: 'security',
        requiresReauth: false,
      },
      create: {
        configKey: 'action-reauth',
        configValue: {
          APPROVE_ADMIN_REQUEST: ['SUPER_ADMIN'],
          UPDATE_FILTER_LIFECYCLE: ['SUPER_ADMIN'],
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
      data: { isActive: false, terminationReason: 'm1m2_test_cleanup' },
    });
    try {
      await prisma.user.delete({ where: { id: testUserId } });
    } catch {
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
  // M1 — POST /api/admin-requests/:id/process
  // =========================================================================
  describe('M1: POST /api/admin-requests/:id/process uses APPROVE_ADMIN_REQUEST', () => {
    it('returns 401 REAUTH_REQUIRED with action=APPROVE_ADMIN_REQUEST when no password is supplied', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin-requests/${DUMMY_REQUEST_ID}/process`,
        headers: { authorization: `Bearer ${token}` },
        payload: { action: 'approve', adminRemarks: 'm1 approve without password' },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('REAUTH_REQUIRED');
      expect(body.action).toBe('APPROVE_ADMIN_REQUEST');
      // Confirm the legacy CREATE_USER key is no longer surfaced for this route.
      expect(body.action).not.toBe('CREATE_USER');
    });

    it('passes the reauth gate when correct x-reauth-password is supplied', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin-requests/${DUMMY_REQUEST_ID}/process`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-reauth-password': TEST_PASSWORD,
        },
        payload: { action: 'approve', adminRemarks: 'm1 approve with password' },
      });

      // Past the reauth gate, the service hits a non-existent request UUID and
      // surfaces a 4xx (typically 404). The signal is "not 401 REAUTH_REQUIRED".
      expect(res.statusCode).not.toBe(401);
      expect([400, 404, 422, 500]).toContain(res.statusCode);
    });
  });

  // =========================================================================
  // M2 — PATCH /api/assets/instances/:id/lifecycle-state
  // =========================================================================
  describe('M2: PATCH /api/assets/instances/:id/lifecycle-state uses UPDATE_FILTER_LIFECYCLE', () => {
    it('returns 401 REAUTH_REQUIRED with action=UPDATE_FILTER_LIFECYCLE when no password is supplied', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/assets/instances/${DUMMY_FILTER_ID}/lifecycle-state`,
        headers: { authorization: `Bearer ${token}` },
        payload: { lifecycleState: 'WASH_IN', remarks: 'm2 lifecycle change without password' },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('REAUTH_REQUIRED');
      expect(body.action).toBe('UPDATE_FILTER_LIFECYCLE');
      // Confirm the legacy UPDATE_ASSET key is no longer surfaced for this route.
      expect(body.action).not.toBe('UPDATE_ASSET');
    });

    it('passes the reauth gate when correct x-reauth-password is supplied', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/assets/instances/${DUMMY_FILTER_ID}/lifecycle-state`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-reauth-password': TEST_PASSWORD,
        },
        payload: { lifecycleState: 'WASH_IN', remarks: 'm2 lifecycle change with password' },
      });

      expect(res.statusCode).not.toBe(401);
      expect([400, 404, 422, 500]).toContain(res.statusCode);
    });
  });
});
