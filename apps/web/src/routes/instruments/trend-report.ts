import { formatDecimals } from '@digilog/shared';
import { createReport, type ReportDoc } from '@/lib/pdf-report';
import {
  alarmTypeText, triggeredText, limitText, clearedText, statusText,
  type AlarmRow, type AlarmStatusTexts,
} from '@/routes/alarms/alarm-display';
import type { TableRow } from './trend-series';

/**
 * The three PDF renderers behind the trend page's governed downloads — one
 * per widget (charts, raw time series, alarms). None of this re-derives
 * limits/decimals/severity wording: everything is passed in already resolved,
 * the same values the screen shows.
 */

export interface ReportInstrument {
  code: string;
  name: string;
  /** "Room CWH-I/142 (Wet Lab)" or "Not placed on a floorplan". */
  locationText: string;
  /** e.g. "18.0 - 25.0 (from this instrument)". */
  limitsText: string;
}

export interface ReportPeriod {
  from: string;
  to: string;
  label: string;
}

/**
 * A period holding tens of thousands of readings cannot become a complete
 * PDF — jsPDF chokes long before that, and a report that silently omits rows
 * while looking finished is worse than one that says so. The body is capped
 * here and, when capped, the report states in its own text how many of how
 * many rows it holds and what period it actually covers — not just in a
 * toast the operator may not see once the file is saved.
 */
const MAX_REPORT_ROWS = 2000;

function capRows<T>(rows: T[]): { shown: T[]; capped: boolean; total: number } {
  if (rows.length <= MAX_REPORT_ROWS) return { shown: rows, capped: false, total: rows.length };
  return { shown: rows.slice(0, MAX_REPORT_ROWS), capped: true, total: rows.length };
}

function addInstrumentDetails(report: ReportDoc, instrument: ReportInstrument, period: ReportPeriod): void {
  report.addKeyValue([
    ['Instrument', instrument.code],
    ['Name', instrument.name],
    ['Location', instrument.locationText],
    ['Limits in force', instrument.limitsText],
    ['Period', period.label],
  ], 2);
}

function addCapNotice(report: ReportDoc, capped: boolean, shownCount: number, total: number, period: ReportPeriod): void {
  if (!capped) return;
  report.addSectionTitle(
    `Truncated: showing the first ${shownCount.toLocaleString()} of ${total.toLocaleString()} rows for ${period.label}. ` +
    `Narrow the period for a complete report.`,
  );
}

/** The charts widget (temperature + humidity) as a report — the two administered
 *  slots only, since that is all the charts themselves show. */
export async function renderTrendReport(
  rows: { ts: string; values: Record<string, number | null> }[],
  keys: { key: string; label: string; decimals: number }[],
  instrument: ReportInstrument,
  period: ReportPeriod,
  formatDateTime: (d: string) => string,
): Promise<ReportDoc> {
  const { shown, capped, total } = capRows(rows);
  const report = await createReport({
    title: 'Instrument Trend',
    subtitle: `${instrument.code} — Temperature & Humidity`,
    reportKey: 'instrument-trend',
    formatDateTime,
  });
  addInstrumentDetails(report, instrument, period);
  addCapNotice(report, capped, shown.length, total, period);
  report.addTable({
    head: ['Timestamp', ...keys.map((k) => k.label)],
    body: shown.map((r) => [
      formatDateTime(r.ts),
      ...keys.map((k) => (r.values[k.key] == null ? '—' : formatDecimals(r.values[k.key], k.decimals) ?? '—')),
    ]),
  });
  return report;
}

/** The raw paged time-series widget — every administered AND extra key column
 *  currently shown on screen, for the dialog's chosen period (which may differ
 *  from the page's). */
export async function renderTimeSeriesReport(
  rows: TableRow[],
  keys: { key: string; label: string; decimals: number }[],
  instrument: ReportInstrument,
  period: ReportPeriod,
  formatDateTime: (d: string) => string,
): Promise<ReportDoc> {
  const { shown, capped, total } = capRows(rows);
  const report = await createReport({
    title: 'Instrument Time Series (raw readings)',
    subtitle: instrument.code,
    reportKey: 'instrument-trend',
    formatDateTime,
  });
  addInstrumentDetails(report, instrument, period);
  addCapNotice(report, capped, shown.length, total, period);
  report.addTable({
    head: ['Timestamp', ...keys.map((k) => k.label)],
    body: shown.map((r) => [
      formatDateTime(r.ts),
      ...keys.map((k) => (r.values[k.key] == null ? '—' : formatDecimals(r.values[k.key], k.decimals) ?? '—')),
    ]),
  });
  return report;
}

/**
 * The alarms widget — same wording as the Alarms page, via `alarm-display.ts`.
 *
 * `statusTexts` must be the SAME configured wording the on-screen widget is
 * showing (from `mapStatusTextsResponse()` over `/api/config/alarm-limits/
 * status-texts`), not the shipped defaults — a printed §11 record that
 * describes an alarm differently than the screen it was generated from is a
 * record that does not match the system it documents. `undefined` is only
 * correct while that config is still loading; `statusText()` itself falls
 * back to the defaults in that case.
 */
export async function renderAlarmsReport(
  rows: AlarmRow[],
  instrument: ReportInstrument,
  period: ReportPeriod,
  formatDateTime: (d: string) => string,
  statusTexts?: AlarmStatusTexts,
): Promise<ReportDoc> {
  const { shown, capped, total } = capRows(rows);
  const report = await createReport({
    title: 'Instrument Alarms',
    subtitle: instrument.code,
    reportKey: 'instrument-trend',
    formatDateTime,
  });
  addInstrumentDetails(report, instrument, period);
  addCapNotice(report, capped, shown.length, total, period);
  report.addTable({
    head: ['Type', 'Severity', 'Raised', 'Value', 'Limit', 'Cleared', 'Status'],
    body: shown.map((a) => [
      alarmTypeText(a),
      a.severity,
      formatDateTime(a.raisedAt),
      triggeredText(a),
      limitText(a),
      a.clearedAt ? `${formatDateTime(a.clearedAt)} (${clearedText(a)})` : '—',
      statusText(a, statusTexts),
    ]),
  });
  return report;
}
