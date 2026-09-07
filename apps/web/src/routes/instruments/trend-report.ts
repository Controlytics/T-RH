import { formatDecimals } from '@digilog/shared';
import { createReport, type ReportDoc } from '@/lib/pdf-report';
import {
  alarmTypeText, triggeredText, limitText, clearedText, statusText,
  type AlarmRow, type AlarmStatusTexts, type AlarmDisplayTexts,
} from '@/routes/alarms/alarm-display';
import type { TableRow } from './trend-series';
import type { ChartImage } from './chart-image';
import type { SlotSummary } from './trend-summary';
import { scopeColumnStyles, CONTENT_WIDTH_MM } from '@/routes/alarms/alarms-report';
import {
  DATA_REPORT_TITLE, DATA_REPORT_HEAD, DATA_REPORT_TYPOGRAPHY, DATA_REPORT_LABEL_MM,
  dataReportLegend, dataReportParameterRows, dataReportRows,
  dataReportColumnStyles, emptyDataReportRow, limitText as slotLimitText,
  type DataReportScope, type DataReportFormatters, type DataReportWords, type ReportSlotRow,
  type SlotBounds, type SlotExtremes,
} from './data-report';

/**
 * The PDF renderers behind the trend page's governed downloads — the trend
 * charts (per slot, or both), the Data Report (the time series widget), and
 * the alarms.
 *
 * None of this re-derives limits or decimals wording: everything is
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
  /** Never computed from the averaged points plotted above it. Its readings
   *  count, extremes, mean AND out-of-limit counts all come from the server's
   *  aggregate over EVERY reading in the range (`withServerSummary`), so a
   *  sampled chart can neither understate the number of excursions here nor
   *  print a maximum below a limit it reports breaches of. Only `first`/`last`
   *  describe the rows the report was built from, and those are two labelled
   *  instants the sampler preserves verbatim.
   *  `null` when the slot had no readings in the period. */
  summary: SlotSummary | null;
}

/**
 * How much of the period's record the CHART and the TABLE were built from.
 *
 * This used to describe a truncation. `GET /:id/telemetry` was asked for
 * `limit=500` and answered `ORDER BY ts DESC`, so a long period came back as
 * its most recent tail — measured on this install, a 30-day period held 7,646
 * rows and 500 came back — and the note said so in those words.
 *
 * IT IS NO LONGER A TRUNCATION, and the note must not keep saying it is. The
 * report now fetches down the `points=` path: the server reads every reading in
 * the range and downsamples by SELECTION, so what comes back is a sample spread
 * across the WHOLE period. A banner claiming the report covers "the most recent
 * portion only" would be a false statement about its own coverage in a signed
 * document — strictly worse than the truncation it was written for.
 *
 * What is still true is that the chart and the table hold fewer rows than the
 * period does, so the note discloses that and scopes itself to those two
 * blocks. The period summary is NOT affected: since 2026-08-27 its readings
 * count, minimum, maximum, mean and out-of-limit counts all come from SQL over
 * every reading in the range (`withServerSummary`). Only `First reading` and
 * `Last reading` are taken from the rows the report holds, and those two are
 * labelled claims about two specific instants which the sampler preserves
 * verbatim — so the note scopes itself to the chart and the table.
 */
