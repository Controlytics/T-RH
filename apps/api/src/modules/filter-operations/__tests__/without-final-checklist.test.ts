/**
 * Task 8 — TDD test for GET /api/filters/cleaning-profiles/without-final-checklist
 *
 * Seeds four cleaning profiles and two ChecklistProfile records:
 *   Profile 1: S1 → S2 → END
 *             (no terminal checklist → unenforceable; MUST be returned)
 *   Profile 2: S1 → S2 → CHECKLIST(active-cp) → END
 *             (CHECKLIST has checklistProfileId pointing to an isActive:true profile
 *              → genuinely enforceable; must NOT be returned)
 *   Profile 3: S1 branches to S2→END and S3→CHECKLIST(active-cp)→END
 *             (diamond — S2 path has no gating checklist → unenforceable even
 *              though S3 path is properly guarded; MUST be returned)
 *   Profile 4: S1 → S2 → CHECKLIST(inactive-cp) → END
 *             (CHECKLIST references a ChecklistProfile with isActive:false →
 *              advance.ts auto-completes the cycle without submit-checklist;
 *              the warning MUST flag this as unenforceable; MUST be returned)
 *             This is the T8-c regression case.
 *
 * Assertions use membership (toContain / not.toContain), not exact array
 * length, to survive other test files' fixtures in the shared test DB.
 *
 * Isolation note: unique SUPER_ADMIN per file.  Teardown deletes all four
 * profiles and the two seeded ChecklistProfile records; cascade removes stages
 * + connections automatically.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import authPlugin from '../../../plugins/auth.js';
import rbacPlugin from '../../../plugins/rbac.js';
import authRoutes from '../../auth/routes.js';
import filterOperationsRoutes from '../routes.js';
import { prisma } from '../../../lib/prisma.js';
import { hashPassword } from '../../../lib/password.js';
import { AppError } from '../../../lib/errors.js';
import { loginAs } from '../../../e2e/test-helper.js';
import { randomUUID } from 'node:crypto';

// ── Unique test user (derived from file name + timestamp) ─────────────────────
const SUFFIX = Date.now().toString(36).slice(-4).toUpperCase();
const WFC_USERNAME = `WFCT${SUFFIX}`.slice(0, 16).toUpperCase();
const WFC_PASSWORD = 'WfcTest@Digilog#8';

// ── Minimal Fastify app builder ───────────────────────────────────────────────
async function buildApp(): Promise<FastifyInstance> {
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

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(filterOperationsRoutes, { prefix: '/api/filters' });
  await app.ready();
  return app;
}

describe('GET /api/filters/cleaning-profiles/without-final-checklist', () => {
  let app: FastifyInstance;
  let authHeaders: Record<string, string>;

  // ChecklistProfile records seeded by this file
  let activeChecklistProfileId: string;   // isActive:true  — used by Profile 2 + Profile 3 (diamond S3 branch)
  let inactiveChecklistProfileId: string; // isActive:false — used by Profile 4 (T8-c regression case)

  // FilterCleaningProfile IDs seeded by this file
  let profile1Id: string; // S1 → S2 → END                              (unenforceable — should be returned)
  let profile2Id: string; // S1 → S2 → CHECKLIST(active) → END          (enforceable  — should NOT be returned)
  let profile3Id: string; // diamond: S1 → {S2→END, S3→CHECKLIST(active)→END} (unenforceable — should be returned)
  let profile4Id: string; // S1 → S2 → CHECKLIST(inactive) → END        (unenforceable — should be returned; T8-c)

  beforeAll(async () => {
    // ── Provision unique SUPER_ADMIN ──────────────────────────────────────────
    const passwordHash = await hashPassword(WFC_PASSWORD);
    await prisma.user.upsert({
      where: { username: WFC_USERNAME },
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
        username: WFC_USERNAME,
        fullName: 'Without Final Checklist Test',
        email: `${WFC_USERNAME.toLowerCase()}@wfc-test.local`,
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        createdBy: 'wfc-test',
      },
    });

    // ── Seed ChecklistProfile records ─────────────────────────────────────────
    // Must be created BEFORE the cleaning profiles that reference them.

    const activeCP = await prisma.checklistProfile.create({
      data: { name: `T8 ActiveCP ${SUFFIX}`, isActive: true },
    });
    activeChecklistProfileId = activeCP.id;

    // T8-c: an inactive checklist profile — advance.ts will not defer completion
    // for a CHECKLIST node whose referenced profile has isActive:false.
    const inactiveCP = await prisma.checklistProfile.create({
      data: { name: `T8 InactiveCP ${SUFFIX}`, isActive: false },
    });
    inactiveChecklistProfileId = inactiveCP.id;

    // ── Seed Profile 1: S1 → S2 → END (no terminal checklist) ─────────────────
    const cp1 = await prisma.filterCleaningProfile.create({
      data: {
        name: `T8 NoChecklist ${SUFFIX}`,
        lineageId: randomUUID(),
        status: 'ACTIVE',
        createdBy: '00000000-0000-0000-0000-000000000001',
        stages: {
          create: [
            { nodeType: 'STAGE', stateKey: 'S1', sortOrder: 1 },
            { nodeType: 'STAGE', stateKey: 'S2', sortOrder: 2 },
            { nodeType: 'END', stateKey: null, sortOrder: 3 },
          ],
        },
      },
      include: { stages: true },
    });
    profile1Id = cp1.id;

    const p1s1 = cp1.stages.find(s => s.stateKey === 'S1')!;
    const p1s2 = cp1.stages.find(s => s.stateKey === 'S2')!;
    const p1end = cp1.stages.find(s => s.nodeType === 'END')!;
    await prisma.filterPipelineConnection.createMany({
      data: [
        { profileId: profile1Id, fromStageId: p1s1.id, toStageId: p1s2.id },
        { profileId: profile1Id, fromStageId: p1s2.id, toStageId: p1end.id },
      ],
    });

    // ── Seed Profile 2: S1 → S2 → CHECKLIST(active) → END ─────────────────────
    // The CHECKLIST node has configuration.checklistProfileId pointing to an
    // isActive:true ChecklistProfile, so advance.ts WOULD defer completion →
    // this profile IS enforceable and must NOT appear in the warning list.
    const cp2 = await prisma.filterCleaningProfile.create({
      data: {
        name: `T8 WithChecklist ${SUFFIX}`,
        lineageId: randomUUID(),
        status: 'ACTIVE',
        createdBy: '00000000-0000-0000-0000-000000000001',
        stages: {
          create: [
            { nodeType: 'STAGE', stateKey: 'S1', sortOrder: 1 },
            { nodeType: 'STAGE', stateKey: 'S2', sortOrder: 2 },
            {
              nodeType: 'CHECKLIST',
              stateKey: null,
              sortOrder: 3,
              configuration: { checklistProfileId: activeChecklistProfileId },
            },
            { nodeType: 'END', stateKey: null, sortOrder: 4 },
          ],
        },
      },
      include: { stages: true },
    });
    profile2Id = cp2.id;

    const p2s1 = cp2.stages.find(s => s.stateKey === 'S1')!;
    const p2s2 = cp2.stages.find(s => s.stateKey === 'S2')!;
    const p2cl = cp2.stages.find(s => s.nodeType === 'CHECKLIST')!;
    const p2end = cp2.stages.find(s => s.nodeType === 'END')!;
    await prisma.filterPipelineConnection.createMany({
      data: [
        { profileId: profile2Id, fromStageId: p2s1.id, toStageId: p2s2.id },
        { profileId: profile2Id, fromStageId: p2s2.id, toStageId: p2cl.id },
        { profileId: profile2Id, fromStageId: p2cl.id, toStageId: p2end.id },
      ],
    });

    // ── Seed Profile 3: diamond — S1 → {S2→END, S3→CHECKLIST(active)→END} ────
    // S3's CHECKLIST references an isActive:true profile → S3 path is genuinely
    // enforceable.  But S2→END has no gating checklist → profile is still
    // unenforceable overall (the unguarded branch silently completes the cycle).
    // This fixture guards the regression where the loop breaks early on the first
    // ENFORCEABLE final stage and incorrectly excludes the profile.
    const cp3 = await prisma.filterCleaningProfile.create({
      data: {
        name: `T8 Diamond ${SUFFIX}`,
        lineageId: randomUUID(),
        status: 'ACTIVE',
        createdBy: '00000000-0000-0000-0000-000000000001',
        stages: {
          create: [
            { nodeType: 'STAGE', stateKey: 'S1', sortOrder: 1 },
            { nodeType: 'STAGE', stateKey: 'S2', sortOrder: 2 },  // final, no gating checklist
            { nodeType: 'STAGE', stateKey: 'S3', sortOrder: 3 },  // final, has active-gating checklist
            {
              nodeType: 'CHECKLIST',
              stateKey: null,
              sortOrder: 4,
              configuration: { checklistProfileId: activeChecklistProfileId },
            },
            { nodeType: 'END', stateKey: null, sortOrder: 5 },
          ],
        },
      },
      include: { stages: true },
    });
    profile3Id = cp3.id;

    const p3s1 = cp3.stages.find(s => s.stateKey === 'S1')!;
    const p3s2 = cp3.stages.find(s => s.stateKey === 'S2')!;
    const p3s3 = cp3.stages.find(s => s.stateKey === 'S3')!;
    const p3cl = cp3.stages.find(s => s.nodeType === 'CHECKLIST')!;
    const p3end = cp3.stages.find(s => s.nodeType === 'END')!;
    await prisma.filterPipelineConnection.createMany({
      data: [
        { profileId: profile3Id, fromStageId: p3s1.id, toStageId: p3s2.id },   // S1→S2
        { profileId: profile3Id, fromStageId: p3s1.id, toStageId: p3s3.id },   // S1→S3
        { profileId: profile3Id, fromStageId: p3s2.id, toStageId: p3end.id },  // S2→END (no gate)
        { profileId: profile3Id, fromStageId: p3s3.id, toStageId: p3cl.id },   // S3→CHECKLIST
        { profileId: profile3Id, fromStageId: p3cl.id, toStageId: p3end.id },  // CHECKLIST→END
      ],
    });

    // ── Seed Profile 4: S1 → S2 → CHECKLIST(inactive) → END  (T8-c) ──────────
    // The CHECKLIST node has a checklistProfileId, but the referenced profile
    // has isActive:false.  advance.ts queries ChecklistProfile with {isActive:true}
    // so it gets back 0 rows → hasPendingChecklistAfterTarget=false → auto-completes
    // without ever hitting submit-checklist.  The warning must flag this profile
    // as unenforceable.  Before the T8-c fix, findProfilesWithoutFinalChecklist
    // only tested for CHECKLIST node presence and wrongly considered this profile
    // enforceable (a silent fail-open in the compliance gate).
    const cp4 = await prisma.filterCleaningProfile.create({
      data: {
        name: `T8 InactiveChecklist ${SUFFIX}`,
        lineageId: randomUUID(),
        status: 'ACTIVE',
        createdBy: '00000000-0000-0000-0000-000000000001',
        stages: {
          create: [
            { nodeType: 'STAGE', stateKey: 'S1', sortOrder: 1 },
            { nodeType: 'STAGE', stateKey: 'S2', sortOrder: 2 },
            {
              nodeType: 'CHECKLIST',
              stateKey: null,
              sortOrder: 3,
              configuration: { checklistProfileId: inactiveChecklistProfileId },
            },
            { nodeType: 'END', stateKey: null, sortOrder: 4 },
          ],
        },
      },
      include: { stages: true },
    });
    profile4Id = cp4.id;

    const p4s1 = cp4.stages.find(s => s.stateKey === 'S1')!;
    const p4s2 = cp4.stages.find(s => s.stateKey === 'S2')!;
    const p4cl = cp4.stages.find(s => s.nodeType === 'CHECKLIST')!;
    const p4end = cp4.stages.find(s => s.nodeType === 'END')!;
    await prisma.filterPipelineConnection.createMany({
      data: [
        { profileId: profile4Id, fromStageId: p4s1.id, toStageId: p4s2.id },
        { profileId: profile4Id, fromStageId: p4s2.id, toStageId: p4cl.id },
        { profileId: profile4Id, fromStageId: p4cl.id, toStageId: p4end.id },
      ],
    });

    // ── Build app and log in ──────────────────────────────────────────────────
    app = await buildApp();
    const token = await loginAs(app, WFC_USERNAME, WFC_PASSWORD);
    authHeaders = { authorization: `Bearer ${token}` };
  }, 30_000);

  afterAll(async () => {
    // Cascade deletes stages + connections via onDelete:Cascade in schema.
    try {
      if (profile1Id) await prisma.filterCleaningProfile.delete({ where: { id: profile1Id } });
    } catch { /* swallow */ }
    try {
      if (profile2Id) await prisma.filterCleaningProfile.delete({ where: { id: profile2Id } });
    } catch { /* swallow */ }
    try {
      if (profile3Id) await prisma.filterCleaningProfile.delete({ where: { id: profile3Id } });
    } catch { /* swallow */ }
    try {
      if (profile4Id) await prisma.filterCleaningProfile.delete({ where: { id: profile4Id } });
    } catch { /* swallow */ }
    // ChecklistProfile records have no FK from FilterPipelineStage, so clean them
    // up after the cleaning profiles are gone.
    try {
      if (activeChecklistProfileId) await prisma.checklistProfile.delete({ where: { id: activeChecklistProfileId } });
    } catch { /* swallow */ }
    try {
      if (inactiveChecklistProfileId) await prisma.checklistProfile.delete({ where: { id: inactiveChecklistProfileId } });
    } catch { /* swallow */ }
    try { await app.close(); } catch { /* swallow */ }
  }, 10_000);

  it('returns 200 with correct membership: no-checklist and inactive-checklist profiles flagged; active-checklist profile excluded', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/filters/cleaning-profiles/without-final-checklist',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { profiles: { id: string; name: string }[] };
    expect(Array.isArray(body.profiles)).toBe(true);

    const ids = body.profiles.map((p) => p.id);

    // Profile 1 (S1→S2→END): no CHECKLIST at all → unenforceable → must appear
    expect(ids).toContain(profile1Id);

    // Profile 2 (S1→S2→CHECKLIST(active)→END): CHECKLIST has an isActive:true
    // checklistProfileId → advance.ts defers completion → genuinely enforceable
    expect(ids).not.toContain(profile2Id);

    // Profile 3 (diamond: S1→{S2→END, S3→CHECKLIST(active)→END}): S2 path has
    // no gating checklist → unenforceable even though S3 path is properly guarded
    expect(ids).toContain(profile3Id);

    // Profile 4 (S1→S2→CHECKLIST(inactive)→END): CHECKLIST has a checklistProfileId
    // but the referenced ChecklistProfile is isActive:false → advance.ts does NOT
    // defer completion → auto-completes without submit-checklist → unenforceable.
    // This is the T8-c regression: before the fix, the warning treated any CHECKLIST
    // node presence as sufficient and incorrectly excluded this profile.
    expect(ids).toContain(profile4Id);
  });
});
