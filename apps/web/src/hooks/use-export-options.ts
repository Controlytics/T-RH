import useSWR from 'swr';
import { formatToFlags } from '@/lib/export-surfaces';

/**
 * Which export formats the current user may use on a given page (surface).
 * Reads the role-wise matrix via `/api/config/export-options/current`.
 *
 * FAIL-OPEN: while the config is loading, or when the role/surface has no
 * explicit entry, both PDF and Excel are shown. Only an explicit NONE/PDF/EXCEL
 * restricts. SUPER_ADMIN gets `{}` from the server -> both shown.
 */
export function useExportOptions(surfaceKey: string): { pdf: boolean; excel: boolean } {
  const { data } = useSWR<Record<string, string>>('/api/config/export-options/current', {
    revalidateOnFocus: false,
  });
  return formatToFlags(data?.[surfaceKey]);
}
