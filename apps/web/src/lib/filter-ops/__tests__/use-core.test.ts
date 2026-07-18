import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Tests for useFilterOperationsCore — the headless hook that owns dialog
 * state + executeOrQueue orchestration for the cleaning-cycle workflow.
 *
 * Day 1 baseline asserts (commit `98b6b6c`):
 *   1. advance() that produces no checklist gate leaves dialogState idle.
 *   2. advance() that produces a checklist gate dispatches open_checklist.
 *   3. submitChecklist() with empty remainingBatch closes the dialog.
 *   4. submitChecklist() with remainingBatch pops the next pending filter
 *      (D1 batch fix: pre-fix the loop dropped subsequent filters silently).
 *   5. REAUTH errors PROPAGATE — the hook does not swallow (D6 contract).
 *   6. OFFLINE_CACHE_RECOMPUTE_FAILED PROPAGATES (D3b contract).
 *
 * Day 3 additions (this commit):
 *   7. advance() forwards the full payload — cleaningAreaId, equipmentGroupId,
 *      instrumentReadings, dryerAction, dryerDurationMinutes.
 *   8. advance() offline calls recomputeAndCacheFilterState with
 *      cycleStarted=false so the cache row reflects the new stage.
 *   9. advance() forwards the reauth password to executeOrQueue.
 *  10. startAndAdvance() posts via 'start-and-advance' op type.
 *  11. startAndAdvance() offline calls recomputeAndCacheFilterState with
 *      cycleStarted=true so the cache row gets the cycle stub.
 *  12. startAndAdvance() dispatches open_checklist when the post-advance
 *      tape carries a SUBMIT_CHECKLIST action.
 *  13. submitChecklist() offline clears pendingChecklist + re-derives tape on
 *      the cache row (21 CFR — without this the next gate sees the stale
 *      pending payload and refuses to advance).
 *  14. submitChecklist() offline cache-clear failure is swallowed and does
 *      NOT cause the hook to throw OFFLINE_CACHE_RECOMPUTE_FAILED (matches
 *      legacy try/catch behaviour at mobile-operations.tsx:1397-1415).
 */

// ── Hoisted mocks ─────────────────────────────────────────────────────────
const {
  mockExecuteOrQueue,
  mockResolvePending,
  mockFindNext,
  mockGetCurrentActions,
  mockRecomputeCache,
  mockAppendCompletion,
  mockGetCachedData,
  mockCacheData,
  mockClearCycle,
  mockResolveForTarget,
  mockCacheServerState,
  onlineRef,
} = vi.hoisted(() => ({
  mockExecuteOrQueue: vi.fn(),
  mockResolvePending: vi.fn(),
  mockFindNext: vi.fn(),
  mockGetCurrentActions: vi.fn(),
  mockRecomputeCache: vi.fn(),
  mockAppendCompletion: vi.fn(),
  mockGetCachedData: vi.fn(),
  mockCacheData: vi.fn(),
  mockClearCycle: vi.fn(),
  mockResolveForTarget: vi.fn(),
  mockCacheServerState: vi.fn(),
  // Dialog-first deferral is online-only. Default false → every pre-2026-07-16
  // test below exercises the legacy advance-then-dialog path unchanged.
  onlineRef: { current: false },
}));

vi.mock('../../../hooks/use-offline', () => ({
  useOffline: () => ({ executeOrQueue: mockExecuteOrQueue, online: onlineRef.current }),
}));

vi.mock('../resolve-pending-checklist', () => ({
  resolvePendingChecklistDialog: mockResolvePending,
  resolveChecklistForTargetStage: mockResolveForTarget,
}));

vi.mock('../next-pending-checklist', () => ({
  findNextPendingChecklist: mockFindNext,
}));

vi.mock('@/lib/action-tape', () => ({
  getCurrentActions: mockGetCurrentActions,
}));

vi.mock('@/lib/offline-cache', () => ({
  recomputeAndCacheFilterState: mockRecomputeCache,
  appendChecklistCompletion: mockAppendCompletion,
  cacheServerStateResponse: mockCacheServerState,
}));

vi.mock('@/lib/offline-store', () => ({
  getCachedData: mockGetCachedData,
  cacheData: mockCacheData,
  clearOfflineCycleId: mockClearCycle,
  OFFLINE_TTL_MS: 86_400_000,
}));

import { useFilterOperationsCore } from '../use-core';

