import useSWR from 'swr';
import { EXPORT_LIMIT_DEFAULT_MAX, EXPORT_LIMIT_DEFAULT_MESSAGE, EXPORT_LIMIT_HARD_CEILING } from '@digilog/shared';

export interface ExportLimit {
  /** The active soft limit, already clamped to the hard ceiling. */
  maxRecords: number;
  /** Build the user-facing "too large" message for a given attempted row count. */
  tooLargeMessage: (count: number) => string;
}

/**
 * Export-size guardrail, driven by the SUPER_ADMIN `export-limit` config
 * (`GET /api/config/export-limit/current`, readable by every authenticated
 * user). Falls back to the shared defaults while the config is loading or if it
 * has never been saved. The stored value is clamped to the hard ceiling here as
 * a second line of defence (the zod schema already caps it at write time).
 *
 * Call this ONCE at the top of a component (rules of hooks); the returned values
 * can be closed over by export handlers.
 */
export function useExportLimit(): ExportLimit {
  const { data } = useSWR<{ maxRecords?: number; message?: string }>(
    '/api/config/export-limit/current',
    { revalidateOnMount: true, dedupingInterval: 5000, revalidateOnFocus: false },
  );
  const raw = data?.maxRecords ?? EXPORT_LIMIT_DEFAULT_MAX;
  const maxRecords = Math.min(Math.max(1, Math.floor(raw)), EXPORT_LIMIT_HARD_CEILING);
  const template = data?.message || EXPORT_LIMIT_DEFAULT_MESSAGE;
  const tooLargeMessage = (count: number): string =>
    template
      .replace(/\{count\}/g, count.toLocaleString())
      .replace(/\{max\}/g, maxRecords.toLocaleString());
  return { maxRecords, tooLargeMessage };
}
