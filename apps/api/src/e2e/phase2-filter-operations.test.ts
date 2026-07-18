import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { loginAs, obtainOfflineGrant } from './test-helper.js';
import authPlugin from '../plugins/auth.js';
import rbacPlugin from '../plugins/rbac.js';
import authRoutes from '../modules/auth/routes.js';
import { AppError } from '../lib/errors.js';

/**
 * Phase 2 — Filter Operations route-level e2e.
 *
 * Closes part of `PHASE_5_RECENT_WORK.md § 11`: replaces the deleted
 * `tests/manual-test-cases/` happy-path coverage for the cycle-write surface.
 *
 * Scope (route layer = Fastify schema validation + RBAC preHandler + reauth
 * gate + response serialization):
 *   1. POST /api/filters/:id/start-cycle           — happy path → 201, decision-tape returned, no legacy fields
 *   2. POST /api/filters/:id/advance               — happy path → 200, updated tape returned
 *   3. POST /api/filters/:id/advance               — missing tapeVersion → 400 (Phase 8.7 schema-level requirement)
 *   4. POST /api/filters/:id/submit-checklist      — happy path → 200
 *   5. POST /api/filters/:id/bypass                — happy path → 200, justification + tapeVersion required
 *   6. POST /api/filters/:id/terminate-cycle       — happy path → 200, post-write tape returned
 *   7. GET  /api/filters/:id/current-state         — response shape: actions[] + tapeVersion present, legacy fields absent
 *
 * Concurrency / collision codes (STALE_TAPE / STATE_CHANGED / CYCLE_CHANGED /
 * ALREADY_SUBMITTED) are exhaustively covered at the service layer in
 * `src/modules/filter-operations/__tests__/concurrent-operator.test.ts`. Not
 * re-exercised here.
 *
 * ─── Test infrastructure choice ──────────────────────────────────────────────
 * The task brief permits a lighter approach when full route-level e2e proves
 * heavy. Seeding the Phase 2 entity tree (CleaningProfile + lineageId + STAGE
 * nodes + connections + AssetTemplate + FilterDetails sidecar + CleaningCycle
 * + FilterEvents) just to exercise route surface is genuinely large and would
 * duplicate fixtures the service-layer suite already validates.
 *
 * Compromise (per advisor recommendation):
 *   - REAL prisma + REAL auth via the existing `buildApp()` helper.
 *     `loginAs()` issues a real JWT against `digilog_db`, RBAC reads the live
 *     SUPER_ADMIN row.
 *   - MOCKED `FilterOperationsService` at module level. The route registers
 *     `new FilterOperationsService()` so the mock controls every method's
 *     return shape.
 *
 * What this proves at the route layer:
 *   - Fastify JSON schema validation (test 3 — missing tapeVersion → 400)
 *   - RBAC preHandler (each route under `requirePermission(...)`)
 *   - Reauth gate (we bypass with `x-offline-replay: 'true'` header — see
 *     `lib/reauth-check.ts` line 49 — so tests don't depend on whether the
 *     local `action-reauth` systemConfig row gates SUPER_ADMIN)
 *   - Response-schema serialization. Phase 8.7 removed `nextAllowedStages`
 *     and `pendingChecklist` from response schemas. The mock deliberately
 *     INCLUDES them so we can assert Fastify strips them on the wire —
 *     otherwise the test would tautologically pass even if the schema regressed.
 */

// ── Hoisted service mock ─────────────────────────────────────────────────────
// Every method returns a snapshot that intentionally contains the legacy
// fields (`nextAllowedStages`, `pendingChecklist`). If Fastify's response
// schema is correctly enforcing Phase 8.7 strip-on-serialize, the wire
// response should NOT include those keys.
const { mockService } = vi.hoisted(() => ({
  mockService: {
    startCycle: vi.fn(),
    advance: vi.fn(),
    submitChecklist: vi.fn(),
    bypass: vi.fn(),
    terminateCycle: vi.fn(),
    getCurrentState: vi.fn(),
    getBatchStates: vi.fn(),
    getEvents: vi.fn(),
    getCycles: vi.fn(),
    getCleaningReasons: vi.fn(),
    retire: vi.fn(),
    replace: vi.fn(),
    getRetirements: vi.fn(),
    getReplacements: vi.fn(),
    getFilterHomeBlock: vi.fn(),
    validateBlockChange: vi.fn(),
  },
}));

