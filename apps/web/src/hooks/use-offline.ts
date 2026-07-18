/**
 * useOffline — Hook for offline-aware operations.
 * Returns online status, pending operation count, and an offline-safe API wrapper.
 *
 * Connectivity comes from connectivity.ts (Capacitor Network plugin + /api/health
 * probe + window online/offline events) — NOT from raw navigator.onLine, which
 * lies on Capacitor Android WebViews.
 */
import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '@/lib/api-client';
import {
  queueOperation,
  getPendingOperations,
  updateFilterStateLocally,
  cacheFilters,
  getCachedFilters,
  cacheData,
  getCachedData,
  clearAllOperations,
  getAllOperations,
  generateClientOpId,
} from '@/lib/offline-store';
import { syncPendingOperations, onSyncEvent, startAutoSync } from '@/lib/sync-engine';
import { isOnline as connIsOnline, onConnectivityChange, startConnectivityEngine } from '@/lib/connectivity';

export function useOffline() {
  const [online, setOnline] = useState(connIsOnline());
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncMessage, setLastSyncMessage] = useState('');

  // Connectivity is owned by lib/connectivity.ts — single source of truth
  // (Capacitor Network plugin + /api/health probe + window online/offline)
  useEffect(() => {
    startConnectivityEngine();
    const unsub = onConnectivityChange(setOnline);
    return unsub;
  }, []);

  // Start auto-sync
  useEffect(() => {
    startAutoSync();
  }, []);

  // Callback that pages can set to be notified when sync completes (for SWR revalidation)
  const [onSyncComplete, setOnSyncComplete] = useState<(() => void) | null>(null);

  // Track sync events
  useEffect(() => {
    const cleanup = onSyncEvent((event) => {
      if (event.type === 'start') { setSyncing(true); setOnline(true); /* sync means API is reachable */ }
      if (event.type === 'complete') {
        setSyncing(false);
        setOnline(true);
        if (event.synced) {
          setLastSyncMessage(`Synced ${event.synced} operation(s)`);
          if (onSyncComplete) onSyncComplete();
        }
        refreshPendingCount();
      }
      if (event.type === 'error') setLastSyncMessage(event.error ?? 'Sync error');
    });
    return cleanup;
  }, [onSyncComplete]);

  // Refresh pending count
  const refreshPendingCount = useCallback(async () => {
    const ops = await getPendingOperations();
    setPendingCount(ops.length);
  }, []);

  useEffect(() => { refreshPendingCount(); }, [refreshPendingCount]);

  // === Offline-safe API calls ===

  /**
   * Execute an API call. If offline, queue the operation for later sync.
   * Returns true if executed immediately, false if queued.
   *
   * Phase 8.7 cutover (Wave 2 — server commit f8fae1d): the four cycle-bound
   * write routes (`advance`, `submit-checklist`, `bypass`, `terminate-cycle`)
   * now REQUIRE `tapeVersion` in the request body — server returns 400
   * SCHEMA_ERROR if absent and 409 STALE_TAPE on mismatch. We read the latest
   * `tapeVersion` from the cached `filter-state-{filterId}` row (same source
   * the FE's `getCurrentActions()` uses) and merge it into:
   *   - the online payload, AND
   *   - the queued operation row (so the offline replay in sync-engine
   *     forwards it on the eventual POST).
   *
   * `start-cycle` and `start-and-advance` are deliberately excluded — there
   * is no prior cycle to derive a tapeVersion from, and the server schemas
   * for these routes do NOT require the field.
   */
  const executeOrQueue = useCallback(async (
    type: 'advance' | 'advance-with-checklist' | 'start-cycle' | 'submit-checklist' | 'bypass' | 'terminate' | 'start-and-advance' | 'start-and-advance-with-checklist',
    filterId: string,
    filterName: string,
    payload: Record<string, any>,
    optimisticState?: string, // Update local state immediately
    // Reauth password forwarded only on the online path. NEVER persisted to
    // the queued IDB row — offline replay relies on the C1 HMAC grant in
    // sync-engine.ts (search `x-offline-replay-token`), not on a stored
    // plaintext password. If callers pass a password and we still fall
    // through to the queue (network error), the password is discarded by
    // queueOperation below — the queued op has no `password` field.
    password?: string,
  ): Promise<{ executed: boolean; result?: any }> => {
    // Phase 8.7: pull the current tapeVersion from the cached filter-state row
    // for cycle-bound writes only. The cache row is written by `cacheServerStateResponse`
    // (server /current-state response → tapeVersion field) and by
    // `recomputeAndCacheFilterState` (re-runs the executor → tapeVersion from
    // computeNextActions). Either way, this is the freshest tapeVersion the
    // FE has observed for this filter.
    const isCycleBound = type === 'advance' || type === 'advance-with-checklist' || type === 'submit-checklist' || type === 'bypass' || type === 'terminate';
    let tapeVersion: number | null = null;
    if (isCycleBound) {
      try {
        const cached = await getCachedData<any>(`filter-state-${filterId}`);
        if (typeof cached?.tapeVersion === 'number') {
          tapeVersion = cached.tapeVersion;
        }
      } catch { /* tapeVersion stays null — server will 400 if it really requires it */ }
    }
    // #9 fix: one clientOpId for BOTH the online attempt and the queued row. If the
    // op commits online but the HTTP response is lost (routine WiFi drop right after
    // the server commit), the queued replay carries the SAME id so the server dedups
    // it (findExisting*ByClientOpId → benign no-op) instead of 409-ing (CYCLE_ACTIVE
    // with a misleading "already active" toast) or creating a duplicate cycle.
    const clientOpId = generateClientOpId();

    // Merge tapeVersion (cycle-bound only) + clientOpId into the online body.
    // start-cycle / start-and-advance inject clientOpId at their own call sites —
    // start-and-advance uses the same `:start` / `:advance` sub-keys the replay does.
    const onlinePayload = {
      ...payload,
      ...(isCycleBound && tapeVersion !== null ? { tapeVersion } : {}),
      clientOpId,
    };

    // Online post helper — routes to postWithReauth when caller forwarded a
    // password (reauth-gated action). Keeps every case branch single-line.
    const onlinePost = <T = any>(url: string, body: any): Promise<T> =>
      password
        ? apiClient.postWithReauth<T>(url, body, password)
        : apiClient.post<T>(url, body);

    // STALE_TAPE auto-recovery. The cached tapeVersion can lag the server's by a
    // few events (cache not refreshed after a prior write / a background re-sync
    // race) — for a single operator this is a FALSE positive, not a real
    // concurrent edit, but it surfaced as "another operator changed this cycle.
    // Refresh and retry". Do that refresh+retry transparently: on 409 STALE_TAPE,
    // re-fetch the live tapeVersion from /current-state and retry the write ONCE.
    // If it still fails (or we can't refresh), surface the original error.
    const cyclePost = async <T = any>(url: string, body: any): Promise<T> => {
      try {
        return await onlinePost<T>(url, body);
      } catch (e: any) {
        const code = e?.code || e?.error;
        if (code !== 'STALE_TAPE') throw e;
        // STALE_TAPE: this cycle's tape moved. Re-fetch the live state to get a
        // fresh tapeVersion for a single retry.
        let cs: any;
        try {
          cs = await apiClient.get<any>(`/api/filters/${filterId}/current-state`);
        } catch { throw e; }
        const fresh = typeof cs?.tapeVersion === 'number' ? cs.tapeVersion : undefined;
        if (fresh === undefined) throw e;
        try {
          return await onlinePost<T>(url, { ...body, tapeVersion: fresh });
        } catch (retryErr: any) {
          // The retry against the FRESH tape STILL failed. For the common
          // false-positive (single operator, lagging cache) the retry SUCCEEDS
          // — so a failure here means the filter's state genuinely moved under
          // us: another operator advanced this cycle (or an earlier action of
          // ours already applied). The raw retry error reads as the operator's
          // OWN mistake — e.g. OUT_OF_SEQUENCE "Cannot move to WASH_OUT from
          // WASH_OUT" — which is exactly wrong in a two-device race. Re-label
          // it as the concurrent change it actually is. Refresh the local cache
          // from the state we just fetched so the operator's next render shows
          // the current reality (the UI also self-heals via /current-state
          // polling, but this makes it immediate). STATE_CHANGED / CYCLE_CHANGED
          // on a FIRST attempt already carry a clean server message and never
          // reach here.
          try {
            const { cacheServerStateResponse } = await import('../lib/offline-cache');
            if (typeof cs?.tapeVersion === 'number') await cacheServerStateResponse(filterId, cs);
          } catch { /* best-effort cache refresh */ }
          const conflict: any = new Error(
            'This filter has already moved on — its cleaning state changed since you opened it (another operator may have advanced it). Refresh to see the current state, then continue if needed.',
          );
          conflict.code = 'CONCURRENT_EDIT';
          conflict.status = 409;
          conflict.cause = retryErr;
          throw conflict;
        }
      }
    };

    // Try executing online first
    try {
      let result: any;
      switch (type) {
        case 'advance':
          result = await cyclePost(`/api/filters/${filterId}/advance`, onlinePayload);
          break;
        // Atomic advance + post-stage checklist (2026-07-16). One tx server-side,
        // so a cancelled checklist leaves no orphaned stage transition. cyclePost
        // (not onlinePost) — it's cycle-bound and carries/refreshes tapeVersion
        // exactly like the bare advance.
        case 'advance-with-checklist':
          result = await cyclePost(`/api/filters/${filterId}/advance-with-checklist`, onlinePayload);
          break;
        case 'start-cycle':
          result = await onlinePost(`/api/filters/${filterId}/start-cycle`, { ...payload, clientOpId });
          break;
        case 'start-and-advance': {
          const { cyclePayload, advancePayload } = payload as any;
          try {
            // start-cycle is the reauth-gated half of this pair (advance has
            // no reauth check on the server). Forward the password here so
            // ADMIN-role operators don't get a REAUTH_REQUIRED on start.
            await onlinePost(`/api/filters/${filterId}/start-cycle`, { ...cyclePayload, clientOpId: `${clientOpId}:start` });
          } catch (startErr: any) {
            const code = startErr?.code || startErr?.error || '';
            if (code !== 'CYCLE_ACTIVE') throw startErr;
          }
          // Phase 8.7 cutover (Wave 2 — server commit f8fae1d): /advance now
          // requires `tapeVersion` in the body. The cycle was just started
          // (or already existed via the CYCLE_ACTIVE benign-race branch
          // above) so the cache row is stale. Fetch the fresh tapeVersion
          // via /current-state and include it.
          let saTapeVersion: number | undefined;
          try {
            const fresh = await apiClient.get<any>(`/api/filters/${filterId}/current-state`);
            if (typeof fresh?.tapeVersion === 'number') saTapeVersion = fresh.tapeVersion;
          } catch { /* if this fails, advance will surface the 400 — fall through */ }
          const advanceBody = {
            ...advancePayload,
            ...(saTapeVersion !== undefined ? { tapeVersion: saTapeVersion } : {}),
            clientOpId: `${clientOpId}:advance`,
          };
          // /advance is NOT in the reauth config — plain post is correct.
          result = await apiClient.post(`/api/filters/${filterId}/advance`, advanceBody);
          break;
        }
        // Cycle-start whose FIRST stage carries a mandatory checklist (2026-07-16).
        // Same start-then-advance pair as above, except the advance half is the
        // ATOMIC advance-with-checklist — so an operator who abandons the
        // checklist never leaves a committed stage entry with no attestation.
        //
        // Start and advance remain two requests (as they already are): making
        // all three atomic would need a new three-way server op, and the
        // start/advance split is a pre-existing, separate gap — a started cycle
        // that never entered a stage records no attestation-less transition.
        case 'start-and-advance-with-checklist': {
          const { cyclePayload, advancePayload } = payload as any;
          try {
            await onlinePost(`/api/filters/${filterId}/start-cycle`, { ...cyclePayload, clientOpId: `${clientOpId}:start` });
          } catch (startErr: any) {
            const code = startErr?.code || startErr?.error || '';
            // Benign race: the cycle already exists — continue to the advance.
            if (code !== 'CYCLE_ACTIVE') throw startErr;
          }
          let sacTapeVersion: number | undefined;
          try {
            const fresh = await apiClient.get<any>(`/api/filters/${filterId}/current-state`);
            if (typeof fresh?.tapeVersion === 'number') sacTapeVersion = fresh.tapeVersion;
          } catch { /* advance will surface the 400 — fall through */ }
          // onlinePost, NOT the plain post the start-and-advance advance-half
          // uses: that comment ("/advance is NOT in the reauth config") does not
          // carry over — this endpoint enforces SUBMIT_CHECKLIST_WITH_SIGNATURE,
          // which IS configured in this deployment. A plain post would 401.
          result = await onlinePost(`/api/filters/${filterId}/advance-with-checklist`, {
            ...advancePayload,
            ...(sacTapeVersion !== undefined ? { tapeVersion: sacTapeVersion } : {}),
            clientOpId: `${clientOpId}:advance`,
          });
          break;
        }
        case 'submit-checklist':
          result = await cyclePost(`/api/filters/${filterId}/submit-checklist`, onlinePayload);
          break;
        case 'bypass':
          result = await cyclePost(`/api/filters/${filterId}/bypass`, onlinePayload);
          break;
        case 'terminate':
          result = await cyclePost(`/api/filters/${filterId}/terminate-cycle`, onlinePayload);
          break;
      }

      // Refresh the cached filter-state row with the fresh tapeVersion the
      // server just emitted. Without this, the next cycle-bound write reads
      // a stale tapeVersion from cache and gets rejected with 409 STALE_TAPE.
      //
      // advance / submit-checklist / bypass / terminate all return
      // service.getCurrentState() (full current-state shape, includes
      // tapeVersion). For these we can cache `result` directly.
      //
      // start-cycle returns just the new cycle row — no tapeVersion. After a
      // successful start we re-fetch /current-state once so subsequent
      // operations on the same filter see the correct (profileVersion *
      // 1_000_000 + 1) starting point. start-and-advance already does its
      // own /current-state fetch above.
      try {
        const { cacheServerStateResponse } = await import('../lib/offline-cache');
        if (type === 'advance' || type === 'submit-checklist' || type === 'bypass' || type === 'terminate') {
          if (result && typeof result.tapeVersion === 'number') {
            await cacheServerStateResponse(filterId, result);
          }
        } else if (type === 'start-cycle' || type === 'start-and-advance') {
          const fresh = await apiClient.get<any>(`/api/filters/${filterId}/current-state`);
          if (fresh && typeof fresh.tapeVersion === 'number') {
            await cacheServerStateResponse(filterId, fresh);
          }
        }
      } catch { /* cache-refresh failure must not fail the operation */ }

      return { executed: true, result };
    } catch (e: any) {
      // Determine if this is a network error (should queue) or API error (should throw)
      const msg = String(e?.message || '').toLowerCase();
      const isNetErr = (e instanceof TypeError && msg.includes('fetch'))
        || msg.includes('failed to connect') || msg.includes('failed to fetch')
        || msg.includes('networkerror') || msg.includes('network request failed')
        || msg.includes('unable to resolve host') || msg.includes('econnrefused')
        || msg.includes('load failed') || msg.includes('tls') || msg.includes('ssl');
      // Audit 2026-05-05 fix #2: REAUTH errors must NOT silently queue.
      // The pre-fix logic queued REAUTH_REQUIRED / REAUTH_FAILED responses
      // because the legacy `x-offline-replay: true` header bypass would
      // replay them later "for free." The C1 audit fix this branch
      // replaced that with the HMAC-signed grant — so the queued op WOULD
      // still replay under the grant, silently overriding the operator's
      // reauth refusal (e.g., typed wrong password and meant to abort).
      // Now: bubble REAUTH errors up so the calling page surfaces the
      // password dialog. The caller (filter-operations.tsx, mobile-
      // operations.tsx) wraps cycle writes in reauth.execute(), which is
      // where the dialog lives — bubbling here is the right path.
      if (!isNetErr) {
        throw e; // Real API error (validation, conflict, REAUTH, etc.) — throw as-is
      }
      // Network error — fall through to queue below
    }

    // Offline or network error: queue the operation. Persist the cycle-bound
    // tapeVersion on the row so the sync-engine forwards it on replay (the
    // engine omits the body field when null, so non-cycle-bound types and
    // null reads here are safe). The cached tapeVersion was captured ABOVE
    // before the network attempt, so we never persist a tape value that's
    // already been bumped by a successful prior write.
    // #9 fix: reuse the SAME clientOpId the failed online attempt sent, so a lost-
    // response online commit and this replay share one idempotency key. For
    // start-and-advance the replay derives `:start`/`:advance` sub-keys from this base.
    await queueOperation({ type, filterId, filterName, payload, tapeVersion, clientOpId });
    if (optimisticState) {
      // When starting a cycle offline, also mark the filter as having an active cycle
      const markCycleActive = type === 'start-and-advance' || type === 'start-cycle';
      // Audit 2026-05-05 fix #3: route through recomputeAndCacheFilterState
      // (not the lighter updateFilterStateLocally) so the cached tapeVersion
      // is bumped via computeNextActions over the just-updated lifecycle state.
      // Without this, chained offline ops on the same filter pulled the
      // pre-start tapeVersion at queue time and hit 409 STALE_TAPE on replay
      // even though the operator did everything right.
      // Lazy-import to avoid circular deps (offline-cache imports from
      // offline-store; use-offline already imports from offline-store).
      const { recomputeAndCacheFilterState } = await import('../lib/offline-cache');
      await recomputeAndCacheFilterState(filterId, optimisticState, markCycleActive);
    }
    await refreshPendingCount();
    return { executed: false };
  }, [refreshPendingCount]);

  // Manually trigger sync
  const manualSync = useCallback(async () => {
    if (!connIsOnline()) return { synced: 0, failed: 0 };
    return syncPendingOperations();
  }, []);

  // Cache filter data for offline use
  const cacheFilterData = useCallback(async (filters: any[]) => {
    await cacheFilters(filters);
  }, []);

  // Get cached filter data when offline
  const getOfflineFilters = useCallback(async () => {
    return getCachedFilters();
  }, []);

  // Generic cache. When the caller doesn't pass a TTL, the runtime value
  // from offline-store (SUPER_ADMIN-tuned via /api/config/offline-cache;
  // default 24h) applies. Callers that specifically want a short window
  // (e.g. SHORT_TTL_MS for non-critical UI caches) pass it explicitly.
  // W2 (offline-safety series): previously hardcoded 30min — that drift
  // between the templates/equipment-groups caches (30min) and the
  // filter-state cache (24h) caused offline templates to expire on long
  // shifts. Single source of truth now.
  const cache = useCallback(async (key: string, data: any, ttlMs?: number) => {
    await cacheData(key, data, ttlMs);
  }, []);

  const getCache = useCallback(async <T>(key: string): Promise<T | null> => {
    return getCachedData<T>(key);
  }, []);

  // Clear all stuck/failed operations from the queue
  const clearQueue = useCallback(async () => {
    await clearAllOperations();
    await refreshPendingCount();
  }, [refreshPendingCount]);

  // Get all operations for debugging
  const getQueueDetails = useCallback(async () => {
    return getAllOperations();
  }, []);

  return {
    online,
    pendingCount,
    syncing,
    lastSyncMessage,
    executeOrQueue,
    manualSync,
    clearQueue,
    getQueueDetails,
    setOnSyncComplete,
    cacheFilterData,
    getOfflineFilters,
    cache,
    getCache,
    refreshPendingCount,
  };
}
