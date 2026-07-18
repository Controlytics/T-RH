import { useCallback, useEffect, useRef, useState } from 'react';
import { mutate } from 'swr';
import { apiClient } from '../../../lib/api-client';
import { useOffline } from '../../../hooks/use-offline';
import { onSyncEvent } from '../../../lib/sync-engine';
import { cacheServerStateResponse } from '@/lib/offline-cache';
import { SYNC_AFTER_ONLINE_DELAY_MS } from '@/lib/timing-constants';
// A-01 coupled-cluster Step 3 (2026-05-29): typed-cache reads exposed
// alongside the legacy mixed-store reads. Parent (filter-operations.tsx)
// opts into these in Step 4 — until then, additive only.
import {
  getCachedBlocks,
  getCachedAreas,
  getCachedAhus,
  getCachedFiltersTyped,
  type CachedBlock,
  type CachedArea,
  type CachedAhu,
  type CachedFilterTyped,
} from '@/lib/offline-store';

// Per-filter `/current-state` priming. Module-level so it can't accidentally
// capture stale component state — all inputs are explicit args.
//
// Generation guard: caller bumps `genRef.current` and passes the new value as
// `myGen`. The loop checks `myGen !== genRef.current` between each await and
// bails if a newer prime started or the component went offline. Closes the
// concurrent-loop hazard the pre-refactor code had (cleanup cleared the
// pending timer but couldn't abort an in-flight async loop).
async function primeFilterStates(
  instancesData: { data?: any[] } | undefined,
  templatesData: { data?: any[] } | undefined,
  genRef: { current: number },
  myGen: number,
): Promise<void> {
  if (!instancesData?.data) return;
  const cacheFilterTemplateIds = new Set(
    ((templatesData?.data ?? []) as any[])
      .filter((t: any) => t.templateKind === 'FILTER')
      .map((t: any) => t.id),
  );
  const filters = instancesData.data.filter((f: any) => {
    // Templates-loaded path: Set membership. First-paint fallback: the
    // instance carries its eager-loaded `template.templateKind` per
    // assets/instance.repository.ts — so we can still classify an instance
    // before the templates SWR settles. Both branches are stable under
    // admin renames (templateKind is the schema-stable signal, not name).
    if (!cacheFilterTemplateIds.has(f.templateId) && f.template?.templateKind !== 'FILTER') return false;
    return f.isActive !== false && f.status !== 'Retired';
  });
  for (const f of filters) {
    if (myGen !== genRef.current) return;
    try {
      const st = await apiClient.get<any>(`/api/filters/${f.id}/current-state`);
      if (myGen !== genRef.current) return;
      // Phase 8.7: route the cache write through the helper so the legacy
      // mirror field names live only in offline-cache.ts.
      await cacheServerStateResponse(f.id, st);
    } catch (err) {
      // eslint-disable-next-line no-console -- intentional structured log
      console.warn(
        '[filter-operations-offline-cache] primeFilterStates stopped at',
        f.name ?? f.id,
        '—',
        err instanceof Error ? err.message : String(err),
      );
      break;
    }
  }
}

interface UseFilterOperationsOfflineCacheInput {
  /** Capacitor-aware online flag, from the parent's useOffline() destructure. */
  online: boolean;
  /** SWR responses passed in by the parent; the hook re-caches them whenever
   *  they refresh, so the offline path always sees the freshest payload. */
  instancesData: any | undefined;
  templatesData: any | undefined;
  reasonsData: any | undefined;
  equipGroupsData: any | undefined;
  identifiersData: any | undefined;
}

