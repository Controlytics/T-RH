/**
 * Phase 4 verification — Permissions / Themes / Reports
 *
 * Closes part of PHASE_5_RECENT_WORK.md § 11 outstanding work by adding
 * route-layer e2e coverage for the three Phase 4 surfaces:
 *
 *   1. Feature toggle permissions (FILTER_OPERATE on /api/filters/*)
 *   2. Theme / branding config (GET /api/config/branding) — public read
 *   3. Report page titles config (GET /api/config/report-page-titles/current)
 *   4. Report generation (POST /api/reports/generate) — covered by integration
 *      harness, smoke-tested at the routing layer here.
 *
 * Test infrastructure
 * -------------------
 * The shared test-helper.ts buildApp() does NOT register filter-operations or
 * reports routes (they're registered by app.ts but not by the lean test
 * harness). Per task constraint "DO NOT touch other test files except adding
 * the new one", this file builds a local Fastify instance inline that mirrors
 * test-helper.buildApp's plugin/route set + the additional routes required
 * for Phase 4 coverage. discoverAndRegisterConfigs() is also called so the
 * dynamic-routes.ts and registry/manifest endpoints are populated.
 *
 * Pattern: real Fastify .inject() against real Prisma (no mocks). Same
 * approach as auth.test.ts / config.test.ts — chosen because:
 *   - the routes use a chain of plugins (auth → audit-logger → rbac) whose
 *     interaction with permissions is exactly what we're verifying,
 *   - mocking prisma.role.findFirst would silently bypass the perm fallback
 *     logic in rbac.ts (which is itself part of Phase 4's RBAC story).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import authPlugin from '../plugins/auth.js';
import rbacPlugin from '../plugins/rbac.js';
import authRoutes from '../modules/auth/routes.js';
import userRoutes from '../modules/users/routes.js';
import configRoutes from '../modules/config/routes.js';
import dynamicConfigRoutes from '../modules/config/dynamic-routes.js';
import filterOperationsRoutes from '../modules/filter-operations/routes.js';
import { discoverAndRegisterConfigs } from '../lib/config-discovery.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { AppError } from '../lib/errors.js';
import { loginAs, ADMIN_PASSWORD } from './test-helper.js';

const SUFFIX = Date.now().toString(36).slice(-4).toUpperCase();
const OPERATOR_USERNAME = `OPP4${SUFFIX}`;
const VIEWER_USERNAME = `VWP4${SUFFIX}`;
const TEST_PASSWORD = 'TestPass@123';

/**
 * Local buildApp variant — mirrors test-helper.buildApp but additionally
 * registers config-discovery (so registry/manifest is populated),
 * filter-operations (so we can exercise FILTER_OPERATE perm), and reports
 * (so we can smoke-test the generation endpoint). All other plugins/routes
 * are kept identical so behavior matches test-helper as closely as possible.
 */
async function buildPhase4App(): Promise<FastifyInstance> {
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
    if (err.statusCode === 429) {
      return reply.code(429).send({ error: 'TOO_MANY_REQUESTS', message: err.message });
    }
    const status = err.statusCode ?? 500;
    return reply.code(status).send({ error: err.message || 'Internal Server Error' });
  });

  app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // Phase 4 needs the config registry populated before route registration so
  // /api/config/registry/manifest returns the real module list and the
  // dynamic config routes are wired up for non-custom-page configs.
  await discoverAndRegisterConfigs();

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(configRoutes, { prefix: '/api/config' });
  await app.register(dynamicConfigRoutes, { prefix: '/api/config' });
  await app.register(filterOperationsRoutes, { prefix: '/api/filters' });

  await app.ready();
  return app;
}