describe('useFilterOperationsCore — Day 1 baseline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteOrQueue.mockResolvedValue({ executed: true, result: { actions: [] } });
    mockResolvePending.mockResolvedValue(null);
    mockFindNext.mockResolvedValue(null);
    mockRecomputeCache.mockResolvedValue(undefined);
    mockAppendCompletion.mockResolvedValue(undefined);
    mockGetCachedData.mockResolvedValue({});
    mockCacheData.mockResolvedValue(undefined);
    mockGetCurrentActions.mockResolvedValue([]);
    mockResolveForTarget.mockResolvedValue([]);
    mockCacheServerState.mockResolvedValue(undefined);
    onlineRef.current = false;
  });

  it('starts with dialogState.kind === "none"', () => {
    const { result } = renderHook(() => useFilterOperationsCore());
    expect(result.current.dialogState.kind).toBe('none');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('advance() with no pending checklist leaves dialogState idle', async () => {
    mockResolvePending.mockResolvedValue(null);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_IN',
      });
    });

    expect(result.current.dialogState.kind).toBe('none');
    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'advance',
      'f1',
      'F-1',
      expect.objectContaining({ targetState: 'WASH_IN' }),
      'WASH_IN',
      undefined,
    );
  });

  it('advance() with a pending checklist dispatches open_checklist', async () => {
    mockResolvePending.mockResolvedValue([
      { id: 'cl1', questions: [{ id: 'q1', text: 'OK?', type: 'YES_NO' }] },
    ]);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_OUT',
      });
    });

    expect(result.current.dialogState.kind).toBe('awaiting_checklist');
    if (result.current.dialogState.kind === 'awaiting_checklist') {
      expect(result.current.dialogState.filterId).toBe('f1');
      expect(result.current.dialogState.filterName).toBe('F-1');
      expect(result.current.dialogState.checklists).toHaveLength(1);
    }
  });

  it('submitChecklist() with empty remainingBatch closes the dialog', async () => {
    mockResolvePending.mockResolvedValueOnce([{ id: 'cl1', questions: [] }]);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_OUT',
      });
    });
    expect(result.current.dialogState.kind).toBe('awaiting_checklist');

    await act(async () => {
      await result.current.submitChecklist({
        filterId: 'f1',
        filterName: 'F-1',
        answers: { q1: 'YES' },
      });
    });
    expect(result.current.dialogState.kind).toBe('none');
  });

  it('submitChecklist() walks remainingBatch and opens dialog for next pending filter (D1 batch fix)', async () => {
    mockResolvePending.mockResolvedValueOnce([{ id: 'cl-f1', questions: [] }]);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_OUT',
        batchRemainder: [
          { filterId: 'f2', filterName: 'F-2' },
          { filterId: 'f3', filterName: 'F-3' },
        ],
      });
    });
    expect(result.current.dialogState.kind).toBe('awaiting_checklist');

    mockFindNext.mockResolvedValueOnce({
      item: { filterId: 'f2', filterName: 'F-2' },
      checklists: [{ id: 'cl-f2', questions: [] }],
      remaining: [{ filterId: 'f3', filterName: 'F-3' }],
    });

    await act(async () => {
      await result.current.submitChecklist({
        filterId: 'f1',
        filterName: 'F-1',
        answers: { q1: 'YES' },
      });
    });

    expect(result.current.dialogState.kind).toBe('awaiting_checklist');
    if (result.current.dialogState.kind === 'awaiting_checklist') {
      expect(result.current.dialogState.filterId).toBe('f2');
      expect(result.current.dialogState.remainingBatch).toEqual([
        { filterId: 'f3', filterName: 'F-3' },
      ]);
    }
  });

  it('submitChecklist() closes when findNextPendingChecklist returns null even with non-empty remainder', async () => {
    mockResolvePending.mockResolvedValueOnce([{ id: 'cl-f1', questions: [] }]);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_OUT',
        batchRemainder: [{ filterId: 'f2', filterName: 'F-2' }],
      });
    });
    expect(result.current.dialogState.kind).toBe('awaiting_checklist');

    mockFindNext.mockResolvedValueOnce(null);

    await act(async () => {
      await result.current.submitChecklist({
        filterId: 'f1',
        filterName: 'F-1',
        answers: {},
      });
    });
    expect(result.current.dialogState.kind).toBe('none');
  });

  it('advance() propagates REAUTH_REQUIRED (does NOT swallow into error state — D6 contract)', async () => {
    mockExecuteOrQueue.mockRejectedValueOnce({ error: 'REAUTH_REQUIRED', message: 'reauth' });

    const { result } = renderHook(() => useFilterOperationsCore());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.advance({
          filterId: 'f1',
          filterName: 'F-1',
          targetState: 'WASH_IN',
        });
      } catch (e) {
        thrown = e;
      }
    });
    expect(thrown).toMatchObject({ error: 'REAUTH_REQUIRED' });
    expect(result.current.error).toBeNull();
  });

  it('advance() propagates REAUTH_FAILED', async () => {
    mockExecuteOrQueue.mockRejectedValueOnce({ error: 'REAUTH_FAILED', message: 'bad password' });

    const { result } = renderHook(() => useFilterOperationsCore());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.advance({
          filterId: 'f1',
          filterName: 'F-1',
          targetState: 'WASH_IN',
        });
      } catch (e) {
        thrown = e;
      }
    });
    expect(thrown).toMatchObject({ error: 'REAUTH_FAILED' });
  });

  it('advance() propagates OFFLINE_CACHE_RECOMPUTE_FAILED (D3b contract)', async () => {
    const err = new Error('IDB write failed') as Error & { code?: string };
    err.code = 'OFFLINE_CACHE_RECOMPUTE_FAILED';
    mockExecuteOrQueue.mockRejectedValueOnce(err);

    const { result } = renderHook(() => useFilterOperationsCore());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.advance({
          filterId: 'f1',
          filterName: 'F-1',
          targetState: 'WASH_IN',
        });
      } catch (e) {
        thrown = e;
      }
    });
    expect(thrown).toMatchObject({ code: 'OFFLINE_CACHE_RECOMPUTE_FAILED' });
  });

  it('advance() sets error state for generic non-special errors', async () => {
    mockExecuteOrQueue.mockRejectedValueOnce(new Error('Network timeout'));

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      try {
        await result.current.advance({
          filterId: 'f1',
          filterName: 'F-1',
          targetState: 'WASH_IN',
        });
      } catch {
        /* generic errors don't throw — they go to error state */
      }
    });
    expect(result.current.error).toBe('Network timeout');
  });

  it('clearError() resets the error state', async () => {
    mockExecuteOrQueue.mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      try {
        await result.current.advance({
          filterId: 'f1',
          filterName: 'F-1',
          targetState: 'WASH_IN',
        });
      } catch { /* */ }
    });
    expect(result.current.error).toBe('boom');

    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});

