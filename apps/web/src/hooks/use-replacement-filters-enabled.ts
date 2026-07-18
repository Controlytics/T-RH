import useSWR from 'swr';

/**
 * Whether the current user's role may expand an AHU to see its filters on the
 * Replacement Schedule page. Configured per-role by SUPER_ADMIN
 * (Config → Replacement Schedule — AHU Filters). FAIL-CLOSED: false until the
 * config loads / unless explicitly enabled. SUPER_ADMIN -> always true (server).
 */
export function useReplacementFiltersEnabled(): boolean {
  const { data } = useSWR<{ enabled: boolean }>('/api/config/replacement-schedule-filters/current', {
    revalidateOnFocus: false,
  });
  return !!data?.enabled;
}
