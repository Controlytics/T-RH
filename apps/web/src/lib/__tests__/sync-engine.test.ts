import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Phase 8.3 — sync engine STALE_TAPE handling + backward-compat replay.
 *
 * The engine must:
 *   - On 409 STALE_TAPE: drop the queued op as `failed` (NOT pending) and
 *     surface a refresh-prompt toast. Retrying with the same stored
 *     tapeVersion would just keep failing.
 *   - On other API errors: retry up to MAX_RETRIES, then mark failed.
 *   - On a queued op that has `tapeVersion: null` (pre-8.3): replay without
 *     including a tapeVersion in the body (server-side schema accepts the
 *     missing field as no-check during 8.3 backward-compat window).
 *
 * Test pattern: mock the engine's collaborators (apiClient + offline-store +
 * connectivity), drive `syncPendingOperations()` directly.
 */

const { mockApiClient, mockOfflineStore, mockConnectivity } = vi.hoisted(() => {
  // Track which ops the store currently considers "pending".
  const opsRegistry: any[] = [];
  return {
    mockApiClient: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      // Audit 2026-05-04 fix #4: sync-engine now calls apiClient.refreshToken()
      // (centralised JWT refresh) instead of inline POST. Default success here
      // mirrors the pre-refactor behavior — tests that needed refresh failure
      // can override by writing mockApiClient.refreshToken.mockResolvedValueOnce(false).
      refreshToken: vi.fn(async () => true),
    },
    mockOfflineStore: {
      __ops: opsRegistry,
      getPendingOperations: vi.fn(async () => opsRegistry.filter(o => o.status === 'pending')),
      updateOperationStatus: vi.fn(async (id: string, status: string, error?: string) => {
        const op = opsRegistry.find(o => o.id === id);
        if (op) {
          op.status = status;
          op.error = error;
          if (status === 'failed' || (status === 'pending' && error)) op.retryCount = (op.retryCount ?? 0) + 1;
        }
      }),
      // 2026-05-17 chained-offline-ops fix: persists refreshed tape on the
      // queued row so a mid-drain interruption doesn't leave the next drain
      // replaying the stale on-disk tape.
      updateOperationTapeVersion: vi.fn(async (id: string, tapeVersion: number) => {
        const op = opsRegistry.find(o => o.id === id);
        if (op) op.tapeVersion = tapeVersion;
      }),
      clearSyncedOperations: vi.fn(async () => {}),
      getPendingTombstones: vi.fn(async (): Promise<any[]> => []),
      updateTombstoneStatus: vi.fn(async () => {}),
      clearSyncedTombstones: vi.fn(async () => {}),
      compactSyncedOperations: vi.fn(async () => ({ removed: 0 })),
      evictLruCache: vi.fn(async () => ({ evicted: 0, total: 0 })),
    },
    mockConnectivity: {
      onConnectivityChange: vi.fn(() => () => {}),
      isOnline: vi.fn(() => true),
      startConnectivityEngine: vi.fn(),
    },
  };
});

vi.mock('../api-client', () => ({ apiClient: mockApiClient }));
vi.mock('../offline-store', () => mockOfflineStore);
vi.mock('../connectivity', () => mockConnectivity);

