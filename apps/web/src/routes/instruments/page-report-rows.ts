import type { Placeholder } from '@digilog/shared';
import type { ReportRow } from '@/lib/templated-report';
import {
  alarmTypeText, triggeredText, limitText as alarmLimitText, clearedText, statusText,
  type AlarmRow, type AlarmStatusTexts, type AlarmDisplayTexts,
} from '@/routes/alarms/alarm-display';
import {
  dataReportRows, emptyDataReportRow, limitText, dataReportIntervalText, dataReportExtremesText, dataReportMktText, orDash,
  type DataReportFormatters, type DataReportScope,
} from './data-report';
import type { DataReportInput, ReportPeriod } from './trend-report';

/**
 * What the trend page's and the Data Report page's reports hand the TEMPLATED
 * builder (2026-11-03, page reports on templates — spec
 * docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md §6):
 * their rows keyed by the kind's field ids, the bold grid, the 2,000-row cap,
 * and the placeholder values a template's title, subtitle, footer and info
 * rows name. Pure, so each rule is pinned without a PDF.
 *
 * Every cell is the page's OWN string — `dataReportRows` (decimals, `Error` /
 * `OL`, `NA`), the alarm-display helpers — never a number for the template to
 * re-round: a template's `decimals` never re-rounds a page's text (review C1).
 * Every placeholder is the parameter block's own wording (`limitText`,
 * `dataReportIntervalText`, the extremes row's sentence shape), and a blank
 * scope field is the header's `-`, never an empty value (which a template
 * prints as `—`).
 */

/**
 * A period holding tens of thousands of readings cannot become a complete
 * PDF — jsPDF chokes long before that, and a report that silently omits rows
 * while looking finished is worse than one that says so. The body is capped
 * here and, when capped, the report states in its own text how many of how
 * many rows it holds and what period it actually covers (`capNotice`) — not
 * just in a toast the operator may not see once the file is saved.
 */
export const MAX_REPORT_ROWS = 2000;

function capRows<T>(rows: readonly T[]): { shown: T[]; capped: boolean; total: number } {
  if (rows.length <= MAX_REPORT_ROWS) return { shown: [...rows], capped: false, total: rows.length };
  return { shown: rows.slice(0, MAX_REPORT_ROWS), capped: true, total: rows.length };
}

/** A page's rows as the templated builder takes them, and how many of how many it holds. */
export interface PageReportRows {
  rows: ReportRow[];
  capped: boolean;
  /** Rows the period held. */
  total: number;
  /** Rows printed (≤ `MAX_REPORT_ROWS`); 0 for an empty period, whose one row says so. */
  shownCount: number;
}

/** The truncation notice a capped report prints above its records, or `null` when nothing was cut. */
export function capNotice(r: Pick<PageReportRows, 'capped' | 'shownCount' | 'total'>, period: ReportPeriod): string | null {
  if (!r.capped) return null;
  return `Truncated: showing the first ${r.shownCount.toLocaleString()} of ${r.total.toLocaleString()} rows for ${period.label}. `
    + 'Narrow the period for a complete report.';
}

/** The Data Report's four fields, in its own column order — `PAGE_REPORT_FIELDS['page:data-report']`. */
const DATA_REPORT_IDS = ['record.date', 'record.time', 'record.temperature', 'record.humidity'] as const;

const keyed = (ids: readonly string[], cells: readonly string[]): ReportRow =>
  Object.fromEntries(ids.map((id, i) => [id, cells[i]]));

/**
 * One instrument's Data Report rows: `dataReportRows`' cells keyed by the four
 * fields, and its bold grid (`[row][field]`, the field order above — ruling
 * R-3). An EMPTY period is ONE row, today's `emptyDataReportRow()` — a header
 * over nothing reads as a rendering failure on paper — with no bold grid.
 * `printedNoData` is over the PRINTED rows, so the legend keys `NA` exactly
 * when a printed cell says it.
 */
