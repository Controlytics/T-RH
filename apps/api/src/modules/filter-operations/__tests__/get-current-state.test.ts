import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests for FilterOperationsService.getCurrentState()
 *
 * Covers the L1 (equipment-group snapshot pinning) and L2 (cycle-pinned
 * cleaning-profile pipeline rendering) invariants — regression coverage so a
 * future refactor cannot silently revert either path back to live-row reads.
 *
 * Mocking strategy: prisma is mocked directly per the canonical pattern in
 * apps/api/src/modules/assets/services/__tests__/instance.service.test.ts.
 * The service's private `getProfilePipeline()` is replaced with a vi.fn() spy
 * on the instance after construction so we can assert the L2 invariant by
 * call-args (option (a) in the task brief — simplest available approach).
 */

// ── prisma mock + dependency mocks ────────────────────────────────────────
const { mockPrisma, mockAuditLog } = vi.hoisted(() => ({
  mockPrisma: {
    assetInstance: { findFirst: vi.fn(), findUnique: vi.fn() },
    cleaningCycle: { findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn(), update: vi.fn() },
    equipmentGroup: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    equipmentGroupVersion: { findUnique: vi.fn() },
    filterCleaningProfile: { findUnique: vi.fn() },
    filterProfile: { findUnique: vi.fn() },
    filterEvent: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    checklistProfile: { findMany: vi.fn() },
    checklistProfileVersion: { findMany: vi.fn() },
    pmScheduleEntry: { findFirst: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
  },
  mockAuditLog: vi.fn(),
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));
// block-change-requests/block-change.service.js is dynamically imported inside
// getCurrentState() — only when filter has no cycle AND a cleaningAreaId is
// passed. Our tests never trigger that branch, so no static mock needed.

import { FilterOperationsService } from '../filter-operations.service.js';

const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' };

const FILTER_ID = 'filter-1';
const CYCLE_ID = 'cycle-1';
const GROUP_ID = 'group-1';
const CYCLE_PROFILE_ID = 'fcp-cycle-pinned';   // cleaning profile id pinned at cycle start
const LIVE_PROFILE_ID = 'fp-live-binding';     // FilterProfile.id resolved live (different from cycle's pin)

// Reusable filter fixture — has a cycle in progress.
function filterWithCycle() {
  return {
    id: FILTER_ID,
    name: 'F-001',
    parentId: 'parent-1',
    template: { templateKind: 'FILTER' },
    filterDetails: {
      filterProfileId: LIVE_PROFILE_ID,
      currentLifecycleState: null, // no current STAGE — keeps the pipeline-walking branch out of these tests
      currentCycleId: CYCLE_ID,
      filterSet: 'A',
    },
  };
}

// Reusable cycle fixture.
function cycleFixture(overrides: Partial<{
  equipmentGroupId: string | null;
  equipmentGroupVersionPin: number | null;
  profileId: string;
  cleaningAreaId: string | null;
  checklistVersionPins: Record<string, number> | null;
}> = {}) {
  return {
    id: CYCLE_ID,
    filterId: FILTER_ID,
    profileId: overrides.profileId ?? CYCLE_PROFILE_ID,
    equipmentGroupId: overrides.equipmentGroupId === undefined ? GROUP_ID : overrides.equipmentGroupId,
    equipmentGroupVersionPin: overrides.equipmentGroupVersionPin === undefined ? 3 : overrides.equipmentGroupVersionPin,
    cleaningAreaId: overrides.cleaningAreaId === undefined ? 'block-1' : overrides.cleaningAreaId,
    checklistVersionPins: overrides.checklistVersionPins ?? null,
    status: 'IN_PROGRESS',
  };
}

// Stub pipeline that getProfilePipeline() returns. Empty stages/connections
// keep the pipeline-walking branches inert; the response still surfaces
// equipmentGroup + warnings which is what L1 cares about.
const stubPipeline = {
  id: CYCLE_PROFILE_ID,
  name: 'Cycle-Pinned Profile',
  flowMode: 'SEQUENTIAL',
  status: 'ACTIVE',
  stages: [],
  connections: [],
};

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Wire up the minimum prisma stub returns needed for getCurrentState() to run
 * end-to-end without throwing. Tests then override the L1/L2-specific calls.
 */
function setupMinimalReads(filter = filterWithCycle(), cycle = cycleFixture()) {
  mockPrisma.assetInstance.findFirst.mockResolvedValue(filter);
  // getFilterHomeBlock walks parents looking for templateKind='BLOCK'. We
  // return the parent immediately as a non-BLOCK with no further parent so
  // the loop exits returning null (no homeBlock).
  mockPrisma.assetInstance.findUnique.mockImplementation(async (args: any) => {
    if (args.where?.id === FILTER_ID) {
      return { id: FILTER_ID, name: 'F-001', parentId: 'parent-1', template: { templateKind: 'FILTER' } };
    }
    if (args.where?.id === 'parent-1') {
      return { id: 'parent-1', name: 'AHU-1', parentId: null, template: { templateKind: 'AHU' } };
    }
    return null;
  });
  mockPrisma.cleaningCycle.findUnique.mockResolvedValue(cycle);
  mockPrisma.cleaningCycle.count.mockResolvedValue(0);
  mockPrisma.systemConfig.findUnique.mockResolvedValue(null);
  mockPrisma.pmScheduleEntry.findFirst.mockResolvedValue(null);
  mockPrisma.filterEvent.findFirst.mockResolvedValue(null);
  // Phase 8.7: tape-generation now runs unconditionally inside getCurrentState,
  // so these two reads always fire when there's a current cycle.
  mockPrisma.filterEvent.findMany.mockResolvedValue([]);
  mockPrisma.filterEvent.count.mockResolvedValue(0);
  mockPrisma.filterProfile.findUnique.mockResolvedValue(null);
  mockPrisma.filterCleaningProfile.findUnique.mockResolvedValue(null);
  mockPrisma.equipmentGroup.findFirst.mockResolvedValue(null);
  mockPrisma.equipmentGroup.findMany.mockResolvedValue([]);
}

/**
 * Construct the service and replace its private getProfilePipeline with a
 * spy that returns stubPipeline. This is option (a) from the task brief —
 * cleanest way to assert L2 (call args) without restructuring production code.
 */
function makeService() {
  const service = new FilterOperationsService();
  const pipelineSpy = vi.fn().mockResolvedValue(stubPipeline);
  // private method — cast through any per the brief's recommendation
  (service as any).getProfilePipeline = pipelineSpy;
  return { service, pipelineSpy };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('FilterOperationsService.getCurrentState() — L1 + L2 invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('L1: equipment-group snapshot resolution', () => {
    it('case 1: pin set + snapshot row exists → returns snapshot fields with version === pin', async () => {
      setupMinimalReads();
      mockPrisma.equipmentGroupVersion.findUnique.mockResolvedValue({
        groupId: GROUP_ID,
        versionNumber: 3,
        snapshot: {
          name: 'AHU-1 Equipment (snapshot @v3)',
          blockId: 'block-1',
          isActive: true,
          instruments: [
            { id: 'inst-A', name: 'Pressure', sortOrder: 0, operatingMin: 5, operatingMax: 15 },
            { id: 'inst-B', name: 'Temp',     sortOrder: 1, operatingMin: 60, operatingMax: 80 },
          ],
        },
      });
      // Should NEVER read live group on this path — but stub it to a poison
      // value so a regression that DOES would make the test red on field-shape.
      mockPrisma.equipmentGroup.findUnique.mockResolvedValue({
        id: GROUP_ID,
        name: 'AHU-1 Equipment (LIVE — should NOT be returned)',
        version: 99,
        instruments: [],
      });

      const { service } = makeService();
      const state = await service.getCurrentState(ctx, FILTER_ID);

      expect(mockPrisma.equipmentGroupVersion.findUnique).toHaveBeenCalledWith({
        where: { groupId_versionNumber: { groupId: GROUP_ID, versionNumber: 3 } },
      });
      expect(state.equipmentGroup).toMatchObject({
        id: GROUP_ID,
        name: 'AHU-1 Equipment (snapshot @v3)',
        blockId: 'block-1',
        isActive: true,
        version: 3,
      });
      expect(state.equipmentGroup.instruments).toHaveLength(2);
      // sortOrder asc enforced
      expect(state.equipmentGroup.instruments[0].id).toBe('inst-A');
      expect(state.equipmentGroup.instruments[1].id).toBe('inst-B');
    });

    it('case 2: pin set + no snapshot row + live.version === pin → returns live row (lazy first-version path)', async () => {
      setupMinimalReads();
      mockPrisma.equipmentGroupVersion.findUnique.mockResolvedValue(null);
      const liveGroup = {
        id: GROUP_ID,
        name: 'AHU-1 Equipment (live, never edited)',
        blockId: 'block-1',
        isActive: true,
        version: 3, // matches pin → lazy first-version
        instruments: [{ id: 'inst-X', name: 'Live', sortOrder: 0 }],
      };
      mockPrisma.equipmentGroup.findUnique.mockResolvedValue(liveGroup);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { service } = makeService();
        const state = await service.getCurrentState(ctx, FILTER_ID);

        expect(state.equipmentGroup).toBe(liveGroup);
        // Lazy-first-version is the EXPECTED state — NOT a warning case.
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('case 3: pin set + no snapshot row + live.version !== pin → returns live row spread with snapshotMissing flag AND warns', async () => {
      setupMinimalReads();
      mockPrisma.equipmentGroupVersion.findUnique.mockResolvedValue(null);
      const liveGroup = {
        id: GROUP_ID,
        name: 'AHU-1 Equipment',
        blockId: 'block-1',
        isActive: true,
        version: 5, // pin is 3 → diverged + no snapshot → defensive log path
        instruments: [],
      };
      mockPrisma.equipmentGroup.findUnique.mockResolvedValue(liveGroup);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { service } = makeService();
        const state = await service.getCurrentState(ctx, FILTER_ID);

        // Audit 2026-05-05 fix #6: pre-fix returned the live row AS-IS with
        // a console.warn — operators saw stale dropdowns until advance()
        // finally threw 409 GROUP_VERSION_MISSING. Now the response carries
        // snapshotMissing/pinnedVersion/liveVersion so the FE can disable
        // submission upfront.
        expect(state.equipmentGroup).toMatchObject({
          ...liveGroup,
          snapshotMissing: true,
          pinnedVersion: 3,
          liveVersion: 5,
        });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const msg = warnSpy.mock.calls[0][0] as string;
        expect(msg).toContain('equipmentGroupVersionPin=3');
        expect(msg).toContain(GROUP_ID);
        expect(msg).toContain(CYCLE_ID);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('case 4: pin null (legacy cycle) → returns live row, NEVER reads equipmentGroupVersion', async () => {
      setupMinimalReads(filterWithCycle(), cycleFixture({ equipmentGroupVersionPin: null }));
      const liveGroup = {
        id: GROUP_ID,
        name: 'AHU-1 Equipment (legacy)',
        blockId: 'block-1',
        isActive: true,
        version: 7,
        instruments: [],
      };
      mockPrisma.equipmentGroup.findUnique.mockResolvedValue(liveGroup);

      const { service } = makeService();
      const state = await service.getCurrentState(ctx, FILTER_ID);

      expect(state.equipmentGroup).toBe(liveGroup);
      // L1 invariant: legacy cycles must NOT consult the version sidecar.
      expect(mockPrisma.equipmentGroupVersion.findUnique).not.toHaveBeenCalled();
    });

    it('case 5: cycle has no equipmentGroupId → block-fallback live group returned (NOT pin path)', async () => {
      const cycleNoGroup = cycleFixture({ equipmentGroupId: null, equipmentGroupVersionPin: null });
      setupMinimalReads(filterWithCycle(), cycleNoGroup);
      const fallback = {
        id: 'group-block-fallback',
        name: 'Block fallback group',
        blockId: 'block-1',
        isActive: true,
        version: 1,
        instruments: [{ id: 'inst-fb', sortOrder: 0 }],
      };
      mockPrisma.equipmentGroup.findFirst.mockResolvedValue(fallback);

      const { service } = makeService();
      const state = await service.getCurrentState(ctx, FILTER_ID);

      expect(state.equipmentGroup).toBe(fallback);
      // Block-fallback is by blockId+isActive, NOT by group id (which is null here).
      expect(mockPrisma.equipmentGroup.findFirst).toHaveBeenCalledWith({
        where: { blockId: 'block-1', isActive: true },
        include: { instruments: { orderBy: { sortOrder: 'asc' } } },
      });
      // No pin path consulted at all when there's no group bound to the cycle.
      expect(mockPrisma.equipmentGroupVersion.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.equipmentGroup.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('L2: cycle-pinned profile pipeline rendering', () => {
    it("case 6: when currentCycle exists, getProfilePipeline is called with the CYCLE's profileId, not the live one", async () => {
      // resolveFilterProfile() returns LIVE_PROFILE_ID (filter.filterProfileId direct
      // assignment short-circuits the config-based path). The cycle was started against
      // CYCLE_PROFILE_ID. L2 says: the pipeline rendered must come from the cycle's pin.
      setupMinimalReads();
      mockPrisma.equipmentGroupVersion.findUnique.mockResolvedValue(null);
      mockPrisma.equipmentGroup.findUnique.mockResolvedValue({
        id: GROUP_ID, name: 'g', blockId: 'block-1', isActive: true, version: 3, instruments: [],
      });
      // profileSyncWarning normalization helpers — keep them inert by returning null.
      // (filterProfile.findUnique already returns null from setupMinimalReads.)

      const { service, pipelineSpy } = makeService();
      const state = await service.getCurrentState(ctx, FILTER_ID);

      // Sanity: the spy was called.
      expect(pipelineSpy).toHaveBeenCalled();

      // L2 invariant — first arg is the cycle's profileId, NOT the live one.
      const firstCallArgs = pipelineSpy.mock.calls[0];
      expect(firstCallArgs[0]).toBe(CYCLE_PROFILE_ID);
      expect(firstCallArgs[0]).not.toBe(LIVE_PROFILE_ID);

      // Returned `profile` reflects the cycle-pinned pipeline (sanity-check end-to-end).
      expect(state.profile).toEqual({ name: stubPipeline.name, flowMode: stubPipeline.flowMode });
    });

    it('L2 control: when no currentCycle exists, getProfilePipeline IS called with the live resolved profileId', async () => {
      // Pre-cycle path: filter has no currentCycleId, so getCurrentState should
      // render the live binding (so the operator sees what they'd start a cycle
      // against). This is the documented inverse of L2 — proves the cycle-pinned
      // branch only fires when a cycle exists.
      const filterNoCycle = {
        ...filterWithCycle(),
        filterDetails: { ...filterWithCycle().filterDetails, currentCycleId: null, currentLifecycleState: null },
      };
      setupMinimalReads(filterNoCycle, cycleFixture());
      // No cycle → cleaningCycle.findUnique should not be called for the cycle path.
      mockPrisma.cleaningCycle.findUnique.mockResolvedValue(null);

      const { service, pipelineSpy } = makeService();
      await service.getCurrentState(ctx, FILTER_ID);

      // Pre-cycle: live profileId is what the operator sees.
      expect(pipelineSpy).toHaveBeenCalledWith(LIVE_PROFILE_ID, false);
    });
  });
});
