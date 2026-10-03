import { MAX_SERIES_POINTS } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { scheduleRows, type ReportSlotRow } from './data-report';
import { toTableRowsWithErrors, type TableRow } from './trend-series';
import type { TelemetryLongRow } from './use-trend-data';
import type { ReportCoverage } from './trend-report';

/** What the sampled chart path returns per key — the whole-range extremes. */
export interface ServerSlotSummary {
  min: number | null;
  max: number | null;
  /** MKT over the whole period, °C; sent only for a temperature slot whose
   *  instrument has `isMktCalculationEnabled` on. Absent on older servers. */
  mkt?: number | null;
}

/**
 * The rows and extremes ONE instrument's Data Report is built from, fetched
 * the way the trend page has fetched them since 2026-09-05 — shared by the
 * trend page's Time Series download and the Instruments page's history widget,
 * so the two documents cannot be built from different data.
 *
 * Two requests, and why both:
 *  1. The sampled CHART path (`points=`) — for `historyTotal` (the period's
 *     true row count) and `summaries` (Max/Min computed in SQL over EVERY
 *     reading, which the parameter block prints). Its rows are NOT used: it
 *     drops a non-numeric reading before sampling, so the failure word could
 *     never print from it.
 *  2. The paged TABLE path, asked for the WHOLE period in one request sized by
 *     that count (no ceiling since 2026-09-02) — every stored reading, raw,
 *     pivoted with `toTableRowsWithErrors` (the on-screen table's own builder)
 *     and laid on the interval schedule.
 *
 * `coverage` reports what the paged call returned against the true total, so a
 * ceiling anywhere would still be disclosed in the report rather than assumed
 * away.
 */
export async function fetchDataReportRows(input: {
  instrumentId: string;
  from: string;
  to: string;
  intervalMs: number | null;
  slotKeys: string[];
}): Promise<{
  rows: ReportSlotRow<TableRow>[];
  coverage: ReportCoverage;
  summaries: Record<string, ServerSlotSummary>;
}> {
  const range = `from=${encodeURIComponent(input.from)}&to=${encodeURIComponent(input.to)}`;
  const sampled = await apiClient.get<{
    history: TelemetryLongRow[];
    historyTotal?: number;
    summaries?: Record<string, ServerSlotSummary>;
  }>(`/api/instruments/${input.instrumentId}/telemetry?${range}&points=${MAX_SERIES_POINTS}`);
  const trueTotal = sampled.historyTotal ?? sampled.history.length;
  const whole = trueTotal > 0
    ? await apiClient.get<{ history: TelemetryLongRow[]; historyTotal?: number }>(
      `/api/instruments/${input.instrumentId}/telemetry?${range}&limit=${trueTotal}&offset=0`,
    )
    : { history: [] as TelemetryLongRow[], historyTotal: 0 };
  return {
    rows: scheduleRows(toTableRowsWithErrors(whole.history, input.slotKeys), input.intervalMs, input.to),
    coverage: { returned: whole.history.length, total: whole.historyTotal ?? whole.history.length },
    summaries: sampled.summaries ?? {},
  };
}

/** The period extremes of one slot — and its MKT when the server sent one —
 *  or nulls for a slot with no key. */
export function slotExtremes(
  summaries: Record<string, ServerSlotSummary>,
  key: string | null,
): { periodMax: number | null; periodMin: number | null; periodMkt: number | null } {
  const s = key ? summaries[key] : undefined;
  return { periodMax: s?.max ?? null, periodMin: s?.min ?? null, periodMkt: s?.mkt ?? null };
}
