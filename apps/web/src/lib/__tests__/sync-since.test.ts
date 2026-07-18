import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Phase 8.4b — sync-since FE consumer.
 *
 * Mocks api-client + offline-store so we drive `syncSince()` deterministically
 * and assert: query string built from versionState, results written into the
 * 6 sync stores, cursors advanced to max(version) per entity, debounce
 * coalesces rapid triggers into one network call, in-flight calls dedupe.
 *
 * Pattern follows sync-engine.test.ts — vi.hoisted mocks, inject by module.
 */

const { mockApiClient, mockStore, storeState } = vi.hoisted(() => {
  const state = {
    versionState: {
      key: 'current' as const,
      profileVersion: 0,
      filterProfileVersion: 0,
      equipmentGroupVersion: 0,
      checklistVersion: 0,
      assetTemplateVersion: 0,
      filterUpdatedSince: null as string | null,
      lastSyncedAt: null as string | null,
    },
    cached: {} as Record<string, any[]>,
  };
  return {
    storeState: state,
    mockApiClient: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
    mockStore: {
      cacheEntities: vi.fn(async (storeName: string, rows: any[]) => {
        state.cached[storeName] = [...(state.cached[storeName] ?? []), ...rows];
      }),
      getVersionState: vi.fn(async () => ({ ...state.versionState })),
      setVersionState: vi.fn(async (v: any) => { state.versionState = { ...v }; }),
    },
  };
});

vi.mock('../api-client', () => ({ apiClient: mockApiClient }));
vi.mock('../offline-store', () => mockStore);