describe('useFilterOperationsCore — Day 3 extended handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteOrQueue.mockResolvedValue({ executed: true, result: { actions: [] } });
    mockResolvePending.mockResolvedValue(null);
    mockFindNext.mockResolvedValue(null);
    mockRecomputeCache.mockResolvedValue(undefined);
    mockAppendCompletion.mockResolvedValue(undefined);
    mockGetCachedData.mockResolvedValue({});
    mockCacheData.mockResolvedValue(undefined);
    mockGetCurrentActions.mockResolvedValue([]);
    mockResolveForTarget.mockResolvedValue([]);
    mockCacheServerState.mockResolvedValue(undefined);
    onlineRef.current = false;
  });

  it('advance() forwards the full payload (cleaningAreaId, equipmentGroupId, instrumentReadings, dryerAction)', async () => {
    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'DRY_IN',
        cleaningAreaId: 'block-a',
        equipmentGroupId: 'eg-1',
        instrumentReadings: { 'inst-1': 25 },
        dryerAction: 'SUBMIT_READINGS',
        dryerDurationMinutes: 15,
        remarks: 'custom',
      });
    });

    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'advance',
      'f1',
      'F-1',
      expect.objectContaining({
        targetState: 'DRY_IN',
        cleaningAreaId: 'block-a',
        equipmentGroupId: 'eg-1',
        instrumentReadings: { 'inst-1': 25 },
        dryerAction: 'SUBMIT_READINGS',
        dryerDurationMinutes: 15,
        remarks: 'custom',
      }),
      'DRY_IN',
      undefined,
    );
  });

  it('advance() strips undefined keys from payload', async () => {
    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_IN',
        // No cleaningAreaId / equipmentGroupId / etc.
      });
    });

    const sentPayload = mockExecuteOrQueue.mock.calls[0][3];
    expect(sentPayload).not.toHaveProperty('cleaningAreaId');
    expect(sentPayload).not.toHaveProperty('equipmentGroupId');
    expect(sentPayload).not.toHaveProperty('instrumentReadings');
    expect(sentPayload).not.toHaveProperty('dryerAction');
    expect(sentPayload).toHaveProperty('targetState', 'WASH_IN');
    expect(sentPayload).toHaveProperty('remarks');
  });

  it('advance() forwards reauth password', async () => {
    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_IN',
        password: 'p@ss',
      });
    });

    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'advance',
      'f1',
      'F-1',
      expect.any(Object),
      'WASH_IN',
      'p@ss',
    );
  });

  it('advance() offline (executed=false) calls recomputeAndCacheFilterState with cycleStarted=false', async () => {
    mockExecuteOrQueue.mockResolvedValueOnce({ executed: false, result: undefined });

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_IN',
        cleaningAreaId: 'block-a',
      });
    });

    expect(mockRecomputeCache).toHaveBeenCalledWith('f1', 'WASH_IN', false, 'block-a');
  });

  it('advance() online (executed=true) does NOT call recomputeAndCacheFilterState', async () => {
    mockExecuteOrQueue.mockResolvedValueOnce({ executed: true, result: { actions: [] } });

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_IN',
      });
    });

    expect(mockRecomputeCache).not.toHaveBeenCalled();
  });

  it('startAndAdvance() posts via "start-and-advance" op type with compound payload', async () => {
    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.startAndAdvance({
        filterId: 'f1',
        filterName: 'F-1',
        cyclePayload: { cleaningReasonKey: 'PERIODIC' },
        advancePayload: { targetState: 'WASH_IN' },
        targetState: 'WASH_IN',
        cleaningAreaId: 'block-a',
        password: 'p@ss',
      });
    });

    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'start-and-advance',
      'f1',
      'F-1',
      {
        cyclePayload: { cleaningReasonKey: 'PERIODIC' },
        advancePayload: { targetState: 'WASH_IN' },
      },
      'WASH_IN',
      'p@ss',
    );
  });

  it('startAndAdvance() offline calls recomputeAndCacheFilterState with cycleStarted=true', async () => {
    mockExecuteOrQueue.mockResolvedValueOnce({ executed: false, result: undefined });

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.startAndAdvance({
        filterId: 'f1',
        filterName: 'F-1',
        cyclePayload: {},
        advancePayload: {},
        targetState: 'WASH_IN',
        cleaningAreaId: 'block-a',
      });
    });

    expect(mockRecomputeCache).toHaveBeenCalledWith('f1', 'WASH_IN', true, 'block-a');
  });

  it('startAndAdvance() dispatches open_checklist when post-advance tape carries SUBMIT_CHECKLIST', async () => {
    mockResolvePending.mockResolvedValueOnce([
      { id: 'cl-f1', questions: [{ id: 'q1', text: 'OK?' }] },
    ]);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.startAndAdvance({
        filterId: 'f1',
        filterName: 'F-1',
        cyclePayload: {},
        advancePayload: {},
        targetState: 'WASH_IN',
      });
    });

    expect(result.current.dialogState.kind).toBe('awaiting_checklist');
  });

  it('startAndAdvance() propagates REAUTH_REQUIRED', async () => {
    mockExecuteOrQueue.mockRejectedValueOnce({ error: 'REAUTH_REQUIRED', message: 'reauth' });

    const { result } = renderHook(() => useFilterOperationsCore());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.startAndAdvance({
          filterId: 'f1',
          filterName: 'F-1',
          cyclePayload: {},
          advancePayload: {},
          targetState: 'WASH_IN',
        });
      } catch (e) { thrown = e; }
    });
    expect(thrown).toMatchObject({ error: 'REAUTH_REQUIRED' });
  });

  it('submitChecklist() offline clears pendingChecklist and re-derives nextAllowedStages + actions on cache row', async () => {
    mockResolvePending.mockResolvedValueOnce([{ id: 'cl-f1', questions: [] }]);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_OUT',
      });
    });

    mockExecuteOrQueue.mockResolvedValueOnce({ executed: false });
    mockGetCachedData.mockResolvedValueOnce({ existing: 'data', pendingChecklist: [{ id: 'cl' }] });
    mockGetCurrentActions.mockResolvedValueOnce([
      { type: 'ADVANCE_TO_STAGE', params: { targetState: 'DRY_IN' } },
      { type: 'SET_DRYER_DURATION', params: { targetState: 'DRY_IN' } },
    ]);

    await act(async () => {
      await result.current.submitChecklist({
        filterId: 'f1',
        filterName: 'F-1',
        answers: { q1: 'YES' },
      });
    });

    // First cacheData call: cleared pendingChecklist
    expect(mockCacheData).toHaveBeenNthCalledWith(
      1,
      'filter-state-f1',
      expect.objectContaining({ pendingChecklist: [] }),
      expect.any(Number),
    );

    // Second cacheData call: nextAllowedStages + actions re-derived from tape
    expect(mockCacheData).toHaveBeenNthCalledWith(
      2,
      'filter-state-f1',
      expect.objectContaining({
        pendingChecklist: [],
        nextAllowedStages: ['DRY_IN', 'DRY_IN'],
        actions: expect.any(Array),
      }),
      expect.any(Number),
    );
  });

  it('submitChecklist() offline completes the cycle when the tape carries COMPLETE_CYCLE (terminal checklist)', async () => {
    mockResolvePending.mockResolvedValueOnce([{ id: 'cl-f1', questions: [] }]);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({ filterId: 'f1', filterName: 'F-1', targetState: 'STORAGE_OUT' });
    });

    mockExecuteOrQueue.mockResolvedValueOnce({ executed: false });
    mockGetCachedData.mockResolvedValueOnce({ existing: 'data', currentState: 'STORAGE_OUT', currentCycle: { id: 'cyc-1' }, pendingChecklist: [{ id: 'cl' }] });
    // Terminal checklist → after clearing the gate the executor emits COMPLETE_CYCLE.
    mockGetCurrentActions.mockResolvedValueOnce([
      { type: 'COMPLETE_CYCLE', params: {} },
      { type: 'TERMINATE_CYCLE', params: {} },
    ]);

    await act(async () => {
      await result.current.submitChecklist({ filterId: 'f1', filterName: 'F-1', answers: { q1: 'YES' } });
    });

    // Second cacheData call clears the cycle (currentState/currentCycle nulled)
    // so a re-scan starts a fresh cycle — no "in-cycle but no next stage" gate.
    expect(mockCacheData).toHaveBeenNthCalledWith(
      2,
      'filter-state-f1',
      expect.objectContaining({ currentState: null, currentCycle: null, nextAllowedStages: [], actions: [] }),
      expect.any(Number),
    );
    // And the offline cycle id is cleared on the filter row.
    expect(mockClearCycle).toHaveBeenCalledWith('f1');
  });

  it('submitChecklist() offline cache-clear failure is swallowed — does NOT throw OFFLINE_CACHE_RECOMPUTE_FAILED', async () => {
    mockResolvePending.mockResolvedValueOnce([{ id: 'cl-f1', questions: [] }]);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_OUT',
      });
    });

    mockExecuteOrQueue.mockResolvedValueOnce({ executed: false });
    mockGetCachedData.mockRejectedValueOnce(new Error('IDB unavailable'));

    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.submitChecklist({
          filterId: 'f1',
          filterName: 'F-1',
          answers: {},
        });
      } catch (e) { thrown = e; }
    });

    expect(thrown).toBeNull();
    // Dialog still closes despite the cache-clear failure.
    expect(result.current.dialogState.kind).toBe('none');
  });

  it('submitChecklist() calls appendChecklistCompletion for each profile in the dialog (Tier 1 log — 21 CFR)', async () => {
    // Open a checklist dialog with 2 profiles
    mockResolvePending.mockResolvedValueOnce([
      { checklistProfileId: 'p1', questions: [] },
      { checklistProfileId: 'p2', questions: [] },
    ]);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_OUT',
      });
    });

    mockExecuteOrQueue.mockResolvedValueOnce({ executed: true });
    // Cache row says currentState=WASH_OUT, cycleId=cyc-1
    mockGetCachedData.mockResolvedValueOnce({
      currentState: 'WASH_OUT',
      currentCycle: { id: 'cyc-1' },
    });

    await act(async () => {
      await result.current.submitChecklist({
        filterId: 'f1',
        filterName: 'F-1',
        answers: { q1: 'YES' },
      });
    });

    expect(mockAppendCompletion).toHaveBeenCalledTimes(2);
    expect(mockAppendCompletion).toHaveBeenNthCalledWith(1, 'f1', expect.objectContaining({
      checklistProfileId: 'p1',
      afterStage: 'WASH_OUT',
      cycleId: 'cyc-1',
      completedAt: expect.any(String),
    }));
    expect(mockAppendCompletion).toHaveBeenNthCalledWith(2, 'f1', expect.objectContaining({
      checklistProfileId: 'p2',
      afterStage: 'WASH_OUT',
      cycleId: 'cyc-1',
    }));
  });

  it('submitChecklist() skips appendChecklistCompletion when cache row has no currentState (defensive)', async () => {
    mockResolvePending.mockResolvedValueOnce([{ checklistProfileId: 'p1', questions: [] }]);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_OUT',
      });
    });

    mockExecuteOrQueue.mockResolvedValueOnce({ executed: true });
    mockGetCachedData.mockResolvedValueOnce({}); // no currentState

    await act(async () => {
      await result.current.submitChecklist({
        filterId: 'f1',
        filterName: 'F-1',
        answers: {},
      });
    });

    expect(mockAppendCompletion).not.toHaveBeenCalled();
  });

  it('submitChecklist() swallows appendChecklistCompletion failures (best-effort log)', async () => {
    mockResolvePending.mockResolvedValueOnce([{ checklistProfileId: 'p1', questions: [] }]);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_OUT',
      });
    });

    mockExecuteOrQueue.mockResolvedValueOnce({ executed: true });
    mockGetCachedData.mockResolvedValueOnce({
      currentState: 'WASH_OUT',
      currentCycle: { id: 'cyc-1' },
    });
    mockAppendCompletion.mockRejectedValueOnce(new Error('IDB write failed'));

    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.submitChecklist({
          filterId: 'f1',
          filterName: 'F-1',
          answers: {},
        });
      } catch (e) { thrown = e; }
    });

    expect(thrown).toBeNull();
    expect(result.current.dialogState.kind).toBe('none');
  });

  it('submitChecklist() online (executed=true) DOES rewrite the cache row (clear pendingChecklist + re-derive tape)', async () => {
    // 2026-05-20: online submitChecklist MUST clear pendingChecklist and
    // re-derive nextAllowedStages/actions so the batch-DRY_IN replay loop
    // doesn't re-open the same checklist dialog forever. Pre-fix this branch
    // was gated on `!executed` and the cache stayed stale. See use-core.ts
    // L432-462 comment block.
    mockResolvePending.mockResolvedValueOnce([{ checklistProfileId: 'p1', questions: [] }]);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1',
        filterName: 'F-1',
        targetState: 'WASH_OUT',
      });
    });

    mockCacheData.mockClear();
    mockExecuteOrQueue.mockResolvedValueOnce({ executed: true });
    mockGetCachedData.mockResolvedValueOnce({
      currentState: 'WASH_OUT',
      currentCycle: { id: 'cyc-1' },
    });

    await act(async () => {
      await result.current.submitChecklist({
        filterId: 'f1',
        filterName: 'F-1',
        answers: {},
      });
    });

    // Two writes: (1) clear pendingChecklist, (2) re-derived tape +
    // nextAllowedStages on top of the cleared row.
    expect(mockCacheData).toHaveBeenCalled();
    const writes = mockCacheData.mock.calls.map((c: any[]) => c[1]);
    expect(writes.some((w: any) => Array.isArray(w?.pendingChecklist) && w.pendingChecklist.length === 0)).toBe(true);
  });
});

