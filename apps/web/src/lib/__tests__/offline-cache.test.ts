import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Deep-review fix tests (2026-05-17).
 *
 * D3 — recomputeAndCacheFilterState must:
 *   - Accept and propagate `blockId` into the offline cycle stub.
 *   - Re-throw on internal failure (no silent swallow) so callers can
 *     surface 21 CFR-relevant offline-state corruption to the operator
 *     instead of proceeding against a stale cache.
 *
 * The pre-fix code had a `catch { console.warn(...) }` that hid IDB write
 * failures, leading to "operator advanced past a required checklist because
 * the cache said none was pending" risk (per the comment removed in the
 * fix). The new contract: throws with `code: 'OFFLINE_CACHE_RECOMPUTE_FAILED'`.
 */

const { mockOfflineStore } = vi.hoisted(() => ({
  mockOfflineStore: {
    getCachedData: vi.fn(),
    cacheData: vi.fn(),
    updateFilterStateLocally: vi.fn(),
    clearOfflineCycleId: vi.fn(),
    getOfflineFilters: vi.fn(),
    OFFLINE_TTL_MS: 24 * 60 * 60 * 1000,
  },
}));

vi.mock('../offline-store', () => mockOfflineStore);

// Stub the executor used inside recompute so the test focuses on D3 behavior.
vi.mock('../local-context', () => ({
  loadLocalContextFromCache: vi.fn().mockResolvedValue({
    filter: { id: 'f1' },
    profile: { nodes: [], edges: [] },
    history: [],
  }),
}));

// Stub @digilog/shared so the cache lib's executor + helper imports work
// in the test environment without pulling the full pipeline executor.
vi.mock('@digilog/shared', () => ({
  collectChecklistsAfterStage: vi.fn().mockReturnValue([]),
  computeNextActions: vi.fn().mockReturnValue({ actions: [], tapeVersion: 'test-v1' }),
  findReachable: vi.fn().mockReturnValue({ hasEndNext: false, reachableStages: [] }),
}));

describe('recomputeAndCacheFilterState — D3 deep-review fix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Minimal cache: no graph + empty stageLookup → recompute takes the
    // early-return branches that don't invoke the shared executor. The
    // tests focus on the cycle-stub blockId plumbing + the throw-on-failure
    // behavior, both of which fire before any graph walk.
    mockOfflineStore.getCachedData.mockResolvedValue({
      stageLookup: {},
      pipelineStages: [],
    });
    mockOfflineStore.cacheData.mockResolvedValue(undefined);
    mockOfflineStore.updateFilterStateLocally.mockResolvedValue(undefined);
    mockOfflineStore.clearOfflineCycleId.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes blockId into the offline cycle stub when cycleStarted=true', async () => {
    const { recomputeAndCacheFilterState } = await import('../offline-cache');

    await recomputeAndCacheFilterState('filter-uuid-1', 'WASH_IN', true, 'block-uuid-A');

    // The cache write should include a currentCycle stub with cleaningAreaId = blockId
    const cacheCalls = mockOfflineStore.cacheData.mock.calls;
    expect(cacheCalls.length).toBeGreaterThan(0);
    const firstWrite = cacheCalls[0][1];
    expect(firstWrite.currentCycle).toBeTruthy();
    expect(firstWrite.currentCycle.cleaningAreaId).toBe('block-uuid-A');
  });

  it('writes null cleaningAreaId when blockId is null (desktop pre-fix behavior)', async () => {
    const { recomputeAndCacheFilterState } = await import('../offline-cache');

    await recomputeAndCacheFilterState('filter-uuid-2', 'WASH_IN', true, null);

    const firstWrite = mockOfflineStore.cacheData.mock.calls[0][1];
    expect(firstWrite.currentCycle).toBeTruthy();
    expect(firstWrite.currentCycle.cleaningAreaId).toBeNull();
  });

  it('throws OFFLINE_CACHE_RECOMPUTE_FAILED when IDB write fails (D3b — no silent swallow)', async () => {
    const { recomputeAndCacheFilterState } = await import('../offline-cache');

    // Simulate IDB write failure mid-recompute
    mockOfflineStore.updateFilterStateLocally.mockRejectedValueOnce(
      new Error('QuotaExceededError: out of space'),
    );

    await expect(
      recomputeAndCacheFilterState('filter-uuid-3', 'WASH_IN', false, 'block-A'),
    ).rejects.toMatchObject({
      code: 'OFFLINE_CACHE_RECOMPUTE_FAILED',
      message: expect.stringContaining('QuotaExceededError'),
    });
  });

  it('throws OFFLINE_CACHE_RECOMPUTE_FAILED when cacheData fails (the 21 CFR-relevant path)', async () => {
    const { recomputeAndCacheFilterState } = await import('../offline-cache');

    // The first cacheData call writes the mid-write row containing
    // pendingChecklist + nextAllowedStages — if THIS fails the offline gate
    // is wrong but pre-fix the operator never knew.
    mockOfflineStore.cacheData.mockRejectedValueOnce(new Error('IDB transaction aborted'));

    await expect(
      recomputeAndCacheFilterState('filter-uuid-4', 'WASH_OUT', false, null),
    ).rejects.toMatchObject({
      code: 'OFFLINE_CACHE_RECOMPUTE_FAILED',
    });
  });
});