// JWT refresh path inside sync-engine reads sessionStorage. Stub it so the
// refresh succeeds and the queue drain proceeds.
beforeEach(() => {
  vi.clearAllMocks();
  mockOfflineStore.__ops.length = 0;
  // Token in storage so refreshTokenBeforeSync() proceeds.
  (globalThis as any).sessionStorage = {
    getItem: vi.fn(() => 'fake-token'),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  (globalThis as any).localStorage = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  // Default: refresh-token + health-probe succeed. Individual tests override
  // /current-state and the cycle-bound POST.
  mockApiClient.post.mockImplementation(async (url: string) => {
    if (url === '/api/auth/refresh') return { token: 'fresh' };
    return {};
  });
  mockApiClient.get.mockImplementation(async (url: string) => {
    if (url === '/api/health') return {};
    if (url.endsWith('/current-state')) return { currentCycle: { id: 'cyc-1' } };
    return {};
  });
});

afterEach(() => {
  vi.resetModules();
});

import { syncPendingOperations, withReplayTimeout } from '../sync-engine';
import { SYNC_OP_REPLAY_TIMEOUT_MS } from '../timing-constants';

function queueOp(overrides: Partial<{
  type: string;
  filterId: string;
  filterName: string;
  payload: Record<string, any>;
  tapeVersion: number | null | undefined;
  retryCount: number;
}> = {}) {
  const op = {
    id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    clientOpId: `cli-${Math.random().toString(36).slice(2, 8)}`,
    type: overrides.type ?? 'advance',
    filterId: overrides.filterId ?? 'filter-1',
    filterName: overrides.filterName ?? 'F-001',
    payload: overrides.payload ?? { targetState: 'WASH_OUT' },
    createdAt: new Date('2026-05-02T10:00:00Z').toISOString(),
    status: 'pending',
    retryCount: overrides.retryCount ?? 0,
    tapeVersion: overrides.tapeVersion === undefined ? 1005 : overrides.tapeVersion,
  };
  mockOfflineStore.__ops.push(op);
  return op;
}

describe('sync-engine — Phase 8.3 tape-version handling', () => {
  it('1. queued op carries its stored tapeVersion through the replay body', async () => {
    queueOp({ type: 'advance', tapeVersion: 1005 });
    // Force a successful POST.
    mockApiClient.post.mockImplementation(async (url: string) => {
      if (url === '/api/auth/refresh') return { token: 'fresh' };
      return { ok: true };
    });

    const result = await syncPendingOperations();

    expect(result.synced).toBe(1);
    // The advance POST should have been called with tapeVersion in the body.
    const advanceCall = mockApiClient.post.mock.calls.find(
      ([url]: any[]) => typeof url === 'string' && url.includes('/advance'),
    );
    expect(advanceCall).toBeTruthy();
    const body = advanceCall![1] as Record<string, any>;
    expect(body.tapeVersion).toBe(1005);
    expect(body.targetState).toBe('WASH_OUT');
  });

  it('2. pre-8.3 queued op (tapeVersion=null) replays WITHOUT a tapeVersion field — server treats as no-check', async () => {
    queueOp({ type: 'advance', tapeVersion: null });
    mockApiClient.post.mockImplementation(async (url: string) => {
      if (url === '/api/auth/refresh') return { token: 'fresh' };
      return { ok: true };
    });

    const result = await syncPendingOperations();

    expect(result.synced).toBe(1);
    const advanceCall = mockApiClient.post.mock.calls.find(
      ([url]: any[]) => typeof url === 'string' && url.includes('/advance'),
    );
    const body = advanceCall![1] as Record<string, any>;
    // Critical: tapeVersion must NOT be on the body so the server skips the
    // staleness check rather than rejecting null.
    expect('tapeVersion' in body).toBe(false);
  });

  it('3. on 409 STALE_TAPE the op is marked failed (NOT pending) — no retry loop', async () => {
    const op = queueOp({ type: 'advance', tapeVersion: 1003 });
    mockApiClient.post.mockImplementation(async (url: string) => {
      if (url === '/api/auth/refresh') return { token: 'fresh' };
      const err: any = new Error('Tape version mismatch');
      err.code = 'STALE_TAPE';
      err.status = 409;
      err.currentTapeVersion = 1005;
      throw err;
    });

    const result = await syncPendingOperations();

    expect(result.failed).toBe(1);
    expect(result.synced).toBe(0);
    // The store-update for this op must be `failed`, not `pending`.
    const finalUpdate = mockOfflineStore.updateOperationStatus.mock.calls
      .filter(([id]: any[]) => id === op.id)
      .pop();
    expect(finalUpdate![1]).toBe('failed');
    // Op state in the registry confirms it.
    expect(op.status).toBe('failed');
    // retryCount must NOT have been incremented above 1 (single attempt).
    expect(op.retryCount).toBeLessThanOrEqual(1);
  });

  it('4. on a generic 500 error the op stays pending (regular retry path)', async () => {
    const op = queueOp({ type: 'advance', tapeVersion: 1005, retryCount: 0 });
    mockApiClient.post.mockImplementation(async (url: string) => {
      if (url === '/api/auth/refresh') return { token: 'fresh' };
      const err: any = new Error('Internal server error');
      err.code = 'INTERNAL';
      err.status = 500;
      throw err;
    });

    const result = await syncPendingOperations();

    expect(result.failed).toBe(1);
    // Op status: still pending so the next tick will retry.
    expect(op.status).toBe('pending');
    expect(op.retryCount).toBe(1); // bumped exactly once
  });

  // ── Phase 8.4 I-3: dedupe STALE_TAPE toasts per filter per drain ──────
  //
  // When 5 cycle-bound ops are queued for the same filter and the cycle
  // moves on, every replay would 409 STALE_TAPE — old behavior emitted 5
  // identical toasts and made 5 wasted POSTs. New behavior: one toast,
  // remaining ops short-circuited to `failed` without hitting the network.

  it('5. I-3: 5 STALE_TAPE-bound ops on the same filter emit ONE toast', async () => {
    // Queue 5 ops for the SAME filter.
    const errorsEmitted: string[] = [];
    for (let i = 0; i < 5; i++) {
      queueOp({ type: 'advance', filterId: 'filter-A', filterName: 'Filter A', tapeVersion: 1003 });
    }

    // First POST returns 409 STALE_TAPE. Subsequent ops for filter-A should
    // be short-circuited (no network call) — but the harness will still
    // throw for any cycle-bound POST that DOES happen.
    let postCallCount = 0;
    mockApiClient.post.mockImplementation(async (url: string) => {
      if (url === '/api/auth/refresh') return { token: 'fresh' };
      postCallCount++;
      const err: any = new Error('Tape version mismatch');
      err.code = 'STALE_TAPE';
      err.status = 409;
      err.currentTapeVersion = 1005;
      throw err;
    });

    // Listen via the SAME imported module syncPendingOperations came from,
    // not a fresh dynamic import (vi.resetModules() between tests would put
    // them in different module-instance spaces and the listener would be
    // attached to the wrong copy of the engine state).
    const engineMod = await import('../sync-engine');
    const off = engineMod.onSyncEvent((ev) => {
      if (ev.type === 'error' && typeof ev.error === 'string') errorsEmitted.push(ev.error);
    });

    const result = await engineMod.syncPendingOperations();
    off();

    expect(result.synced).toBe(0);
    expect(result.failed).toBe(5);
    // Network: only one POST should have happened (the first); the other
    // four were short-circuited by the dedupe set.
    expect(postCallCount).toBe(1);
    // Toast: exactly one STALE_TAPE-themed toast for filter-A.
    const staleToasts = errorsEmitted.filter(e => /Filter A:.*another operator/.test(e));
    expect(staleToasts).toHaveLength(1);
  });

  // ── Phase 8.7 follow-up (2026-05-03): cycle-tombstone tapeVersion + ──────
  // justification field-name. The server's terminate-cycle route REQUIRES
  // tapeVersion (commit f8fae1d) and `justification` (minLength 10), not
  // `reason`. The tombstone replay path is separate from the cycle-bound
  // operations replay path (agent H's 28e574c covers the latter).

  it('7. cycle tombstone with tapeVersion forwards it on terminate-cycle replay AND uses justification', async () => {
    // syncPendingOperations() short-circuits if the operations queue is
    // empty (line 230) — tombstone draining only runs when there is also
    // at least one pending op. Queue a benign advance to drive both paths.
    queueOp({ type: 'advance', filterId: 'filter-Z', tapeVersion: 999 });

    mockOfflineStore.getPendingTombstones.mockResolvedValueOnce([
      {
        id: 'ts-1',
        clientOpId: 'cli-ts-1',
        entityType: 'cycle',
        entityId: 'cyc-1',
        payload: { filterId: 'filter-T', justification: 'Operator stopped due to abnormal condition' },
        createdAt: new Date('2026-05-03T08:00:00Z').toISOString(),
        status: 'pending',
        retryCount: 0,
        tapeVersion: 1042,
      },
    ]);
    // Default mockApiClient.post resolves {} for both /terminate-cycle and
    // /advance (the refresh-token branch already short-circuits in beforeEach).
    mockApiClient.post.mockImplementation(async (url: string) => {
      if (url === '/api/auth/refresh') return { token: 'fresh' };
      return { ok: true };
    });

    await syncPendingOperations();

    const terminateCall = mockApiClient.post.mock.calls.find(
      ([url]: any[]) => typeof url === 'string' && url.includes('/terminate-cycle'),
    );
    expect(terminateCall).toBeTruthy();
    const [url, body] = terminateCall!;
    expect(url).toBe('/api/filters/filter-T/terminate-cycle');
    // The fix: server requires `justification` (minLength 10), not `reason`.
    expect(body.justification).toBe('Operator stopped due to abnormal condition');
    expect('reason' in body).toBe(false);
    // The fix: tapeVersion is forwarded on the body for staleness check.
    expect(body.tapeVersion).toBe(1042);
    expect(body.clientOpId).toBe('cli-ts-1');
    // Tombstone marked synced.
    expect(mockOfflineStore.updateTombstoneStatus).toHaveBeenCalledWith('ts-1', 'synced');
  });

  it('8. cycle tombstone with tapeVersion=null replays WITHOUT a tapeVersion field (legacy on-disk row)', async () => {
    // A pre-fix tombstone that was queued before tapeVersion existed on
    // the type. Replay must omit the field so the request body parses.
    // The server schema requires the field — this op WILL 400 SCHEMA_ERROR
    // on the live server, which is the documented migration cost.
    queueOp({ type: 'advance', filterId: 'filter-Z', tapeVersion: 999 });

    mockOfflineStore.getPendingTombstones.mockResolvedValueOnce([
      {
        id: 'ts-2',
        clientOpId: 'cli-ts-2',
        entityType: 'cycle',
        entityId: 'cyc-2',
        // Legacy row used `reason` field name. The fix accepts both shapes
        // so any pre-fix on-disk rows still send a syntactically valid body.
        payload: { filterId: 'filter-L', reason: 'Legacy offline terminate' },
        createdAt: new Date('2026-05-03T08:00:00Z').toISOString(),
        status: 'pending',
        retryCount: 0,
        tapeVersion: null,
      },
    ]);
    mockApiClient.post.mockImplementation(async (url: string) => {
      if (url === '/api/auth/refresh') return { token: 'fresh' };
      return { ok: true };
    });

    await syncPendingOperations();

    const terminateCall = mockApiClient.post.mock.calls.find(
      ([url]: any[]) => typeof url === 'string' && url.includes('/terminate-cycle'),
    );
    expect(terminateCall).toBeTruthy();
    const body = terminateCall![1] as Record<string, any>;
    // Critical: tapeVersion field must NOT be on the body — null is dropped.
    expect('tapeVersion' in body).toBe(false);
    // Legacy `reason` field is mapped to `justification` so the body is
    // still syntactically valid (server will accept the field; whether the
    // request succeeds depends on whether the server treats missing
    // tapeVersion as 400 — that's a migration-cost case documented in
    // sync-engine.ts).
    expect(body.justification).toBe('Legacy offline terminate');
    expect('reason' in body).toBe(false);
  });

  it('6. I-3: STALE_TAPE on different filters each emits its own toast', async () => {
    const errorsEmitted: string[] = [];
    queueOp({ type: 'advance', filterId: 'filter-X', filterName: 'Filter X', tapeVersion: 1003 });
    queueOp({ type: 'advance', filterId: 'filter-Y', filterName: 'Filter Y', tapeVersion: 1004 });

    mockApiClient.post.mockImplementation(async (url: string) => {
      if (url === '/api/auth/refresh') return { token: 'fresh' };
      const err: any = new Error('Tape version mismatch');
      err.code = 'STALE_TAPE';
      err.status = 409;
      err.currentTapeVersion = 1099;
      throw err;
    });

    const engineMod = await import('../sync-engine');
    const off = engineMod.onSyncEvent((ev) => {
      if (ev.type === 'error' && typeof ev.error === 'string') errorsEmitted.push(ev.error);
    });

    const result = await engineMod.syncPendingOperations();
    off();

    expect(result.failed).toBe(2);
    const xToasts = errorsEmitted.filter(e => /Filter X:.*another operator/.test(e));
    const yToasts = errorsEmitted.filter(e => /Filter Y:.*another operator/.test(e));
    expect(xToasts).toHaveLength(1);
    expect(yToasts).toHaveLength(1);
  });

  // ── 2026-05-17 offline cycle test regression ──────────────────────────────
  //
  // Scenario observed on the tablet during the 22:00–22:23 offline cycle:
  // operator did Wash In (start-and-advance) + Wash Out (advance) + CWH
  // checklist + Dry In + dryer-duration + temperature, all offline. When the
  // tablet came back online, ONLY the Wash In synced — the other 4+ ops
  // marked as failed in IDB with no DLQ entry and no operator-visible toast
  // because pendingCount excludes 'failed' rows.
  //
  // Root cause: each queued op captures its `tapeVersion` at queue time from
  // the local cache. The Wash In compound op (`start-and-advance`) is queued
  // with tapeVersion=null (start-cycle isn't cycle-bound), and the subsequent
  // ops are queued against the LOCAL placeholder cycle's recomputed tape
  // (`profileVersion * 1e6 + N_local_events`). After Wash In syncs and
  // creates the REAL cycle, the server's actual tapeVersion is bigger than
  // the local one (server has the CYCLE_STARTED + STATE_TRANSITION events
  // the local executor never synthesizes). The next queued op's stored
  // tapeVersion lands on the server as 409 STALE_TAPE. The
  // `staleTapeFiltersThisDrain` dedup then marks every further op for the
  // same filter as failed without even trying.
  //
  // Fix (sync-engine.ts): after each successful cycle-bound op, re-fetch
  // `/api/filters/:id/current-state` once and rewrite the in-memory
  // tapeVersion on every subsequent queued op for the same filter. The
  // tombstone-tape path (already at line 280-290) does the equivalent thing
  // by reading off the row at replay time; this brings the ops drain to
  // parity.
  it('9. chained offline ops on the same filter: each successful op refreshes downstream tapeVersions', async () => {
    // Op 1: start-and-advance (Wash In) — no tapeVersion, internally
    // handled by the engine's own /current-state fetch (line 230-234).
    queueOp({
      type: 'start-and-advance',
      filterId: 'filter-A',
      filterName: 'mups-rdu-01',
      payload: {
        cyclePayload: { profileId: 'p-1', cleaningReasonKey: 'filter' },
        advancePayload: { targetState: 'WASH_IN', cleaningAreaId: 'block-FD' },
      },
      tapeVersion: null,
    });
    // Op 2: advance to WASH_OUT. tapeVersion captured at queue time against
    // a LOCAL placeholder cycle — synthesizeEvents returns [] for a freshly
    // started cycle, so locally `filterEventCount = 0` and the executor
    // emitted `profileVersion * 1e6 + 0 = 5_000_000`.
    queueOp({
      type: 'advance',
      filterId: 'filter-A',
      filterName: 'mups-rdu-01',
      payload: { targetState: 'WASH_OUT' },
      tapeVersion: 5_000_000,
    });
    // Op 3: submit-checklist (CWH). Same stale-tape situation as op 2.
    queueOp({
      type: 'submit-checklist',
      filterId: 'filter-A',
      filterName: 'mups-rdu-01',
      payload: { afterStage: 'WASH_OUT', answers: { q1: '25' } },
      tapeVersion: 5_000_000,
    });

    // Server bookkeeping: tracks tapeVersion. start-cycle bumps to +1
    // (CYCLE_STARTED event), each advance/submit-checklist bumps by +1 each.
    // Real server starts at the post-WASH_IN value (5*1e6 + 2 = 5_000_002)
    // after the start-and-advance compound op finishes.
    let serverTapeVersion = 5_000_002;
    mockApiClient.get.mockImplementation(async (url: string) => {
      if (url === '/api/health') return {};
      if (url.endsWith('/current-state')) {
        return { currentCycle: { id: 'real-cyc-1' }, tapeVersion: serverTapeVersion };
      }
      return {};
    });

    mockApiClient.post.mockImplementation(async (url: string, body: any) => {
      if (url === '/api/auth/refresh') return { token: 'fresh' };
      if (url.includes('/start-cycle')) {
        // start-cycle creates the cycle (CYCLE_STARTED event)
        serverTapeVersion = 5_000_001;
        return { id: 'real-cyc-1' };
      }
      if (url.includes('/advance')) {
        // start-and-advance's internal advance leg fetches fresh tapeVersion
        // (5_000_001 right after start-cycle) and sends that — succeeds.
        // Subsequent stand-alone advance ops must carry tapeVersion ===
        // serverTapeVersion to succeed.
        if (typeof body.tapeVersion !== 'number' || body.tapeVersion !== serverTapeVersion) {
          const err: any = new Error(`Stale tape: expected ${serverTapeVersion}, got ${body.tapeVersion}`);
          err.code = 'STALE_TAPE';
          err.status = 409;
          err.currentTapeVersion = serverTapeVersion;
          throw err;
        }
        serverTapeVersion++;
        return { tapeVersion: serverTapeVersion };
      }
      if (url.includes('/submit-checklist')) {
        if (typeof body.tapeVersion !== 'number' || body.tapeVersion !== serverTapeVersion) {
          const err: any = new Error(`Stale tape: expected ${serverTapeVersion}, got ${body.tapeVersion}`);
          err.code = 'STALE_TAPE';
          err.status = 409;
          throw err;
        }
        serverTapeVersion++;
        return { tapeVersion: serverTapeVersion };
      }
      return {};
    });

    const result = await syncPendingOperations();

    // All three ops should sync. Pre-fix: only op 1 (start-and-advance)
    // succeeds; ops 2 and 3 fail with STALE_TAPE (op 3 short-circuited by
    // the dedup set without even hitting the network).
    expect(result.synced).toBe(3);
    expect(result.failed).toBe(0);

    // Lock in the MECHANISM, not just the outcome (advisor 2026-05-17): the
    // pass-condition is the refresh fetch happening between ops. Without it,
    // a green test could simply mean the mock didn't enforce tapeVersion.
    const refreshFetches = mockApiClient.get.mock.calls.filter(
      ([url]: any[]) => typeof url === 'string' && url === '/api/filters/filter-A/current-state',
    );
    // start-and-advance's internal /current-state fetch (line 230-234 of
    // sync-engine.ts) + at least 1 chained-ops refresh fetch between ops.
    // We don't pin the exact number — the implementation may add a final
    // post-loop refresh in future — but it must be > 1.
    expect(refreshFetches.length).toBeGreaterThanOrEqual(2);

    // IDB persistence side of the fix: the refreshed tapeVersion was
    // written back so a mid-drain failure on a future op doesn't leave
    // the stale on-disk tape in place. Both ops 2 and 3 should have been
    // rewritten at least once.
    const persistedOp2 = mockOfflineStore.updateOperationTapeVersion.mock.calls
      .filter(([id]: any[]) => id === mockOfflineStore.__ops[1].id);
    const persistedOp3 = mockOfflineStore.updateOperationTapeVersion.mock.calls
      .filter(([id]: any[]) => id === mockOfflineStore.__ops[2].id);
    expect(persistedOp2.length).toBeGreaterThanOrEqual(1);
    expect(persistedOp3.length).toBeGreaterThanOrEqual(1);
  });
});

describe('sync-engine — per-op replay timeout (hung-request hardening)', () => {
  it('withReplayTimeout resolves a fast promise and clears its timer', async () => {
    await expect(withReplayTimeout(Promise.resolve('ok'), 1000, 'F')).resolves.toBe('ok');
  });

  it('withReplayTimeout rejects with OP_TIMEOUT when the promise never settles', async () => {
    vi.useFakeTimers();
    try {
      const p = withReplayTimeout(new Promise<never>(() => {}), 5000, 'F-hung');
      const assertion = expect(p).rejects.toMatchObject({ code: 'OP_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(5001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hung replay returns the op to pending WITHOUT burning retry budget, and the drain finishes', async () => {
    vi.useFakeTimers();
    try {
      const op = queueOp({ type: 'advance', tapeVersion: 1005, retryCount: 1 });
      // The advance POST hangs forever; refresh + health probe still resolve.
      mockApiClient.post.mockImplementation((url: string) => {
        if (url === '/api/auth/refresh') return Promise.resolve({ token: 'fresh' });
        if (url.includes('/advance')) return new Promise(() => {}); // never resolves
        return Promise.resolve({});
      });

      const drain = syncPendingOperations();
      // Let the pre-drain awaits settle, then fire the per-op timeout.
      await vi.advanceTimersByTimeAsync(SYNC_OP_REPLAY_TIMEOUT_MS + 100);
      const result = await drain;

      // Reclaimed, not stranded in 'syncing' — the exact freeze we're preventing.
      expect(op.status).toBe('pending');
      // Interrupted replay is not a failure — retry budget preserved.
      expect(op.retryCount).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.synced).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