export function rowsForDataReport(input: DataReportInput): PageReportRows & { bold: boolean[][]; printedNoData: boolean } {
  const { shown, capped, total } = capRows(input.rows);
  if (shown.length === 0) {
    return { rows: [keyed(DATA_REPORT_IDS, emptyDataReportRow())], bold: [], capped, total, shownCount: 0, printedNoData: false };
  }
  const body = dataReportRows(
    shown,
    { temp: input.temp.key, rh: input.rh.key },
    { temp: input.temp, rh: input.rh },
    input.fmt,
    input.words,
  );
  return {
    rows: body.cells.map((cells) => keyed(DATA_REPORT_IDS, cells)),
    bold: body.bold,
    capped,
    total,
    shownCount: shown.length,
    printedNoData: body.printedNoData,
  };
}

/**
 * The trend page's Instrument Alarms rows, keyed by its six fields — the six
 * strings today's report printed: the type, when it was raised, the value it
 * fired on, the limit, when it cleared (with what), and its status, each in the
 * ADMINISTERED wording the screen shows.
 */
export function rowsForInstrumentAlarms(
  rows: readonly AlarmRow[],
  formatDateTime: (iso: string) => string,
  statusTexts?: AlarmStatusTexts,
  inactivityTexts?: AlarmDisplayTexts,
): PageReportRows {
  const { shown, capped, total } = capRows(rows);
  return {
    rows: shown.map((a) => ({
      'alarm.type': alarmTypeText(a, inactivityTexts),
      'alarm.raisedAt': formatDateTime(a.raisedAt),
      'alarm.value': triggeredText(a, inactivityTexts),
      'alarm.limit': alarmLimitText(a, inactivityTexts),
      'alarm.clearedAt': a.clearedAt ? `${formatDateTime(a.clearedAt)} (${clearedText(a, inactivityTexts)})` : '—',
      'alarm.status': statusText(a, statusTexts),
    })),
    capped,
    total,
    shownCount: shown.length,
  };
}

type Values = Partial<Record<Placeholder, string>>;

/**
 * The instrument header's eight fields — Block / Area / Location / Inst ID,
 * Start / End Date / Time — and the period (`{from}` / `{to}` as instants,
 * `{period}` its label), as the page's header block prints them.
 */
export function instrumentPlaceholderValues(
  scope: DataReportScope,
  period: ReportPeriod,
  fmt: DataReportFormatters,
  formatDateTime: (iso: string) => string,
): Values {
  return {
    block: orDash(scope.blockName),
    area: orDash(scope.areaName),
    location: orDash(scope.locationName),
    instrument: orDash(scope.instrumentLabel),
    fromDate: fmt.formatDate(period.from),
    fromTime: fmt.formatTime(period.from),
    toDate: fmt.formatDate(period.to),
    toTime: fmt.formatTime(period.to),
    from: formatDateTime(period.from),
    to: formatDateTime(period.to),
    period: period.label,
  };
}

/** The trend report's: the instrument header's, and `{series}` — the slot the report covers. */
export function trendPlaceholderValues(
  scope: DataReportScope,
  period: ReportPeriod,
  fmt: DataReportFormatters,
  formatDateTime: (iso: string) => string,
  series: string,
): Values {
  return { ...instrumentPlaceholderValues(scope, period, fmt, formatDateTime), series };
}

/**
 * One instrument's Data Report values: the header's, the two limits, the
 * extremes line, the interval and the MKT — each the parameter block's own
 * wording. `extremes` and `mkt` are ABSENT when the block prints none (no bound
 * in force; no MKT from the server), so a template prints `—` there.
 */
export function dataReportPlaceholderValues(input: DataReportInput): Values {
  const extremes = dataReportExtremesText(input.temp, input.rh);
  const mkt = dataReportMktText(input.temp);
  return {
    ...instrumentPlaceholderValues(input.scope, input.period, input.fmt, input.formatDateTime),
    tempLimit: limitText(input.temp),
    rhLimit: limitText(input.rh),
    ...(extremes !== null ? { extremes } : {}),
    interval: dataReportIntervalText(input.intervalMs),
    ...(mkt !== null ? { mkt } : {}),
  };
}