import { syncSince, triggerSync, __resetSyncSinceForTest, __isSyncBusyForTest } from '../sync-since';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  storeState.versionState = {
    key: 'current',
    profileVersion: 0,
    filterProfileVersion: 0,
    equipmentGroupVersion: 0,
    checklistVersion: 0,
    assetTemplateVersion: 0,
    filterUpdatedSince: null,
    lastSyncedAt: null,
  };
  storeState.cached = {};
  __resetSyncSinceForTest();
  // navigator.onLine defaults true in jsdom
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('syncSince() — happy-path round-trip', () => {
  it('1. calls /api/sync/since with cursors from current versionState (defaults)', async () => {
    mockApiClient.get.mockResolvedValueOnce({
      filterCleaningProfiles: [], filterProfiles: [], equipmentGroups: [],
      checklistProfiles: [], assetTemplates: [], filters: [],
      serverTimestamp: '2026-05-02T00:00:00Z', hasMore: false,
    });
    await syncSince();
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
    const url = mockApiClient.get.mock.calls[0][0] as string;
    expect(url).toMatch(/^\/api\/sync\/since\?/);
    expect(url).toContain('profileVersion=0');
    expect(url).toContain('filterProfileVersion=0');
    expect(url).toContain('equipmentGroupVersion=0');
    expect(url).toContain('checklistVersion=0');
    expect(url).toContain('assetTemplateVersion=0');
    expect(url).not.toContain('filterUpdatedSince=');
  });

  it('2. propagates non-default cursor values into the query', async () => {
    storeState.versionState.profileVersion = 12;
    storeState.versionState.filterProfileVersion = 4;
    storeState.versionState.equipmentGroupVersion = 8;
    storeState.versionState.filterUpdatedSince = '2026-04-30T00:00:00Z';
    mockApiClient.get.mockResolvedValueOnce({
      filterCleaningProfiles: [], filterProfiles: [], equipmentGroups: [],
      checklistProfiles: [], assetTemplates: [], filters: [],
      serverTimestamp: '2026-05-02T00:00:00Z', hasMore: false,
    });
    await syncSince();
    const url = mockApiClient.get.mock.calls[0][0] as string;
    expect(url).toContain('profileVersion=12');
    expect(url).toContain('filterProfileVersion=4');
    expect(url).toContain('equipmentGroupVersion=8');
    expect(url).toContain('filterUpdatedSince=');
    // url-encoded
    expect(decodeURIComponent(url)).toContain('filterUpdatedSince=2026-04-30T00:00:00Z');
  });

  it('3. writes incoming rows into the 6 sync stores', async () => {
    mockApiClient.get.mockResolvedValueOnce({
      filterCleaningProfiles: [{ id: 'fcp-1', version: 1 }],
      filterProfiles: [{ id: 'fp-1', version: 2 }],
      equipmentGroups: [{ id: 'eg-1', version: 5 }],
      checklistProfiles: [],
      assetTemplates: [],
      filters: [{ id: 'f-1', updatedAt: '2026-05-01T10:00:00Z' }],
      serverTimestamp: '2026-05-02T00:00:00Z', hasMore: false,
    });
    await syncSince();
    expect(mockStore.cacheEntities).toHaveBeenCalledWith('syncFilterCleaningProfiles', [{ id: 'fcp-1', version: 1 }]);
    expect(mockStore.cacheEntities).toHaveBeenCalledWith('syncFilterProfiles', [{ id: 'fp-1', version: 2 }]);
    expect(mockStore.cacheEntities).toHaveBeenCalledWith('syncEquipmentGroups', [{ id: 'eg-1', version: 5 }]);
    expect(mockStore.cacheEntities).toHaveBeenCalledWith('syncChecklistProfiles', []);
    expect(mockStore.cacheEntities).toHaveBeenCalledWith('syncAssetTemplates', []);
    expect(mockStore.cacheEntities).toHaveBeenCalledWith('syncFilters', [{ id: 'f-1', updatedAt: '2026-05-01T10:00:00Z' }]);
  });

  it('4. advances cursors to max(version) per entity', async () => {
    storeState.versionState.profileVersion = 5;
    mockApiClient.get.mockResolvedValueOnce({
      filterCleaningProfiles: [
        { id: 'fcp-a', version: 7 },
        { id: 'fcp-b', version: 12 },
        { id: 'fcp-c', version: 9 },
      ],
      filterProfiles: [{ id: 'fp-1', version: 3 }],
      equipmentGroups: [],
      checklistProfiles: [],
      assetTemplates: [],
      filters: [],
      serverTimestamp: '2026-05-02T00:00:00Z', hasMore: false,
    });
    const result = await syncSince();
    expect(result.versionState.profileVersion).toBe(12);   // max of 7/12/9
    expect(result.versionState.filterProfileVersion).toBe(3);
    expect(result.versionState.equipmentGroupVersion).toBe(0); // unchanged
    expect(mockStore.setVersionState).toHaveBeenCalledTimes(1);
  });

  it('5. cursors NEVER go backward when an entity returns no rows', async () => {
    storeState.versionState.profileVersion = 100;
    storeState.versionState.filterProfileVersion = 50;
    mockApiClient.get.mockResolvedValueOnce({
      filterCleaningProfiles: [], filterProfiles: [], equipmentGroups: [],
      checklistProfiles: [], assetTemplates: [], filters: [],
      serverTimestamp: '2026-05-02T00:00:00Z', hasMore: false,
    });
    const result = await syncSince();
    expect(result.versionState.profileVersion).toBe(100);
    expect(result.versionState.filterProfileVersion).toBe(50);
  });

  it('6. filter watermark advances to max(updatedAt, filterDetailsUpdatedAt)', async () => {
    mockApiClient.get.mockResolvedValueOnce({
      filterCleaningProfiles: [], filterProfiles: [], equipmentGroups: [],
      checklistProfiles: [], assetTemplates: [],
      filters: [
        { id: 'f-1', updatedAt: '2026-05-01T10:00:00Z', filterDetailsUpdatedAt: '2026-05-01T11:00:00Z' },
        { id: 'f-2', updatedAt: '2026-05-02T08:00:00Z', filterDetailsUpdatedAt: null },
        { id: 'f-3', updatedAt: '2026-04-30T00:00:00Z', filterDetailsUpdatedAt: '2026-05-02T15:00:00Z' },
      ],
      serverTimestamp: '2026-05-02T20:00:00Z', hasMore: false,
    });
    const result = await syncSince();
    // f-3.filterDetailsUpdatedAt is the latest at 2026-05-02T15:00:00Z
    expect(result.versionState.filterUpdatedSince).toBe('2026-05-02T15:00:00Z');
  });

  it('7. result.rowsAdded counts what was returned per entity', async () => {
    mockApiClient.get.mockResolvedValueOnce({
      filterCleaningProfiles: [{ id: 'a', version: 1 }, { id: 'b', version: 2 }],
      filterProfiles: [{ id: 'fp', version: 1 }],
      equipmentGroups: [],
      checklistProfiles: [],
      assetTemplates: [],
      filters: [{ id: 'f1', updatedAt: '2026-05-01T00:00:00Z' }, { id: 'f2', updatedAt: '2026-05-01T01:00:00Z' }, { id: 'f3', updatedAt: '2026-05-01T02:00:00Z' }],
      serverTimestamp: '2026-05-02T00:00:00Z', hasMore: false,
    });
    const result = await syncSince();
    expect(result.rowsAdded).toEqual({
      filterCleaningProfiles: 2,
      filterProfiles: 1,
      equipmentGroups: 0,
      checklistProfiles: 0,
      assetTemplates: 0,
      filters: 3,
    });
  });

  it('8. hasMore flag from server is surfaced unchanged', async () => {
    mockApiClient.get.mockResolvedValueOnce({
      filterCleaningProfiles: [], filterProfiles: [], equipmentGroups: [],
      checklistProfiles: [], assetTemplates: [], filters: [],
      serverTimestamp: '2026-05-02T00:00:00Z', hasMore: true,
    });
    const result = await syncSince();
    expect(result.hasMore).toBe(true);
  });

  it('9. malformed response (missing arrays) treats them as empty — no crash', async () => {
    mockApiClient.get.mockResolvedValueOnce({
      // intentionally empty — no entity keys at all
      serverTimestamp: '2026-05-02T00:00:00Z',
    } as any);
    const result = await syncSince();
    expect(result.rowsAdded.filterCleaningProfiles).toBe(0);
    expect(result.hasMore).toBe(false);
  });
});

