import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * M39 — getBatchStates must not re-read shared rows once per filter.
 *
 * getBatchStates fans getCurrentState out across every active filter. Most of
 * what getCurrentState reads is NOT per-filter: the stage-interlock config, the
 * cleaning-profile-assignment config, each cleaning profile's pipeline (many
 * filters share one profile), and each AHU's PM entry. Pre-fix every one of
 * those was re-read PER FILTER — measured at 3,099 Prisma reads for 199 active
 * filters on the tablet's offline-cache-warmup hot path.
 *
 * A batch-scoped read memo (batch-cache.ts) collapses them to one apiece.
 * These tests lock that in: the counts below are per-BATCH, not per-filter, so
 * they must not scale with FILTER_IDS.length.
 *
 * The output contract is locked separately by the D5 parity test
 * (deep-review-d5-d7.test.ts), which asserts the batch's per-filter object
 * deep-equals what the un-memoised single-filter path returns.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    assetInstance: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    cleaningCycle: { findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn(), groupBy: vi.fn(), update: vi.fn() },
    equipmentGroup: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    equipmentGroupVersion: { findUnique: vi.fn() },
    filterCleaningProfile: { findUnique: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    filterProfile: { findUnique: vi.fn() },
    filterEvent: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    checklistProfile: { findMany: vi.fn() },
    checklistProfileVersion: { findMany: vi.fn() },
    pmScheduleEntry: { findFirst: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
  },
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: vi.fn() }));

import { FilterOperationsService } from '../filter-operations.service.js';

const ctx = {
  userId: 'admin', userSub: 'sub-1', userRole: 'ADMIN' as const,
  ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1',
};

// Three filters, all children of ONE AHU — the real-world shape (199 filters
// across a few dozen AHUs), which is exactly what makes the fan-out wasteful.
const FILTER_IDS = ['f-1', 'f-2', 'f-3'];
const AHU_ID = 'ahu-1';
const PROFILE_ID = 'profile-shared';

const instanceFixture = (id: string) => ({
  id,
  name: `F-${id}`,
  parentId: AHU_ID,
  attributes: {},
  template: { templateKind: 'FILTER' },
  filterDetails: {
    // Direct assignment to ONE shared profile — all three filters render the
    // same pipeline, so it must be loaded once.
    filterProfileId: PROFILE_ID,
    currentLifecycleState: null,
    currentCycleId: null,
    filterSet: 'A',
  },
});

const countConfigReads = (key: string) =>
  mockPrisma.systemConfig.findUnique.mock.calls.filter(
    ([arg]: any[]) => arg?.where?.configKey === key,
  ).length;

describe('M39 — getBatchStates does not re-read shared rows per filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.assetInstance.findMany.mockResolvedValue(FILTER_IDS.map((id) => ({ id })));
    mockPrisma.assetInstance.findFirst.mockImplementation(async ({ where }: any) => instanceFixture(where.id));
    // The home-block / ancestor walk: filter -> AHU -> BLOCK.
    mockPrisma.assetInstance.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === AHU_ID) return { id: AHU_ID, name: 'AHU-1', parentId: 'block-1', template: { templateKind: 'AHU' } };
      if (where.id === 'block-1') return { id: 'block-1', name: 'Block 1', parentId: null, template: { templateKind: 'BLOCK' } };
      return instanceFixture(where.id);
    });
    mockPrisma.cleaningCycle.findUnique.mockResolvedValue(null);
    mockPrisma.cleaningCycle.findFirst.mockResolvedValue(null);
    mockPrisma.cleaningCycle.count.mockResolvedValue(0);
    mockPrisma.cleaningCycle.groupBy.mockResolvedValue([]);
    mockPrisma.filterProfile.findUnique.mockResolvedValue(null);
    mockPrisma.filterCleaningProfile.findUnique.mockResolvedValue({
      id: PROFILE_ID, name: 'Shared', flowMode: 'SEQUENTIAL', status: 'ACTIVE', stages: [], connections: [],
    });
    mockPrisma.systemConfig.findUnique.mockResolvedValue(null);
    mockPrisma.pmScheduleEntry.findFirst.mockResolvedValue(null);
  });

  it('reads the stage-interlock config ONCE per batch, not once per filter', async () => {
    const service = new FilterOperationsService();
    const res: any = await service.getBatchStates(ctx, undefined);

    expect(Object.keys(res.states)).toHaveLength(FILTER_IDS.length);
    expect(countConfigReads('stage-interlock')).toBe(1);
  });

  it('loads a shared cleaning-profile pipeline ONCE, not once per filter', async () => {
    const service = new FilterOperationsService();
    await service.getBatchStates(ctx, undefined);

    // All three filters point at PROFILE_ID, so the pipeline is one load.
    expect(mockPrisma.filterCleaningProfile.findUnique).toHaveBeenCalledTimes(1);
  });

  it("reads an AHU's PM-due entry ONCE for all of its filters", async () => {
    const service = new FilterOperationsService();
    await service.getBatchStates(ctx, undefined);

    // The PM window question is per-AHU; all three filters share AHU_ID.
    expect(mockPrisma.pmScheduleEntry.findFirst).toHaveBeenCalledTimes(1);
  });

  it('counts cycles for every filter in ONE groupBy instead of a count per filter', async () => {
    const service = new FilterOperationsService();
    await service.getBatchStates(ctx, undefined);

    expect(mockPrisma.cleaningCycle.groupBy).toHaveBeenCalledTimes(1);
    expect(mockPrisma.cleaningCycle.count).not.toHaveBeenCalled();
  });

  it('walks each shared ancestor ONCE across the whole batch', async () => {
    const service = new FilterOperationsService();
    await service.getBatchStates(ctx, undefined);

    const reads = (id: string) =>
      mockPrisma.assetInstance.findUnique.mock.calls.filter(([a]: any[]) => a?.where?.id === id).length;
    // The AHU and block are on every filter's home-block walk.
    expect(reads(AHU_ID)).toBe(1);
    expect(reads('block-1')).toBe(1);
  });

  it('leaves the single-filter path un-memoised (no cache arg → per-call reads)', async () => {
    const service = new FilterOperationsService();
    // Two independent polls of the SAME filter must each do their own reads —
    // the memo is batch-scoped only, so there is no cross-request staleness.
    await service.getCurrentState(ctx, 'f-1', undefined);
    await service.getCurrentState(ctx, 'f-1', undefined);

    expect(countConfigReads('stage-interlock')).toBe(2);
    expect(mockPrisma.cleaningCycle.count).toHaveBeenCalledTimes(2);
    expect(mockPrisma.cleaningCycle.groupBy).not.toHaveBeenCalled();
  });
});
