/**
 * Day 2 of D1/D2/D4 dialog-state refactor (2026-05-17).
 *
 * Tests the new synthesis behavior in local-context.ts:synthesizeEvents:
 *
 *   1. When cache row carries `checklistCompletions[]`, that becomes the
 *      preferred source for synthesizing CHECKLIST_COMPLETED events.
 *      One synthesized event per matching log entry.
 *
 *   2. When `checklistCompletions[]` is absent OR empty, the loader falls
 *      back to the legacy `pendingChecklist === []` signal (existing
 *      behavior). This is the backward-compat path for cache rows written
 *      before Day 2.
 *
 *   3. PARITY: with the same effective "operator completed checklist X
 *      after stage WASH_IN" state, both the new tier-1 path and the legacy
 *      tier-2 path produce equivalent executor decisions (the synthesized
 *      events differ in detail — completion log has timestamp+profileId,
 *      legacy has neither — but both result in a passing CHECKLIST gate).
 *
 *   4. The completion log filters by `afterStage === currentState` so a
 *      completion logged at WASH_IN does NOT inadvertently satisfy a gate
 *      after WASH_OUT.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../offline-store', () => ({
  getCachedData: vi.fn(),
  getCachedEntity: vi.fn(),
  getCachedFilters: vi.fn(),
  cacheData: vi.fn().mockResolvedValue(undefined),
  updateFilterStateLocally: vi.fn().mockResolvedValue(undefined),
  clearOfflineCycleId: vi.fn().mockResolvedValue(undefined),
  OFFLINE_TTL_MS: 24 * 60 * 60 * 1000,
}));

import { loadLocalContextFromCache } from '../local-context';
import { getCachedData, getCachedFilters } from '../offline-store';

const mockGetCachedData = vi.mocked(getCachedData);
const mockGetCachedFilters = vi.mocked(getCachedFilters);

// Profile graph: START → WASH_IN → CHECKLIST(cl-prof-A) → WASH_OUT → END
const profile = {
  id: 'cp-1',
  lineageId: 'lin-1',
  name: 'Standard',
  flowMode: 'SEQUENTIAL',
  version: 3,
  status: 'ACTIVE',
  cleaningReasons: { keys: ['ROUTINE'] },
  stages: [
    { id: 'n-start', stateKey: null, nodeType: 'START', configuration: {}, sortOrder: 0 },
    { id: 'n-wash-in', stateKey: 'WASH_IN', nodeType: 'STAGE', configuration: {}, sortOrder: 1 },
    {
      id: 'n-cl',
      stateKey: null,
      nodeType: 'CHECKLIST',
      configuration: { checklistProfileId: 'cl-prof-A' },
      sortOrder: 2,
    },
    { id: 'n-wash-out', stateKey: 'WASH_OUT', nodeType: 'STAGE', configuration: {}, sortOrder: 3 },
    { id: 'n-end', stateKey: null, nodeType: 'END', configuration: {}, sortOrder: 4 },
  ],
  connections: [
    { fromStageId: 'n-start', toStageId: 'n-wash-in' },
    { fromStageId: 'n-wash-in', toStageId: 'n-cl' },
    { fromStageId: 'n-cl', toStageId: 'n-wash-out' },
    { fromStageId: 'n-wash-out', toStageId: 'n-end' },
  ],
};

const baseFilter = {
  id: 'filter-1',
  name: 'F-1',
  status: 'Active',
  parentId: null,
  template: { templateKind: 'FILTER' },
  filterDetails: {
    filterProfileId: 'fp-1',
    currentLifecycleState: 'WASH_IN',
    currentCycleId: 'cycle-1',
    filterSet: null,
  },
};

function setupCachedReads(cachedState: any) {
  mockGetCachedFilters.mockResolvedValue([baseFilter as any]);
  mockGetCachedData.mockImplementation((key: string) => {
    if (key === 'filter-state-filter-1') return Promise.resolve(cachedState);
    if (key === 'active-profile-fp-1') {
      return Promise.resolve({
        id: 'fp-1',
        name: 'FP-1',
        isActive: true,
        cleaningProfile: profile,
        applicableTemplates: [],
      });
    }
    return Promise.resolve(null);
  });
}

describe('Day 2 — synthesizeEvents prefers checklistCompletions[]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('synthesizes CHECKLIST_COMPLETED for each matching completion log entry', async () => {
    setupCachedReads({
      currentState: 'WASH_IN',
      currentCycle: { id: 'cycle-1', status: 'IN_PROGRESS' },
      pipelineGraph: { stages: profile.stages, connections: profile.connections },
      checklistCompletions: [
        {
          checklistProfileId: 'cl-prof-A',
          afterStage: 'WASH_IN',
          completedAt: '2026-05-17T12:00:00.000Z',
          cycleId: 'cycle-1',
        },
      ],
    });

    const ctx = await loadLocalContextFromCache('filter-1');
    expect(ctx).not.toBeNull();
    const events = ctx!.events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'CHECKLIST_COMPLETED',
      attributes: expect.objectContaining({
        afterStage: 'WASH_IN',
        checklistProfileId: 'cl-prof-A',
        source: 'completion-log',
      }),
    });
  });

  it('filters by afterStage so a WASH_IN completion does NOT clear a WASH_OUT gate', async () => {
    // currentLifecycleState moves to WASH_OUT (operator advanced past WASH_IN)
    mockGetCachedFilters.mockResolvedValue([
      {
        ...baseFilter,
        filterDetails: { ...baseFilter.filterDetails, currentLifecycleState: 'WASH_OUT' },
      } as any,
    ]);
    mockGetCachedData.mockImplementation((key: string) => {
      if (key === 'filter-state-filter-1') {
        return Promise.resolve({
          currentState: 'WASH_OUT',
          currentCycle: { id: 'cycle-1', status: 'IN_PROGRESS' },
          pipelineGraph: { stages: profile.stages, connections: profile.connections },
          checklistCompletions: [
            // Logged against WASH_IN — should NOT match WASH_OUT
            {
              checklistProfileId: 'cl-prof-A',
              afterStage: 'WASH_IN',
              completedAt: '2026-05-17T12:00:00.000Z',
            },
          ],
        });
      }
      if (key === 'active-profile-fp-1') {
        return Promise.resolve({
          id: 'fp-1',
          name: 'FP-1',
          isActive: true,
          cleaningProfile: profile,
          applicableTemplates: [],
        });
      }
      return Promise.resolve(null);
    });

    const ctx = await loadLocalContextFromCache('filter-1');
    const events = ctx!.events ?? [];
    // No synthesized event for WASH_OUT since no completion logged for it.
    // Falls through to tier-2 legacy check, which also finds no gate (no
    // pendingChecklist field present at all).
    expect(events.filter((e: any) => e.attributes?.afterStage === 'WASH_OUT')).toHaveLength(0);
  });

  it('logs multiple completions for chained CHECKLIST→CHECKLIST→STAGE profiles', async () => {
    setupCachedReads({
      currentState: 'WASH_IN',
      currentCycle: { id: 'cycle-1', status: 'IN_PROGRESS' },
      pipelineGraph: { stages: profile.stages, connections: profile.connections },
      checklistCompletions: [
        { checklistProfileId: 'cl-prof-A', afterStage: 'WASH_IN', completedAt: '2026-05-17T12:00:00.000Z' },
        { checklistProfileId: 'cl-prof-B', afterStage: 'WASH_IN', completedAt: '2026-05-17T12:01:00.000Z' },
      ],
    });

    const ctx = await loadLocalContextFromCache('filter-1');
    const events = ctx!.events ?? [];
    expect(events).toHaveLength(2);
    expect(events.map((e: any) => e.attributes.checklistProfileId).sort()).toEqual(['cl-prof-A', 'cl-prof-B']);
  });
});

describe('Day 2 — legacy fallback retained for cache rows from before this migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to pendingChecklist === [] signal when checklistCompletions is absent', async () => {
    setupCachedReads({
      currentState: 'WASH_IN',
      currentCycle: { id: 'cycle-1', status: 'IN_PROGRESS' },
      pipelineGraph: { stages: profile.stages, connections: profile.connections },
      // No checklistCompletions field — pre-Day-2 cache row
      pendingChecklist: [],
    });

    const ctx = await loadLocalContextFromCache('filter-1');
    const events = ctx!.events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'CHECKLIST_COMPLETED',
      attributes: expect.objectContaining({
        afterStage: 'WASH_IN',
        source: 'legacy-pending-signal',
      }),
    });
  });

  it('legacy fallback still respects non-empty pendingChecklist (gate stays blocked)', async () => {
    setupCachedReads({
      currentState: 'WASH_IN',
      currentCycle: { id: 'cycle-1', status: 'IN_PROGRESS' },
      pipelineGraph: { stages: profile.stages, connections: profile.connections },
      pendingChecklist: [{ checklistProfileId: 'cl-prof-A', questions: [] }],
    });

    const ctx = await loadLocalContextFromCache('filter-1');
    expect(ctx!.events).toEqual([]);
  });

  it('completion log takes precedence over legacy pendingChecklist', async () => {
    // Cache row contains BOTH a completion log AND non-empty pendingChecklist
    // (a stale legacy field from a pre-Day-2 row that wasn't cleared). The
    // tier-1 completion log should win, gate clears.
    setupCachedReads({
      currentState: 'WASH_IN',
      currentCycle: { id: 'cycle-1', status: 'IN_PROGRESS' },
      pipelineGraph: { stages: profile.stages, connections: profile.connections },
      pendingChecklist: [{ checklistProfileId: 'cl-prof-A', questions: [] }],
      checklistCompletions: [
        { checklistProfileId: 'cl-prof-A', afterStage: 'WASH_IN', completedAt: '2026-05-17T12:00:00.000Z' },
      ],
    });

    const ctx = await loadLocalContextFromCache('filter-1');
    const events = ctx!.events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0].attributes.source).toBe('completion-log');
  });
});

describe('Day 2 — appendChecklistCompletion helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends a new completion entry to an empty log', async () => {
    const { cacheData, getCachedData } = await import('../offline-store');
    const mockCacheData = vi.mocked(cacheData);
    const mockGet = vi.mocked(getCachedData);
    mockGet.mockResolvedValueOnce({ currentState: 'WASH_IN' } as any);

    const { appendChecklistCompletion } = await import('../offline-cache');
    await appendChecklistCompletion('filter-1', {
      checklistProfileId: 'cl-A',
      afterStage: 'WASH_IN',
      completedAt: '2026-05-17T13:00:00.000Z',
      cycleId: 'cycle-1',
    });

    expect(mockCacheData).toHaveBeenCalledWith(
      'filter-state-filter-1',
      expect.objectContaining({
        checklistCompletions: [
          {
            checklistProfileId: 'cl-A',
            afterStage: 'WASH_IN',
            completedAt: '2026-05-17T13:00:00.000Z',
            cycleId: 'cycle-1',
          },
        ],
      }),
      expect.any(Number),
    );
  });

  it('does not double-log when called twice with same (profileId, afterStage, cycleId)', async () => {
    const { cacheData, getCachedData } = await import('../offline-store');
    const mockCacheData = vi.mocked(cacheData);
    const mockGet = vi.mocked(getCachedData);

    // First call: empty log. Second call: log already contains the entry.
    mockGet
      .mockResolvedValueOnce({ currentState: 'WASH_IN' } as any)
      .mockResolvedValueOnce({
        currentState: 'WASH_IN',
        checklistCompletions: [
          { checklistProfileId: 'cl-A', afterStage: 'WASH_IN', completedAt: '2026-05-17T13:00:00.000Z', cycleId: 'cycle-1' },
        ],
      } as any);

    const { appendChecklistCompletion } = await import('../offline-cache');
    await appendChecklistCompletion('filter-1', {
      checklistProfileId: 'cl-A',
      afterStage: 'WASH_IN',
      completedAt: '2026-05-17T13:00:00.000Z',
      cycleId: 'cycle-1',
    });
    mockCacheData.mockClear();
    await appendChecklistCompletion('filter-1', {
      checklistProfileId: 'cl-A',
      afterStage: 'WASH_IN',
      completedAt: '2026-05-17T13:00:01.000Z', // different timestamp, same key
      cycleId: 'cycle-1',
    });

    // Second call must NOT write because (profileId, afterStage, cycleId) matches.
    expect(mockCacheData).not.toHaveBeenCalled();
  });
});
