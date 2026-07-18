import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';

/**
 * Wave 3 (asset-removal) — frontend read hook for the new typed-table
 * hierarchy endpoints landed in Wave 2.
 *
 * Hits `GET /api/hierarchy/tree` and returns the nested
 * Block → Area → AHU → Filter structure. Existing pages still read from
 * the legacy AssetInstance routes; this hook is the bridge for new pages
 * that want to consume the typed-table read path directly.
 */

export type HierarchyFilter = {
  id: string;
  name: string;
  status: string;
  currentLifecycleState: string | null;
};

export type HierarchyAhu = {
  id: string;
  name: string;
  status: string;
  filters: HierarchyFilter[];
};

export type HierarchyArea = {
  id: string;
  name: string;
  status: string;
  ahus: HierarchyAhu[];
};

export type HierarchyBlock = {
  id: string;
  name: string;
  status: string;
  areas: HierarchyArea[];
};

export type HierarchyTree = {
  blocks: HierarchyBlock[];
};

export function useHierarchy() {
  const { data, error, isLoading, mutate } = useSWR<HierarchyTree>(
    '/api/hierarchy/tree',
    // Explicit fetcher (rather than relying on the global SWRConfig
    // default) so this hook is self-contained and unambiguous about
    // going through apiClient — same auth/hard-cutoff/error-mapping
    // path every other authenticated read in the app uses.
    (url: string) => apiClient.get<HierarchyTree>(url),
    {
      revalidateOnFocus: false,
      dedupingInterval: 5000,
    },
  );

  return { data, error, isLoading, mutate };
}
