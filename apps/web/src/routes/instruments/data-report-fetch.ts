/**
 * The sampled CHART call is made for `historyTotal` and `summaries` ONLY — the server
 * computes both in SQL over EVERY reading of the period whatever `points` is
 * (`getRangeSummary`'s `count(*)`, Min / Max / MKT) — and its rows are thrown away
 * (see below). So it asks for the fewest points the chart path returns: `lttb` keeps
 * just the first and last reading of a key at 2. At `MAX_SERIES_POINTS` (5,000 a key)
 * those discarded rows were ~1 MB of JSON per instrument — 30 of the 34 MB a
 * 30-instrument, 7-day, 15-minute report parsed after G1-01 (performance audit R1
 * retest, 2026-11-18: 34 → 3 MB). The server still reads every row for that call.
 */
const SUMMARY_ONLY_POINTS = 2;
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
 *  2. The ROWS, pivoted with `toTableRowsWithErrors` (the on-screen table's own
 *     builder) and laid on the interval schedule:
 *     - an INTERVAL report reads `/telemetry-report-rows` — only the readings
 *       `scheduleRows` keeps (each slot's first instant), chosen by the server
 *       with the same rule (performance audit 2026-11-17, G1-01);
 *     - a RAW report reads the paged TABLE path for the WHOLE period in one
 *       request sized by that count (no ceiling since 2026-09-02) — every
 *       stored reading, raw.
 *
 * `coverage` is what the rows call returned against the period's true total. For
 * a RAW report a shortfall is a ceiling, disclosed rather than assumed away; for
 * an INTERVAL report `returned` is the KEPT readings, so `returned < total` is
 * expected there and is not a truncation. (No report prints it since 2026-10-06.)
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
  }>(`/api/instruments/${input.instrumentId}/telemetry?${range}&points=${SUMMARY_ONLY_POINTS}`);
  const trueTotal = sampled.historyTotal ?? sampled.history.length;
  const interval = input.intervalMs !== null && input.intervalMs > 0 ? input.intervalMs : null;
  const whole = trueTotal === 0
    ? { history: [] as TelemetryLongRow[], historyTotal: 0 }
    : interval !== null
      // An INTERVAL report prints the first reading of each slot (`scheduleRows`), so
      // the server returns exactly those readings, chosen by the same rule
      // (performance audit 2026-11-17, G1-01: the whole period was 78 MB for 26
      // instruments x 7 days). `scheduleRows` below then builds the identical report —
      // same anchor, same slots, same NA rows — from a fraction of the data.
      ? await apiClient.get<{ history: TelemetryLongRow[]; historyTotal?: number }>(
        `/api/instruments/${input.instrumentId}/telemetry-report-rows?${range}&intervalMs=${interval}&keys=${encodeURIComponent(input.slotKeys.join(','))}`,
      )
      // RAW prints every stored reading, so the whole period it is.
      : await apiClient.get<{ history: TelemetryLongRow[]; historyTotal?: number }>(
        `/api/instruments/${input.instrumentId}/telemetry?${range}&limit=${trueTotal}&offset=0`,
      );
  return {
    rows: scheduleRows(toTableRowsWithErrors(whole.history, input.slotKeys), input.intervalMs, input.to),
    coverage: { returned: whole.history.length, total: whole.historyTotal ?? whole.history.length },
    summaries: sampled.summaries ?? {},
  };
}

/**
 * One instrument's attributes as a report template prints them (2026-11-03,
 * ruling T3-A): `attr:<key>` → the text the attributes panel shows — the
 * server's `display` (a limit at the instrument's own decimals) else the
 * stored `value`. The SAME route and the same visibility as the panel; an
 * offset key the caller may not see is simply absent, and a template naming it
 * prints `—`.
 */
export async function fetchReportAttributes(instrumentId: string): Promise<Record<string, string>> {
  const res = await apiClient.get<{ data: { key: string; value: string; display?: string | null }[] }>(
    `/api/instruments/${instrumentId}/attributes`,
  );
  return Object.fromEntries(res.data.map((a) => [`attr:${a.key}`, a.display ?? a.value]));
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
