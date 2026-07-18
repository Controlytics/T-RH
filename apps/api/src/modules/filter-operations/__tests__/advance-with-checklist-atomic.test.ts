/**
 * Atomic advance + checklist — `POST /api/filters/:id/advance-with-checklist`.
 *
 * Companion to `terminal-checklist-advance-persistence.test.ts`, which documents
 * the DEFECT this op fixes: the bare `/advance` commits the stage transition
 * before the operator answers the stage's mandatory checklist, so closing the
 * dialog strands a checksummed `filter_events` row + hash-chained `audit_trail`
 * row asserting a stage entry whose required attestation never happened.
 *
 * That file keeps asserting the bare endpoint's CURRENT behaviour on purpose:
 * this is a PHASE 1 change (see tasks/ATOMIC-ADVANCE-CHECKLIST-PLAN.md). The bare
 * endpoint must keep accepting a bare advance until offline queues built before
 * this shipped have drained; phase 2 flips it to reject. So `/advance` is
 * unchanged and its test is unchanged — the fix is that the client now dispatches
 * THIS op instead, and this file pins what it guarantees.
 *
 * What's asserted here
 * --------------------
 *  1. Happy path — one op writes BOTH the transition and the checklist, and the
 *     cycle completes (advance defers completion, checklist performs it — the
 *     same handoff as the two-request flow, now in one tx).
 *  2. ATOMICITY — a failure in the checklist half rolls the advance half back.
 *     This is the actual claim of the whole change. Forced via the
 *     ALREADY_SUBMITTED guard, which lives INSIDE `executeChecklistTx`: prepare
 *     passes, the advance writes, then the checklist throws → everything unwinds.
 *  3. The checklist event AND the hash-chained audit row record the TARGET stage.
 *     `submit-checklist.ts` had 10 reads of the filter's live stage; in the
 *     composed path the filter has not moved at prepare time, so any missed read
 *     silently records the WRONG stage in an immutable §11 row. Nothing else in
 *     the suite catches that — hence an explicit assertion.
 *  4. NO_CHECKLIST_AT_TARGET — refuses to fabricate an attestation for a stage
 *     that has no checklist.
 *  5. Interlock — with the QA interlock enabled, a terminal WASH_OUT + checklist
 *     now 422s instead of completing with no QA sign-off. BEHAVIOUR CHANGE: in
 *     the bare flow `hasPendingChecklistAfterTarget` keeps `willComplete` false
 *     so the 422 never fires and the cycle completes past an unapproved gate.
 *     Latent today (every ACTIVE profile ends at STORAGE_OUT, not an interlock
 *     stage) but one profile edit from live. Closed for THIS path only — the bare
 *     two-request path keeps the hole until phase 2 (tracked separately).
 *
 * Test-infra notes (mirrors terminal-checklist-advance-persistence.test.ts)
 * ------------------------------------------------------------------------
 * - Real Fastify (in-process `inject()`), real Prisma, real auth, against
 *   `digilog_test_db` (vitest.env.ts). Unique SUPER_ADMIN per file so the shared
 *   `admin` login race can't touch us.
 * - `getInterlockConfig` is module-mocked rather than writing the shared
 *   `system_config['stage-interlock']` row — that row is global to the test DB and
 *   other suites read it. Every other export stays real (importOriginal).
 * - Filters are parented to NOTHING, so `resolveAhuId` returns null and the AHU
 *   completion gate short-circuits regardless of what another suite left behind.
 * - Every assertion is scoped by this file's own filterId/cycleId — membership,
 *   never ambient counts.
 * - Teardown does NOT delete audit_trail rows (the `audit_trail_no_delete`
 *   immutability trigger rejects them by design).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';

// Mutable so a single test can flip the interlock on without touching the shared
// system_config row. Default OFF = every other test sees today's behaviour.
const interlockCfg = {
  enabled: false,
  requireDifferentApprover: false,
  washOutApproverRole: 'ADMIN',
  dryOutApproverRole: 'ADMIN',
};
vi.mock('../stage-interlock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stage-interlock.js')>();
  return { ...actual, getInterlockConfig: async () => ({ ...interlockCfg }) };
});

import authPlugin from '../../../plugins/auth.js';
import rbacPlugin from '../../../plugins/rbac.js';
import authRoutes from '../../auth/routes.js';
import filterOperationsRoutes from '../routes.js';
import { prisma } from '../../../lib/prisma.js';
import { hashPassword } from '../../../lib/password.js';
import { AppError } from '../../../lib/errors.js';
import { loginAs } from '../../../e2e/test-helper.js';
import { randomUUID } from 'node:crypto';

const SUFFIX = Date.now().toString(36).slice(-4).toUpperCase();
const AWC_USERNAME = `AWCA${SUFFIX}`.slice(0, 16).toUpperCase();
const AWC_PASSWORD = 'AwcTest@Digilog#7';
const REASON_KEY = 'ROUTINE';

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
  await app.register(filterOperationsRoutes, { prefix: '/api/filters' });
  await app.ready();
  return app;
}

describe('POST /:id/advance-with-checklist — atomic advance + checklist', () => {
  let app: FastifyInstance;
  let authHeaders: Record<string, string>;

  let filterTemplateId = '';
  let checklistProfileId = '';
  let questionId = '';
  // Pipeline A: START → S1 → S2 → CHECKLIST(active) → END  (S2 terminal + checklist)
  let profileA = '';
  let fpA = '';
  // Pipeline B: START → T1 → T2 → END  (no checklist anywhere)
  let profileB = '';
  let fpB = '';
  // Pipeline C: START → WASH_IN → WASH_OUT → CHECKLIST(active) → END (interlock)
  let profileC = '';
  let fpC = '';

  const createdFilterIds: string[] = [];

  async function freshTape(filterId: string): Promise<number> {
    const res = await app.inject({
      method: 'GET', url: `/api/filters/${filterId}/current-state`, headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    return res.json().tapeVersion as number;
  }

  /** A filter bound to the given FilterProfile, parented to nothing. */
  async function makeFilter(filterProfileId: string, label: string): Promise<string> {
    const id = (await prisma.assetInstance.create({
      data: { name: `AWC-${label}-${SUFFIX}-${createdFilterIds.length}`, templateId: filterTemplateId },
    })).id;
    await prisma.filterDetails.create({
      data: { assetInstanceId: id, filterProfileId, currentCycleId: null, currentLifecycleState: null },
    });
    createdFilterIds.push(id);
    return id;
  }

  async function startCycle(filterId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: `/api/filters/${filterId}/start-cycle`, headers: authHeaders,
      payload: { cleaningReasonKey: REASON_KEY, _currentPassword: AWC_PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function bareAdvance(filterId: string, targetState: string) {
    const res = await app.inject({
      method: 'POST', url: `/api/filters/${filterId}/advance`, headers: authHeaders,
      payload: { targetState, tapeVersion: await freshTape(filterId), _currentPassword: AWC_PASSWORD },
    });
    return res;
  }

  /** One ACTIVE checklist profile, one REQUIRED question, reused by A and C. */
  async function makePipeline(
    name: string,
    stageKeys: string[],
    opts: { withChecklist: boolean },
  ): Promise<{ cleaningProfileId: string; filterProfileId: string }> {
    const nodes: any[] = [{ nodeType: 'START', stateKey: null, sortOrder: 0 }];
    stageKeys.forEach((k, i) => nodes.push({ nodeType: 'STAGE', stateKey: k, sortOrder: i + 1 }));
    if (opts.withChecklist) {
      nodes.push({
        nodeType: 'CHECKLIST', stateKey: null, sortOrder: stageKeys.length + 1,
        configuration: { checklistProfileId },
      });
    }
    nodes.push({ nodeType: 'END', stateKey: null, sortOrder: stageKeys.length + 2 });

    const cleaning = await prisma.filterCleaningProfile.create({
      data: {
        name: `AWC ${name} ${SUFFIX}`,
        lineageId: randomUUID(),
        status: 'ACTIVE',
        createdBy: '00000000-0000-0000-0000-000000000001',
        cleaningReasons: [{ key: REASON_KEY, name: 'Routine', requiresJustification: false }],
        stages: { create: nodes },
      },
      include: { stages: true },
    });

    // Chain them in sortOrder: START → …stages… → [CHECKLIST] → END
    const ordered = [...cleaning.stages].sort((a, b) => a.sortOrder - b.sortOrder);
    const conns = ordered.slice(0, -1).map((from, i) => ({
      profileId: cleaning.id, fromStageId: from.id, toStageId: ordered[i + 1].id,
    }));
    await prisma.filterPipelineConnection.createMany({ data: conns });

    const fp = await prisma.filterProfile.create({
      data: { name: `AWC FP ${name} ${SUFFIX}`, cleaningProfileId: cleaning.id },
    });
    return { cleaningProfileId: cleaning.id, filterProfileId: fp.id };
  }

  beforeAll(async () => {
    const passwordHash = await hashPassword(AWC_PASSWORD);
    await prisma.user.upsert({
      where: { username: AWC_USERNAME },
      update: {
        passwordHash, role: 'SUPER_ADMIN', status: 'ENABLED', forcePasswordChange: false,
        isTemporaryPassword: false, failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null,
      },
      create: {
        username: AWC_USERNAME, fullName: 'Atomic Advance+Checklist Test',
        email: `${AWC_USERNAME.toLowerCase()}@awc-test.local`, passwordHash,
        role: 'SUPER_ADMIN', status: 'ENABLED', forcePasswordChange: false,
        isTemporaryPassword: false, createdBy: 'awc-test',
      },
    });

    await prisma.templateKind.upsert({
      where: { code: 'FILTER' }, update: {},
      create: { code: 'FILTER', label: 'Filter', isSystem: true },
    });
    filterTemplateId = (await prisma.assetTemplate.create({
      data: { name: `AWC Filter Tpl ${SUFFIX}`, templateKind: 'FILTER' },
    })).id;

    // isActive:true is load-bearing — advance only defers completion for a
    // CHECKLIST node whose referenced profile is active.
    const cp = await prisma.checklistProfile.create({
      data: {
        name: `AWC Terminal CP ${SUFFIX}`,
        isActive: true,
        questions: {
          create: [{
            question: 'Was the filter visually inspected after the final stage?',
            questionType: 'YES_NO', required: true, sortOrder: 1,
          }],
        },
      },
      include: { questions: true },
    });
    checklistProfileId = cp.id;
    questionId = cp.questions[0].id;

    ({ cleaningProfileId: profileA, filterProfileId: fpA } =
      await makePipeline('A', ['S1', 'S2'], { withChecklist: true }));
    ({ cleaningProfileId: profileB, filterProfileId: fpB } =
      await makePipeline('B', ['T1', 'T2'], { withChecklist: false }));
    ({ cleaningProfileId: profileC, filterProfileId: fpC } =
      await makePipeline('C', ['WASH_IN', 'WASH_OUT'], { withChecklist: true }));

    app = await buildApp();
    const token = await loginAs(app, AWC_USERNAME, AWC_PASSWORD);
    authHeaders = { authorization: `Bearer ${token}` };
  }, 60_000);

  afterAll(async () => {
    try {
      for (const id of createdFilterIds) {
        await prisma.filterEvent.deleteMany({ where: { filterId: id } });
        await prisma.cleaningStageApproval.deleteMany({ where: { filterId: id } }).catch(() => undefined);
        await prisma.cleaningCycle.deleteMany({ where: { filterId: id } });
        await prisma.filterDetails.deleteMany({ where: { assetInstanceId: id } });
        await prisma.assetInstance.delete({ where: { id } }).catch(() => undefined);
      }
      for (const id of [fpA, fpB, fpC]) {
        if (id) await prisma.filterProfile.delete({ where: { id } }).catch(() => undefined);
      }
      for (const id of [profileA, profileB, profileC]) {
        if (id) await prisma.filterCleaningProfile.delete({ where: { id } }).catch(() => undefined);
      }
      if (checklistProfileId) await prisma.checklistProfile.delete({ where: { id: checklistProfileId } }).catch(() => undefined);
      if (filterTemplateId) await prisma.assetTemplate.delete({ where: { id: filterTemplateId } }).catch(() => undefined);
    } catch { /* swallow — cleanup must never mask a real failure */ }
    try { await app.close(); } catch { /* swallow */ }
  }, 30_000);

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Happy path
  // ───────────────────────────────────────────────────────────────────────────
  describe('happy path — one op, both records, cycle completes', () => {
    let filterId = '';
    let cycleId = '';

    beforeAll(async () => {
      filterId = await makeFilter(fpA, 'happy');
      cycleId = await startCycle(filterId);
      expect((await bareAdvance(filterId, 'S1')).statusCode).toBe(200);
    }, 30_000);

    it('advances to the terminal stage AND records the checklist in one request', async () => {
      const res = await app.inject({
        method: 'POST', url: `/api/filters/${filterId}/advance-with-checklist`, headers: authHeaders,
        payload: {
          targetState: 'S2',
          answers: { [questionId]: 'YES' },
          tapeVersion: await freshTape(filterId),
          _currentPassword: AWC_PASSWORD,
        },
      });
      expect(res.statusCode).toBe(200);

      const transition = await prisma.filterEvent.findFirst({
        where: { filterId, cycleId, eventType: 'STATE_TRANSITION', toState: 'S2' },
      });
      expect(transition).not.toBeNull();
      expect(transition!.fromState).toBe('S1');
      expect(transition!.checksum).toBeTruthy();

      const checklist = await prisma.filterEvent.findFirst({
        where: { filterId, cycleId, eventType: 'CHECKLIST_COMPLETED' },
      });
      expect(checklist).not.toBeNull();
      expect(checklist!.checksum).toBeTruthy();
    });

    it('completes the cycle — advance defers, checklist performs it, same tx', async () => {
      const cycle = await prisma.cleaningCycle.findUnique({ where: { id: cycleId } });
      expect(cycle!.status).toBe('COMPLETED');
      expect(cycle!.completedAt).not.toBeNull();

      const done = await prisma.filterEvent.count({
        where: { filterId, cycleId, eventType: 'CYCLE_COMPLETED' },
      });
      expect(done).toBe(1);

      const details = await prisma.filterDetails.findUnique({ where: { assetInstanceId: filterId } });
      expect(details!.currentLifecycleState).toBe('CLEANING_CYCLE_COMPLETED');
      expect(details!.currentCycleId).toBeNull();
    });

    // The silent-wrong-data trap. In the composed path the filter is still at S1
    // when the checklist is PREPARED, so every stage read must be overridden to
    // the target. A miss records the wrong stage in an immutable §11 row and no
    // other assertion in the suite would notice.
    it('records the checklist against the TARGET stage (S2) — not the pre-advance stage (S1)', async () => {
      const checklist = await prisma.filterEvent.findFirst({
        where: { filterId, cycleId, eventType: 'CHECKLIST_COMPLETED' },
      });
      expect((checklist!.attributes as any).afterStage).toBe('S2');

      // The hash-chained §11 row — submit-checklist.ts:275 read the live stage.
      // chainPosition, not timestamp: the schema notes timestamp can collide at
      // sub-millisecond on batched writes — and this row is written in the same
      // tx as the transition's audit row.
      const audit = await prisma.auditTrail.findFirst({
        where: { action: 'CHECKLIST_COMPLETED', targetType: 'filter', targetId: filterId },
        orderBy: { chainPosition: 'desc' },
      });
      expect(audit).not.toBeNull();
      expect((audit!.afterValue as any).stage).toBe('S2');
      expect(audit!.checksum).toBeTruthy();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Atomicity — the actual claim
  // ───────────────────────────────────────────────────────────────────────────
  describe('atomicity — a failing checklist half rolls the advance half back', () => {
    let filterId = '';
    let cycleId = '';
    let res: Awaited<ReturnType<FastifyInstance['inject']>>;

    beforeAll(async () => {
      filterId = await makeFilter(fpA, 'rollback');
      cycleId = await startCycle(filterId);
      expect((await bareAdvance(filterId, 'S1')).statusCode).toBe(200);

      // Arm the trap: a CHECKLIST_COMPLETED already on record for S2 makes
      // executeChecklistTx throw 409 ALREADY_SUBMITTED — and that guard runs
      // INSIDE the transaction, AFTER executeAdvanceTx has written the
      // transition. Exactly the shape we need: prepare passes, advance writes,
      // checklist blows up, everything must unwind.
      await prisma.filterEvent.create({
        data: {
          filterId, cycleId, eventType: 'CHECKLIST_COMPLETED',
          performedBy: randomUUID(), // performed_by is a uuid column, not a username
          attributes: { afterStage: 'S2', answers: {}, checklists: [] },
          checksum: 'armed-trap-not-a-real-checksum',
          telemetrySnapshot: {},
          ipAddress: '127.0.0.1',
        },
      });

      // NB: that insert bumps filterEventCount → the tape moved. Read it AFTER.
      res = await app.inject({
        method: 'POST', url: `/api/filters/${filterId}/advance-with-checklist`, headers: authHeaders,
        payload: {
          targetState: 'S2',
          answers: { [questionId]: 'YES' },
          tapeVersion: await freshTape(filterId),
          _currentPassword: AWC_PASSWORD,
        },
      });
    }, 30_000);

    it('fails the request with the checklist half\'s error', () => {
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('ALREADY_SUBMITTED');
    });

    it('wrote NO STATE_TRANSITION event — the advance half rolled back', async () => {
      const transition = await prisma.filterEvent.findFirst({
        where: { filterId, cycleId, eventType: 'STATE_TRANSITION', toState: 'S2' },
      });
      expect(transition).toBeNull();
    });

    it('left the filter at S1 — currentLifecycleState never moved', async () => {
      const details = await prisma.filterDetails.findUnique({ where: { assetInstanceId: filterId } });
      expect(details!.currentLifecycleState).toBe('S1');
    });

    it('wrote NO hash-chained audit_trail STATE_TRANSITION row for the rolled-back advance', async () => {
      // The audit write lives inside the same tx (audit §1.1) — it must unwind
      // with it. If this ever fails, the tx boundary has been broken and the §11
      // trail is asserting a transition the database does not have.
      const row = await prisma.auditTrail.findFirst({
        where: {
          action: 'STATE_TRANSITION', targetType: 'filter', targetId: filterId,
          afterValue: { path: ['state'], equals: 'S2' },
        },
      });
      expect(row).toBeNull();
    });

    it('left the cycle IN_PROGRESS', async () => {
      const cycle = await prisma.cleaningCycle.findUnique({ where: { id: cycleId } });
      expect(cycle!.status).toBe('IN_PROGRESS');
      expect(cycle!.completedAt).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Wrong-tool guard
  // ───────────────────────────────────────────────────────────────────────────
  describe('NO_CHECKLIST_AT_TARGET — refuses to fabricate an attestation', () => {
    let filterId = '';

    beforeAll(async () => {
      filterId = await makeFilter(fpB, 'nochecklist');
      await startCycle(filterId);
      expect((await bareAdvance(filterId, 'T1')).statusCode).toBe(200);
    }, 30_000);

    it('rejects when no active checklist follows the target stage', async () => {
      const res = await app.inject({
        method: 'POST', url: `/api/filters/${filterId}/advance-with-checklist`, headers: authHeaders,
        payload: {
          targetState: 'T2', answers: {},
          tapeVersion: await freshTape(filterId), _currentPassword: AWC_PASSWORD,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('NO_CHECKLIST_AT_TARGET');
    });

    it('wrote nothing — the filter is still at T1', async () => {
      const details = await prisma.filterDetails.findUnique({ where: { assetInstanceId: filterId } });
      expect(details!.currentLifecycleState).toBe('T1');
      const transition = await prisma.filterEvent.findFirst({
        where: { filterId, eventType: 'STATE_TRANSITION', toState: 'T2' },
      });
      expect(transition).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Interlock — BEHAVIOUR CHANGE for the composed path
  // ───────────────────────────────────────────────────────────────────────────
  describe('QA stage interlock at a terminal WASH_OUT', () => {
    let filterId = '';

    beforeAll(async () => {
      filterId = await makeFilter(fpC, 'interlock');
      await startCycle(filterId);
      expect((await bareAdvance(filterId, 'WASH_IN')).statusCode).toBe(200);
    }, 30_000);

    afterAll(() => { interlockCfg.enabled = false; });

    it('422s rather than completing a cycle out of an unapproved interlock stage', async () => {
      interlockCfg.enabled = true;
      const res = await app.inject({
        method: 'POST', url: `/api/filters/${filterId}/advance-with-checklist`, headers: authHeaders,
        payload: {
          targetState: 'WASH_OUT',
          answers: { [questionId]: 'YES' },
          tapeVersion: await freshTape(filterId),
          _currentPassword: AWC_PASSWORD,
        },
      });

      // Because the checklist lands in the SAME tx, the cycle genuinely completes
      // here — so the terminal-interlock guard must fire. In the bare two-request
      // flow `hasPendingChecklistAfterTarget` keeps willComplete=false, the guard
      // stays silent, and the cycle completes with QA never approving. This op
      // closes that for its own path.
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('INTERLOCK_TERMINAL_STAGE');
    });

    it('wrote nothing — rejected in prepare, before the transaction', async () => {
      const details = await prisma.filterDetails.findUnique({ where: { assetInstanceId: filterId } });
      expect(details!.currentLifecycleState).toBe('WASH_IN');
      const transition = await prisma.filterEvent.findFirst({
        where: { filterId, eventType: 'STATE_TRANSITION', toState: 'WASH_OUT' },
      });
      expect(transition).toBeNull();
    });

    it('with the interlock OFF the same op completes normally', async () => {
      interlockCfg.enabled = false;
      const res = await app.inject({
        method: 'POST', url: `/api/filters/${filterId}/advance-with-checklist`, headers: authHeaders,
        payload: {
          targetState: 'WASH_OUT',
          answers: { [questionId]: 'YES' },
          tapeVersion: await freshTape(filterId),
          _currentPassword: AWC_PASSWORD,
        },
      });
      expect(res.statusCode).toBe(200);

      const cycle = await prisma.cleaningCycle.findFirst({
        where: { filterId }, orderBy: { startedAt: 'desc' },
      });
      expect(cycle!.status).toBe('COMPLETED');
    });
  });
});