/**
 * Dialog-first atomic advance+checklist (2026-07-16).
 *
 * The defect: `advance()` wrote the stage transition, THEN the dialog rendered.
 * Close is client-only and makes no API call, so an operator who closed the
 * dialog left a checksummed filter_events row + hash-chained audit_trail row
 * asserting a stage entry whose mandatory checklist was never answered — a
 * 21 CFR §11 record of an event whose required attestation does not exist.
 * Reproduced server-side in
 * apps/api/src/modules/filter-operations/__tests__/terminal-checklist-advance-persistence.test.ts.
 *
 * The fix inverts the order: resolve the target stage's checklist FIRST, render
 * the dialog, write NOTHING, and on submit dispatch ONE atomic
 * `advance-with-checklist` op. These tests pin the reorder without a device
 * (step 6, tablet verification, is operator-only).
 *
 * Scope gate — deferral is online + single-filter + non-dryer only. Batch
 * continuations drive their own dialog cascade (deferring trips assertOpenable)
 * and offline needs the combined queue entry; both keep the legacy path until
 * those land. Every test above runs with onlineRef.current = false, which is
 * exactly why they still assert the pre-fix behaviour unchanged.
 */
describe('useFilterOperationsCore — dialog-first atomic advance+checklist', () => {
  const CHECKLIST = [
    { checklistProfileId: 'cp1', questions: [{ id: 'q1', question: 'Inspected?', questionType: 'YES_NO' }] },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteOrQueue.mockResolvedValue({ executed: true, result: { actions: [] } });
    mockResolvePending.mockResolvedValue(null);
    mockFindNext.mockResolvedValue(null);
    mockRecomputeCache.mockResolvedValue(undefined);
    mockAppendCompletion.mockResolvedValue(undefined);
    mockGetCachedData.mockResolvedValue({});
    mockCacheData.mockResolvedValue(undefined);
    mockGetCurrentActions.mockResolvedValue([]);
    mockResolveForTarget.mockResolvedValue([]);
    mockCacheServerState.mockResolvedValue(undefined);
    onlineRef.current = true;
  });

  // THE bug, in one assertion: the write must not happen.
  it('writes NOTHING when the target stage has a checklist — opens the dialog instead', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);

    const { result } = renderHook(() => useFilterOperationsCore());
    let outcome: any;
    await act(async () => {
      outcome = await result.current.advance({ filterId: 'f1', filterName: 'F-1', targetState: 'S2' });
    });

    // Pre-fix this was 1 — the advance committed before the dialog rendered.
    expect(mockExecuteOrQueue).not.toHaveBeenCalled();
    expect(outcome.deferred).toBe(true);
    expect(outcome.executed).toBe(false);
    expect(outcome.dialogOpened).toBe(true);
    expect(result.current.dialogState.kind).toBe('awaiting_checklist');
  });

  it('parks the advance intent on the dialog', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1', filterName: 'F-1', targetState: 'S2',
        cleaningAreaId: 'blk1', remarks: 'r',
      });
    });

    expect(result.current.dialogState.kind).toBe('awaiting_checklist');
    if (result.current.dialogState.kind === 'awaiting_checklist') {
      const d = result.current.dialogState.deferredAdvance;
      expect(d?.targetState).toBe('S2');
      expect(d?.payload).toMatchObject({ targetState: 'S2', cleaningAreaId: 'blk1', remarks: 'r' });
    }
  });

  // Close is a client-only no-op — with the advance parked (never written), that
  // is now literally true. Pre-fix the transition was already on record.
  it('discards the parked advance on close — still zero writes', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({ filterId: 'f1', filterName: 'F-1', targetState: 'S2' });
    });
    act(() => { result.current.dispatch({ type: 'close' }); });

    expect(result.current.dialogState.kind).toBe('none');
    expect(mockExecuteOrQueue).not.toHaveBeenCalled();
  });

  it('submits the parked advance and the answers as ONE atomic op', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1', filterName: 'F-1', targetState: 'S2', cleaningAreaId: 'blk1',
      });
    });
    await act(async () => {
      await result.current.submitChecklist({
        filterId: 'f1', filterName: 'F-1', answers: { q1: 'YES' }, password: 'pw',
      });
    });

    // ONE call, not an advance followed by a submit-checklist.
    expect(mockExecuteOrQueue).toHaveBeenCalledTimes(1);
    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'advance-with-checklist',
      'f1',
      'F-1',
      expect.objectContaining({ targetState: 'S2', cleaningAreaId: 'blk1', answers: { q1: 'YES' } }),
      'S2',
      'pw',
    );
    expect(result.current.dialogState.kind).toBe('none');
  });

  it('caches the server snapshot after the combined op — the cache row still held the pre-advance stage', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);
    const snapshot = { currentState: null, tapeVersion: 9, actions: [] };
    mockExecuteOrQueue.mockResolvedValue({ executed: true, result: snapshot });

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({ filterId: 'f1', filterName: 'F-1', targetState: 'S2' });
    });
    await act(async () => {
      await result.current.submitChecklist({ filterId: 'f1', filterName: 'F-1', answers: { q1: 'YES' } });
    });

    expect(mockCacheServerState).toHaveBeenCalledWith('f1', snapshot);
  });

  // The network dropped between opening the dialog and submitting. executeOrQueue
  // falls through to the IDB queue, so the local cache must be reconciled to the
  // stage the queued op will land on.
  it('recomputes the cache for the target stage when the combined op queues', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);
    mockExecuteOrQueue.mockResolvedValue({ executed: false });

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1', filterName: 'F-1', targetState: 'S2', cleaningAreaId: 'blk1',
      });
    });
    await act(async () => {
      await result.current.submitChecklist({ filterId: 'f1', filterName: 'F-1', answers: { q1: 'YES' } });
    });

    expect(mockCacheServerState).not.toHaveBeenCalled();
    expect(mockRecomputeCache).toHaveBeenCalledWith('f1', 'S2', false, 'blk1');
  });

  // afterStage feeds appendChecklistCompletion (and the server's §11 record via
  // the op). The cache row holds the PRE-advance stage, so reading it here would
  // log the attestation against a stage the checklist does not belong to.
  it('logs the checklist completion against the TARGET stage, not the cached pre-advance stage', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);
    mockGetCachedData.mockResolvedValue({ currentState: 'S1', currentCycle: { id: 'cyc1' } });

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({ filterId: 'f1', filterName: 'F-1', targetState: 'S2' });
    });
    await act(async () => {
      await result.current.submitChecklist({ filterId: 'f1', filterName: 'F-1', answers: { q1: 'YES' } });
    });

    expect(mockAppendCompletion).toHaveBeenCalledWith(
      'f1',
      expect.objectContaining({ checklistProfileId: 'cp1', afterStage: 'S2' }),
    );
  });

  it('advances plainly when the target stage has no checklist', async () => {
    mockResolveForTarget.mockResolvedValue([]);

    const { result } = renderHook(() => useFilterOperationsCore());
    let outcome: any;
    await act(async () => {
      outcome = await result.current.advance({ filterId: 'f1', filterName: 'F-1', targetState: 'S2' });
    });

    expect(outcome.deferred).toBe(false);
    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'advance', 'f1', 'F-1', expect.objectContaining({ targetState: 'S2' }), 'S2', undefined,
    );
  });

  // ── Scope gates: everything below must keep the legacy path ──────────────

  it('does NOT defer a dryer SET_DURATION — it never leaves DRY_IN, so the post-DRY_IN checklist must not pop', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1', filterName: 'F-1', targetState: 'DRY_IN',
        dryerAction: 'SET_DURATION', dryerDurationMinutes: 30,
      });
    });

    expect(mockResolveForTarget).not.toHaveBeenCalled();
    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'advance', 'f1', 'F-1', expect.objectContaining({ dryerAction: 'SET_DURATION' }), 'DRY_IN', undefined,
    );
  });

  it('does NOT defer a batch continuation (would trip assertOpenable)', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1', filterName: 'F-1', targetState: 'S2',
        batchRemainder: [{ filterId: 'f2', filterName: 'F-2' }],
      });
    });

    expect(mockResolveForTarget).not.toHaveBeenCalled();
    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'advance', 'f1', 'F-1', expect.anything(), 'S2', undefined,
    );
  });

  it('does NOT defer when the caller opts out (allowDefer:false — caller has follow-on batch work)', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({
        filterId: 'f1', filterName: 'F-1', targetState: 'S2', allowDefer: false,
      });
    });

    expect(mockResolveForTarget).not.toHaveBeenCalled();
    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'advance', 'f1', 'F-1', expect.anything(), 'S2', undefined,
    );
  });

  // Offline is the tablet's normal mode and the surface the defect was reported
  // on. The resolve is cache-first (the tablet caches checklist-profiles via SWR
  // + the offline sync) and the combined op queues as ONE entry.
  it('defers OFFLINE too and queues ONE combined op', async () => {
    onlineRef.current = false;
    mockResolveForTarget.mockResolvedValue(CHECKLIST);
    mockExecuteOrQueue.mockResolvedValue({ executed: false });

    const { result } = renderHook(() => useFilterOperationsCore());
    let outcome: any;
    await act(async () => {
      outcome = await result.current.advance({ filterId: 'f1', filterName: 'F-1', targetState: 'S2' });
    });
    expect(outcome.deferred).toBe(true);
    expect(mockExecuteOrQueue).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.submitChecklist({ filterId: 'f1', filterName: 'F-1', answers: { q1: 'YES' } });
    });

    // ONE queue entry — not an advance row followed by a submit-checklist row,
    // which would replay as two transactions and re-open the orphan window on
    // sync if the checklist half failed.
    expect(mockExecuteOrQueue).toHaveBeenCalledTimes(1);
    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'advance-with-checklist', 'f1', 'F-1',
      expect.objectContaining({ targetState: 'S2', answers: { q1: 'YES' } }),
      'S2', undefined,
    );
  });

  // Fail SOFT, not silent: an unresolvable checklist offline (profiles never
  // synced / stale cache) falls back to the legacy path rather than skipping the
  // gate. The server re-validates the queued advance on replay regardless.
  it('falls back to the legacy path when the checklist cannot be resolved offline', async () => {
    onlineRef.current = false;
    mockResolveForTarget.mockResolvedValue([]); // cache miss — cannot render the dialog
    mockExecuteOrQueue.mockResolvedValue({ executed: false });

    const { result } = renderHook(() => useFilterOperationsCore());
    let outcome: any;
    await act(async () => {
      outcome = await result.current.advance({ filterId: 'f1', filterName: 'F-1', targetState: 'S2' });
    });

    expect(outcome.deferred).toBe(false);
    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'advance', 'f1', 'F-1', expect.anything(), 'S2', undefined,
    );
  });

  // A stale intent leaking onto a different filter's submit would advance the
  // WRONG filter. It can't: the intent lives on the dialog state, and this
  // guard also checks the id.
  it('ignores a parked intent belonging to a different filter', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.advance({ filterId: 'f1', filterName: 'F-1', targetState: 'S2' });
    });
    mockExecuteOrQueue.mockClear();

    await act(async () => {
      await result.current.submitChecklist({ filterId: 'f-other', filterName: 'F-OTHER', answers: {} });
    });

    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'submit-checklist', 'f-other', 'F-OTHER', expect.anything(), undefined, undefined,
    );
  });
});

