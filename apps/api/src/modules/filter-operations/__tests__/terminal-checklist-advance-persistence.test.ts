/**
 * ⚠️  DEFECT-DOCUMENTING TEST — asserts CURRENT (defective) behaviour, 2026-07-15.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THIS TEST PASSES BY ASSERTING A BUG. It is evidence, not a fix.
 *
 * The defect
 * ----------
 * `advance()` (apps/api/src/modules/filter-operations/cycle-write/advance.ts)
 * persists the stage transition BEFORE the operator's mandatory terminal
 * checklist is submitted:
 *
 *   - :348-359  eventData + `computeChecksum(eventData)`
 *   - :455      `tx.filterEvent.create({ ...eventData, checksum })`   ← immutable
 *   - :474      `tx.filterDetails.update({ currentLifecycleState: targetState })`
 *   - :531      `auditLog({ action: 'STATE_TRANSITION', ... }, tx)`   ← hash-chained
 *
 * In a pipeline shaped  START → S1 → S2 → CHECKLIST(active) → END, S2 is the
 * TERMINAL stage and carries a mandatory terminal checklist. On the tablet the
 * operator taps "advance to S2"; the advance COMMITS, and only then does the UI
 * render the checklist dialog. Pressing Close makes NO API call (verified) — so
 * the operator walks away and the system permanently asserts, in a checksummed
 * `filter_events` row and a hash-chained `audit_trail` row, that the filter
 * entered its final cleaning stage with its mandatory checklist unanswered.
 * That is a 21 CFR §11 record of an event whose required attestation is absent.
 *
 * The CORRECT half (also asserted here so a later fix cannot regress it)
 * ---------------------------------------------------------------------
 * The cycle does NOT falsely complete. advance.ts:376-395 computes
 * `hasPendingChecklistAfterTarget` — an ACTIVE ChecklistProfile between the
 * target stage and END defers completion (`willComplete === false` at :395), so
 * the completion block at :492-528 is skipped and the cycle stays IN_PROGRESS
 * with completed_at NULL. `submitChecklist()` performs the completion instead.
 *
 * WHEN THE FIX LANDS — update this header and flip these assertions
 * ----------------------------------------------------------------
 * When the atomic advance+checklist fix lands (see
 * `tasks/ATOMIC-ADVANCE-CHECKLIST-PLAN.md`), assertions (a), (b) and (d) below
 * MUST be flipped to expect ZERO persisted rows before checklist submission:
 *
 *   (a) no STATE_TRANSITION FilterEvent for the terminal stage
 *   (b) FilterDetails.currentLifecycleState still at the PREVIOUS stage (S1)
 *   (d) no STATE_TRANSITION audit_trail row for the terminal transition
 *
 * Assertions (c) and (e) and the final completion test document CORRECT
 * behaviour and must keep passing unchanged. This header must be updated at the
 * same time.
 *
 * Test-infra notes
 * ----------------
 * - Real Fastify (in-process `inject()`), real Prisma, real auth. Pattern copied
 *   from `without-final-checklist.test.ts` + `ahu-completion-gate.e2e.test.ts`.
 * - Unique SUPER_ADMIN per file (filename + timestamp) so the shared-`admin`
 *   login race can't touch us. Runs against `digilog_test_db` (vitest.env.ts).
 * - Reauth is satisfied with `_currentPassword` in the body — NOT the
 *   offline-replay grant, which would set `isOfflineReplay=true` and take a
 *   different code path through advance(). This test is the ONLINE operator.
 * - The filter is deliberately parented to NOTHING, so `resolveAhuId` returns
 *   null and `assertAhuInterlockSatisfied` short-circuits regardless of whatever
 *   `ahu-completion-process` mode another suite has left in the shared test DB.
 * - Every assertion is scoped by this file's own filterId / cycleId
 *   (membership, not ambient counts) so concurrent suites cannot skew it.
 * - Teardown does NOT delete audit_trail rows: the `audit_trail_no_delete`
 *   immutability trigger rejects them by design.
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

// ── Unique test user (file name + timestamp) ─────────────────────────────────
const SUFFIX = Date.now().toString(36).slice(-4).toUpperCase();
const TCA_USERNAME = `TCAP${SUFFIX}`.slice(0, 16).toUpperCase();
const TCA_PASSWORD = 'TcaTest@Digilog#7';

const REASON_KEY = 'ROUTINE';

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

describe('advance() persists a terminal stage transition BEFORE its mandatory checklist (DEFECT, 2026-07-15)', () => {
  let app: FastifyInstance;
  let authHeaders: Record<string, string>;

  let filterTemplateId = '';
  let checklistProfileId = '';
  let checklistQuestionId = '';
  let cleaningProfileId = '';
  let filterProfileId = '';
  let filterId = '';
  let cycleId = '';

  /** GET the live tape version — every write must carry a fresh one (409 STALE_TAPE otherwise). */
  async function freshTape(): Promise<number> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/filters/${filterId}/current-state`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    return res.json().tapeVersion as number;
  }

  beforeAll(async () => {
    // ── Unique SUPER_ADMIN ────────────────────────────────────────────────────
    const passwordHash = await hashPassword(TCA_PASSWORD);
    await prisma.user.upsert({
      where: { username: TCA_USERNAME },
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
        username: TCA_USERNAME,
        fullName: 'Terminal Checklist Advance Test',
        email: `${TCA_USERNAME.toLowerCase()}@tca-test.local`,
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        createdBy: 'tca-test',
      },
    });

    // ── Template kind + asset template ────────────────────────────────────────
    await prisma.templateKind.upsert({
      where: { code: 'FILTER' },
      update: {},
      create: { code: 'FILTER', label: 'Filter', isSystem: true },
    });
    filterTemplateId = (await prisma.assetTemplate.create({
      data: { name: `TCA Filter Tpl ${SUFFIX}`, templateKind: 'FILTER' },
    })).id;

    // ── ACTIVE checklist profile with one REQUIRED question ───────────────────
    // isActive:true is load-bearing: advance.ts:381-385 only defers completion
    // for CHECKLIST nodes whose referenced profile is active.
    const cpProfile = await prisma.checklistProfile.create({
      data: {
        name: `TCA Terminal CP ${SUFFIX}`,
        isActive: true,
        questions: {
          create: [
            {
              question: 'Was the filter visually inspected after the final stage?',
              questionType: 'YES_NO',
              required: true,
              sortOrder: 1,
            },
          ],
        },
      },
      include: { questions: true },
    });
    checklistProfileId = cpProfile.id;
    checklistQuestionId = cpProfile.questions[0].id;

    // ── Cleaning profile: START → S1 → S2 → CHECKLIST(active) → END ───────────
    // S2 is the TERMINAL stage and carries the mandatory terminal checklist.
    const cleaning = await prisma.filterCleaningProfile.create({
      data: {
        name: `TCA Cleaning Profile ${SUFFIX}`,
        lineageId: randomUUID(),
        status: 'ACTIVE',
        createdBy: '00000000-0000-0000-0000-000000000001',
        // Own the reason list so start-cycle doesn't depend on ambient config.
        cleaningReasons: [{ key: REASON_KEY, name: 'Routine', requiresJustification: false }],
        stages: {
          create: [
            { nodeType: 'START', stateKey: null, sortOrder: 0 },
            { nodeType: 'STAGE', stateKey: 'S1', sortOrder: 1 },
            { nodeType: 'STAGE', stateKey: 'S2', sortOrder: 2 },
            {
              nodeType: 'CHECKLIST',
              stateKey: null,
              sortOrder: 3,
              configuration: { checklistProfileId },
            },
            { nodeType: 'END', stateKey: null, sortOrder: 4 },
          ],
        },
      },
      include: { stages: true },
    });
    cleaningProfileId = cleaning.id;

    const start = cleaning.stages.find(s => s.nodeType === 'START')!;
    const s1 = cleaning.stages.find(s => s.stateKey === 'S1')!;
    const s2 = cleaning.stages.find(s => s.stateKey === 'S2')!;
    const cl = cleaning.stages.find(s => s.nodeType === 'CHECKLIST')!;
    const end = cleaning.stages.find(s => s.nodeType === 'END')!;
    await prisma.filterPipelineConnection.createMany({
      data: [
        { profileId: cleaningProfileId, fromStageId: start.id, toStageId: s1.id },
        { profileId: cleaningProfileId, fromStageId: s1.id, toStageId: s2.id },
        { profileId: cleaningProfileId, fromStageId: s2.id, toStageId: cl.id },
        { profileId: cleaningProfileId, fromStageId: cl.id, toStageId: end.id },
      ],
    });

    // ── FilterProfile (binds the filter to the cleaning pipeline) ─────────────
    filterProfileId = (await prisma.filterProfile.create({
      data: { name: `TCA FP ${SUFFIX}`, cleaningProfileId },
    })).id;

    // ── Filter instance — NO parent, so the AHU interlock never engages ───────
    filterId = (await prisma.assetInstance.create({
      data: { name: `TCA-Filter-${SUFFIX}`, templateId: filterTemplateId },
    })).id;

    // Direct binding: without filterProfileId, resolveFilterProfile falls back to
    // "first ACTIVE cleaning profile, oldest first" and could pick up another
    // suite's fixture in the shared test DB.
    await prisma.filterDetails.create({
      data: {
        assetInstanceId: filterId,
        filterProfileId,
        currentCycleId: null,
        currentLifecycleState: null,
      },
    });

    app = await buildApp();
    const token = await loginAs(app, TCA_USERNAME, TCA_PASSWORD);
    authHeaders = { authorization: `Bearer ${token}` };
  }, 60_000);

  afterAll(async () => {
    // FK-safe order: filter_events → cleaning_cycles → filter_details →
    // asset_instance → filter_profile → filter_cleaning_profile (cascades
    // stages/connections) → checklist_profile (cascades questions) → template.
    // audit_trail rows are intentionally left: the `audit_trail_no_delete`
    // immutability trigger rejects deletes (21 CFR §11.10(e)).
    try {
      if (filterId) await prisma.filterEvent.deleteMany({ where: { filterId } });
      if (filterId) await prisma.cleaningCycle.deleteMany({ where: { filterId } });
      if (filterId) await prisma.filterDetails.deleteMany({ where: { assetInstanceId: filterId } });
      if (filterId) await prisma.assetInstance.delete({ where: { id: filterId } }).catch(() => undefined);
      if (filterProfileId) await prisma.filterProfile.delete({ where: { id: filterProfileId } }).catch(() => undefined);
      if (cleaningProfileId) await prisma.filterCleaningProfile.delete({ where: { id: cleaningProfileId } }).catch(() => undefined);
      if (checklistProfileId) await prisma.checklistProfile.delete({ where: { id: checklistProfileId } }).catch(() => undefined);
      if (filterTemplateId) await prisma.assetTemplate.delete({ where: { id: filterTemplateId } }).catch(() => undefined);
    } catch { /* swallow — cleanup must never mask a real failure */ }
    try { await app.close(); } catch { /* swallow */ }
  }, 30_000);

  // ───────────────────────────────────────────────────────────────────────────
  // Step 1 — drive the filter to the TERMINAL stage S2 and STOP.
  // The operator sees the checklist dialog only after this advance committed,
  // and presses Close — which makes NO API call. So the test makes none either.
  // ───────────────────────────────────────────────────────────────────────────
  it('advances START → S1 → S2 without submitting the terminal checklist', async () => {
    const startRes = await app.inject({
      method: 'POST',
      url: `/api/filters/${filterId}/start-cycle`,
      headers: authHeaders,
      payload: { cleaningReasonKey: REASON_KEY, _currentPassword: TCA_PASSWORD },
    });
    expect(startRes.statusCode).toBe(201);
    cycleId = startRes.json().id as string;
    expect(cycleId).toBeTruthy();

    const toS1 = await app.inject({
      method: 'POST',
      url: `/api/filters/${filterId}/advance`,
      headers: authHeaders,
      payload: { targetState: 'S1', tapeVersion: await freshTape(), _currentPassword: TCA_PASSWORD },
    });
    expect(toS1.statusCode).toBe(200);
    expect(toS1.json().currentState).toBe('S1');

    // The terminal advance. advance.ts sees S2 → CHECKLIST(active) → END, so
    // hasPendingChecklistAfterTarget = true and completion is deferred — but the
    // transition itself is committed right here, before any checklist exists.
    const toS2 = await app.inject({
      method: 'POST',
      url: `/api/filters/${filterId}/advance`,
      headers: authHeaders,
      payload: { targetState: 'S2', tapeVersion: await freshTape(), _currentPassword: TCA_PASSWORD },
    });
    expect(toS2.statusCode).toBe(200);
    expect(toS2.json().currentState).toBe('S2');

    // ── Operator presses Close. No further request is made. ──
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Step 2 — what is now permanently on record.
  // ───────────────────────────────────────────────────────────────────────────

  it('(a) BUGGY: a checksummed STATE_TRANSITION FilterEvent to S2 is already persisted', async () => {
    // DOCUMENTS BUGGY BEHAVIOUR.
    // advance.ts:455 wrote this row inside the tx, before the operator had any
    // opportunity to answer the mandatory terminal checklist. filter_events is
    // an immutable, checksummed 21 CFR §11 log — this row now asserts, forever,
    // that the filter entered its final cleaning stage.
    //
    // AFTER THE FIX: this must become `expect(evt).toBeNull()`.
    const evt = await prisma.filterEvent.findFirst({
      where: { filterId, cycleId, eventType: 'STATE_TRANSITION', toState: 'S2' },
    });
    expect(evt).not.toBeNull();
    expect(evt!.fromState).toBe('S1');
    expect(typeof evt!.checksum).toBe('string');
    expect(evt!.checksum.length).toBeGreaterThan(0);
  });

  it('(b) BUGGY: FilterDetails.currentLifecycleState already moved to S2', async () => {
    // DOCUMENTS BUGGY BEHAVIOUR.
    // advance.ts:474. The live filter state says "at the final stage" while the
    // attestation that gates that stage has never been given.
    //
    // AFTER THE FIX: this must become `expect(details!.currentLifecycleState).toBe('S1')`.
    const details = await prisma.filterDetails.findUnique({
      where: { assetInstanceId: filterId },
    });
    expect(details!.currentLifecycleState).toBe('S2');
  });

  it('(c) CORRECT: no CHECKLIST_COMPLETED event exists for this cycle', async () => {
    // DOCUMENTS CORRECT BEHAVIOUR — and is the whole point of (a),(b),(d):
    // the checklist genuinely was never answered, so the records above are
    // asserting a stage entry whose mandatory attestation does not exist.
    // Must keep passing after the fix.
    const completed = await prisma.filterEvent.count({
      where: { filterId, cycleId, eventType: 'CHECKLIST_COMPLETED' },
    });
    expect(completed).toBe(0);
  });

  it('(d) BUGGY: a hash-chained audit_trail STATE_TRANSITION row is already written', async () => {
    // DOCUMENTS BUGGY BEHAVIOUR.
    // advance.ts:531 wrote this inside the same tx. audit_trail is hash-chained
    // and delete-protected: this §11 record cannot be withdrawn if the operator
    // never comes back to answer the checklist.
    //
    // AFTER THE FIX: this must become `expect(row).toBeNull()`.
    const row = await prisma.auditTrail.findFirst({
      where: {
        action: 'STATE_TRANSITION',
        targetType: 'filter',
        targetId: filterId,
        afterValue: { path: ['state'], equals: 'S2' },
      },
    });
    expect(row).not.toBeNull();
    expect(row!.checksum).toBeTruthy();
  });

  it('(e) CORRECT: the cycle stays IN_PROGRESS with completed_at NULL — completion is deferred', async () => {
    // DOCUMENTS CORRECT BEHAVIOUR. This is the half advance.ts gets right:
    // hasPendingChecklistAfterTarget (advance.ts:376-395) sees the ACTIVE
    // CHECKLIST between S2 and END → willComplete=false → the completion block
    // (:492-528) is skipped. The cycle does NOT falsely complete.
    // Asserted here so the later atomic-advance fix cannot regress it.
    const cycle = await prisma.cleaningCycle.findUnique({ where: { id: cycleId } });
    expect(cycle!.status).toBe('IN_PROGRESS');
    expect(cycle!.completedAt).toBeNull();

    // And no CYCLE_COMPLETED event was emitted either.
    const done = await prisma.filterEvent.count({
      where: { filterId, cycleId, eventType: 'CYCLE_COMPLETED' },
    });
    expect(done).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Step 3 — the re-scan path: the operator comes back, scans the tag again,
  // and answers the checklist. Only NOW does the cycle complete.
  // ───────────────────────────────────────────────────────────────────────────
  it('CORRECT: submitting the terminal checklist completes the cycle', async () => {
    // DOCUMENTS CORRECT BEHAVIOUR — submitChecklist owns the deferred completion.
    // Must keep passing after the fix (though under an atomic advance+checklist
    // design the transition and this submission would land in ONE transaction).
    const res = await app.inject({
      method: 'POST',
      url: `/api/filters/${filterId}/submit-checklist`,
      headers: authHeaders,
      payload: {
        answers: { [checklistQuestionId]: 'YES' },
        tapeVersion: await freshTape(),
        _currentPassword: TCA_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(200);

    const cycle = await prisma.cleaningCycle.findUnique({ where: { id: cycleId } });
    expect(cycle!.status).toBe('COMPLETED');
    expect(cycle!.completedAt).not.toBeNull();

    const completedEvt = await prisma.filterEvent.findFirst({
      where: { filterId, cycleId, eventType: 'CYCLE_COMPLETED' },
    });
    expect(completedEvt).not.toBeNull();

    const checklistEvt = await prisma.filterEvent.findFirst({
      where: { filterId, cycleId, eventType: 'CHECKLIST_COMPLETED' },
    });
    expect(checklistEvt).not.toBeNull();
    expect((checklistEvt!.attributes as any).afterStage).toBe('S2');
  });
});