interface UseFilterOperationsOfflineCacheReturn {
  /** Cached filter instances loaded from IndexedDB on mount or offline transition. */
  offlineInstances: any[];
  /** Cached templates loaded from IndexedDB on mount or offline transition. */
  offlineTemplates: any[];
  /** A-01 cluster Step 3 (2026-05-29): typed-kind caches read from the v6
   *  IDB stores (cache_blocks / cache_areas / cache_ahus / cache_filters_typed).
   *  Populated by offline-sync-service.ts on login + sync drain. Use these
   *  instead of filtering the mixed offlineInstances array by templateId —
   *  no template-kind discrimination needed. Additive: existing consumers
   *  of offlineInstances are unaffected. */
  offlineBlocks: CachedBlock[];
  offlineAreas: CachedArea[];
  offlineAhus: CachedAhu[];
  offlineFiltersTyped: CachedFilterTyped[];
  /** True once the first mount-time load resolves (success OR failure). The
   *  parent uses this to gate its `isLoading` computation. */
  offlineDataLoaded: boolean;
  /** Re-pull offline filter instances. Called from cycle-mutation handlers
   *  after an operation succeeds so the local `offlineInstances` reflects
   *  the new lifecycle state. Replaces the previous
   *  `getOfflineFilters().then(setOfflineInstances)` inline pattern. */
  refreshOfflineInstances: () => Promise<void>;
  /** A-01 cluster Step 3: re-pull typed-kind caches after a sync drain so
   *  the consumer sees fresh data. Mirrors refreshOfflineInstances above. */
  refreshOfflineTyped: () => Promise<void>;
}

/**
 * Phase 2 of the filter-operations.tsx extraction. Owns:
 *
 *   - The three local state slots (offlineInstances, offlineTemplates,
 *     offlineDataLoaded) that the parent renders against when the SWR
 *     responses haven't arrived yet.
 *   - The 9 useEffects that prime / drain the offline cache:
 *       1. instances     -> cacheFilterData
 *       2. templates     -> cache('templates', ...)
 *       3. reasons       -> cache('cleaning-reasons', ...)
 *       4. equipGroups   -> cache('equipment-groups', ...)
 *       5. filter-states -> per-filter /current-state pre-warm (trigger-only:
 *                           mount, online flip, post-sync — see effect 5 body)
 *       6. identifiers   -> cache('identifier-map', ...)
 *       7. mount         -> load offline filters + templates
 *       8. offline flip  -> re-load offline filters + templates
 *       9. post-sync     -> mutate('/api/assets/instances') + reprime
 *
 * A-01 Wave 5 migration note (2026-05-29): this hook has NO legacy
 * /api/assets/* API calls to migrate. The only legacy reference is the
 * `mutate('/api/assets/instances')` SWR cache-key invalidation in
 * effect 9. That key MUST match the SWR fetcher key in filter-operations.tsx
 * (line ~59), mobile-operations.tsx (line ~328), and mobile-wrapper.tsx
 * (line ~182) — all of which are carve-outs not migrated in Wave 5. Changing
 * the mutate key here without coordinating those files would silently break
 * cross-component invalidation (post-sync drain would no longer trigger
 * filter-operations.tsx to revalidate). Migration is gated on those three
 * carve-out files moving their SWR keys first.
 *
 * Hook is read-side caching only. Mutation handlers remain in
 * filter-operations.tsx (Phase 3 of the extraction was explicitly declined —
 * see [[filter-ops-extraction-2026-05-14]] memory).
 */