/**
 * Batch dialog-first (2026-07-16, step 5).
 *
 * ONE checklist dialog covers N filters, so only the PRIMARY filter has dialog
 * state. Members 2..N carry their parked advance through the explicit
 * `deferredAdvance` arg — without it they would submit a bare checklist against
 * a stage their filter never entered, which is the orphan bug wearing a
 * different hat.
 *
 * The batch page code (mobile-operations.tsx handleSubmitQueue) does the
 * partitioning + parking; these pin the hook contract it depends on.
 */
describe('useFilterOperationsCore — batch parked advances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteOrQueue.mockResolvedValue({ executed: true, result: { actions: [] } });
    mockResolvePending.mockResolvedValue(null);
    mockFindNext.mockResolvedValue(null);
    mockRecomputeCache.mockResolvedValue(undefined);
    mockAppendCompletion.mockResolvedValue(undefined);
    mockGetCachedData.mockResolvedValue({});
    mockCacheData.mockResolvedValue(undefined);
    mockGetCurrentActions.mockResolvedValue([]);
    mockResolveForTarget.mockResolvedValue([]);
    mockCacheServerState.mockResolvedValue(undefined);
    onlineRef.current = true;
  });

  // The batch member with no dialog state of its own.
  it('sends an explicit parked advance as one atomic op even with no dialog open', async () => {
    const { result } = renderHook(() => useFilterOperationsCore());
    expect(result.current.dialogState.kind).toBe('none');

    await act(async () => {
      await result.current.submitChecklist({
        filterId: 'f2',
        filterName: 'F-2',
        answers: { q1: 'YES' },
        deferredAdvance: { targetState: 'S2', payload: { targetState: 'S2', cleaningAreaId: 'blk1' } },
      });
    });

    expect(mockExecuteOrQueue).toHaveBeenCalledTimes(1);
    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'advance-with-checklist',
      'f2',
      'F-2',
      expect.objectContaining({ targetState: 'S2', cleaningAreaId: 'blk1', answers: { q1: 'YES' } }),
      'S2',
      undefined,
    );
  });

  it('logs each batch member\'s completion against ITS target stage', async () => {
    mockGetCachedData.mockResolvedValue({ currentState: 'S1', currentCycle: { id: 'cyc2' } });
    mockResolvePending.mockResolvedValueOnce([{ checklistProfileId: 'cp1', questions: [] }]);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.submitChecklist({
        filterId: 'f2',
        filterName: 'F-2',
        answers: { q1: 'YES' },
        deferredAdvance: { targetState: 'S2', payload: { targetState: 'S2' } },
      });
    });

    // The cache row still says S1 (the advance is in-flight in the same op).
    const calls = mockAppendCompletion.mock.calls;
    for (const c of calls) {
      expect(c[1]).toMatchObject({ afterStage: 'S2' });
    }
  });

  // The explicit arg must win: during a batch the dialog belongs to the PRIMARY,
  // so falling back to the dialog lookup for member 2..N would attach the
  // primary's advance to the wrong filter.
  it('prefers the explicit parked advance over the open dialog\'s intent', async () => {
    mockResolveForTarget.mockResolvedValue([
      { checklistProfileId: 'cp1', questions: [{ id: 'q1', question: 'ok?', questionType: 'YES_NO' }] },
    ]);

    const { result } = renderHook(() => useFilterOperationsCore());
    // Primary parks an advance to S2 and owns the dialog.
    await act(async () => {
      await result.current.advance({ filterId: 'f1', filterName: 'F-1', targetState: 'S2' });
    });
    mockExecuteOrQueue.mockClear();

    // Member 2 submits with its OWN parked advance while f1's dialog is open.
    await act(async () => {
      await result.current.submitChecklist({
        filterId: 'f2',
        filterName: 'F-2',
        answers: { q1: 'YES' },
        deferredAdvance: { targetState: 'S9', payload: { targetState: 'S9' } },
      });
    });

    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'advance-with-checklist',
      'f2',
      'F-2',
      expect.objectContaining({ targetState: 'S9' }),
      'S9',
      undefined,
    );
  });
});

