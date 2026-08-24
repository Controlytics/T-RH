import { formatDecimals } from '@digilog/shared';
import { createReport, type ReportDoc } from '@/lib/pdf-report';
import {
  alarmTypeText, triggeredText, limitText, clearedText, statusText,
  type AlarmRow, type AlarmStatusTexts,
} from '@/routes/alarms/alarm-display';
import type { TableRow } from './trend-series';
import type { ChartImage } from './chart-image';
import type { SlotSummary } from './trend-summary';

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

/** One slot's picture and its period statistics. `image` is `null` when the
 *  slot had no readings to draw or the rasteriser could not produce a PNG — the
 *  report then says which, rather than leaving a gap that reads as "no data". */
export interface TrendChartSection {
  /** 'Temperature' / 'Humidity' — the heading above this chart. */
  title: string;
  image: ChartImage | null;
  /** Why there is no picture. Printed verbatim when `image` is null. */
  unavailableReason: string;
  /** Computed from the STORED readings, never from the averaged points plotted
   *  above them. `null` when the slot had no readings in the period. */
  summary: SlotSummary | null;
}

/**
 * How much of the period's record this report was actually built from.
 *
 * `GET /:id/telemetry` caps `limit` at 500 server-side and the repository orders
 * `ts DESC`, so a long period comes back as its most recent tail, not the whole
 * window — measured on this install, a 30-day period holds 7,646 rows and 500
 * come back. A statistics block computed over 6.5% of a period, printed under a
 * heading naming the whole period, is a §11 misrepresentation with no tell. So
 * the report states its own coverage whenever the two numbers differ.
 */
export interface ReportCoverage {
  /** Readings the report received. */
  returned: number;
  /** Readings the period actually holds, from the endpoint's `historyTotal`. */
  total: number;
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
  /**
   * Whether the TABLE holds averaged points rather than stored readings.
   *
   * The table under an averaged chart shows the SAME points the chart plots —
   * two blocks of one report disagreeing about the value at an instant, with
   * nothing saying why, is the defect this whole report was rewritten to
   * remove. The raw record then lives in the Time Series report, and this one
   * says so rather than leaving the reader to wonder where it went.
   */
  tableIsAveraged: boolean;
  coverage: ReportCoverage;
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

/** A number at the slot's own resolved precision, or an em dash. */
function num(v: number | null | undefined, decimals: number): string {
  return v == null ? '—' : (formatDecimals(v, decimals) ?? '—');
}

/**
 * One slot's period statistics, under its chart.
 *
 * Out-of-spec is stated in READINGS, and the wording says so. Converting
 * samples into a duration means assuming what happened between them, and the
 * gap left by an instrument that went offline is exactly where that assumption
 * is worst — it would attribute a value to a stretch with no record at all.
 */
function addSummary(report: ReportDoc, summary: SlotSummary, formatDateTime: (d: string) => string): void {
  const d = summary.decimals;
  const rows: string[][] = [
    ['Readings', summary.count.toLocaleString()],
    ['Minimum', `${num(summary.min, d)} ${summary.unit}`],
    ['Maximum', `${num(summary.max, d)} ${summary.unit}`],
    ['Mean', `${num(summary.mean, d)} ${summary.unit}`],
    ['First reading', `${num(summary.first.value, d)} ${summary.unit}  —  ${formatDateTime(summary.first.ts)}`],
    ['Last reading', `${num(summary.last.value, d)} ${summary.unit}  —  ${formatDateTime(summary.last.ts)}`],
  ];

  if (summary.outOfSpecCount === null) {
    // NOT "0 out of spec". No limits are set, so nothing was checked, and a
    // zero here would read as a clean period rather than an unjudged one.
    rows.push(['Out of specification', 'Not assessed — no limits are set for this slot']);
  } else {
    const pct = summary.count > 0 ? (summary.outOfSpecCount / summary.count) * 100 : 0;
    rows.push([
      'Out of specification',
      `${summary.outOfSpecCount.toLocaleString()} of ${summary.count.toLocaleString()} readings (${pct.toFixed(1)}%)`,
    ]);
    rows.push([
      '— below / above limit',
      `${(summary.belowCount ?? 0).toLocaleString()} below ${num(summary.limitMin, d)}`
      + `  /  ${(summary.aboveCount ?? 0).toLocaleString()} above ${num(summary.limitMax, d)}`,
    ]);
  }

  report.addTable({ head: [`${summary.label} — period summary`, 'Value'], body: rows });
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
    // Says what this report IS, so a reader months later does not have to infer
    // it from the title alone how it differs from the Time Series report. The
    // audit `reportType` cannot carry this — target_type is VARCHAR(50) and
    // "Instrument Trend — Temperature & Humidity" already uses 41 of it.
    subtitle: `${input.instrument.code} — ${input.slotLabel}. Chart and period summary. `
      + `The complete raw record is the Instrument Time Series report.`,
    reportKey: 'instrument-trend',
    formatDateTime: input.formatDateTime,
  });
  addInstrumentDetails(report, input.instrument, input.period);

  // Coverage first, above everything it qualifies. A statistics block reads as
  // authoritative, so if it does not cover the period its heading names, that
  // has to be the first thing read, not a footnote under the table.
  if (input.coverage.total > input.coverage.returned) {
    addNote(
      report,
      // "stored values across all keys", not "readings": this count spans every
      // key the instrument sent, while each summary below counts ONE slot. Two
      // numbers in the same units that cannot be reconciled would read as a
      // contradiction rather than as the different measures they are.
      `INCOMPLETE PERIOD: this report was built from the ${input.coverage.returned.toLocaleString()} most recent `
      + `stored values across all keys, but ${input.period.label} holds ${input.coverage.total.toLocaleString()}. `
      + `The chart, the summary and the table below all describe that most recent portion only — not the whole `
      + `period named above. Narrow the period for a report that covers all of it.`,
      report.colors.red,
    );
  }

  // The same disclosure `ChartIntervalNote` makes on screen, in the same words
  // (`intervalLabel` is the one source for the bucket's name). A printed record
  // that drops it shows derived numbers as if they were readings — and paper
  // outlives the screen that explained itself.
  if (input.averagedLabel) {
    addNote(
      report,
      `Note: the chart AND the table below are AVERAGED over ${input.averagedLabel}. Each point and each row is `
      + `the mean of the readings in its bucket, not a stored reading. The period summary is NOT averaged — it is `
      + `computed from the stored readings, so a brief excursion that averaging smooths away still appears there. `
      + `For the complete unaveraged record, use the Instrument Time Series report.`,
      report.colors.red,
    );
  }

  for (const section of input.charts) {
    addChart(report, section);
    if (section.summary) {
      addSummary(report, section.summary, input.formatDateTime);
    } else {
      addNote(report, `No ${section.title.toLowerCase()} readings in this period, so there is nothing to summarise.`, report.colors.muted);
    }
  }

  addCapNotice(report, capped, shown.length, total, input.period);
  report.addSectionTitle(
    input.tableIsAveraged
      ? `Averaged readings — the same points plotted above, not stored readings`
      : `Readings — every stored reading in this period`,
  );
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