describe('Phase 4 — Permissions / Themes / Reports', () => {
  let app: FastifyInstance;
  let viewerToken: string;
  let operatorToken: string;

  beforeAll(async () => {
    app = await buildPhase4App();

    // Provision a VIEWER and OPERATOR user. VIEWER lacks FILTER_OPERATE;
    // OPERATOR has it. Both share the same TEST_PASSWORD.
    const passwordHash = await hashPassword(TEST_PASSWORD);

    for (const [username, role] of [
      [VIEWER_USERNAME, 'VIEWER'],
      [OPERATOR_USERNAME, 'OPERATOR'],
    ] as const) {
      await prisma.user.upsert({
        where: { username },
        update: {
          passwordHash,
          role,
          status: 'ENABLED',
          forcePasswordChange: false,
          isTemporaryPassword: false,
          failedLoginAttempts: 0,
          lockedAt: null,
          lockoutUntil: null,
        },
        create: {
          username,
          fullName: `Phase 4 ${role} User`,
          email: `${username.toLowerCase()}@example.com`,
          passwordHash,
          role,
          status: 'ENABLED',
          forcePasswordChange: false,
          isTemporaryPassword: false,
          createdBy: 'phase4-test',
        },
      });
    }

    viewerToken = await loginAs(app, VIEWER_USERNAME, TEST_PASSWORD);
    operatorToken = await loginAs(app, OPERATOR_USERNAME, TEST_PASSWORD);
  });

  afterAll(async () => {
    // Terminate sessions for the test users so subsequent suites don't hit
    // SESSION_CONFLICT, then close the app. Leave the user rows in place —
    // user.delete cascades into many tables and is unnecessary for
    // re-runnable tests (the upsert above resets them).
    await prisma.session.updateMany({
      where: { user: { username: { in: [VIEWER_USERNAME, OPERATOR_USERNAME] } }, isActive: true },
      data: { isActive: false, terminationReason: 'phase4_test_cleanup' },
    });
    await app.close();
  });

  // ===========================================================================
  // 1. Feature toggle permission — DENIED
  // ===========================================================================
  describe('Feature toggle: FILTER_OPERATE permission gate', () => {
    it('VIEWER (no FILTER_OPERATE) gets 403 on POST /api/filters/:id/start-cycle', async () => {
      // A syntactically valid UUID; the perm check fires before the filter is
      // resolved, so we never reach the DB lookup. Body is intentionally
      // minimal — the perm check sits in preHandler so it returns 403 before
      // body validation runs.
      const dummyUuid = '00000000-0000-4000-8000-000000000000';
      const res = await app.inject({
        method: 'POST',
        url: `/api/filters/${dummyUuid}/start-cycle`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { cleaningReasonKey: 'OOC' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('FORBIDDEN');
      // In non-production env the rbac plugin echoes the requiredPermission.
      // When NODE_ENV=production it omits the field. Accept either.
      if (body.requiredPermission !== undefined) {
        expect(body.requiredPermission).toBe('FILTER_OPERATE');
      }
    });

    // =========================================================================
    // 2. Feature toggle permission — GRANTED
    // =========================================================================
    it('OPERATOR (with FILTER_OPERATE) passes the perm gate (status != 403)', async () => {
      // OPERATOR has FILTER_OPERATE per seed.ts — perm check should pass.
      // The action *also* requires reauth (action-reauth.START_CLEANING_CYCLE
      // includes OPERATOR), so we supply x-reauth-password. Beyond reauth the
      // service tries to load the filter by uuid — that will return 404.
      // We assert "not 403", which is the perm-passed signal regardless of
      // what downstream validation does.
      const dummyUuid = '00000000-0000-4000-8000-000000000000';
      const res = await app.inject({
        method: 'POST',
        url: `/api/filters/${dummyUuid}/start-cycle`,
        headers: {
          authorization: `Bearer ${operatorToken}`,
          'x-reauth-password': TEST_PASSWORD,
        },
        payload: { cleaningReasonKey: 'OOC' },
      });

      expect(res.statusCode).not.toBe(403);
      // Common downstream codes: 404 (filter not found), 400 (validation),
      // 500 (service error). All confirm the perm gate passed.
      expect([400, 404, 422, 500]).toContain(res.statusCode);
    });
  });

  // ===========================================================================
  // 3. Report page titles — GET (public to authenticated users)
  //    (Replaced the former "Report Settings" config on 2026-06-29.)
  // ===========================================================================
  describe('GET /api/config/report-page-titles/current', () => {
    it('returns 200 with the report page titles object (or empty defaults)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/config/report-page-titles/current',
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Returns row?.configValue ?? {} with an open schema. Either an empty {}
      // or a populated object is valid — the GET-current endpoint exists and
      // is readable by any authenticated user so the report chrome can render.
      expect(body).toBeTypeOf('object');
      expect(body).not.toBeNull();
    });

    // PUT round-trip — writes via the CONFIG_UPDATE-gated PUT, then re-reads via
    // the public GET-current endpoint to confirm the systemConfig row persisted.
    it('PUT /api/config/report-page-titles persists the payload (round-trip)', async () => {
      const adminToken = await loginAs(app);

      const payload = {
        performedByLabel: `By(${Date.now()}):`,
        recordsLabel: 'entries',
        pageLabel: 'Sheet',
      };

      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/config/report-page-titles',
        headers: { authorization: `Bearer ${adminToken}` },
        payload,
      });
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody.success).toBe(true);

      const getRes = await app.inject({
        method: 'GET',
        url: '/api/config/report-page-titles/current',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(getRes.statusCode).toBe(200);
      const getBody = JSON.parse(getRes.body);
      expect(getBody).toMatchObject(payload);
    });
  });

  // ===========================================================================
  // 4. Theme / branding — GET (public, returns the theme set)
  // ===========================================================================
  describe('GET /api/config/branding (theme set)', () => {
    it('returns 200 with branding fields including theme colors', async () => {
      // Branding GET is public — no auth header.
      const res = await app.inject({
        method: 'GET',
        url: '/api/config/branding',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Per branding.def.ts the schema declares appName, appTagline,
      // companyName, version, primaryColor, secondaryColor. Always-on
      // branding ensures appName at minimum — see config.test.ts:33.
      expect(body.appName).toBeTruthy();
      // primaryColor / secondaryColor may be undefined if branding has never
      // been customized; just assert the response is the branding object.
      expect(body).toBeTypeOf('object');
    });
  });

  // ===========================================================================
  // 5. Config manifest discovery — confirms report-page-titles + branding are
  // registered
  // ===========================================================================
  describe('GET /api/config/registry/manifest', () => {
    it('lists report-page-titles and branding modules for SUPER_ADMIN', async () => {
      // The manifest endpoint requires authentication (uses req.user.role).
      // Use the existing admin login to fetch the full manifest.
      const adminToken = await loginAs(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/config/registry/manifest',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Manifest is an array of module definitions filtered by role visibility.
      // SUPER_ADMIN sees all registered modules.
      expect(Array.isArray(body)).toBe(true);
      const keys = body.map((m: { moduleKey: string }) => m.moduleKey);
      expect(keys).toContain('report-page-titles');
      expect(keys).toContain('branding');
    });
  });

  // ===========================================================================
  // 6. Report generation smoke test — SKIPPED with rationale
  // ===========================================================================
  // (Removed 2026-07-04: POST /api/reports/generate tests — the reports
  // generate/sign module was deleted as dead code, no FE surface since
  // 2026-06-08. See tasks/REMOVE-REPORTS-MODULE-PLAN.md.)
});
