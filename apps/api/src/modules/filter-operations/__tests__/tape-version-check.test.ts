import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Phase 8.3 — server-side tape-version concurrency check.
 *
 * Tests the assertTapeVersionFresh() helper inside the 4 write methods via
 * terminateCycle() — chosen because it has the smallest dependency surface
 * (no cleaning-profile pipeline lookup), so the concurrency-check path is
 * exercised cleanly without unrelated mocks.
 *
 * Mocking pattern follows get-current-state.test.ts: prisma + audit + the
 * idempotency helper are mocked; service is constructed normally.
 */

const { mockPrisma, mockAuditLog, mockFindExistingByClientOpId } = vi.hoisted(() => ({
  mockPrisma: {
    assetInstance: { findFirst: vi.fn(), findUnique: vi.fn() },
    cleaningCycle: { findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn(), update: vi.fn() },
    equipmentGroup: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    equipmentGroupVersion: { findUnique: vi.fn() },
    filterCleaningProfile: { findUnique: vi.fn() },
    filterProfile: { findUnique: vi.fn() },
    filterEvent: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
    filterDetails: { update: vi.fn() },
    checklistProfile: { findMany: vi.fn() },
    checklistProfileVersion: { findMany: vi.fn() },
    pmScheduleEntry: { findFirst: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  mockAuditLog: vi.fn(),
  mockFindExistingByClientOpId: vi.fn(),
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

import { FilterOperationsService } from '../filter-operations.service.js';

const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' };

const FILTER_ID = 'filter-1';
const CYCLE_ID = 'cycle-1';

const VALID_JUSTIFICATION = 'Operator-initiated termination — equipment offline.';

function setupBaselineMocks(opts: {
  cycleProfileVersion: number;
  filterEventCount: number;
}) {
  // getFilter() — has an active cycle.
  mockPrisma.assetInstance.findFirst.mockResolvedValue({
    id: FILTER_ID,
    name: 'F-001',
    parentId: null,
    filterDetails: {
      filterProfileId: 'fp-1',
      currentLifecycleState: 'WASH_IN',
      currentCycleId: CYCLE_ID,
      filterSet: 'A',
    },
  });
  // assertTapeVersionFresh() inputs — Phase 8.5 Commit 3 reads cycle via
  // loadLocalContext (`prisma.cleaningCycle.findUnique`) and event count via
  // `prisma.filterEvent.findMany` (length matters; attribute shape doesn't).
  mockPrisma.cleaningCycle.findUnique.mockResolvedValue({
    id: CYCLE_ID,
    profileId: 'cp-1',
    profileVersion: opts.cycleProfileVersion,
    status: 'IN_PROGRESS',
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
    cycleCode: '',
    filterId: FILTER_ID,
  });
  // Phase 8.5 Commit 3 swap: `assertTapeVersionFresh` reads ctx.events.length,
  // not a count() query. Build a minimal-shape event array of the right length.
  const events = Array.from({ length: opts.filterEventCount }, (_, i) => ({
    id: `evt-${i}`,
    cycleId: CYCLE_ID,
    eventType: 'STATE_TRANSITION',
    fromState: null,
    toState: null,
    performedAt: new Date(),
    attributes: {},
  }));
  mockPrisma.filterEvent.findMany.mockResolvedValue(events);
  mockPrisma.filterEvent.count.mockResolvedValue(opts.filterEventCount);
  // Profile lookup chain (loadLocalContext → loadCleaningProfile).
  mockPrisma.filterProfile.findUnique.mockResolvedValue(null);
  mockPrisma.filterCleaningProfile.findUnique.mockResolvedValue({
    id: 'cp-1',
    name: 'std',
    flowMode: 'SEQUENTIAL',
    version: opts.cycleProfileVersion,
    status: 'ACTIVE',
    cleaningReasons: {},
    stages: [],
    connections: [],
  });
  // Idempotency: never previously seen.
  mockFindExistingByClientOpId.mockResolvedValue(null);
  // Transaction: just invoke the callback so the txn body runs against the
  // (mocked) tx.* fields. We give the callback a tx object that proxies to
  // mockPrisma's per-table mocks.
  // Phase 8.7 follow-up: terminateCycle now does SELECT FOR UPDATE on
  // filter_details inside the txn — the tx proxy must expose `$queryRaw`
  // returning a row that matches the pre-lock snapshot (state=WASH_IN,
  // cycle=CYCLE_ID), otherwise the recheck rejects with STATE_CHANGED /
  // CYCLE_CHANGED before we get to test the tape-version path.
  mockPrisma.$transaction.mockImplementation(async (cb: any) => {
    return cb({
      $queryRaw: vi.fn().mockResolvedValue([
        { current_lifecycle_state: 'WASH_IN', current_cycle_id: CYCLE_ID },
      ]),
      cleaningCycle: { update: vi.fn().mockResolvedValue({}) },
      filterDetails: { update: vi.fn().mockResolvedValue({}) },
      filterEvent: { create: vi.fn().mockResolvedValue({}) },
    });
  });
  // For getCurrentState() final call — make it return null cycle so the
  // happy-path doesn't fail mid-render. The check we care about runs BEFORE
  // the txn, so a cycle=null final getCurrentState is fine for these tests.
  mockPrisma.cleaningCycle.findFirst.mockResolvedValue(null);
  mockPrisma.systemConfig.findUnique.mockResolvedValue(null);
  mockPrisma.pmScheduleEntry.findFirst.mockResolvedValue(null);
  mockPrisma.filterEvent.findFirst.mockResolvedValue(null);
  mockPrisma.cleaningCycle.count.mockResolvedValue(0);
  mockPrisma.equipmentGroup.findFirst.mockResolvedValue(null);
  mockPrisma.equipmentGroup.findMany.mockResolvedValue([]);
  // Final getCurrentState() also walks parents via findUnique. Stop the loop
  // by returning a non-BLOCK with no parent.
  mockPrisma.assetInstance.findUnique.mockResolvedValue({
    id: FILTER_ID, name: 'F-001', parentId: null, template: { templateKind: 'FILTER' },
  });
}

describe('Phase 8.3 — server tape-version concurrency check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. tapeVersion matches → write proceeds (no STALE_TAPE)', async () => {
    // Phase 8.4 M3: profileVersion=2, filterEventCount=5
    // → tapeVersion = 2 * 1_000_000 + 5 = 2_000_005.
    setupBaselineMocks({ cycleProfileVersion: 2, filterEventCount: 5 });
    const service = new FilterOperationsService();
    await expect(
      service.terminateCycle(ctx, FILTER_ID, { justification: VALID_JUSTIFICATION, tapeVersion: 2_000_005 }),
    ).resolves.not.toThrow();
    // Phase 8.5 Commit 3: loadLocalContext loads events via findMany;
    // assertTapeVersionFresh reads ctx.events.length. Concurrency check still
    // runs — just expressed via findMany rather than count.
    expect(mockPrisma.filterEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { filterId: FILTER_ID, cycleId: CYCLE_ID } }),
    );
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('2. tapeVersion mismatched → 409 STALE_TAPE with currentTapeVersion in details', async () => {
    // Live tapeVersion = 2_000_005 but client sent 2_000_003 (stale).
    setupBaselineMocks({ cycleProfileVersion: 2, filterEventCount: 5 });
    const service = new FilterOperationsService();
    await expect(
      service.terminateCycle(ctx, FILTER_ID, { justification: VALID_JUSTIFICATION, tapeVersion: 2_000_003 }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'STALE_TAPE',
      details: { currentTapeVersion: 2_000_005 },
    });
    // Critically: the mismatch must reject BEFORE the transaction runs.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('3. tapeVersion absent → write proceeds (backward compat for pre-cutover callers)', async () => {
    setupBaselineMocks({ cycleProfileVersion: 2, filterEventCount: 5 });
    const service = new FilterOperationsService();
    await expect(
      service.terminateCycle(ctx, FILTER_ID, { justification: VALID_JUSTIFICATION }),
    ).resolves.not.toThrow();
    // The concurrency check itself is a non-op when tapeVersion is undefined;
    // loadLocalContext still loads events (it's the universal context loader),
    // so we only assert the txn ran.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
