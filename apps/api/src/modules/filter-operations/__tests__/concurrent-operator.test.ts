import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Phase 8.7 — Concurrent-Operator Collision Test Suite.
 *
 * Verifies the four documented 409 collision codes the audit
 * (`tasks/AUDIT-2026-05-02-concurrent-operator.md`) maps to each filter-operations
 * write method:
 *
 *   submitChecklist  → STALE_TAPE | ALREADY_SUBMITTED
 *   advance          → STALE_TAPE | STATE_CHANGED | CYCLE_CHANGED
 *   bypass           → STALE_TAPE | STATE_CHANGED | CYCLE_CHANGED
 *                      (Phase 8.7 follow-up added cycle-id recheck.)
 *   terminateCycle   → STALE_TAPE | STATE_CHANGED | CYCLE_CHANGED
 *                      (Phase 8.7 follow-up added SELECT FOR UPDATE + recheck.)
 *
 * Mocking strategy mirrors `tape-version-check.test.ts` and
 * `get-current-state.test.ts`:
 *   - `prisma` is mocked at module level via `vi.hoisted`.
 *   - `auditLog`, `findExistingByClientOpId`, and the upsert/clear helpers are
 *     replaced with vi.fn() noops.
 *   - The transaction mock takes a per-test override so we can simulate the
 *     post-lock state-recheck returning the value another operator wrote.
 *
 * Collision simulations:
 *   STALE_TAPE         — operator A's submitted tapeVersion lags the live
 *                        `profileVersion * 1_000_000 + events.length`.
 *   STATE_CHANGED      — `tx.$queryRaw` returns a `current_lifecycle_state`
 *                        different from the snapshot operator A loaded.
 *   CYCLE_CHANGED      — `tx.$queryRaw` returns a `current_cycle_id` different
 *                        from the snapshot operator A loaded (only advance
 *                        checks this; bypass omits it).
 *   ALREADY_SUBMITTED  — `tx.filterEvent.findFirst` returns a truthy CHECKLIST_COMPLETED
 *                        event for the same stage (operator A wrote it; B is racing).
 */

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const { mockPrisma, mockAuditLog, mockFindExistingByClientOpId, mockUpsertFilterDetails } = vi.hoisted(() => ({
  mockPrisma: {
    assetInstance: { findFirst: vi.fn(), findUnique: vi.fn() },
    cleaningCycle: { findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn(), update: vi.fn() },
    equipmentGroup: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    equipmentGroupVersion: { findUnique: vi.fn() },
    filterCleaningProfile: { findUnique: vi.fn() },
    filterProfile: { findUnique: vi.fn() },
    filterEvent: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
    filterDetails: { update: vi.fn(), upsert: vi.fn(), findUnique: vi.fn() },
    checklistProfile: { findMany: vi.fn() },
    checklistProfileVersion: { findMany: vi.fn() },
    pmScheduleEntry: { findFirst: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  mockAuditLog: vi.fn(),
  mockFindExistingByClientOpId: vi.fn(),
  mockUpsertFilterDetails: vi.fn(),
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));
// `withClientOpId` is a pure pass-through helper (no I/O); preserve the real
// implementation via importOriginal so cycle-write writers can thread the
// clientOpId into event attributes. Only the I/O-bound `findExistingByClientOpId`
// probe is mocked.
vi.mock('../../../lib/idempotency.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/idempotency.js')>();
  return { ...actual, findExistingByClientOpId: mockFindExistingByClientOpId };
});
vi.mock('../../../lib/filter-details.js', () => ({
  upsertFilterDetails: mockUpsertFilterDetails,
}));

import { FilterOperationsService } from '../filter-operations.service.js';

// ── Constants ────────────────────────────────────────────────────────────────
const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' };

const FILTER_ID = 'filter-1';
const CYCLE_ID = 'cycle-A';
const ALT_CYCLE_ID = 'cycle-B';                 // operator B's racing cycle
const PROFILE_ID = 'cp-1';

// Tape arithmetic: profileVersion=2, eventCount=5  → tapeVersion = 2_000_005.
const PROFILE_VERSION = 2;
const EVENT_COUNT = 5;
const FRESH_TAPE = PROFILE_VERSION * 1_000_000 + EVENT_COUNT;   // 2_000_005
const STALE_TAPE = FRESH_TAPE - 1;                              // 2_000_004

const CURRENT_STATE = 'WASH_IN';
const NEXT_STATE = 'WASH_OUT';
const ANOTHER_STATE = 'DRY_IN';

const VALID_JUSTIFICATION = 'Operator-initiated termination — equipment offline.';
const VALID_BYPASS_JUSTIFICATION = 'Bypass needed — line down for maintenance.';

// ── Pipeline fixture ─────────────────────────────────────────────────────────
// Two STAGE nodes wired SEQUENTIAL: WASH_IN → WASH_OUT → END.
// This is the minimal shape that lets advance()'s reachability + checklist
// gate guards pass without inventing checklist nodes.
const STAGE_WASH_IN_ID = 'stage-wash-in';
const STAGE_WASH_OUT_ID = 'stage-wash-out';
const STAGE_DRY_IN_ID = 'stage-dry-in';
const END_NODE_ID = 'node-end';

function makePipelineRow(opts: { flowMode?: 'SEQUENTIAL' | 'BYPASS_ENABLED' } = {}) {
  return {
    id: PROFILE_ID,
    name: 'std',
    flowMode: opts.flowMode ?? 'SEQUENTIAL',
    version: PROFILE_VERSION,
    status: 'ACTIVE',
    cleaningReasons: {},
    lineageId: 'lineage-1',
    stages: [
      { id: STAGE_WASH_IN_ID, stateKey: 'WASH_IN', nodeType: 'STAGE', configuration: {}, sortOrder: 0 },
      { id: STAGE_WASH_OUT_ID, stateKey: 'WASH_OUT', nodeType: 'STAGE', configuration: {}, sortOrder: 1 },
      { id: STAGE_DRY_IN_ID, stateKey: 'DRY_IN', nodeType: 'STAGE', configuration: {}, sortOrder: 2 },
      { id: END_NODE_ID, stateKey: null, nodeType: 'END', configuration: {}, sortOrder: 3 },
    ],
    connections: [
      { fromStageId: STAGE_WASH_IN_ID, toStageId: STAGE_WASH_OUT_ID },
      { fromStageId: STAGE_WASH_OUT_ID, toStageId: STAGE_DRY_IN_ID },
      { fromStageId: STAGE_DRY_IN_ID, toStageId: END_NODE_ID },
    ],
  };
}

function cycleRow(overrides: Partial<{ id: string; profileId: string; profileVersion: number; status: string }> = {}) {
  return {
    id: overrides.id ?? CYCLE_ID,
    cycleCode: 'CC-1',
    filterId: FILTER_ID,
    profileId: overrides.profileId ?? PROFILE_ID,
    profileVersion: overrides.profileVersion ?? PROFILE_VERSION,
    status: overrides.status ?? 'IN_PROGRESS',
    cleaningAreaId: null,
    equipmentGroupId: null,
    equipmentGroupVersionPin: null,
    checklistVersionPins: null,
    dryerStartedAt: null,
    dryerDurationMinutes: null,
    dryerReadingsSubmitted: false,
    cleaningReasonKey: 'ROUTINE',
    cleaningReasonLabel: 'Routine',
    startedAt: new Date(0),
    completedAt: null,
    terminatedAt: null,
    sequenceNumber: 1,
  };
}

function filterRow() {
  return {
    id: FILTER_ID,
    name: 'F-001',
    parentId: null,
    template: { templateKind: 'FILTER' },
    filterDetails: {
      filterProfileId: PROFILE_ID,
      currentLifecycleState: CURRENT_STATE,
      currentCycleId: CYCLE_ID,
      filterSet: 'A',
    },
  };
}

/**
 * Wire prisma + idempotency mocks to a sane in-progress baseline. Each test
 * then overrides the one or two calls it needs to simulate the collision.
 *
 * `txOverride` lets a test inject the proxy `tx` object the service code
 * runs against inside the transaction callback — used to make `tx.$queryRaw`
 * return a "another operator changed it" snapshot, or `tx.filterEvent.findFirst`
 * return an existing event row.
 */
function setupBaseline(txOverride?: (tx: any) => void) {
  // Filter (loadLocalContext + getFilter use this).
  mockPrisma.assetInstance.findFirst.mockResolvedValue(filterRow());
  // FilterDetails findUnique used by startCycle's recheck only — not by these methods.
  mockPrisma.filterDetails.findUnique.mockResolvedValue({ currentCycleId: CYCLE_ID });
  // Cycle.
  mockPrisma.cleaningCycle.findUnique.mockResolvedValue(cycleRow());
  // Events: length matters for tape arithmetic + assertChecklistGatePassed sees no events.
  const events = Array.from({ length: EVENT_COUNT }, (_, i) => ({
    id: `evt-${i}`,
    cycleId: CYCLE_ID,
    eventType: 'STATE_TRANSITION',
    fromState: null,
    toState: null,
    performedAt: new Date(),
    attributes: {},
  }));
  mockPrisma.filterEvent.findMany.mockResolvedValue(events);
  mockPrisma.filterEvent.count.mockResolvedValue(EVENT_COUNT);
  mockPrisma.filterEvent.findFirst.mockResolvedValue(null);

  // Profile resolution chain.
  mockPrisma.filterProfile.findUnique.mockResolvedValue(null);
  mockPrisma.filterCleaningProfile.findUnique.mockResolvedValue(makePipelineRow());

  // No bound equipment group on this cycle.
  mockPrisma.equipmentGroup.findUnique.mockResolvedValue(null);
  mockPrisma.equipmentGroup.findFirst.mockResolvedValue(null);
  mockPrisma.equipmentGroup.findMany.mockResolvedValue([]);

  // Idempotency: never previously seen.
  mockFindExistingByClientOpId.mockResolvedValue(null);

  // For the final getCurrentState() call after a successful write.
  mockPrisma.assetInstance.findUnique.mockResolvedValue({
    id: FILTER_ID, name: 'F-001', parentId: null, template: { templateKind: 'FILTER' },
  });
  mockPrisma.cleaningCycle.findFirst.mockResolvedValue(null);
  mockPrisma.cleaningCycle.count.mockResolvedValue(0);
  mockPrisma.systemConfig.findUnique.mockResolvedValue(null);
  mockPrisma.pmScheduleEntry.findFirst.mockResolvedValue(null);

  // Transaction proxy. By default, the locked row's state matches the snapshot
  // operator A loaded — so STATE_CHANGED + CYCLE_CHANGED do NOT fire.
  // Tests that want a collision pass a `txOverride` to flip the returned row.
  mockPrisma.$transaction.mockImplementation(async (cb: any) => {
    const tx: any = {
      $queryRaw: vi.fn().mockResolvedValue([
        { current_lifecycle_state: CURRENT_STATE, current_cycle_id: CYCLE_ID },
      ]),
      cleaningCycle: { update: vi.fn().mockResolvedValue({}) },
      filterDetails: { update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
      filterEvent: {
        create: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    if (txOverride) txOverride(tx);
    return cb(tx);
  });
}

describe('Phase 8.7 — Concurrent-Operator Collision Codes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────────
  // 1. submitChecklist
  // ────────────────────────────────────────────────────────────────────────
  describe('submitChecklist()', () => {
    it('STALE_TAPE — operator A submits with old tapeVersion after operator B advanced (tape moved on)', async () => {
      // Operator B already advanced — events.length grew, so the live tape is
      // FRESH_TAPE. Operator A's request still carries STALE_TAPE.
      setupBaseline();
      const service = new FilterOperationsService();

      await expect(
        service.submitChecklist(ctx, FILTER_ID, {
          answers: {},
          clientOpId: 'op-A',
          tapeVersion: STALE_TAPE,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'STALE_TAPE',
        details: { currentTapeVersion: FRESH_TAPE },
      });
      // Tape rejection MUST happen before the transaction body runs.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('STATE_CHANGED — operator A snapshots the stage; operator B advanced/bypassed before A acquires the row lock', async () => {
      // 2026-07-04 race fix: submitChecklist now rechecks (state, cycle) post-lock
      // via lockAndVerifyFilterState. The locked row reports a DIFFERENT
      // currentLifecycleState → 409 STATE_CHANGED, before any completion write.
      setupBaseline((tx) => {
        tx.$queryRaw.mockResolvedValue([
          { current_lifecycle_state: NEXT_STATE, current_cycle_id: CYCLE_ID },
        ]);
      });
      const service = new FilterOperationsService();

      await expect(
        service.submitChecklist(ctx, FILTER_ID, {
          answers: {},
          clientOpId: 'op-A',
          tapeVersion: FRESH_TAPE,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'STATE_CHANGED',
      });
      // Transaction WAS entered — the rejection happens after the row lock.
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('CYCLE_CHANGED — operator A snapshots cycle X; operator B terminated it before A acquires the lock (else the completion branch flips TERMINATED→COMPLETED)', async () => {
      // The exact contradictory-record race: same currentLifecycleState (state
      // check passes) but a DIFFERENT current_cycle_id → 409 CYCLE_CHANGED,
      // so A's completion writes never clobber B's terminate.
      setupBaseline((tx) => {
        tx.$queryRaw.mockResolvedValue([
          { current_lifecycle_state: CURRENT_STATE, current_cycle_id: ALT_CYCLE_ID },
        ]);
      });
      const service = new FilterOperationsService();

      await expect(
        service.submitChecklist(ctx, FILTER_ID, {
          answers: {},
          clientOpId: 'op-A',
          tapeVersion: FRESH_TAPE,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'CYCLE_CHANGED',
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('ALREADY_SUBMITTED — operator A already wrote CHECKLIST_COMPLETED for this stage; operator B (different clientOpId) hits the duplicate check', async () => {
      // Two different clientOpIds — same cycle, same stage. Operator A's
      // submission is already persisted; B races behind A and the in-txn
      // findFirst returns A's event row, triggering 409 ALREADY_SUBMITTED.
      // (Same clientOpId would short-circuit at findExistingByClientOpId and
      // return getCurrentState() — that's idempotent replay, not a collision.)
      setupBaseline((tx) => {
        tx.filterEvent.findFirst.mockResolvedValue({
          id: 'existing-event-from-operator-A',
          eventType: 'CHECKLIST_COMPLETED',
          attributes: { afterStage: CURRENT_STATE },
        });
      });
      const service = new FilterOperationsService();

      await expect(
        service.submitChecklist(ctx, FILTER_ID, {
          answers: {},
          clientOpId: 'op-B',
          tapeVersion: FRESH_TAPE,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'ALREADY_SUBMITTED',
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 2. advance
  // ────────────────────────────────────────────────────────────────────────
  describe('advance()', () => {
    it('STALE_TAPE — operator B already advanced; operator A submits with old tape', async () => {
      setupBaseline();
      const service = new FilterOperationsService();

      await expect(
        service.advance(ctx, FILTER_ID, {
          targetState: NEXT_STATE,
          clientOpId: 'op-A',
          tapeVersion: STALE_TAPE,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'STALE_TAPE',
        details: { currentTapeVersion: FRESH_TAPE },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('STATE_CHANGED — operator A snapshots WASH_IN; operator B advanced to WASH_OUT before A acquires the row lock', async () => {
      // Operator A's snapshot says state=WASH_IN, cycle unchanged. Inside
      // the txn the SELECT FOR UPDATE returns state=WASH_OUT — so the
      // post-lock recheck rejects with STATE_CHANGED. Cycle id is unchanged
      // so the cycle check (which runs after) doesn't fire.
      setupBaseline((tx) => {
        tx.$queryRaw.mockResolvedValue([
          { current_lifecycle_state: NEXT_STATE, current_cycle_id: CYCLE_ID },
        ]);
      });
      const service = new FilterOperationsService();

      await expect(
        service.advance(ctx, FILTER_ID, {
          targetState: NEXT_STATE,
          clientOpId: 'op-A',
          tapeVersion: FRESH_TAPE,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'STATE_CHANGED',
      });
      // Transaction WAS entered — the rejection happens after the row lock.
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('CYCLE_CHANGED — operator A snapshots cycle X; operator B terminated cycle X and started cycle Y before A acquires the lock', async () => {
      // For CYCLE_CHANGED to fire, the locked row must report the SAME
      // currentLifecycleState (so the state check passes) but a DIFFERENT
      // currentCycleId. That's exactly the "B terminated and re-started"
      // race the audit predicts.
      setupBaseline((tx) => {
        tx.$queryRaw.mockResolvedValue([
          { current_lifecycle_state: CURRENT_STATE, current_cycle_id: ALT_CYCLE_ID },
        ]);
      });
      const service = new FilterOperationsService();

      await expect(
        service.advance(ctx, FILTER_ID, {
          targetState: NEXT_STATE,
          clientOpId: 'op-A',
          tapeVersion: FRESH_TAPE,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'CYCLE_CHANGED',
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it.skip('ALREADY_SUBMITTED — n/a for advance; no checklist-event duplicate check', () => {
      // advance() writes STATE_TRANSITION events, not CHECKLIST_COMPLETED, and
      // has no equivalent duplicate-submission code path. The collision the
      // audit expects here is STATE_CHANGED / CYCLE_CHANGED, both covered above.
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 3. bypass
  // ────────────────────────────────────────────────────────────────────────
  describe('bypass()', () => {
    it('STALE_TAPE — operator B already advanced; operator A submits a bypass with old tape', async () => {
      // bypass() requires flowMode=BYPASS_ENABLED to pass assertBypassAllowed.
      setupBaseline();
      mockPrisma.filterCleaningProfile.findUnique.mockResolvedValue(makePipelineRow({ flowMode: 'BYPASS_ENABLED' }));
      const service = new FilterOperationsService();

      await expect(
        service.bypass(ctx, FILTER_ID, {
          targetState: ANOTHER_STATE,
          justification: VALID_BYPASS_JUSTIFICATION,
          clientOpId: 'op-A',
          tapeVersion: STALE_TAPE,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'STALE_TAPE',
        details: { currentTapeVersion: FRESH_TAPE },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it.skip('STATE_CHANGED — fired only by advance() in the audit; bypass shares the same code path. The audit lists this collision under bypass at line 1641 — exercised here.', () => {
      // Note: superseded by the explicit STATE_CHANGED test below — kept as
      // a stub for a moment to make the matrix scan-clean.
    });

    it('STATE_CHANGED — operator A snapshots WASH_IN; operator B advanced to WASH_OUT before A acquires the bypass lock', async () => {
      setupBaseline((tx) => {
        // Phase 8.7 follow-up: bypass now SELECTs both columns. State check
        // fires first, so cycle_id matching the snapshot keeps STATE_CHANGED
        // as the firing code rather than CYCLE_CHANGED.
        tx.$queryRaw.mockResolvedValue([
          { current_lifecycle_state: NEXT_STATE, current_cycle_id: CYCLE_ID },
        ]);
      });
      mockPrisma.filterCleaningProfile.findUnique.mockResolvedValue(makePipelineRow({ flowMode: 'BYPASS_ENABLED' }));
      const service = new FilterOperationsService();

      await expect(
        service.bypass(ctx, FILTER_ID, {
          targetState: ANOTHER_STATE,
          justification: VALID_BYPASS_JUSTIFICATION,
          clientOpId: 'op-A',
          tapeVersion: FRESH_TAPE,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'STATE_CHANGED',
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('CYCLE_CHANGED — operator A snapshots cycle X; operator B terminated X and started cycle Y before A acquires the bypass lock', async () => {
      // Phase 8.7 follow-up: bypass now ALSO rechecks current_cycle_id inside
      // the row lock (mirrors advance — see filter-operations.service.ts).
      // The locked row reports the SAME currentLifecycleState (state check
      // passes) but a DIFFERENT currentCycleId — that's the "B terminated and
      // re-started" race the audit predicts.
      setupBaseline((tx) => {
        tx.$queryRaw.mockResolvedValue([
          { current_lifecycle_state: CURRENT_STATE, current_cycle_id: ALT_CYCLE_ID },
        ]);
      });
      mockPrisma.filterCleaningProfile.findUnique.mockResolvedValue(makePipelineRow({ flowMode: 'BYPASS_ENABLED' }));
      const service = new FilterOperationsService();

      await expect(
        service.bypass(ctx, FILTER_ID, {
          targetState: ANOTHER_STATE,
          justification: VALID_BYPASS_JUSTIFICATION,
          clientOpId: 'op-A',
          tapeVersion: FRESH_TAPE,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'CYCLE_CHANGED',
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it.skip('ALREADY_SUBMITTED — n/a for bypass; no duplicate-event check', () => {
      // bypass writes BYPASS_DEVIATION events; no duplicate guard.
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 4. terminateCycle
  // ────────────────────────────────────────────────────────────────────────
  describe('terminateCycle()', () => {
    it('STALE_TAPE — operator B already advanced; operator A terminates with old tape', async () => {
      setupBaseline();
      const service = new FilterOperationsService();

      await expect(
        service.terminateCycle(ctx, FILTER_ID, {
          justification: VALID_JUSTIFICATION,
          clientOpId: 'op-A',
          tapeVersion: STALE_TAPE,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'STALE_TAPE',
        details: { currentTapeVersion: FRESH_TAPE },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('STATE_CHANGED — operator A snapshots WASH_IN; operator B advanced to WASH_OUT before A acquires the terminate lock', async () => {
      // Phase 8.7 follow-up: terminateCycle now SELECT FOR UPDATE + rechecks
      // current_lifecycle_state (mirrors advance — see filter-operations.service.ts).
      // Closes the gap audit AUDIT-2026-05-02-concurrent-operator.md called out
      // at lines 83-87 ("Lock Acquisition: NONE; State Recheck: MISSING").
      setupBaseline((tx) => {
        tx.$queryRaw.mockResolvedValue([
          { current_lifecycle_state: NEXT_STATE, current_cycle_id: CYCLE_ID },
        ]);
      });
      const service = new FilterOperationsService();

      await expect(
        service.terminateCycle(ctx, FILTER_ID, {
          justification: VALID_JUSTIFICATION,
          clientOpId: 'op-A',
          tapeVersion: FRESH_TAPE,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'STATE_CHANGED',
      });
      // Transaction WAS entered — the rejection happens after the row lock.
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('CYCLE_CHANGED — operator A snapshots cycle X; operator B terminated X and started cycle Y before A acquires the terminate lock', async () => {
      // Phase 8.7 follow-up: terminateCycle also rechecks current_cycle_id
      // inside the row lock. Locked row reports the SAME
      // currentLifecycleState (so state check passes) but a DIFFERENT
      // currentCycleId — exactly the "B terminated and re-started" race.
      setupBaseline((tx) => {
        tx.$queryRaw.mockResolvedValue([
          { current_lifecycle_state: CURRENT_STATE, current_cycle_id: ALT_CYCLE_ID },
        ]);
      });
      const service = new FilterOperationsService();

      await expect(
        service.terminateCycle(ctx, FILTER_ID, {
          justification: VALID_JUSTIFICATION,
          clientOpId: 'op-A',
          tapeVersion: FRESH_TAPE,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'CYCLE_CHANGED',
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it.skip('ALREADY_SUBMITTED — n/a for terminateCycle; not a checklist write', () => {
      // No checklist event involved.
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Cross-cutting sanity: the fresh-tape happy path on advance still succeeds.
  // Without this the suite could be all-red trivially.
  // ────────────────────────────────────────────────────────────────────────
  describe('happy-path control (no collision)', () => {
    it('advance with fresh tape + matching locked snapshot completes the transaction', async () => {
      setupBaseline();
      const service = new FilterOperationsService();
      await expect(
        service.advance(ctx, FILTER_ID, {
          targetState: NEXT_STATE,
          clientOpId: 'op-fresh',
          tapeVersion: FRESH_TAPE,
        }),
      ).resolves.not.toThrow();
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});