export function useFilterOperationsOfflineCache(
  input: UseFilterOperationsOfflineCacheInput,
): UseFilterOperationsOfflineCacheReturn {
  const { online, instancesData, templatesData, reasonsData, equipGroupsData, identifiersData } = input;
  const { cacheFilterData, getOfflineFilters, cache, getCache } = useOffline();

  const [offlineInstances, setOfflineInstances] = useState<any[]>([]);
  const [offlineTemplates, setOfflineTemplates] = useState<any[]>([]);
  // A-01 cluster Step 3: typed-kind caches alongside the legacy mixed cache.
  const [offlineBlocks, setOfflineBlocks] = useState<CachedBlock[]>([]);
  const [offlineAreas, setOfflineAreas] = useState<CachedArea[]>([]);
  const [offlineAhus, setOfflineAhus] = useState<CachedAhu[]>([]);
  const [offlineFiltersTyped, setOfflineFiltersTyped] = useState<CachedFilterTyped[]>([]);
  const [offlineDataLoaded, setOfflineDataLoaded] = useState(false);

  // Latest SWR payloads, mirrored to a ref so non-React-flow triggers
  // (sync-complete event handler) can read fresh data without re-subscribing.
  const latestDataRef = useRef<{ instances: any; templates: any }>({ instances: undefined, templates: undefined });
  useEffect(() => {
    latestDataRef.current = { instances: instancesData, templates: templatesData };
  });

  // Prime-loop generation counter. Bumping it tells in-flight loops to bail
  // (concurrent-loop guard). Reset on offline flip too — keeps the in-flight
  // loop from continuing to write IDB after the operator disconnects.
  const primeGenRef = useRef(0);

  // Gate so the prime fires AT MOST ONCE per online window. Reset on offline
  // flip so the next online flip re-primes. Without this gate, the prime
  // effect would re-fire on every 30s `instancesData` SWR refresh, hammering
  // the API with N GETs per filter for no real freshness gain (the post-sync
  // trigger below already handles "data just changed").
  const hasInitiallyPrimedRef = useRef(false);

  const triggerPrime = useCallback(() => {
    primeGenRef.current += 1;
    const myGen = primeGenRef.current;
    void primeFilterStates(latestDataRef.current.instances, latestDataRef.current.templates, primeGenRef, myGen);
  }, []);

  // 1. Cache filter instances for offline use
  useEffect(() => { if (instancesData?.data) cacheFilterData(instancesData.data); }, [instancesData, cacheFilterData]);
  // 2. Cache templates
  useEffect(() => { if (templatesData?.data) cache('templates', templatesData.data); }, [templatesData, cache]);
  // 3. Cache cleaning reasons for offline cycle start
  useEffect(() => {
    const r = (reasonsData as any)?.reasons ?? reasonsData;
    if (r) cache('cleaning-reasons', r);
  }, [reasonsData, cache]);
  // 4. Cache equipment groups for offline equipment/limits selection
  useEffect(() => {
    if (equipGroupsData) cache('equipment-groups', Array.isArray(equipGroupsData) ? equipGroupsData : equipGroupsData?.data ?? []);
  }, [equipGroupsData, cache]);

  // 5. Pre-cache /current-state for every FILTER instance so offline ops have
  //    a complete snapshot. Trigger-only: fires AT MOST ONCE per online
  //    window (mount + each offline→online flip). The 30s SWR refresh of
  //    `instancesData` no longer re-triggers this — `hasInitiallyPrimedRef`
  //    guards against the re-fire after the first prime. Post-sync priming
  //    is handled by effect 9 below, which picks up server-side changes
  //    that landed via our own queue drain.
  //
  //    Pre-refactor (2026-05-14, [[filter-ops-extraction-2026-05-14]]) this
  //    fired on every `instancesData` change — meaning every 30s for a page
  //    sitting open, the loop fetched /current-state for every filter even
  //    though nothing had changed. With N=50 filters that was 6000 GETs/hour
  //    of pure waste. The original "SWR ordering bug" framing from the deep
  //    review was wrong (no race exists — `instance.repository.ts:16`
  //    eager-loads `template.templateKind`); the real cost was the steady
  //    drip.
  //
  //    `SYNC_AFTER_ONLINE_DELAY_MS` (2s) still debounces the initial prime
  //    so the first paint isn't competing with the other 5 SWR loads.
  useEffect(() => {
    if (!online) {
      // Offline transition: reset the prime gate and abort any in-flight
      // loop so we don't keep writing IDB after disconnect.
      hasInitiallyPrimedRef.current = false;
      primeGenRef.current += 1;
      return;
    }
    if (hasInitiallyPrimedRef.current) return;
    if (!instancesData?.data) return; // wait for SWR to settle
    hasInitiallyPrimedRef.current = true;
    const timer = setTimeout(triggerPrime, SYNC_AFTER_ONLINE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [online, instancesData, triggerPrime]);

  // 6. Build + cache identifier map (RFID tag lookup, name lookup)
  useEffect(() => {
    if (!identifiersData) return;
    const list = Array.isArray(identifiersData) ? identifiersData : [];
    const map: Record<string, { filterId: string; filterName: string }> = {};
    for (const ident of list) {
      if (ident.identifierValue && ident.assetId) {
        const entry = { filterId: ident.assetId, filterName: ident.asset?.name || ident.assetId };
        map[ident.identifierValue] = entry;
        map[ident.identifierValue.toUpperCase()] = entry;
        map[ident.identifierValue.toLowerCase()] = entry;
      }
    }
    if (Object.keys(map).length > 0) cache('identifier-map', map);
  }, [identifiersData, cache]);

  // 7. Load cached data on mount — first render needs SOMETHING to show
  //    while the SWR responses are still in flight.
  useEffect(() => {
    Promise.all([
      getOfflineFilters().then(setOfflineInstances),
      getCache<any[]>('templates').then(t => setOfflineTemplates(t ?? [])),
      // A-01 cluster Step 3: typed-kind caches.
      getCachedBlocks().then(setOfflineBlocks).catch(() => {}),
      getCachedAreas().then(setOfflineAreas).catch(() => {}),
      getCachedAhus().then(setOfflineAhus).catch(() => {}),
      getCachedFiltersTyped().then(setOfflineFiltersTyped).catch(() => {}),
    ]).finally(() => setOfflineDataLoaded(true));
    // Mount-only — getOfflineFilters / getCache are stable closures from
    // useOffline; including them re-runs the load needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 8. Re-load offline filters + templates + typed caches whenever
  //    connectivity drops. Without this, the offline fallback shows stale
  //    (mount-time) data if the operator was online for hours before
  //    disconnecting.
  useEffect(() => {
    if (!online) {
      Promise.all([
        getOfflineFilters().then(setOfflineInstances),
        getCache<any[]>('templates').then(t => setOfflineTemplates(t ?? [])),
        getCachedBlocks().then(setOfflineBlocks).catch(() => {}),
        getCachedAreas().then(setOfflineAreas).catch(() => {}),
        getCachedAhus().then(setOfflineAhus).catch(() => {}),
        getCachedFiltersTyped().then(setOfflineFiltersTyped).catch(() => {}),
      ]).finally(() => setOfflineDataLoaded(true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  // 9. After a successful sync drain, force the instances SWR to refetch
  //    so the parent re-renders, AND re-prime /current-state for every
  //    filter so cached cycle/checklist data reflects the just-drained ops.
  //    This is the third trigger in the trigger-only design (mount + online
  //    flip + post-sync) — replaces the 30s drip that effect 5 used to do.
  useEffect(() => {
    const cleanup = onSyncEvent((event) => {
      if (event.type === 'complete' && event.synced && event.synced > 0) {
        mutate('/api/assets/instances');
        triggerPrime();
      }
    });
    return cleanup;
  }, [triggerPrime]);

  const refreshOfflineInstances = useCallback(async () => {
    const fresh = await getOfflineFilters();
    setOfflineInstances(fresh);
  }, [getOfflineFilters]);

  // A-01 cluster Step 3: refresh the typed-kind caches in parallel. Called
  // by parent after sync drain (post-sync hook in effect 9 below would also
  // call this, but kept separate so callers can refresh independently).
  const refreshOfflineTyped = useCallback(async () => {
    const [blocks, areas, ahus, filtersTyped] = await Promise.all([
      getCachedBlocks().catch(() => []),
      getCachedAreas().catch(() => []),
      getCachedAhus().catch(() => []),
      getCachedFiltersTyped().catch(() => []),
    ]);
    setOfflineBlocks(blocks);
    setOfflineAreas(areas);
    setOfflineAhus(ahus);
    setOfflineFiltersTyped(filtersTyped);
  }, []);

  return {
    offlineInstances,
    offlineTemplates,
    offlineBlocks,
    offlineAreas,
    offlineAhus,
    offlineFiltersTyped,
    offlineDataLoaded,
    refreshOfflineInstances,
    refreshOfflineTyped,
  };
}