export interface ReportCoverage {
  /** Stored values the report received — the sample the chart and table hold. */
  returned: number;
  /** Stored values the period actually holds, from the endpoint's `historyTotal`. */
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
  // NOTE ON POPULATIONS. `Readings`, `Minimum`, `Maximum`, `Mean` and the
  // out-of-limit figures are ALL over every reading in the period, computed in
  // SQL — one population throughout (see `withServerSummary`). The exception is
  // the first/last pair, which is read from the rows the report holds: those two
  // are claims about two specific INSTANTS, each printed with its own timestamp,
  // not claims about the range, so a range minimum below both of them is
  // expected rather than a contradiction. Before 2026-08-27 the extremes were
  // row-derived, which let a sampled `Maximum 24.8 °C` print directly above
  // `3 readings above 25.0` — arithmetically impossible on a signed record.
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
    rows.push(['Out of limit', 'Not assessed — no limits are set for this slot']);
  } else {
    const pct = summary.count > 0 ? (summary.outOfSpecCount / summary.count) * 100 : 0;
    // ONE definition of "this side was assessed", used by both the qualifier
    // and the per-side text below. Two conditions that can disagree would print
    // "no low limit set" on one line and a two-sided assessment on the line
    // above it — and they DO diverge if either the count or the bound is null
    // on its own, which is reachable on the fallback path where no server
    // summary is available and `summariseSlot`'s own zero stands.
    const lowAssessed = summary.belowCount !== null && summary.limitMin != null;
    const highAssessed = summary.aboveCount !== null && summary.limitMax != null;
    // Which bounds this figure was assessed against, when only one exists. The
    // total is a real count either way, but "3 of 2,500 readings" under a
    // heading saying "Out of limit" reads as a full two-sided assessment, and
    // half an assessment presented as a whole one overstates what was checked.
    const only = !lowAssessed ? ' — against the high limit only'
      : !highAssessed ? ' — against the low limit only' : '';
    rows.push([
      'Out of limit',
      `${summary.outOfSpecCount.toLocaleString()} of ${summary.count.toLocaleString()} readings (${pct.toFixed(1)}%)${only}`,
    ]);
    // Per SIDE, because a bound can be absent on its own. A missing low limit
    // printed as "0 below —" claims the readings were checked against a low
    // limit and passed; nothing was checked at all. The `?? 0` that used to be
    // here was exactly that defect — which is why the null has to survive all
    // the way into the words rather than being coalesced away one line short.
    const belowText = lowAssessed
      ? `${(summary.belowCount ?? 0).toLocaleString()} below ${num(summary.limitMin, d)}`
      : 'no low limit set — not assessed';
    const aboveText = highAssessed
      ? `${(summary.aboveCount ?? 0).toLocaleString()} above ${num(summary.limitMax, d)}`
      : 'no high limit set — not assessed';
    rows.push(['— below / above limit', `${belowText}  /  ${aboveText}`]);
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
    // NOT "the complete raw record is the Instrument Time Series report". That
    // report calls the SAME sampled fetch this one does (`points=`), so for a
    // wide period it is not the complete record either — and no report from
    // this page prints more than MAX_REPORT_ROWS rows regardless. What is
    // actually true of it is that it is UNAVERAGED.
    subtitle: `${input.instrument.code} — ${input.slotLabel}. Chart and period summary. `
      + `The Instrument Time Series report covers the same readings unaveraged.`,
    reportKey: 'instrument-trend',
    formatDateTime: input.formatDateTime,
  });
  addInstrumentDetails(report, input.instrument, input.period);

  // Coverage first, above everything it qualifies. What the chart and the table
  // are drawn from has to be the first thing read, not a footnote under them.
  if (input.coverage.total > input.coverage.returned) {
    addNote(
      report,
      // "stored values across all keys", not "readings": this count spans every
      // key the instrument sent, while each summary below counts ONE slot. Two
      // numbers in the same units that cannot be reconciled would read as a
      // contradiction rather than as the different measures they are. It is a
      // claim about what this report was BUILT FROM, for the same reason —
      // attributing an all-keys number to a Temperature-only table would be a
      // count of a population that table does not hold.
      //
      // And the remedy it offers is one that exists. It used to end "or use the
      // Instrument Time Series report", which calls the SAME sampled fetch:
      // whenever this note prints because LTTB sampled, that report sampled too,
      // so the sentence was false in essentially every instance it appeared.
      // Narrowing the period is the remedy that actually works, bounded by
      // MAX_REPORT_ROWS, which no report from this page exceeds.
      `REPRESENTATIVE SAMPLE: this report was built from ${input.coverage.returned.toLocaleString()} of the `
      + `${input.coverage.total.toLocaleString()} stored values across all keys that ${input.period.label} holds. `
      + `They are selected ACROSS THE WHOLE PERIOD — this is not a recent portion of it — so the chart and the `
      + `readings table below preserve the shape of the record without printing every stored reading. The period `
      + `summary below is NOT affected: its readings count, minimum, maximum, mean and out-of-limit counts are all `
      + `computed over EVERY reading in the period, not over this sample. Only its first and last readings are read `
      + `from this sample, and the sample keeps the period's first and last stored readings exactly. To print every `
      + `stored reading, NARROW THE PERIOD — no report from this page prints more than `
      + `${MAX_REPORT_ROWS.toLocaleString()} rows, and the Instrument Time Series report is built from the same `
      + `sample as this one.`,
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
      + `For the same period UNAVERAGED, use the Instrument Time Series report — it prints stored readings rather `
      + `than bucket means. It is built from the same sample as this report, and states its own coverage.`,
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

/**
 * The Time Series widget's download: the DATA REPORT, built to the operator's
 * `Data Report.pdf` (2026-09-04). The layout is `data-report.ts`; this function
 * only lays it onto the shared chrome, exactly as `buildAlarmsReport` does for
 * the alarm report.
 *
 * `rows` arrive already bucketed (`firstPerInterval`) and oldest-first — one
 * stored reading per interval when the page has an interval selected, every
 * reading at Raw. `temp`/`rh` carry the bounds the server resolved AND the
 * period extremes from the server's whole-range summary, never the extremes of
 * `rows`: with an interval selected the table holds one reading per bucket, and
 * a maximum taken over those could sit below an excursion between two of them.
 *
 * `coverage` is what the rows were drawn from. On the interval path the page
 * fetches EVERY reading in the period before bucketing, so `returned === total`
 * and no disclosure prints. At Raw the rows come from the sampled chart path,
 * and a period wider than the sample says so in the report — a signed record
 * silently holding a subset is the defect class this codebase has fixed twice.
 */
export interface DataReportInput {
  scope: DataReportScope;
  period: ReportPeriod;
  fmt: DataReportFormatters;
  formatDateTime: (d: string) => string;
  temp: { key: string | null } & SlotBounds & SlotExtremes;
  rh: { key: string | null } & SlotBounds & SlotExtremes;
  /** From `scheduleRows()` — newest first, one per slot, `row: null` = NA. */
  rows: ReportSlotRow[];
  intervalMs: number | null;
  coverage: ReportCoverage;
  /** The administered fault words, from `useSensorWords()`. */
  words: DataReportWords;
}

/** One instrument's section, prepared: its capped rows and printed cells. */
interface PreparedDataSection {
  input: DataReportInput;
  shown: ReportSlotRow[];
  capped: boolean;
  total: number;
  body: ReturnType<typeof dataReportRows>;
  limitTexts: string[];
}

function prepareDataSection(input: DataReportInput): PreparedDataSection {
  const { shown, capped, total } = capRows(input.rows);
  return {
    input, shown, capped, total,
    limitTexts: [slotLimitText(input.temp), slotLimitText(input.rh)],
    body: dataReportRows(
      shown,
      { temp: input.temp.key, rh: input.rh.key },
      { temp: input.temp, rh: input.rh },
      input.fmt,
      input.words,
    ),
  };
}

/** The chrome every Data Report — single or multi-instrument — is created with. */
function dataReportChrome(formatDateTime: (d: string) => string, legend: { abbr: string; meaning: string }[]) {
  return {
    title: DATA_REPORT_TITLE,
    orientation: 'portrait' as const,
    reportKey: 'instrument-trend',
    formatDateTime,
    legend,
    typography: DATA_REPORT_TYPOGRAPHY,
    showAppName: false,
  };
}

export async function renderDataReport(input: DataReportInput): Promise<ReportDoc> {
  const section = prepareDataSection(input);
  const report = await createReport(dataReportChrome(
    input.formatDateTime,
    dataReportLegend(section.limitTexts, section.body.printedNoData),
  ));
  addDataReportSection(report, section);
  return report;
}

/**
 * The Data Report for SEVERAL instruments — the Data Report page's Generate
 * Data Report card (an Area's instruments, or a hand-picked set). Each
 * instrument is on its own page with the SAME parameter block and table as its
 * single-instrument Data Report — `renderDataReport` for each, in one file —
 * so a page torn out of this document reads exactly like the report that
 * instrument would have produced alone. NO cover block: the 2026-09-05 version
 * opened with one naming the Block, Area, period and instrument count, and the
 * operator asked on 2026-09-07 for "the same report of time series widget",
 * which has none. The legend is the union of every page's — an abbreviation is
 * keyed if any page printed it.
 */
export interface DataReportsInput {
  formatDateTime: (d: string) => string;
  /** One per instrument, in the order they print. */
  instruments: DataReportInput[];
}

export async function renderDataReports(input: DataReportsInput): Promise<ReportDoc> {
  const sections = input.instruments.map(prepareDataSection);
  const legend = dataReportLegend(
    sections.flatMap((s) => s.limitTexts),
    sections.some((s) => s.body.printedNoData),
  );
  const report = await createReport(dataReportChrome(input.formatDateTime, legend));
  if (sections.length === 0) {
    addNote(report, 'No instruments were selected for this report.', report.colors.muted);
  }
  sections.forEach((section, i) => {
    if (i > 0) report.newPage();
    addDataReportSection(report, section);
  });
  return report;
}

/**
 * One instrument's Data Report body, drawn into an existing document: the
 * parameter block, the coverage disclosure if any, the row-cap notice if any,
 * and the readings table.
 */
function addDataReportSection(report: ReportDoc, section: PreparedDataSection): void {
  const { input, shown, capped, total, body } = section;
  // The parameter block: headless, two fields per row, ruled like the alarm
  // report's — the same column helper, so the two documents' centre lines land
  // in the same place; only the label column is wider, for the larger type.
  report.addTable({
    body: dataReportParameterRows({
      scope: input.scope, period: input.period, temp: input.temp, rh: input.rh,
      intervalMs: input.intervalMs, fmt: input.fmt,
    }),
    columnStyles: scopeColumnStyles(CONTENT_WIDTH_MM, DATA_REPORT_LABEL_MM),
  });
  if (input.coverage.total > input.coverage.returned) {
    addNote(
      report,
      `REPRESENTATIVE SAMPLE: this report was built from ${input.coverage.returned.toLocaleString()} of the `
      + `${input.coverage.total.toLocaleString()} stored values across all keys that ${input.period.label} holds, selected `
      + `ACROSS THE WHOLE PERIOD rather than taken from its most recent portion. Every row below is a stored, `
      + `unaveraged reading, but these are NOT every stored reading in the period. Temp. Max / Min and RH Max / Min `
      + `above are computed over EVERY reading in the period, not over this sample. To print every stored reading, `
      + `narrow the period or select an interval — no report from this page prints more than `
      + `${MAX_REPORT_ROWS.toLocaleString()} rows.`,
      report.colors.red,
    );
  }
  addCapNotice(report, capped, shown.length, total, input.period);
  report.addTable({
    head: DATA_REPORT_HEAD,
    columnStyles: dataReportColumnStyles(),
    // A report of an empty period must SAY it is empty — a header with no rows
    // reads as a rendering failure on paper.
    body: shown.length ? body.cells : [emptyDataReportRow()],
    bold: shown.length ? body.bold : undefined,
  });
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
 *
 * `inactivityTexts` carries every OTHER administered wording for the same
 * reason, one column over: the inactivity alarm's three value cells and the
 * RS485 failure word. A report printed without it says "—" and "Error" where the
 * screen says whatever the operator configured — and a §11 record that describes
 * an alarm differently from the screen it was generated from is a record that
 * does not match the system it documents.
 */
export async function renderAlarmsReport(
  rows: AlarmRow[],
  instrument: ReportInstrument,
  period: ReportPeriod,
  formatDateTime: (d: string) => string,
  statusTexts?: AlarmStatusTexts,
  inactivityTexts?: AlarmDisplayTexts,
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
    head: ['Type', 'Raised', 'Value', 'Limit', 'Cleared', 'Status'],
    body: shown.map((a) => [
      alarmTypeText(a, inactivityTexts),
      formatDateTime(a.raisedAt),
      triggeredText(a, inactivityTexts),
      limitText(a, inactivityTexts),
      a.clearedAt ? `${formatDateTime(a.clearedAt)} (${clearedText(a, inactivityTexts)})` : '—',
      statusText(a, statusTexts),
    ]),
  });
  return report;
}