vi.mock('../modules/filter-operations/filter-operations.service.js', () => ({
  FilterOperationsService: vi.fn().mockImplementation(() => mockService),
}));

// Routes are imported AFTER the mock. They construct `new FilterOperationsService()`
// inside `routes.ts` / `events-routes.ts` which now resolves to the mocked class.
import filterOperationsRoutes from '../modules/filter-operations/routes.js';
import filterEventsRoutes from '../modules/filter-operations/events-routes.js';

// ── Constants ────────────────────────────────────────────────────────────────
const FILTER_ID = '11111111-1111-1111-1111-111111111111';
const CYCLE_ID = '22222222-2222-2222-2222-222222222222';
const PROFILE_ID = '33333333-3333-3333-3333-333333333333';
const PROFILE_VERSION = 2;
const FRESH_TAPE = PROFILE_VERSION * 1_000_000 + 5; // 2_000_005

// Reusable post-write snapshot. Includes legacy fields ON PURPOSE so the test
// can prove Fastify response schema strips them (Phase 8.7 invariant).
function postWriteSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    filterId: FILTER_ID,
    filterName: 'F-001',
    currentState: 'WASH_OUT',
    currentCycle: { id: CYCLE_ID, status: 'IN_PROGRESS', sequenceNumber: 1 },
    nextBlocks: [],
    pipelineStages: [],
    profile: { id: PROFILE_ID, name: 'std' },
    filterSet: 'A',
    totalCycles: 1,
    equipmentGroup: null,
    actions: [
      { type: 'ADVANCE', label: 'Advance to DRY_IN', targetState: 'DRY_IN' },
    ],
    tapeVersion: FRESH_TAPE + 1,
    // ── Legacy fields removed in Phase 8.7 — Fastify response schema MUST strip them ──
    nextAllowedStages: ['DRY_IN'],
    pendingChecklist: { profileId: 'cl-1', questions: [] },
    ...overrides,
  };
}

// Reusable get-state snapshot. Also includes legacy fields on purpose.
function getStateSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    filterId: FILTER_ID,
    filterName: 'F-001',
    currentState: 'WASH_IN',
    currentCycle: { id: CYCLE_ID, status: 'IN_PROGRESS' },
    nextBlocks: [],
    pipelineStages: [{ stateKey: 'WASH_IN' }, { stateKey: 'WASH_OUT' }],
    pipelineGraph: { nodes: [], edges: [] },
    profile: { id: PROFILE_ID, name: 'std' },
    filterSet: 'A',
    totalCycles: 1,
    equipmentGroup: null,
    blockEquipmentGroups: [],
    homeBlock: null,
    blockChangeStatus: null,
    isPmDue: false,
    pmReasonKey: null,
    profileSyncWarning: null,
    equipmentGroupSyncWarning: null,
    stageLookup: {
      WASH_IN: { nextStages: ['WASH_OUT'], pendingChecklistProfileIds: [], leadsToEnd: false },
    },
    actions: [
      { type: 'ADVANCE', label: 'Advance to WASH_OUT', targetState: 'WASH_OUT' },
    ],
    tapeVersion: FRESH_TAPE,
    // ── Legacy fields removed in Phase 8.7 ──
    nextAllowedStages: ['WASH_OUT'],
    pendingChecklist: null,
    ...overrides,
  };
}

