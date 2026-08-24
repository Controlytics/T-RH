import { formatDecimals } from '@digilog/shared';
import { createReport, type ReportDoc } from '@/lib/pdf-report';
import {
  alarmTypeText, triggeredText, limitText, clearedText, statusText,
  type AlarmRow, type AlarmStatusTexts,
} from '@/routes/alarms/alarm-display';
import type { TableRow } from './trend-series';
import type { ChartImage } from './chart-image';

/**
 * The PDF renderers behind the trend page's governed downloads — the trend
 * charts (per slot, or both), the raw time series, and the alarms.
 *
 * None of this re-derives limits/decimals/severity wording: everything is
 * passed in already resolved, the same values the screen shows. That now
 * extends to the picture itself — the chart arrives as a PNG rasterised from
 * the real `TimeSeriesChart`, not redrawn here from the same numbers. See
 * `chart-image.ts`.
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

/** One slot's picture, as it will appear in the PDF. `image` is `null` when the
 *  slot had no readings to draw or the rasteriser could not produce a PNG — the
 *  report then says which, rather than leaving a gap that reads as "no data". */
export interface TrendChartSection {
  /** 'Temperature' / 'Humidity' — the heading above this chart. */
  title: string;
  image: ChartImage | null;
  /** Why there is no picture. Printed verbatim when `image` is null. */
  unavailableReason: string;
}

export interface TrendReportInput {
  /** 'Temperature', 'Humidity', or 'Temperature & Humidity' — names the SLOT this
   *  report covers, and is what distinguishes the three reports in the audit trail. */
  slotLabel: string;
  charts: TrendChartSection[];
  rows: TableRow[];
  keys: { key: string; label: string; decimals: number }[];
  instrument: ReportInstrument;
  period: ReportPeriod;
  formatDateTime: (d: string) => string;
  /**
   * The bucket the CHARTS were averaged over, or `null` at raw.
   *
   * Not cosmetic. A plotted point in an averaged chart is a derived number, and
   * the table printed under it holds the stored readings — so without this the
   * PDF shows two different values for one instant and states neither as
   * derived. The screen discloses it (`ChartIntervalNote`); a printed §11 record
   * that drops the disclosure on the way to paper is worse, because the paper
   * outlives the screen.
   */
  averagedLabel: string | null;
}

/** Page margin and usable width, matching `pdf-report.ts`'s own 14mm gutters. */
const MARGIN = 14;

/**
 * A wrapped paragraph of body text.
 *
 * NOT `addSectionTitle`. That primitive draws a fixed 7mm pill and a single
 * unwrapped `doc.text` line, so a sentence longer than the page runs off the
 * right edge instead of wrapping — fine for a heading, silently lossy for a
 * disclosure. A §11 statement that the reader cannot finish reading is not a
 * statement.
 */
function addNote(report: ReportDoc, text: string, color: [number, number, number]): void {
  const lines = report.doc.splitTextToSize(text, report.pw - MARGIN * 2) as string[];
  report.checkPageBreak(lines.length * 4 + 4);
  report.doc.setFontSize(8);
  report.doc.setTextColor(...color);
  report.doc.text(lines, MARGIN, report.y);
  report.y += lines.length * 4 + 4;
  report.doc.setTextColor(...report.colors.text);
}

/**
 * Draw one chart PNG across the text column, or state why there isn't one.
 *
 * Goes through `report.doc` directly rather than growing `pdf-report.ts` an
 * image primitive: this is the only report that prints a picture, and a shared
 * helper invented for one caller is a shared helper nobody else's needs shaped.
 */
function addChart(report: ReportDoc, section: TrendChartSection): void {
  report.addSectionTitle(section.title);
  if (!section.image) {
    addNote(report, section.unavailableReason, report.colors.muted);
    return;
  }
  const w = report.pw - MARGIN * 2;
  const h = (section.image.height / section.image.width) * w;
  report.checkPageBreak(h + 4);
  report.doc.addImage(section.image.dataUrl, 'PNG', MARGIN, report.y, w, h);
  report.y += h + 6;
}

/**
 * The trend widget as a report: the CHART the operator saw, with its in-spec
 * band, and the readings table beneath it.
 *
 * The chart is the picture and the table is the record — both, never one. A
 * trend report carrying only a table is not a trend report (it is the time
 * series report with a different title), and a chart with no table underneath
 * cannot be read back value by value.
 *
 * Company name, logo, Printed By + User ID, printed date/time and the signature
 * block all come from `createReport()`; none of it is rebuilt here.
 */
export async function renderTrendReport(input: TrendReportInput): Promise<ReportDoc> {
  const { shown, capped, total } = capRows(input.rows);
  const report = await createReport({
    title: `Instrument Trend — ${input.slotLabel}`,
    subtitle: `${input.instrument.code} — ${input.slotLabel}`,
    reportKey: 'instrument-trend',
    formatDateTime: input.formatDateTime,
  });
  addInstrumentDetails(report, input.instrument, input.period);

  // The same disclosure `ChartIntervalNote` makes on screen, in the same words
  // (`intervalLabel` is the one source for the bucket's name). A printed record
  // that drops it shows derived numbers as if they were readings — and paper
  // outlives the screen that explained itself.
  if (input.averagedLabel) {
    addNote(
      report,
      `Note: the chart below is AVERAGED over ${input.averagedLabel}. Each plotted point is the mean of the `
      + `readings in its bucket, not a stored reading. The table lists every stored reading in this period.`,
      report.colors.red,
    );
  }

  for (const section of input.charts) addChart(report, section);

  addCapNotice(report, capped, shown.length, total, input.period);
  report.addTable({
    head: ['Timestamp', ...input.keys.map((k) => k.label)],
    body: shown.map((r) => [
      input.formatDateTime(r.ts),
      ...input.keys.map((k) => (r.values[k.key] == null ? '—' : formatDecimals(r.values[k.key], k.decimals) ?? '—')),
    ]),
  });
  // CAVEAT: `report.getSnapshot()` records tables and key/value blocks only, so
  // a snapshot of this report would carry the table WITHOUT the chart or the
  // averaging note. Nothing re-renders a trend report from a snapshot today
  // (that path is "Send for Review", which this page does not offer). If it is
  // ever wired up here, the snapshot format has to learn about images first —
  // silently re-rendering a trend report as a bare table is the exact defect
  // this renderer was written to fix.
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