/**
 * Dialog-first CYCLE START (2026-07-16) — the last orphan.
 *
 * `startAndAdvance` committed the cycle AND the entry into its first stage
 * before a mandatory WASH_IN-style checklist rendered, so Close stranded a stage
 * entry with no attestation. This is the INVISIBLE variant of the reported bug —
 * the next advance throws CHECKLIST_PENDING and drags the operator back, so it
 * self-corrects in practice — but it is the same §11 class.
 *
 * The submit dispatches `start-and-advance-with-checklist`: start, then the
 * ATOMIC advance+checklist. Start remains a separate request (as it already was);
 * a started cycle that never entered a stage records no attestation-less
 * transition, so it is a different (pre-existing) gap.
 */
describe('useFilterOperationsCore — dialog-first cycle start', () => {
  const CHECKLIST = [
    { checklistProfileId: 'cp1', questions: [{ id: 'q1', question: 'Inspected?', questionType: 'YES_NO' }] },
  ];
  const CYCLE = { cleaningReasonKey: 'ROUTINE' };
  const ADV = { targetState: 'WASH_IN', cleaningAreaId: 'blk1' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteOrQueue.mockResolvedValue({ executed: true, result: { actions: [] } });
    mockResolvePending.mockResolvedValue(null);
    mockFindNext.mockResolvedValue(null);
    mockRecomputeCache.mockResolvedValue(undefined);
    mockAppendCompletion.mockResolvedValue(undefined);
    mockGetCachedData.mockResolvedValue({});
    mockCacheData.mockResolvedValue(undefined);
    mockGetCurrentActions.mockResolvedValue([]);
    mockResolveForTarget.mockResolvedValue([]);
    mockCacheServerState.mockResolvedValue(undefined);
    onlineRef.current = true;
  });

  it('writes NOTHING — not even the cycle start — when the first stage has a checklist', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);

    const { result } = renderHook(() => useFilterOperationsCore());
    let outcome: any;
    await act(async () => {
      outcome = await result.current.startAndAdvance({
        filterId: 'f1', filterName: 'F-1',
        cyclePayload: CYCLE, advancePayload: ADV,
        targetState: 'WASH_IN', cleaningAreaId: 'blk1',
      });
    });

    expect(mockExecuteOrQueue).not.toHaveBeenCalled();
    expect(outcome.deferred).toBe(true);
    expect(result.current.dialogState.kind).toBe('awaiting_checklist');
  });

  it('parks the cyclePayload — that is what routes the submit to the compound op', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.startAndAdvance({
        filterId: 'f1', filterName: 'F-1',
        cyclePayload: CYCLE, advancePayload: ADV,
        targetState: 'WASH_IN',
      });
    });

    if (result.current.dialogState.kind === 'awaiting_checklist') {
      expect(result.current.dialogState.deferredAdvance?.cyclePayload).toEqual(CYCLE);
    }
  });

  it('submits start + atomic advance+checklist as ONE compound op', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.startAndAdvance({
        filterId: 'f1', filterName: 'F-1',
        cyclePayload: CYCLE, advancePayload: ADV,
        targetState: 'WASH_IN',
      });
    });
    await act(async () => {
      await result.current.submitChecklist({
        filterId: 'f1', filterName: 'F-1', answers: { q1: 'YES' }, password: 'pw',
      });
    });

    expect(mockExecuteOrQueue).toHaveBeenCalledTimes(1);
    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'start-and-advance-with-checklist',
      'f1',
      'F-1',
      expect.objectContaining({
        cyclePayload: CYCLE,
        advancePayload: expect.objectContaining({ targetState: 'WASH_IN', answers: { q1: 'YES' } }),
      }),
      'WASH_IN',
      'pw',
    );
  });

  // cycleStarted=true or the next offline scan sees no cycle in progress and
  // offers to start a SECOND one.
  it('recomputes the cache WITH the cycle stub when the compound op queues', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);
    mockExecuteOrQueue.mockResolvedValue({ executed: false });

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.startAndAdvance({
        filterId: 'f1', filterName: 'F-1',
        cyclePayload: CYCLE, advancePayload: ADV,
        targetState: 'WASH_IN', cleaningAreaId: 'blk1',
      });
    });
    await act(async () => {
      await result.current.submitChecklist({ filterId: 'f1', filterName: 'F-1', answers: { q1: 'YES' } });
    });

    expect(mockRecomputeCache).toHaveBeenCalledWith('f1', 'WASH_IN', true, 'blk1');
  });

  // The reason dialog is OPEN when the no-equipment cycle-start path calls
  // startAndAdvance. open_checklist from awaiting_reason used to throw
  // assertOpenable — a crash, not a cosmetic miss.
  it('opens the checklist directly over the reason dialog without tripping assertOpenable', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);

    const { result } = renderHook(() => useFilterOperationsCore());
    act(() => {
      result.current.dispatch({ type: 'open_reason', filterId: 'f1', filterName: 'F-1', stage: 'WASH_IN' });
    });
    expect(result.current.dialogState.kind).toBe('awaiting_reason');

    await act(async () => {
      await result.current.startAndAdvance({
        filterId: 'f1', filterName: 'F-1',
        cyclePayload: CYCLE, advancePayload: ADV,
        targetState: 'WASH_IN',
      });
    });

    expect(result.current.dialogState.kind).toBe('awaiting_checklist');
  });

  it('does NOT defer a batch continuation', async () => {
    mockResolveForTarget.mockResolvedValue(CHECKLIST);

    const { result } = renderHook(() => useFilterOperationsCore());
    await act(async () => {
      await result.current.startAndAdvance({
        filterId: 'f1', filterName: 'F-1',
        cyclePayload: CYCLE, advancePayload: ADV,
        targetState: 'WASH_IN',
        skipChecklistDispatch: true,
      });
    });

    expect(mockResolveForTarget).not.toHaveBeenCalled();
    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'start-and-advance', 'f1', 'F-1', expect.anything(), 'WASH_IN', undefined,
    );
  });

  it('starts+advances plainly when the first stage has no checklist', async () => {
    mockResolveForTarget.mockResolvedValue([]);

    const { result } = renderHook(() => useFilterOperationsCore());
    let outcome: any;
    await act(async () => {
      outcome = await result.current.startAndAdvance({
        filterId: 'f1', filterName: 'F-1',
        cyclePayload: CYCLE, advancePayload: ADV,
        targetState: 'WASH_IN',
      });
    });

    expect(outcome.deferred).toBe(false);
    expect(mockExecuteOrQueue).toHaveBeenCalledWith(
      'start-and-advance', 'f1', 'F-1', expect.anything(), 'WASH_IN', undefined,
    );
  });
});