/**
 * Offline checklist regression (2026-07-10).
 *
 * The offline sync caches /batch-states + /current-state responses verbatim.
 * Post-Phase-8.7 the server no longer emits `pendingChecklist` — only the
 * `actions[]` tape carries the checklist gate. An empty `pendingChecklist` in
 * the cached row makes `synthesizeEvents` Tier 2 read the gate as "already
 * submitted" and the local executor recompute drops SUBMIT_CHECKLIST → the
 * offline checklist dialog never appears (see local-context.test #13/#14).
 *
 * `withDerivedPendingChecklist` must fill `pendingChecklist` from the tape so
 * the synced cache matches what `cacheServerStateResponse` produces online.
 */
describe('withDerivedPendingChecklist — offline checklist gate derivation', () => {
  const submitAction = {
    type: 'SUBMIT_CHECKLIST',
    label: 'Submit Checklist: Post-Wash',
    params: {
      afterStage: 'WASH_OUT',
      checklistProfileId: 'cl-prof-1',
      versionPin: 2,
      questions: [
        { id: 'q1', question: 'Temp OK?', questionType: 'YES_NO', required: true, sortOrder: 0 },
      ],
    },
  } as any;

  it('derives pendingChecklist (with questions) from the tape when the field is absent', async () => {
    const { withDerivedPendingChecklist } = await import('../offline-cache');
    const raw = { currentState: 'WASH_OUT', actions: [submitAction] }; // no pendingChecklist (batch-states shape)

    const out = withDerivedPendingChecklist(raw as any);

    expect(Array.isArray(out.pendingChecklist)).toBe(true);
    expect(out.pendingChecklist).toHaveLength(1);
    expect(out.pendingChecklist![0].checklistProfileId).toBe('cl-prof-1');
    expect(out.pendingChecklist![0].questions).toHaveLength(1);
    // Other fields preserved untouched.
    expect(out.currentState).toBe('WASH_OUT');
  });

  it('leaves an already-populated pendingChecklist untouched', async () => {
    const { withDerivedPendingChecklist } = await import('../offline-cache');
    const existing = [{ checklistProfileId: 'x', questions: [] }];
    const raw = { actions: [submitAction], pendingChecklist: existing };

    const out = withDerivedPendingChecklist(raw as any);

    expect(out.pendingChecklist).toBe(existing);
  });

  it('does not fabricate a checklist when the tape has no SUBMIT_CHECKLIST', async () => {
    const { withDerivedPendingChecklist } = await import('../offline-cache');
    const raw = { actions: [{ type: 'ADVANCE_TO_STAGE', label: 'x', params: { targetState: 'DRY_IN' } }] };

    const out = withDerivedPendingChecklist(raw as any);

    // No SUBMIT_CHECKLIST → no pendingChecklist added (stays absent, not []).
    expect(out.pendingChecklist).toBeUndefined();
  });
});