describe('syncSince() — concurrency dedup', () => {
  it('10. two concurrent calls only fire ONE network request', async () => {
    let resolveResp: (v: any) => void = () => {};
    mockApiClient.get.mockImplementationOnce(() =>
      new Promise(r => { resolveResp = r; })
    );
    // Both calls dedupe via the inFlight Promise. Note: the network call
    // doesn't fire until after the `await getVersionState()` microtask
    // resolves, so we let microtasks flush before asserting.
    const a = syncSince();
    const b = syncSince();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
    resolveResp({
      filterCleaningProfiles: [], filterProfiles: [], equipmentGroups: [],
      checklistProfiles: [], assetTemplates: [], filters: [],
      serverTimestamp: '2026-05-02T00:00:00Z', hasMore: false,
    });
    const [ra, rb] = await Promise.all([a, b]);
    // Both promises share the same in-flight result.
    expect(ra).toBe(rb);
  });
});

describe('triggerSync() — debounce + coalescing', () => {
  it('11. multiple triggers within DEBOUNCE_MS coalesce into one network call', async () => {
    mockApiClient.get.mockResolvedValue({
      filterCleaningProfiles: [], filterProfiles: [], equipmentGroups: [],
      checklistProfiles: [], assetTemplates: [], filters: [],
      serverTimestamp: '2026-05-02T00:00:00Z', hasMore: false,
    });
    triggerSync('test-1');
    triggerSync('test-2');
    triggerSync('test-3');
    triggerSync('test-4');
    triggerSync('test-5');
    // Nothing has fired yet — debounce window open.
    expect(mockApiClient.get).toHaveBeenCalledTimes(0);
    expect(__isSyncBusyForTest()).toBe(true);
    // Advance past the 1s debounce.
    await vi.advanceTimersByTimeAsync(1000);
    // Sync fires once.
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
  });

  it('12. trigger after the previous run completes still goes through', async () => {
    mockApiClient.get.mockResolvedValue({
      filterCleaningProfiles: [], filterProfiles: [], equipmentGroups: [],
      checklistProfiles: [], assetTemplates: [], filters: [],
      serverTimestamp: '2026-05-02T00:00:00Z', hasMore: false,
    });
    triggerSync('first');
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
    // Wait for the in-flight promise to settle, then trigger again.
    await vi.runOnlyPendingTimersAsync();
    triggerSync('second');
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
  });
});
