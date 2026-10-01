import { useMemo } from 'react';
import useSWR from 'swr';
import { coerceReportDownloadsResponse, type ReportDownloadsPolicy } from '@digilog/shared';

/**
 * How each report type downloads — Direct or Request, remarks and password
 * required or not — as administered under Configuration → Report Downloads
 * (2026-10-01). The ONE browser reader of
 * `GET /api/config/report-downloads/current`, read with
 * `coerceReportDownloadsResponse` — the reader for the route's per-kind shape,
 * NOT `coerceReportDownloads`, which reads the stored row (using that one here
 * silently turned every type into Request).
 *
 * `policy` is `undefined` until the response arrives: a dialog must not guess
 * a mode, because guessing Direct for a reviewed type would show a Download
 * button the server then refuses. The server is the control either way.
 */
export function useReportDownloads(): { policy: ReportDownloadsPolicy | undefined; error: unknown } {
  const { data, error } = useSWR<unknown>('/api/config/report-downloads/current');
  const policy = useMemo(() => (data === undefined ? undefined : coerceReportDownloadsResponse(data)), [data]);
  return { policy, error };
}