/**
 * 21 CFR fail-closed (2026-07-10) — the STORAGE_OUT offline bug.
 *
 * Reproduction: a cleaning profile has a CHECKLIST node after STORAGE_OUT.
 * Offline, buildPendingChecklistFromProfile could not resolve the checklist's
 * questions (checklist-profiles cache miss), so it returned []. The old
 * cycleComplete logic then read "no pending checklist + terminal stage" as
 * "cycle done", cleared the offline cycle id, and the next scan rolled the
 * filter into a fresh WASH_IN cycle — the required checklist silently skipped.
 * On sync the server correctly rejected the un-checklisted cycle.
 *
 * The guard: when stageLookup/graph says a checklist fires after the stage but
 * it couldn't be resolved, the cycle must NOT complete — park the filter until
 * it re-syncs online.
 */
describe('recomputeAndCacheFilterState — fail-closed on unresolved checklist gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOfflineStore.cacheData.mockResolvedValue(undefined);
    mockOfflineStore.updateFilterStateLocally.mockResolvedValue(undefined);
    mockOfflineStore.clearOfflineCycleId.mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('does NOT complete the cycle when a checklist is expected but unresolvable offline', async () => {
    mockOfflineStore.getCachedData.mockImplementation(async (key: string) => {
      if (key === 'checklist-profiles') return []; // cannot resolve cl-1's questions
      if (key.startsWith('filter-state-')) {
        return {
          currentState: 'STORAGE_IN',
          currentCycle: { id: 'cyc-1', status: 'IN_PROGRESS' },
          stageLookup: {
            STORAGE_OUT: { nextStages: [], pendingChecklistProfileIds: ['cl-1'], leadsToEnd: true, interlockGated: false },
          },
          pipelineStages: [{ stateKey: 'STORAGE_OUT', sortOrder: 5 }],
        };
      }
      return null;
    });

    const { recomputeAndCacheFilterState } = await import('../offline-cache');
    await recomputeAndCacheFilterState('filter-uuid-9', 'STORAGE_OUT', false, null);

    // Cycle must NOT be completed → the offline cycle id must NOT be cleared,
    // and the filter stays parked at STORAGE_OUT (not rolled into a new cycle).
    expect(mockOfflineStore.clearOfflineCycleId).not.toHaveBeenCalled();
    const firstWrite = mockOfflineStore.cacheData.mock.calls[0];
    expect(firstWrite[1].currentState).toBe('STORAGE_OUT');
    expect(firstWrite[1].currentCycle).not.toBeNull();
  });

  it('DOES complete the cycle at a terminal stage that genuinely has no checklist', async () => {
    mockOfflineStore.getCachedData.mockImplementation(async (key: string) => {
      if (key === 'checklist-profiles') return [];
      if (key.startsWith('filter-state-')) {
        return {
          currentState: 'STORAGE_IN',
          currentCycle: { id: 'cyc-1', status: 'IN_PROGRESS' },
          stageLookup: {
            STORAGE_OUT: { nextStages: [], pendingChecklistProfileIds: [], leadsToEnd: true, interlockGated: false },
          },
          pipelineStages: [{ stateKey: 'STORAGE_OUT', sortOrder: 5 }],
        };
      }
      return null;
    });

    const { recomputeAndCacheFilterState } = await import('../offline-cache');
    await recomputeAndCacheFilterState('filter-uuid-10', 'STORAGE_OUT', false, null);

    // No checklist expected → terminal stage completes normally (no regression).
    expect(mockOfflineStore.clearOfflineCycleId).toHaveBeenCalledWith('filter-uuid-10');
    const firstWrite = mockOfflineStore.cacheData.mock.calls[0];
    expect(firstWrite[1].currentState).toBeNull();
  });
});
