/**
 * e2e tests for AHU Cleaning Completion Process config + reader.
 *
 * Task 1 of the AHU Completion Process feature:
 *   - GET /api/config/ahu-completion-process/current → { mode } (public, auth only)
 *   - PUT /api/config/dynamic/ahu-completion-process → persists mode (SUPER_ADMIN)
 *
 * App builder note
 * ----------------
 * The shared buildApp() in test-helper.ts does NOT register dynamicConfigRoutes
 * (required for the PUT test) nor does it call discoverAndRegisterConfigs()
 * (required so the registry knows about ahu-completion-process before
 * dynamic-routes.ts iterates getAll() at registration time).
 * This file builds its own lean Fastify instance following the same pattern
 * as phase4-perms-themes-reports.test.ts.
 *
 * Unique SUPER_ADMIN
 * ------------------
 * Provisions its own user in beforeAll (username derived from this file's name)
 * to avoid contending with the shared `admin` session. Pattern from phase5 test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import authPlugin from '../../../plugins/auth.js';
import rbacPlugin from '../../../plugins/rbac.js';
import authRoutes from '../../auth/routes.js';
import configRoutes from '../../config/routes.js';
import dynamicConfigRoutes from '../../config/dynamic-routes.js';
import { discoverAndRegisterConfigs } from '../../../lib/config-discovery.js';
import { prisma } from '../../../lib/prisma.js';
import { hashPassword } from '../../../lib/password.js';
import { AppError } from '../../../lib/errors.js';
import { loginAs } from '../../../e2e/test-helper.js';
import { randomUUID } from 'node:crypto';
import { computeAhuCompletionStatus, computeAhuBatchStatus, computeAhuSetAvailability, assertAhuInterlockSatisfied, resolveAhuId } from '../ahu-completion-gate.js';
import filterOperationsRoutes from '../routes.js';

// ── Unique test user ────────────────────────────────────────────────────────
// Derived from this file's name so it never clashes with the shared `admin`
// or any other test file's fixture user.
const SUFFIX = Date.now().toString(36).slice(-4).toUpperCase();
const AHU_GATE_USERNAME = `AHUGT${SUFFIX}`.slice(0, 16).toUpperCase();
const AHU_GATE_PASSWORD = 'AhuGate@Test#999';

// ── Local app builder ───────────────────────────────────────────────────────
async function buildAhuApp(): Promise<FastifyInstance> {
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
    if ((err as any).code === 'FST_ERR_VALIDATION' || (err as any).validation) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: err.message,
        ...((err as any).validation ? { details: (err as any).validation } : {}),
      });
    }
    const status = err.statusCode ?? 500;
    return reply.code(status).send({ error: err.message || 'Internal Server Error' });
  });

  app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // MUST run before dynamicConfigRoutes registers — it iterates getAll() at
  // registration time, so the new def must already be in the registry.
  await discoverAndRegisterConfigs();

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(configRoutes, { prefix: '/api/config' });
  await app.register(dynamicConfigRoutes, { prefix: '/api/config' });

  await app.ready();
  return app;
}

describe('AHU Completion Process — config endpoint + reader', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let authHeaders: Record<string, string>;

  beforeAll(async () => {
    app = await buildAhuApp();

    // Provision unique SUPER_ADMIN — idempotent upsert so re-runs work.
    const passwordHash = await hashPassword(AHU_GATE_PASSWORD);
    await prisma.user.upsert({
      where: { username: AHU_GATE_USERNAME },
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
        username: AHU_GATE_USERNAME,
        fullName: 'AHU Gate Test Admin',
        email: `${AHU_GATE_USERNAME.toLowerCase()}@ahugate-test.local`,
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        createdBy: 'ahu-gate-test',
      },
    });

    adminToken = await loginAs(app, AHU_GATE_USERNAME, AHU_GATE_PASSWORD);
    authHeaders = { authorization: `Bearer ${adminToken}` };
  });

  afterAll(async () => {
    // Reset config row to default so we leave no state leakage.
    // Best-effort — don't let cleanup failures mask test failures.
    try {
      await app.inject({
        method: 'PUT',
        url: '/api/config/dynamic/ahu-completion-process',
        headers: authHeaders,
        payload: { mode: 'NONE' },
      });
    } catch {
      // swallow
    }
    try {
      await app.close();
    } catch {
      // swallow
    }
  });

  it('GET /api/config/ahu-completion-process/current returns NONE by default', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/config/ahu-completion-process/current',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe('NONE');
  });

  it('PUT dynamic config sets mode to INTERLOCK and /current reflects it', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/config/dynamic/ahu-completion-process',
      headers: authHeaders,
      payload: { mode: 'INTERLOCK' },
    });
    expect(put.statusCode).toBe(200);

    const res = await app.inject({
      method: 'GET',
      url: '/api/config/ahu-completion-process/current',
      headers: authHeaders,
    });
    expect(res.json().mode).toBe('INTERLOCK');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 3 — DB-backed helpers: resolveAhuId, loadCountedFilters,
//           computeAhuCompletionStatus
//
// Fixture: one AHU with two child FILTER instances sharing profile S1→S2→CL→END.
//   Filter A parked at S2 (final stage).
//   Filter B mid-cleaning at S1 (not final).
// Excluded filter = A.  Expectation: B is pending, allAtFinal = false.
// ─────────────────────────────────────────────────────────────────────────────
describe('AHU Completion Status — computeAhuCompletionStatus', () => {
  let ahuTemplateId: string;
  let filterTemplateId: string;
  let cleaningProfileId: string;
  let filterProfileId: string;
  let ahuId: string;
  let filterAId: string;
  let filterBId: string;
  let cycleAId: string;
  let cycleBId: string;

  beforeAll(async () => {
    // ── Template kinds (seeded by seed.ts; upsert for safety) ───────────────
    await prisma.templateKind.upsert({
      where: { code: 'AHU' },
      update: {},
      create: { code: 'AHU', label: 'AHU', isSystem: true },
    });
    await prisma.templateKind.upsert({
      where: { code: 'FILTER' },
      update: {},
      create: { code: 'FILTER', label: 'Filter', isSystem: true },
    });

    // ── Asset templates (unique names via SUFFIX) ────────────────────────────
    const ahuTpl = await prisma.assetTemplate.create({
      data: { name: `AHU Tpl T3 ${SUFFIX}`, templateKind: 'AHU' },
    });
    ahuTemplateId = ahuTpl.id;

    const filterTpl = await prisma.assetTemplate.create({
      data: { name: `Filter Tpl T3 ${SUFFIX}`, templateKind: 'FILTER' },
    });
    filterTemplateId = filterTpl.id;

    // ── Cleaning profile: S1 → S2 → [CHECKLIST] → END ───────────────────────
    const cp = await prisma.filterCleaningProfile.create({
      data: {
        name: `CP T3 ${SUFFIX}`,
        lineageId: randomUUID(),
        status: 'ACTIVE',
        createdBy: '00000000-0000-0000-0000-000000000001',
        stages: {
          create: [
            { nodeType: 'STAGE', stateKey: 'S1', sortOrder: 1 },
            { nodeType: 'STAGE', stateKey: 'S2', sortOrder: 2 },
            { nodeType: 'CHECKLIST', stateKey: null, sortOrder: 3 },
            { nodeType: 'END', stateKey: null, sortOrder: 4 },
          ],
        },
      },
      include: { stages: true },
    });
    cleaningProfileId = cp.id;

    // Wire connections: S1 → S2 → CHECKLIST → END
    const s1 = cp.stages.find(s => s.stateKey === 'S1')!;
    const s2 = cp.stages.find(s => s.stateKey === 'S2')!;
    const cl = cp.stages.find(s => s.nodeType === 'CHECKLIST')!;
    const end = cp.stages.find(s => s.nodeType === 'END')!;
    await prisma.filterPipelineConnection.createMany({
      data: [
        { profileId: cleaningProfileId, fromStageId: s1.id, toStageId: s2.id },
        { profileId: cleaningProfileId, fromStageId: s2.id, toStageId: cl.id },
        { profileId: cleaningProfileId, fromStageId: cl.id, toStageId: end.id },
      ],
    });

    // ── Filter profile (links AssetInstance → CleaningProfile) ──────────────
    const fp = await prisma.filterProfile.create({
      data: { name: `FP T3 ${SUFFIX}`, cleaningProfileId },
    });
    filterProfileId = fp.id;

    // ── AHU instance (no parent) ─────────────────────────────────────────────
    const ahu = await prisma.assetInstance.create({
      data: { name: `AHU T3 ${SUFFIX}`, templateId: ahuTemplateId },
    });
    ahuId = ahu.id;

    // ── Filter A — parked at final stage (S2) ────────────────────────────────
    const fA = await prisma.assetInstance.create({
      data: { name: `Filter A T3 ${SUFFIX}`, templateId: filterTemplateId, parentId: ahuId },
    });
    filterAId = fA.id;

    // ── Filter B — mid-cleaning at S1 ────────────────────────────────────────
    const fB = await prisma.assetInstance.create({
      data: { name: `Filter B T3 ${SUFFIX}`, templateId: filterTemplateId, parentId: ahuId },
    });
    filterBId = fB.id;

    // ── Cycles (profileId = FilterCleaningProfile.id directly) ───────────────
    // loadLocalContext handles this: tries FilterProfile lookup (null), falls
    // back to treating profileId as a FilterCleaningProfile id.
    const cycleA = await prisma.cleaningCycle.create({
      data: {
        cycleCode: `CC-T3A-${SUFFIX}`,
        filterId: filterAId,
        profileId: cleaningProfileId,
        profileVersion: 1,
        sequenceNumber: 1,
        cleaningReasonKey: 'SCHEDULED',
        cleaningReasonLabel: 'Scheduled',
      },
    });
    cycleAId = cycleA.id;

    const cycleB = await prisma.cleaningCycle.create({
      data: {
        cycleCode: `CC-T3B-${SUFFIX}`,
        filterId: filterBId,
        profileId: cleaningProfileId,
        profileVersion: 1,
        sequenceNumber: 1,
        cleaningReasonKey: 'SCHEDULED',
        cleaningReasonLabel: 'Scheduled',
      },
    });
    cycleBId = cycleB.id;

    // ── FilterDetails: A at S2 (final), B at S1 (not final) ─────────────────
    await prisma.filterDetails.create({
      data: {
        assetInstanceId: filterAId,
        filterProfileId,
        currentCycleId: cycleAId,
        currentLifecycleState: 'S2',
      },
    });
    await prisma.filterDetails.create({
      data: {
        assetInstanceId: filterBId,
        filterProfileId,
        currentCycleId: cycleBId,
        currentLifecycleState: 'S1',
      },
    });
  }, 30_000);

  afterAll(async () => {
    // FK-safe teardown order:
    // FilterDetails → CleaningCycles → child instances → AHU → FilterProfile
    //   → FilterCleaningProfile (cascades stages/connections) → templates
    try {
      await prisma.filterDetails.deleteMany({
        where: { assetInstanceId: { in: [filterAId, filterBId].filter(Boolean) } },
      });
      await prisma.cleaningCycle.deleteMany({
        where: { id: { in: [cycleAId, cycleBId].filter(Boolean) } },
      });
      await prisma.assetInstance.deleteMany({
        where: { id: { in: [filterAId, filterBId].filter(Boolean) } },
      });
      if (ahuId) await prisma.assetInstance.delete({ where: { id: ahuId } });
      if (filterProfileId) await prisma.filterProfile.delete({ where: { id: filterProfileId } });
      if (cleaningProfileId)
        await prisma.filterCleaningProfile.delete({ where: { id: cleaningProfileId } });
      if (ahuTemplateId) await prisma.assetTemplate.delete({ where: { id: ahuTemplateId } });
      if (filterTemplateId) await prisma.assetTemplate.delete({ where: { id: filterTemplateId } });
    } catch {
      // Swallow cleanup errors — don't mask real test failures.
    }
  }, 30_000);

  it('computeAhuCompletionStatus reports the mid-cleaning sibling as pending', async () => {
    // Exclude A (at final S2). Only B (at S1, non-final) remains → allAtFinal false.
    const status = await computeAhuCompletionStatus(ahuId, filterAId);
    expect(status.allAtFinal).toBe(false);
    expect(status.pending.map(p => p.id)).toContain(filterBId);
  });

  it('computeAhuCompletionStatus sees only the final-stage filter as done', async () => {
    // Exclude B (at S1). Only A (at S2, final) remains.
    // If computeFinalStageKey returns null/wrong key, A is treated as pending → assertion fails.
    // This discriminating case proves the final-stage graph walk actually works.
    const done = await computeAhuCompletionStatus(ahuId, filterBId);
    expect(done.allAtFinal).toBe(true);
    expect(done.pending).toEqual([]);
  });

  // ── Task 4: assertAhuInterlockSatisfied + completion-status endpoint ─────────
  describe('Task 4 — assertAhuInterlockSatisfied + completion-status endpoint', () => {
    let app4: FastifyInstance;
    let authHeaders4: Record<string, string>;

    // Non-AHU parent fixture for the templateKind !== 'AHU' branch test.
    let nonAhuTemplateId: string;
    let nonAhuParentId: string;
    let nonAhuChildId: string;

    beforeAll(async () => {
      // Set mode to INTERLOCK in DB (upsert in case first describe's afterAll
      // has already run and the row exists with NONE; or the row doesn't exist yet).
      await prisma.systemConfig.upsert({
        where: { configKey: 'ahu-completion-process' },
        update: { configValue: { mode: 'INTERLOCK' } as any },
        create: {
          configKey: 'ahu-completion-process',
          configValue: { mode: 'INTERLOCK' } as any,
          configType: 'filter-management',
        },
      });

      // Build a minimal Fastify app with filter-operations routes (for endpoint test).
      app4 = Fastify({ logger: false, ajv: { customOptions: { keywords: ['example'] } } });
      await app4.register(cors, { origin: true, credentials: true });
      await app4.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
      await app4.register(authPlugin);
      await app4.register(rbacPlugin);
      app4.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
        if (err instanceof AppError) {
          return reply.code(err.statusCode).send({
            error: err.code,
            message: err.message,
            ...(err.details ? { details: err.details } : {}),
          });
        }
        if ((err as any).code === 'FST_ERR_VALIDATION' || (err as any).validation) {
          return reply.code(400).send({
            error: 'VALIDATION_ERROR',
            message: err.message,
            ...((err as any).validation ? { details: (err as any).validation } : {}),
          });
        }
        const status = err.statusCode ?? 500;
        return reply.code(status).send({ error: err.message || 'Internal Server Error' });
      });
      await app4.register(authRoutes, { prefix: '/api/auth' });
      await app4.register(filterOperationsRoutes, { prefix: '/api/filters' });
      await app4.ready();

      // ── Non-AHU parent fixture (for templateKind !== 'AHU' branch) ──────────
      // Upsert BLOCK kind (seeded in seed.ts, upsert is safe on a test DB).
      await prisma.templateKind.upsert({
        where: { code: 'BLOCK' },
        update: {},
        create: { code: 'BLOCK', label: 'Block', isSystem: true },
      });
      const nonAhuTpl = await prisma.assetTemplate.create({
        data: { name: `Block Tpl T4 ${SUFFIX}`, templateKind: 'BLOCK' },
      });
      nonAhuTemplateId = nonAhuTpl.id;

      const nonAhuParent = await prisma.assetInstance.create({
        data: { name: `Block Parent T4 ${SUFFIX}`, templateId: nonAhuTemplateId },
      });
      nonAhuParentId = nonAhuParent.id;

      // Child whose parent EXISTS but is a BLOCK (not AHU) — exercises the
      // `templateKind !== 'AHU'` return-null branch in resolveAhuId.
      const nonAhuChild = await prisma.assetInstance.create({
        data: {
          name: `Child of Block T4 ${SUFFIX}`,
          templateId: filterTemplateId,
          parentId: nonAhuParentId,
        },
      });
      nonAhuChildId = nonAhuChild.id;

      // Login as the SUPER_ADMIN provisioned in the first describe's beforeAll.
      // That user persists in the DB across all describes in this file.
      const token = await loginAs(app4, AHU_GATE_USERNAME, AHU_GATE_PASSWORD);
      authHeaders4 = { authorization: `Bearer ${token}` };
    }, 30_000);

    afterAll(async () => {
      // Reset config to NONE so we leave no state leakage.
      try {
        await prisma.systemConfig.updateMany({
          where: { configKey: 'ahu-completion-process' },
          data: { configValue: { mode: 'NONE' } as any },
        });
      } catch { /* swallow */ }
      // Tear down non-AHU fixture (FK-safe: child → parent → template).
      try {
        if (nonAhuChildId) await prisma.assetInstance.delete({ where: { id: nonAhuChildId } });
        if (nonAhuParentId) await prisma.assetInstance.delete({ where: { id: nonAhuParentId } });
        if (nonAhuTemplateId) await prisma.assetTemplate.delete({ where: { id: nonAhuTemplateId } });
      } catch { /* swallow */ }
      try { await app4.close(); } catch { /* swallow */ }
    }, 10_000);

    // ── resolveAhuId coverage (Task 3 follow-through) ───────────────────────
    it('resolveAhuId returns the AHU id when the immediate parent is an AHU', async () => {
      const resolved = await resolveAhuId(filterAId);
      expect(resolved).toBe(ahuId);
    });

    it('resolveAhuId returns null when the filter has no parent (early-return null guard)', async () => {
      // ahuId itself has parentId = null → hits `if (!self?.parentId) return null;`.
      // This covers the no-parent guard, NOT the templateKind branch.
      const resolved = await resolveAhuId(ahuId);
      expect(resolved).toBeNull();
    });

    it('resolveAhuId returns null when the immediate parent exists but is not an AHU (templateKind !== AHU branch)', async () => {
      // nonAhuChildId has parentId → nonAhuParentId whose templateKind is 'BLOCK'.
      // resolveAhuId: self.parentId is non-null (skips early guard) → fetches parent
      // → parent.template.templateKind === 'BLOCK' !== 'AHU' → returns null.
      // This is the only test that exercises the `return parent?.template?.templateKind === 'AHU' ? parent.id : null`
      // branch when templateKind is NOT 'AHU'.
      const resolved = await resolveAhuId(nonAhuChildId);
      expect(resolved).toBeNull();
    });

    // ── assertAhuInterlockSatisfied ─────────────────────────────────────────
    it('assertAhuInterlockSatisfied passes on offline replay regardless of mode', async () => {
      // isOfflineReplay = true → immediate return, no DB reads.
      await expect(assertAhuInterlockSatisfied({ filterId: filterAId, isOfflineReplay: true }))
        .resolves.toBeUndefined();
    });

    it('assertAhuInterlockSatisfied passes when mode is NONE', async () => {
      // Temporarily set mode to NONE.
      await prisma.systemConfig.updateMany({
        where: { configKey: 'ahu-completion-process' },
        data: { configValue: { mode: 'NONE' } as any },
      });
      try {
        await expect(assertAhuInterlockSatisfied({ filterId: filterAId, isOfflineReplay: false }))
          .resolves.toBeUndefined();
      } finally {
        // Restore INTERLOCK for the throw test below.
        await prisma.systemConfig.updateMany({
          where: { configKey: 'ahu-completion-process' },
          data: { configValue: { mode: 'INTERLOCK' } as any },
        });
      }
    });

    it('assertAhuInterlockSatisfied throws 422 AHU_INTERLOCK_PENDING when a sibling is not at final stage', async () => {
      // mode = INTERLOCK; filter A is at S2 (final) but filter B is at S1 (not final).
      // Calling with filterAId (exclude A): B is pending → should throw.
      await expect(assertAhuInterlockSatisfied({ filterId: filterAId, isOfflineReplay: false }))
        .rejects.toMatchObject({ statusCode: 422, code: 'AHU_INTERLOCK_PENDING' });
    });

    // ── GET /api/filters/ahu/:ahuId/completion-status ───────────────────────
    it('GET completion-status returns 200 with allAtFinal=false and B in pending', async () => {
      const res = await app4.inject({
        method: 'GET',
        url: `/api/filters/ahu/${ahuId}/completion-status`,
        headers: authHeaders4,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.allAtFinal).toBe(false);
      expect(body.pending.map((p: { id: string }) => p.id)).toContain(filterBId);
    });
  });

  // ── Task 5: submit-checklist HTTP route integration ──────────────────────────
  // Verifies that the assertAhuInterlockSatisfied gate is wired into the
  // submit-checklist completion path and fires BEFORE any DB write.
  //
  // Fixture (inherited from outer beforeAll):
  //   Filter A — at S2 (final), cycleAId IN_PROGRESS.
  //   Filter B — at S1 (not final), cycleBId IN_PROGRESS.
  //   Profile:  S1 → S2 → [CHECKLIST, no checklistProfileId] → END.
  //   CHECKLIST node has no checklistProfileId → resolveChecklistQuestions
  //   returns [] → answers:{} is valid for all three tests.
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Task 5 — submit-checklist interlock gate (HTTP route)', () => {
    let app5: FastifyInstance;
    let authHeaders5: Record<string, string>;

    beforeAll(async () => {
      // Set mode to INTERLOCK (Task 4 afterAll already reset it to NONE).
      await prisma.systemConfig.upsert({
        where: { configKey: 'ahu-completion-process' },
        update: { configValue: { mode: 'INTERLOCK' } as any },
        create: {
          configKey: 'ahu-completion-process',
          configValue: { mode: 'INTERLOCK' } as any,
          configType: 'filter-management',
        },
      });

      // Build a minimal Fastify app mirroring app4 (same error handler is
      // required — without it AppError.code is swallowed by the default handler
      // and res.json().error becomes 'Unprocessable Entity', not 'AHU_INTERLOCK_PENDING').
      app5 = Fastify({ logger: false, ajv: { customOptions: { keywords: ['example'] } } });
      await app5.register(cors, { origin: true, credentials: true });
      await app5.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
      await app5.register(authPlugin);
      await app5.register(rbacPlugin);
      app5.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
        if (err instanceof AppError) {
          return reply.code(err.statusCode).send({
            error: err.code,
            message: err.message,
            ...(err.details ? { details: err.details } : {}),
          });
        }
        if ((err as any).code === 'FST_ERR_VALIDATION' || (err as any).validation) {
          return reply.code(400).send({
            error: 'VALIDATION_ERROR',
            message: err.message,
            ...((err as any).validation ? { details: (err as any).validation } : {}),
          });
        }
        const status = err.statusCode ?? 500;
        return reply.code(status).send({ error: err.message || 'Internal Server Error' });
      });
      await app5.register(authRoutes, { prefix: '/api/auth' });
      await app5.register(filterOperationsRoutes, { prefix: '/api/filters' });
      await app5.ready();

      const token = await loginAs(app5, AHU_GATE_USERNAME, AHU_GATE_PASSWORD);
      authHeaders5 = { authorization: `Bearer ${token}` };
    }, 30_000);

    afterAll(async () => {
      // Reset mode unconditionally — runs even if tests were skipped or failed.
      try {
        await prisma.systemConfig.updateMany({
          where: { configKey: 'ahu-completion-process' },
          data: { configValue: { mode: 'NONE' } as any },
        });
      } catch { /* swallow */ }
      // Remove FilterEvents written by these tests so the outer afterAll's
      // cleaningCycle.deleteMany / assetInstance.deleteMany can succeed without
      // FK violations (FilterEvent.cycleId and FilterEvent.filterId are FK cols).
      try {
        await prisma.filterEvent.deleteMany({
          where: { filterId: { in: [filterAId, filterBId].filter(Boolean) } },
        });
      } catch { /* swallow */ }
      try { await app5.close(); } catch { /* swallow */ }
    }, 10_000);

    it('submit-checklist at final stage is blocked (422) when a sibling is not at final', async () => {
      // Fixture state: A at S2, B at S1, mode=INTERLOCK.
      // The gate fires before any transaction → no DB write on 422.
      const stateRes = await app5.inject({
        method: 'GET',
        url: `/api/filters/${filterAId}/current-state`,
        headers: authHeaders5,
      });
      expect(stateRes.statusCode).toBe(200);
      const { tapeVersion } = stateRes.json();

      const res = await app5.inject({
        method: 'POST',
        url: `/api/filters/${filterAId}/submit-checklist`,
        headers: authHeaders5,
        payload: { answers: {}, tapeVersion, _currentPassword: AHU_GATE_PASSWORD },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toContain('AHU_INTERLOCK_PENDING');
    });

    it('submit-checklist completes the cycle when all siblings are at final', async () => {
      // Move B to its final stage (S2) via direct DB update so the gate sees
      // all siblings at final and allows A's completion.
      await prisma.filterDetails.update({
        where: { assetInstanceId: filterBId },
        data: { currentLifecycleState: 'S2' },
      });

      // Re-fetch tapeVersion: test 1 threw 422 (no write occurred), so
      // cycle events are unchanged — but re-fetching is more robust.
      const stateRes = await app5.inject({
        method: 'GET',
        url: `/api/filters/${filterAId}/current-state`,
        headers: authHeaders5,
      });
      expect(stateRes.statusCode).toBe(200);
      const { tapeVersion } = stateRes.json();

      const res = await app5.inject({
        method: 'POST',
        url: `/api/filters/${filterAId}/submit-checklist`,
        headers: authHeaders5,
        payload: { answers: {}, tapeVersion, _currentPassword: AHU_GATE_PASSWORD },
      });
      expect(res.statusCode).toBe(200);

      // Confirm the cycle was completed in the DB.
      const cycle = await prisma.cleaningCycle.findUnique({ where: { id: cycleAId } });
      expect(cycle?.status).toBe('COMPLETED');
    });

    it('submit-checklist completes normally when mode is NONE (gate short-circuits)', async () => {
      // After test 2: Filter A is COMPLETED (no active cycle).
      // Filter B is at S2 with cycleBId still IN_PROGRESS — use it for this test.
      // Mode → NONE: gate short-circuits immediately; cycle completes normally.
      await prisma.systemConfig.updateMany({
        where: { configKey: 'ahu-completion-process' },
        data: { configValue: { mode: 'NONE' } as any },
      });

      const stateRes = await app5.inject({
        method: 'GET',
        url: `/api/filters/${filterBId}/current-state`,
        headers: authHeaders5,
      });
      expect(stateRes.statusCode).toBe(200);
      const { tapeVersion } = stateRes.json();

      const res = await app5.inject({
        method: 'POST',
        url: `/api/filters/${filterBId}/submit-checklist`,
        headers: authHeaders5,
        payload: { answers: {}, tapeVersion, _currentPassword: AHU_GATE_PASSWORD },
      });
      expect(res.statusCode).toBe(200);

      // Confirm cycle B also completed.
      const cycleB = await prisma.cleaningCycle.findUnique({ where: { id: cycleBId } });
      expect(cycleB?.status).toBe('COMPLETED');
    });
  });

  // ── Task 9 (2026-07-02 regression): count filters that resolve their profile
  //    via config-rule / default fallback — i.e. FilterDetails.filterProfileId
  //    is NULL. This is the PRODUCTION norm (0/274 filters carry a direct
  //    binding; resolveFilterProfile falls back to the block/area rule or the
  //    default active profile). The original loadCountedFilters predicate
  //    `filterDetails.filterProfileId != null` excluded EVERY such filter, so
  //    computeAhuCompletionStatus returned zero siblings and INTERLOCK/POPUP
  //    were silent no-ops system-wide. The Task 3 fixtures set filterProfileId,
  //    which is exactly why they never caught this. Fixtures here leave it NULL.
  describe('AHU interlock — counts filters with NO filterProfileId binding (regression)', () => {
    let ahu2 = '';
    let finalFilter = '';   // reached final via CLEANING_CYCLE_COMPLETED (no cycle)
    let idleFilter = '';    // never started → must be counted + block
    let ahuTpl2 = '';
    let filterTpl2 = '';

    beforeAll(async () => {
      const ahuT = await prisma.assetTemplate.create({ data: { name: `AHU Tpl T9 ${SUFFIX}`, templateKind: 'AHU' } });
      ahuTpl2 = ahuT.id;
      const filterT = await prisma.assetTemplate.create({ data: { name: `Filter Tpl T9 ${SUFFIX}`, templateKind: 'FILTER' } });
      filterTpl2 = filterT.id;

      const ahu = await prisma.assetInstance.create({ data: { name: `AHU T9 ${SUFFIX}`, templateId: ahuTpl2 } });
      ahu2 = ahu.id;

      const fFinal = await prisma.assetInstance.create({ data: { name: `Filter Final T9 ${SUFFIX}`, templateId: filterTpl2, parentId: ahu2 } });
      finalFilter = fFinal.id;
      const fIdle = await prisma.assetInstance.create({ data: { name: `Filter Idle T9 ${SUFFIX}`, templateId: filterTpl2, parentId: ahu2 } });
      idleFilter = fIdle.id;

      // The crux: NO direct binding — both clean via config/default resolution.
      await prisma.filterDetails.create({ data: { assetInstanceId: finalFilter, filterProfileId: null, currentCycleId: null, currentLifecycleState: 'CLEANING_CYCLE_COMPLETED' } });
      await prisma.filterDetails.create({ data: { assetInstanceId: idleFilter, filterProfileId: null, currentCycleId: null, currentLifecycleState: null } });
    }, 30_000);

    afterAll(async () => {
      try {
        await prisma.filterDetails.deleteMany({ where: { assetInstanceId: { in: [finalFilter, idleFilter].filter(Boolean) } } });
        for (const id of [finalFilter, idleFilter, ahu2].filter(Boolean)) {
          await prisma.assetInstance.delete({ where: { id } }).catch(() => undefined);
        }
        for (const id of [filterTpl2, ahuTpl2].filter(Boolean)) {
          await prisma.assetTemplate.delete({ where: { id } }).catch(() => undefined);
        }
      } catch { /* swallow cleanup errors */ }
    });

    it('counts a never-started sibling (filterProfileId=null) as pending — pre-fix it was excluded → allAtFinal=true', async () => {
      // Exclude the completed filter; the idle sibling with no binding must
      // still be counted and reported pending. Pre-fix this returned
      // { allAtFinal: true, pending: [] } because loadCountedFilters found none.
      const { allAtFinal, pending } = await computeAhuCompletionStatus(ahu2, finalFilter);
      expect(allAtFinal).toBe(false);
      expect(pending.map(p => p.id)).toContain(idleFilter);
    });

    it('returns ahuName + the full filter roster with correct done flags (2026-07-02 dialog data)', async () => {
      const res = await computeAhuCompletionStatus(ahu2, finalFilter);
      expect(res.ahuName).toBe(`AHU T9 ${SUFFIX}`);
      // filters includes BOTH (roster is not excluded).
      const byId = new Map(res.filters.map(f => [f.id, f]));
      expect(byId.get(finalFilter)?.done).toBe(true);   // CLEANING_CYCLE_COMPLETED
      expect(byId.get(idleFilter)?.done).toBe(false);   // never started
      expect(byId.get(idleFilter)?.stage).toBe('Not started');
    });
  });

  // ── Task 10 (2026-07-02): multi-AHU batch status (carousel data) ────────────
  describe('computeAhuBatchStatus — one block per distinct AHU, pending first', () => {
    let ahuTpl10 = '';
    let filterTpl10 = '';
    let ahuPending = '';   // has an idle filter → allAtFinal=false
    let ahuReady = '';     // all filters done → allAtFinal=true
    let fP = '';           // done filter in ahuPending
    let fPidle = '';       // idle filter in ahuPending
    let fR = '';           // done filter in ahuReady

    beforeAll(async () => {
      ahuTpl10 = (await prisma.assetTemplate.create({ data: { name: `AHU Tpl T10 ${SUFFIX}`, templateKind: 'AHU' } })).id;
      filterTpl10 = (await prisma.assetTemplate.create({ data: { name: `Filter Tpl T10 ${SUFFIX}`, templateKind: 'FILTER' } })).id;

      ahuPending = (await prisma.assetInstance.create({ data: { name: `AHU Pending T10 ${SUFFIX}`, templateId: ahuTpl10 } })).id;
      ahuReady = (await prisma.assetInstance.create({ data: { name: `AHU Ready T10 ${SUFFIX}`, templateId: ahuTpl10 } })).id;

      fP = (await prisma.assetInstance.create({ data: { name: `FP T10 ${SUFFIX}`, templateId: filterTpl10, parentId: ahuPending } })).id;
      fPidle = (await prisma.assetInstance.create({ data: { name: `FPidle T10 ${SUFFIX}`, templateId: filterTpl10, parentId: ahuPending } })).id;
      fR = (await prisma.assetInstance.create({ data: { name: `FR T10 ${SUFFIX}`, templateId: filterTpl10, parentId: ahuReady } })).id;

      await prisma.filterDetails.create({ data: { assetInstanceId: fP, filterProfileId: null, currentCycleId: null, currentLifecycleState: 'CLEANING_CYCLE_COMPLETED' } });
      await prisma.filterDetails.create({ data: { assetInstanceId: fPidle, filterProfileId: null, currentCycleId: null, currentLifecycleState: null } });
      await prisma.filterDetails.create({ data: { assetInstanceId: fR, filterProfileId: null, currentCycleId: null, currentLifecycleState: 'CLEANING_CYCLE_COMPLETED' } });
    }, 30_000);

    afterAll(async () => {
      try {
        await prisma.filterDetails.deleteMany({ where: { assetInstanceId: { in: [fP, fPidle, fR].filter(Boolean) } } });
        for (const id of [fP, fPidle, fR, ahuPending, ahuReady].filter(Boolean)) {
          await prisma.assetInstance.delete({ where: { id } }).catch(() => undefined);
        }
        for (const id of [filterTpl10, ahuTpl10].filter(Boolean)) {
          await prisma.assetTemplate.delete({ where: { id } }).catch(() => undefined);
        }
      } catch { /* swallow */ }
    });

    it('returns a block per AHU with correct allAtFinal, pending AHU first', async () => {
      const { ahus } = await computeAhuBatchStatus([fP, fR]);
      expect(ahus).toHaveLength(2);
      // Pending AHU sorts first.
      expect(ahus[0].ahuId).toBe(ahuPending);
      expect(ahus[0].allAtFinal).toBe(false);
      expect(ahus[1].ahuId).toBe(ahuReady);
      expect(ahus[1].allAtFinal).toBe(true);
      // The pending AHU's roster includes the idle filter as not-done.
      expect(ahus[0].filters.find(f => f.id === fPidle)?.done).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-07-03 — Filter-set scoping (SET_A / SET_B / ALL)
//
// Operator picks a set live before the AHU-completion popup. The gate must
// scope the sibling roster to the chosen set + UNCLASSIFIED filters, excluding
// only the OPPOSITE named set. Unclassified (null filterSet) ALWAYS counts.
//
// Fixture (lightweight no-cycle pattern — done = CLEANING_CYCLE_COMPLETED,
// not-done = idle/null; avoids cleaning-profile/cycle setup):
//   SA1 — SET_A, done
//   SB1 — SET_B, done
//   SBX — SET_B, NOT done   (the only Set-B blocker)
//   U1  — unclassified (null), done
//
// The discriminating case: the SAME roster returns allAtFinal=false under ALL
// (SBX blocks) but allAtFinal=true under SET_A (SBX excluded) — proving the
// choice actually scopes the gate.
// ─────────────────────────────────────────────────────────────────────────────
describe('AHU Completion Status — filter-set scoping', () => {
  let ahuTplFS = '';
  let filterTplFS = '';
  let ahuFS = '';
  let sa1 = '';
  let sb1 = '';
  let sbx = '';
  let u1 = '';
  // Second AHU — proves the "no FilterDetails row" (never-started) branch of
  // filterSetWhere still counts + blocks under a set choice (D4 idle-blocks).
  let ahuND = '';
  let ndDone = '';
  let ndIdle = '';   // NO filterDetails row created — the discriminating case.
  // App for the route-schema passthrough test (Fastify strips unlisted body
  // fields — an untested schema is how `set` could silently drop to ALL).
  let appFS: FastifyInstance;
  let headersFS: Record<string, string> = {};

  beforeAll(async () => {
    ahuTplFS = (await prisma.assetTemplate.create({ data: { name: `AHU Tpl FS ${SUFFIX}`, templateKind: 'AHU' } })).id;
    filterTplFS = (await prisma.assetTemplate.create({ data: { name: `Filter Tpl FS ${SUFFIX}`, templateKind: 'FILTER' } })).id;
    ahuFS = (await prisma.assetInstance.create({ data: { name: `AHU FS ${SUFFIX}`, templateId: ahuTplFS } })).id;

    sa1 = (await prisma.assetInstance.create({ data: { name: `SA1 FS ${SUFFIX}`, templateId: filterTplFS, parentId: ahuFS } })).id;
    sb1 = (await prisma.assetInstance.create({ data: { name: `SB1 FS ${SUFFIX}`, templateId: filterTplFS, parentId: ahuFS } })).id;
    sbx = (await prisma.assetInstance.create({ data: { name: `SBX FS ${SUFFIX}`, templateId: filterTplFS, parentId: ahuFS } })).id;
    u1 = (await prisma.assetInstance.create({ data: { name: `U1 FS ${SUFFIX}`, templateId: filterTplFS, parentId: ahuFS } })).id;

    await prisma.filterDetails.create({ data: { assetInstanceId: sa1, currentCycleId: null, currentLifecycleState: 'CLEANING_CYCLE_COMPLETED', filterSet: 'SET_A' } });
    await prisma.filterDetails.create({ data: { assetInstanceId: sb1, currentCycleId: null, currentLifecycleState: 'CLEANING_CYCLE_COMPLETED', filterSet: 'SET_B' } });
    await prisma.filterDetails.create({ data: { assetInstanceId: sbx, currentCycleId: null, currentLifecycleState: null, filterSet: 'SET_B' } });
    await prisma.filterDetails.create({ data: { assetInstanceId: u1, currentCycleId: null, currentLifecycleState: 'CLEANING_CYCLE_COMPLETED', filterSet: null } });

    // ── No-details AHU: one done (Set A) + one never-started (NO details row) ──
    ahuND = (await prisma.assetInstance.create({ data: { name: `AHU ND FS ${SUFFIX}`, templateId: ahuTplFS } })).id;
    ndDone = (await prisma.assetInstance.create({ data: { name: `ND Done FS ${SUFFIX}`, templateId: filterTplFS, parentId: ahuND } })).id;
    ndIdle = (await prisma.assetInstance.create({ data: { name: `ND Idle FS ${SUFFIX}`, templateId: filterTplFS, parentId: ahuND } })).id;
    await prisma.filterDetails.create({ data: { assetInstanceId: ndDone, currentCycleId: null, currentLifecycleState: 'CLEANING_CYCLE_COMPLETED', filterSet: 'SET_A' } });
    // ndIdle: intentionally NO filterDetails.create — exercises `{ filterDetails: { is: null } }`.

    // ── App mounting the real filter-operations routes (schema passthrough) ────
    appFS = Fastify({ logger: false, ajv: { customOptions: { keywords: ['example'] } } });
    await appFS.register(cors, { origin: true, credentials: true });
    await appFS.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    await appFS.register(authPlugin);
    await appFS.register(rbacPlugin);
    appFS.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      const status = err.statusCode ?? 500;
      return reply.code(status).send({ error: err.message || 'Internal Server Error' });
    });
    await appFS.register(authRoutes, { prefix: '/api/auth' });
    await appFS.register(filterOperationsRoutes, { prefix: '/api/filters' });
    await appFS.ready();
    const token = await loginAs(appFS, AHU_GATE_USERNAME, AHU_GATE_PASSWORD);
    headersFS = { authorization: `Bearer ${token}` };
  }, 30_000);

  afterAll(async () => {
    try {
      await prisma.filterDetails.deleteMany({ where: { assetInstanceId: { in: [sa1, sb1, sbx, u1, ndDone].filter(Boolean) } } });
      for (const id of [sa1, sb1, sbx, u1, ndDone, ndIdle, ahuFS, ahuND].filter(Boolean)) {
        await prisma.assetInstance.delete({ where: { id } }).catch(() => undefined);
      }
      for (const id of [filterTplFS, ahuTplFS].filter(Boolean)) {
        await prisma.assetTemplate.delete({ where: { id } }).catch(() => undefined);
      }
    } catch { /* swallow */ }
    try { await appFS.close(); } catch { /* swallow */ }
  }, 30_000);

  it('ALL (default) counts every filter — SBX blocks', async () => {
    const status = await computeAhuCompletionStatus(ahuFS, '', 'ALL');
    expect(status.allAtFinal).toBe(false);
    expect(status.pending.map(p => p.id)).toContain(sbx);
    // Full roster present.
    expect(status.filters.map(f => f.id).sort()).toEqual([sa1, sb1, sbx, u1].sort());
  });

  it('omitting set === ALL (legacy callers unaffected)', async () => {
    const withAll = await computeAhuCompletionStatus(ahuFS, '', 'ALL');
    const omitted = await computeAhuCompletionStatus(ahuFS, '');
    expect(omitted.filters.map(f => f.id).sort()).toEqual(withAll.filters.map(f => f.id).sort());
    expect(omitted.allAtFinal).toBe(withAll.allAtFinal);
  });

  it('SET_A excludes Set B, includes unclassified → unblocks (discriminator)', async () => {
    const status = await computeAhuCompletionStatus(ahuFS, '', 'SET_A');
    // Same data as the ALL case, but SBX (Set B) is out of scope → all done.
    expect(status.allAtFinal).toBe(true);
    expect(status.pending).toEqual([]);
    const ids = status.filters.map(f => f.id);
    expect(ids).toContain(sa1);
    expect(ids).toContain(u1);      // unclassified always counts
    expect(ids).not.toContain(sb1); // opposite set excluded
    expect(ids).not.toContain(sbx);
  });

  it('SET_B excludes Set A, includes unclassified → SBX still blocks', async () => {
    const status = await computeAhuCompletionStatus(ahuFS, '', 'SET_B');
    expect(status.allAtFinal).toBe(false);
    expect(status.pending.map(p => p.id)).toEqual([sbx]);
    const ids = status.filters.map(f => f.id);
    expect(ids).toContain(sb1);
    expect(ids).toContain(sbx);
    expect(ids).toContain(u1);      // unclassified always counts
    expect(ids).not.toContain(sa1); // opposite set excluded
  });

  it('batch status honors the set choice', async () => {
    // Pass one filter from the AHU; batch resolves the AHU and scopes to SET_A.
    const { ahus } = await computeAhuBatchStatus([sa1], 'SET_A');
    expect(ahus).toHaveLength(1);
    expect(ahus[0].ahuId).toBe(ahuFS);
    expect(ahus[0].allAtFinal).toBe(true); // SBX excluded under SET_A
    expect(ahus[0].filters.map(f => f.id)).not.toContain(sbx);
  });

  it('a never-started filter (NO FilterDetails row) still counts + blocks under SET_A', async () => {
    // ndIdle has no filterDetails row → unclassified. Under SET_A it must remain
    // in scope and block (D4 idle-blocks). If Prisma `is: null` misbehaved, it
    // would silently drop — the same silent-no-op class as the original bug.
    const status = await computeAhuCompletionStatus(ahuND, '', 'SET_A');
    expect(status.allAtFinal).toBe(false);
    expect(status.pending.map(p => p.id)).toContain(ndIdle);
    expect(status.filters.map(f => f.id)).toContain(ndIdle);
  });

  it('set availability: an AHU with both Set A and Set B → hasBothSets true', async () => {
    // ahuFS has sa1 (SET_A) + sb1/sbx (SET_B) → the chooser is meaningful.
    const { hasBothSets } = await computeAhuSetAvailability([sa1]);
    expect(hasBothSets).toBe(true);
  });

  it('set availability: an AHU with a single set (+ unclassified) → hasBothSets false', async () => {
    // ahuND has only ndDone (SET_A) + ndIdle (unclassified, no row) → no A/B
    // split → the chooser would be meaningless, so the client proceeds as ALL.
    const { hasBothSets } = await computeAhuSetAvailability([ndDone]);
    expect(hasBothSets).toBe(false);
  });

  it('batch ENDPOINT passes the set param through the route schema (not stripped)', async () => {
    // Without set → ALL → SBX blocks → allAtFinal false.
    const resAll = await appFS.inject({
      method: 'POST',
      url: '/api/filters/ahu-completion-status/batch',
      headers: headersFS,
      payload: { filterIds: [sa1] },
    });
    expect(resAll.statusCode).toBe(200);
    const allAhu = resAll.json().ahus.find((a: any) => a.ahuId === ahuFS);
    expect(allAhu.allAtFinal).toBe(false);

    // With set=SET_A → SBX out of scope → allAtFinal true. Proves the schema
    // carries `set` to computeAhuBatchStatus rather than dropping it.
    const resA = await appFS.inject({
      method: 'POST',
      url: '/api/filters/ahu-completion-status/batch',
      headers: headersFS,
      payload: { filterIds: [sa1], set: 'SET_A' },
    });
    expect(resA.statusCode).toBe(200);
    const setAAhu = resA.json().ahus.find((a: any) => a.ahuId === ahuFS);
    expect(setAAhu.allAtFinal).toBe(true);
    expect(setAAhu.filters.map((f: any) => f.id)).not.toContain(sbx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-07-03 — Full 3-mode gate with 10 filters (CWH-block scenario).
//
// Exercises NONE / POPUP / INTERLOCK against ONE AHU carrying 10 filters — the
// user-requested "10 filters, cwh block, 3 methods" scenario. Done the
// audit-safe way (test DB, gate code driven directly): driving 10 real cleaning
// cycles ×3 modes would write hundreds of permanent, hash-chained rows into the
// live 21 CFR audit_trail. Lightweight state pattern: done = the terminal cycle
// finished (CLEANING_CYCLE_COMPLETED); idle = never started (blocks under
// INTERLOCK per design D4).
// ─────────────────────────────────────────────────────────────────────────────
describe('AHU completion — NONE / POPUP / INTERLOCK with 10 filters (CWH)', () => {
  let ahuTpl10m = '';
  let filterTpl10m = '';
  let ahu10 = '';
  const fids: string[] = [];

  const setMode = (mode: 'NONE' | 'POPUP' | 'INTERLOCK') =>
    prisma.systemConfig.upsert({
      where: { configKey: 'ahu-completion-process' },
      update: { configValue: { mode } as any },
      create: { configKey: 'ahu-completion-process', configValue: { mode } as any, configType: 'filter-management' },
    });
  const setDone = (id: string) =>
    prisma.filterDetails.update({ where: { assetInstanceId: id }, data: { currentCycleId: null, currentLifecycleState: 'CLEANING_CYCLE_COMPLETED' } });
  const setIdle = (id: string) =>
    prisma.filterDetails.update({ where: { assetInstanceId: id }, data: { currentCycleId: null, currentLifecycleState: null } });

  beforeAll(async () => {
    ahuTpl10m = (await prisma.assetTemplate.create({ data: { name: `AHU Tpl 3M ${SUFFIX}`, templateKind: 'AHU' } })).id;
    filterTpl10m = (await prisma.assetTemplate.create({ data: { name: `Filter Tpl 3M ${SUFFIX}`, templateKind: 'FILTER' } })).id;
    // Name mirrors the CWH-block filter naming convention (CWH/F1/AHU-.../...).
    ahu10 = (await prisma.assetInstance.create({ data: { name: `CWH/F1/AHU-10 ${SUFFIX}`, templateId: ahuTpl10m } })).id;
    for (let i = 0; i < 10; i++) {
      const f = await prisma.assetInstance.create({
        data: { name: `CWH/F1/AHU-10/F${i} ${SUFFIX}`, templateId: filterTpl10m, parentId: ahu10 },
      });
      fids.push(f.id);
      await prisma.filterDetails.create({ data: { assetInstanceId: f.id, currentCycleId: null, currentLifecycleState: 'CLEANING_CYCLE_COMPLETED' } });
    }
  }, 30_000);

  afterAll(async () => {
    try {
      await setMode('NONE');
      await prisma.filterDetails.deleteMany({ where: { assetInstanceId: { in: fids } } });
      for (const id of [...fids, ahu10].filter(Boolean)) await prisma.assetInstance.delete({ where: { id } }).catch(() => undefined);
      for (const id of [filterTpl10m, ahuTpl10m].filter(Boolean)) await prisma.assetTemplate.delete({ where: { id } }).catch(() => undefined);
    } catch { /* swallow */ }
  }, 30_000);

  it('all 10 filters resolve to the same AHU and are counted', async () => {
    const status = await computeAhuCompletionStatus(ahu10, '');
    expect(status.filters).toHaveLength(10);
  });

  it('NONE: never blocks submission, even with an idle sibling (no server gate)', async () => {
    await setMode('NONE');
    await setIdle(fids[9]);
    await expect(assertAhuInterlockSatisfied({ filterId: fids[0], isOfflineReplay: false })).resolves.toBeUndefined();
    await setDone(fids[9]);
  });

  it('POPUP: server does NOT gate (client-only warning), but completion-status flags the idle filter', async () => {
    await setMode('POPUP');
    await setIdle(fids[9]);
    // POPUP has no server enforcement — the gate is a no-op...
    await expect(assertAhuInterlockSatisfied({ filterId: fids[0], isOfflineReplay: false })).resolves.toBeUndefined();
    // ...but the status the client reads to render the warning DOES flag it.
    const status = await computeAhuCompletionStatus(ahu10, fids[0]);
    expect(status.allAtFinal).toBe(false);
    expect(status.pending.map(p => p.id)).toContain(fids[9]);
    expect(status.filters).toHaveLength(10);
    await setDone(fids[9]);
  });

  it('INTERLOCK: blocks with 422 when any 1 of the 10 is not at final', async () => {
    await setMode('INTERLOCK');
    await setIdle(fids[9]);
    await expect(assertAhuInterlockSatisfied({ filterId: fids[0], isOfflineReplay: false }))
      .rejects.toMatchObject({ statusCode: 422, code: 'AHU_INTERLOCK_PENDING' });
    await setDone(fids[9]);
  });

  it('INTERLOCK: passes once all 10 filters have reached final', async () => {
    await setMode('INTERLOCK');
    // fids[9] restored to done above → all 10 completed.
    await expect(assertAhuInterlockSatisfied({ filterId: fids[0], isOfflineReplay: false })).resolves.toBeUndefined();
  });

  it('INTERLOCK: 422 details carry the AHU name + full 10-filter roster + the pending one', async () => {
    await setMode('INTERLOCK');
    await setIdle(fids[9]);
    try {
      await assertAhuInterlockSatisfied({ filterId: fids[0], isOfflineReplay: false });
      throw new Error('expected AHU_INTERLOCK_PENDING to throw');
    } catch (e: any) {
      expect(e.code).toBe('AHU_INTERLOCK_PENDING');
      expect(e.details.filters).toHaveLength(10);
      expect(e.details.pendingFilters.map((p: any) => p.id)).toContain(fids[9]);
      expect(e.details.ahuName).toContain('AHU-10');
    }
    await setDone(fids[9]);
  });

  it('INTERLOCK: offline replay is never blocked (best-effort, D2)', async () => {
    await setMode('INTERLOCK');
    await setIdle(fids[9]);
    await expect(assertAhuInterlockSatisfied({ filterId: fids[0], isOfflineReplay: true })).resolves.toBeUndefined();
    await setDone(fids[9]);
  });
});