describe('Phase 2 — Filter Operations route-level e2e', () => {
  let app: FastifyInstance;
  let token: string;
  let offlineGrant: string;

  beforeAll(async () => {
    // Build a minimal app inline — base `buildApp()` from test-helper doesn't
    // include filter-operations routes and calls `app.ready()` internally,
    // which prevents post-hoc `register()` calls (Fastify error: "Root plugin
    // has already booted"). Reproduce just the plugins + auth routes the
    // login flow needs, then mount our routes-under-test.
    app = Fastify({
      logger: false,
      ajv: { customOptions: { keywords: ['example'] } },
    });

    await app.register(cors, { origin: true, credentials: true });
    await app.register(authPlugin);
    await app.register(rbacPlugin);

    // Match the global error handler in test-helper.ts so service errors map
    // to consistent HTTP shapes.
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

    // Auth routes are needed so `loginAs()` can issue a real JWT.
    await app.register(authRoutes, { prefix: '/api/auth' });
    // Routes under test.
    await app.register(filterOperationsRoutes, { prefix: '/api/filters' });
    await app.register(filterEventsRoutes, { prefix: '/api/filters' });
    await app.ready();

    token = await loginAs(app);
    // Audit 2026-05-04 fix C1: legacy `x-offline-replay: true` header is
    // now rejected. Obtain a real HMAC-signed grant for replay calls.
    offlineGrant = await obtainOfflineGrant(app, token);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper: authenticated POST that bypasses reauth via offline-replay grant
  // token. Audit 2026-05-04 fix C1 — bare `x-offline-replay: true` header is
  // no longer accepted; tests obtain a real signed grant in beforeAll.
  function offlinePost(url: string, payload: unknown) {
    return app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: `Bearer ${token}`,
        'x-offline-replay-token': offlineGrant,
      },
      payload: payload as Record<string, unknown>,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 1. start-cycle happy path
  //
  // Note: start-cycle's response schema declares `additionalProperties: true`
  // (routes.ts line 162) — that's an intentional escape hatch for the cycle
  // row (Prisma returns extra columns the schema doesn't enumerate). So
  // unlike the other write routes, this one does NOT strip legacy fields by
  // schema; the no-leak guarantee is on the service layer. We assert the
  // affirmative contract only here: tape returned, cycle identity present,
  // 201 status. The legacy-fields-stripped invariant is asserted on the
  // routes whose schemas actually enforce it (advance/submit-checklist/
  // bypass/terminate-cycle/current-state below).
  // ──────────────────────────────────────────────────────────────────────────
  describe('POST /api/filters/:id/start-cycle', () => {
    it('returns 201 with cycle row + decision-tape (actions[] + tapeVersion)', async () => {
      mockService.startCycle.mockResolvedValue({
        id: CYCLE_ID,
        cycleCode: 'CC-1',
        filterId: FILTER_ID,
        status: 'IN_PROGRESS',
        sequenceNumber: 1,
        actions: [{ type: 'ADVANCE', label: 'Advance to WASH_IN' }],
        tapeVersion: FRESH_TAPE,
      });

      const res = await offlinePost(`/api/filters/${FILTER_ID}/start-cycle`, {
        cleaningReasonKey: 'ROUTINE',
        clientOpId: 'op-start-1',
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);

      // Decision-tape contract — actions[] + tapeVersion present.
      expect(Array.isArray(body.actions)).toBe(true);
      expect(typeof body.tapeVersion).toBe('number');
      expect(body.tapeVersion).toBe(FRESH_TAPE);

      // Cycle identity surfaces.
      expect(body.id).toBe(CYCLE_ID);
      expect(body.cycleCode).toBe('CC-1');
      expect(body.status).toBe('IN_PROGRESS');

      expect(mockService.startCycle).toHaveBeenCalledTimes(1);
    });

    it('returns 400 when cleaningReasonKey is missing (schema-required field)', async () => {
      const res = await offlinePost(`/api/filters/${FILTER_ID}/start-cycle`, {
        clientOpId: 'op-start-noreason',
      });

      expect(res.statusCode).toBe(400);
      expect(mockService.startCycle).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. advance happy path
  // ──────────────────────────────────────────────────────────────────────────
  describe('POST /api/filters/:id/advance', () => {
    it('returns 200 with updated actions + tapeVersion; legacy fields stripped', async () => {
      mockService.advance.mockResolvedValue(postWriteSnapshot());

      const res = await offlinePost(`/api/filters/${FILTER_ID}/advance`, {
        targetState: 'WASH_OUT',
        tapeVersion: FRESH_TAPE,
        clientOpId: 'op-advance-1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.filterId).toBe(FILTER_ID);
      expect(body.currentState).toBe('WASH_OUT');
      expect(Array.isArray(body.actions)).toBe(true);
      expect(body.actions.length).toBeGreaterThan(0);
      expect(typeof body.tapeVersion).toBe('number');
      // Tape moves forward post-write.
      expect(body.tapeVersion).toBe(FRESH_TAPE + 1);

      // Phase 8.7 invariant.
      expect(body).not.toHaveProperty('nextAllowedStages');
      expect(body).not.toHaveProperty('pendingChecklist');

      expect(mockService.advance).toHaveBeenCalledTimes(1);
      // Service receives the same body the client sent.
      const [, , bodyArg] = mockService.advance.mock.calls[0];
      expect(bodyArg).toMatchObject({ targetState: 'WASH_OUT', tapeVersion: FRESH_TAPE });
    });

    // ────────────────────────────────────────────────────────────────────────
    // 3. advance — missing tapeVersion → Fastify schema validation rejects
    // ────────────────────────────────────────────────────────────────────────
    it('returns 400 when tapeVersion is missing (Phase 8.7 schema-level required field)', async () => {
      const res = await offlinePost(`/api/filters/${FILTER_ID}/advance`, {
        targetState: 'WASH_OUT',
        clientOpId: 'op-advance-stale',
        // tapeVersion deliberately omitted
      });

      expect(res.statusCode).toBe(400);
      // Fastify validation rejects BEFORE the route handler runs, so the
      // service mock must not have been invoked.
      expect(mockService.advance).not.toHaveBeenCalled();

      // Error body should reference the missing required property.
      const body = JSON.parse(res.body);
      const text = JSON.stringify(body).toLowerCase();
      expect(text).toContain('tapeversion');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. submit-checklist happy path
  // ──────────────────────────────────────────────────────────────────────────
  describe('POST /api/filters/:id/submit-checklist', () => {
    it('returns 200 with post-write snapshot; legacy fields stripped', async () => {
      mockService.submitChecklist.mockResolvedValue(postWriteSnapshot({
        currentState: 'WASH_IN',
      }));

      const res = await offlinePost(`/api/filters/${FILTER_ID}/submit-checklist`, {
        answers: { q_1: 'PASS', q_2: 'YES' },
        tapeVersion: FRESH_TAPE,
        clientOpId: 'op-checklist-1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.filterId).toBe(FILTER_ID);
      expect(Array.isArray(body.actions)).toBe(true);
      expect(typeof body.tapeVersion).toBe('number');
      expect(body).not.toHaveProperty('nextAllowedStages');
      expect(body).not.toHaveProperty('pendingChecklist');

      expect(mockService.submitChecklist).toHaveBeenCalledTimes(1);
      const [, , bodyArg] = mockService.submitChecklist.mock.calls[0];
      expect(bodyArg).toMatchObject({
        answers: { q_1: 'PASS', q_2: 'YES' },
        tapeVersion: FRESH_TAPE,
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. bypass happy path
  // ──────────────────────────────────────────────────────────────────────────
  describe('POST /api/filters/:id/bypass', () => {
    it('returns 200 with post-write snapshot; legacy fields stripped', async () => {
      mockService.bypass.mockResolvedValue(postWriteSnapshot({
        currentState: 'DRY_IN',
      }));

      const res = await offlinePost(`/api/filters/${FILTER_ID}/bypass`, {
        targetState: 'DRY_IN',
        justification: 'Line down for emergency maintenance — bypass approved by supervisor.',
        tapeVersion: FRESH_TAPE,
        clientOpId: 'op-bypass-1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.filterId).toBe(FILTER_ID);
      expect(body.currentState).toBe('DRY_IN');
      expect(Array.isArray(body.actions)).toBe(true);
      expect(typeof body.tapeVersion).toBe('number');
      expect(body).not.toHaveProperty('nextAllowedStages');
      expect(body).not.toHaveProperty('pendingChecklist');

      expect(mockService.bypass).toHaveBeenCalledTimes(1);
    });

    it('returns 400 when justification is shorter than 10 chars (schema minLength)', async () => {
      const res = await offlinePost(`/api/filters/${FILTER_ID}/bypass`, {
        targetState: 'DRY_IN',
        justification: 'too short',
        tapeVersion: FRESH_TAPE,
      });

      expect(res.statusCode).toBe(400);
      expect(mockService.bypass).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. terminate-cycle happy path
  // ──────────────────────────────────────────────────────────────────────────
  describe('POST /api/filters/:id/terminate-cycle', () => {
    it('returns 200 with cycle-complete snapshot; tape moves forward; legacy fields stripped', async () => {
      mockService.terminateCycle.mockResolvedValue(postWriteSnapshot({
        currentState: null,
        currentCycle: { id: CYCLE_ID, status: 'TERMINATED' },
        actions: [{ type: 'START_CYCLE', label: 'Start a new cleaning cycle' }],
      }));

      const res = await offlinePost(`/api/filters/${FILTER_ID}/terminate-cycle`, {
        justification: 'Operator terminated cycle — equipment offline for repair.',
        tapeVersion: FRESH_TAPE,
        clientOpId: 'op-terminate-1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // Cycle-complete actions surface (decision-tape).
      expect(Array.isArray(body.actions)).toBe(true);
      expect(body.actions[0].type).toBe('START_CYCLE');
      expect(typeof body.tapeVersion).toBe('number');

      // Phase 8.7 invariant.
      expect(body).not.toHaveProperty('nextAllowedStages');
      expect(body).not.toHaveProperty('pendingChecklist');

      expect(mockService.terminateCycle).toHaveBeenCalledTimes(1);
    });

    it('returns 400 when tapeVersion is missing', async () => {
      const res = await offlinePost(`/api/filters/${FILTER_ID}/terminate-cycle`, {
        justification: 'Operator terminated cycle — equipment offline for repair.',
        // tapeVersion deliberately omitted
      });

      expect(res.statusCode).toBe(400);
      expect(mockService.terminateCycle).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 7. getCurrentState response shape
  // ──────────────────────────────────────────────────────────────────────────
  describe('GET /api/filters/:id/current-state', () => {
    it('returns 200 with actions[] + tapeVersion; legacy fields stripped from response', async () => {
      mockService.getCurrentState.mockResolvedValue(getStateSnapshot());

      const res = await app.inject({
        method: 'GET',
        url: `/api/filters/${FILTER_ID}/current-state`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // Decision-tape contract.
      expect(Array.isArray(body.actions)).toBe(true);
      expect(body.actions.length).toBeGreaterThan(0);
      expect(typeof body.tapeVersion).toBe('number');
      expect(body.tapeVersion).toBe(FRESH_TAPE);

      // Other expected fields.
      expect(body.filterId).toBe(FILTER_ID);
      expect(body.currentState).toBe('WASH_IN');
      expect(body.stageLookup).toBeDefined();

      // Phase 8.7 invariant — even though service-layer payload includes both
      // legacy fields, response serialization strips them.
      expect(body).not.toHaveProperty('nextAllowedStages');
      expect(body).not.toHaveProperty('pendingChecklist');

      expect(mockService.getCurrentState).toHaveBeenCalledTimes(1);
    });
  });
});
