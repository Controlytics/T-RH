import useSWR from 'swr';

/**
 * Whether the current user's role may expand an AHU to see its filters on the
 * PM Schedule page. Configured per-role by SUPER_ADMIN
 * (Config → PM Schedule — AHU Filters). SEPARATE matrix from the Replacement
 * Schedule one. FAIL-CLOSED: false until the config loads / unless explicitly
 * enabled. SUPER_ADMIN -> always true (server).
 */
export function usePmFiltersEnabled(): boolean {
  const { data } = useSWR<{ enabled: boolean }>('/api/config/pm-schedule-filters/current', {
    revalidateOnFocus: false,
  });
  return !!data?.enabled;
}
