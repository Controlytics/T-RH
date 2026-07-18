import { useEffect } from 'react';
import useSWR from 'swr';
import { setRuntimeOfflineTtlMs } from '../lib/offline-store';
import { setHardCutoffMs } from '../lib/hard-cutoff';

interface OfflineCacheConfigResponse {
  cacheStalenessHours: number;
  cacheHardCutoffHours: number;
}

/**
 * W2 + W4 bootstrap hook. Reads the SUPER_ADMIN-tuned offline-cache config
 * from /api/config/offline-cache/current and pushes the staleness value into
 * the offline-store runtime variable. The W4 hard-cutoff blocker consumes
 * `cacheHardCutoffHours` from the same response.
 *
 * Mount this once at the app root (AppLayout) — it polls every 5 minutes
 * for config updates so a SUPER_ADMIN change propagates without requiring
 * the operator to reload.
 *
 * Why a hook rather than a one-shot fetch: SWR gives us deduplication
 * (multiple components reading from the same key share one fetch),
 * automatic retry on failure, and revalidate-on-focus so the value
 * refreshes after the operator unlocks the tablet.
 */
export function useOfflineConfig(): OfflineCacheConfigResponse {
  // Gate on an access token. AppLayout runs this hook during render BEFORE its
  // `if (!isAuthenticated) return <Navigate to="/login">` early-return, so
  // without this gate the SWR fires on every tokenless app open (fresh tab =
  // empty sessionStorage). /api/config/offline-cache/current is not a public
  // endpoint, so that call 401s with "Missing token" and surfaces a toast.
  const hasToken = typeof sessionStorage !== 'undefined' && !!sessionStorage.getItem('access_token');
  const { data } = useSWR<OfflineCacheConfigResponse>(
    hasToken ? '/api/config/offline-cache/current' : null,
    {
      revalidateOnMount: true,
      revalidateOnFocus: true,
      // Long-ish dedup so we don't hammer the endpoint, but short enough that
      // a SUPER_ADMIN config change propagates within a few minutes without
      // a manual reload.
      dedupingInterval: 60_000,
      refreshInterval: 5 * 60 * 1000, // every 5 minutes
    },
  );

  const cacheStalenessHours = data?.cacheStalenessHours ?? 24;
  const cacheHardCutoffHours = data?.cacheHardCutoffHours ?? 24;

  useEffect(() => {
    // Push the staleness value into offline-store so cacheData / getCachedData
    // honor it on the very next read. min() inside getCachedData ensures
    // entries already on disk also respect a tighter window.
    setRuntimeOfflineTtlMs(cacheStalenessHours * 60 * 60 * 1000);
  }, [cacheStalenessHours]);

  useEffect(() => {
    // W4: push the hard-cutoff window into the lockout module so apiClient
    // and the blocker overlay see the live value.
    setHardCutoffMs(cacheHardCutoffHours * 60 * 60 * 1000);
  }, [cacheHardCutoffHours]);

  return { cacheStalenessHours, cacheHardCutoffHours };
}
