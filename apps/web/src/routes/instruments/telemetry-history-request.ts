import { apiClient } from '@/lib/api-client';

/**
 * THE merged-history request — the Data Report table (`history-widget.tsx`), the dashboard time-series widget and
 * that widget's report all read `POST /api/instruments/telemetry-history` through here.
 *
 * A POST that only reads (performance audit WA-26, 2026-11-18): the selection rides in the body because a Block of
 * 450 instruments put 450 ids in the GET's URL and the server answered HTTP 431. The server answers the POST and the
 * GET identically (one implementation). `postRead` bounds it like any read — the long bound unless the caller says.
 *
 * As an SWR key use `[TELEMETRY_HISTORY_PATH, body]`: SWR hashes it by content, so an equal selection is one key.
 */
export const TELEMETRY_HISTORY_PATH = '/api/instruments/telemetry-history';

export interface TelemetryHistoryRequest {
  instrumentIds: string[];
  /** Only these keys; absent = every key. */
  keys?: string[];
  from: string;
  to: string;
  limit: number;
  offset: number;
}

export interface TelemetryHistoryRow {
  instrumentId: string;
  ts: string;
  values: Record<string, unknown>;
}

export interface TelemetryHistoryPage {
  data: TelemetryHistoryRow[];
  total: number;
}

export function fetchTelemetryHistory(body: TelemetryHistoryRequest, opts: { timeoutMs?: number } = {}) {
  return apiClient.postRead<TelemetryHistoryPage>(TELEMETRY_HISTORY_PATH, body, opts);
}
