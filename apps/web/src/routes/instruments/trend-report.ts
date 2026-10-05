import { boundInForce } from '@/routes/dashboard/set-point';
import { createReport, type ReportDoc, type NoteColor } from '@/lib/pdf-report';
import {
  alarmTypeText, triggeredText, limitText, clearedText, statusText,
  type AlarmRow, type AlarmStatusTexts, type AlarmDisplayTexts,
} from '@/routes/alarms/alarm-display';
import type { ChartImage } from './chart-image';
import {
  scopeColumnStyles, scopeTableRows, instrumentAlarmsHeaderPairs, CONTENT_WIDTH_MM,
  type AlarmReportScope, type AlarmReportFormatters,
} from '@/routes/alarms/alarms-report';
import {
  DATA_REPORT_TITLE, DATA_REPORT_HEAD, DATA_REPORT_TYPOGRAPHY, DATA_REPORT_LABEL_MM,
  dataReportLegend, dataReportParameterRows, dataReportRows,
  dataReportColumnStyles, emptyDataReportRow, limitText as slotLimitText, printsMkt,
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
  // The per-slot PERIOD SUMMARY table that sat under each chart until
  // 2026-10-05 (readings count, extremes, mean, first / last, out-of-limit
  // counts) was removed at the operator's "in trend repots remove period
  // summary table". The whole-range figures it printed are still computed by
  // the server (`getRangeSummary`) and still print on the Data Report.
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
  // `rows` / `keys` (the readings table under the chart) and `tableIsAveraged`
  // left on 2026-10-05 (operator: "remove the readings table from trend") —
  // the stored readings are the Instrument Time Series report's job.
  instrument: ReportInstrument;
  period: ReportPeriod;
  formatDateTime: (d: string) => string;
  /**
   * The header block (operator, 2026-10-05: "make trend report header into
   * table properly as like alarm report header table"): Block / Area /
   * Location / Inst ID against Start Date / Time and End Date / Time, ruled
   * exactly as the alarm report's. It replaced the Instrument / Name /
   * Location / Limits in force / Period key-value block.
   */
  header: { scope: AlarmReportScope; fmt: AlarmReportFormatters };
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
  coverage: ReportCoverage;
}

/** Page margin and usable width, matching `pdf-report.ts`'s own 14mm gutters. */
const MARGIN = 14;

/**
 * A wrapped paragraph of body text — `ReportDoc.addNote`, which RECORDS the
 * note into the snapshot (2026-09-07) so a reviewed draft and the approved copy
 * carry the same disclosures. Kept as a local shim so the call sites read as
 * before.
 */
function addNote(report: ReportDoc, text: string, color: NoteColor): void {
  report.addNote(text, color);
}

/**
 * Draw one chart PNG across the text column, or state why there isn't one.
 * Through `report.addImage` (2026-09-07) so the raster is in the snapshot too.
 */
function addChart(report: ReportDoc, section: TrendChartSection): void {
  report.addSectionTitle(section.title);
  if (!section.image) {
    addNote(report, section.unavailableReason, 'muted');
    return;
  }
  const w = report.pw - MARGIN * 2;
  const h = (section.image.height / section.image.width) * w;
  report.addImage(section.image.dataUrl, w, h);
}

/**
 * The trend widget as a report: the ruled header block and the CHART the
 * operator saw, with its in-spec band.
 *
 * Until 2026-10-05 it also carried a per-slot period summary and the readings
 * table under the chart; the operator removed both ("in trend repots remove
 * period summary table", then "remove the readings table from trend"). The
 * stored readings, value by value, are the Instrument Time Series report's
 * job, and this report says so in its subtitle and notes.
 *
 * Company name, logo, Printed By + User ID, printed date/time and the signature
 * block all come from `createReport()`; none of it is rebuilt here.
 */
export async function renderTrendReport(input: TrendReportInput): Promise<ReportDoc> {
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
    subtitle: `${input.instrument.code} — ${input.slotLabel}. The chart as seen on screen. `
      + `The Instrument Time Series report covers the same readings unaveraged.`,
    reportKey: 'instrument-trend',
    formatDateTime: input.formatDateTime,
  });
  report.addTable({
    body: scopeTableRows(instrumentAlarmsHeaderPairs(input.header.scope, { from: input.period.from, to: input.period.to }, input.header.fmt)),
    columnStyles: scopeColumnStyles(),
  });

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
      + `They are selected ACROSS THE WHOLE PERIOD — this is not a recent portion of it — so the chart below preserves `
      + `the shape of the record without plotting every stored reading. For the readings themselves, NARROW THE PERIOD `
      + `and use the Instrument Time Series report — no report from this page prints more than `
      + `${MAX_REPORT_ROWS.toLocaleString()} rows, and the Instrument Time Series report is built from the same `
      + `sample as this one.`,
      'red',
    );
  }

  // The same disclosure `ChartIntervalNote` makes on screen, in the same words
  // (`intervalLabel` is the one source for the bucket's name). A printed record
  // that drops it shows derived numbers as if they were readings — and paper
  // outlives the screen that explained itself.
  if (input.averagedLabel) {
    addNote(
      report,
      `Note: the chart is AVERAGED over ${input.averagedLabel}. Each point is `
      + `the mean of the readings in its bucket, not a stored reading. `
      + `For the same period UNAVERAGED, use the Instrument Time Series report — it prints stored readings rather `
      + `than bucket means. It is built from the same sample as this report, and states its own coverage.`,
      'red',
    );
  }

  for (const section of input.charts) addChart(report, section);
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

/**
 * The single-instrument Data Report IS the multi-instrument one with one
 * instrument (review, 2026-09-07: the two were hand-maintained copies that
 * happened to be byte-equivalent). One code path, so they cannot drift.
 */
export async function renderDataReport(input: DataReportInput): Promise<ReportDoc> {
  return renderDataReports({ formatDateTime: input.formatDateTime, instruments: [input] });
}

/**
 * The sentence in the sample disclosure that names the Max / Min cells — ONLY
 * the ones that print. The extremes row omits a slot's cells when no bound is
 * in force (`extremesRow`), and a signed note about cells that are not there is
 * the stale-disclosure defect this file already fixed once (2026-08-27).
 */
export function extremesSentence(input: Pick<DataReportInput, 'temp' | 'rh'>): string {
  const cells: string[] = [];
  for (const [name, s] of [['Temp.', input.temp], ['RH', input.rh]] as const) {
    const parts = [boundInForce(s.max) ? 'Max' : null, boundInForce(s.min) ? 'Min' : null].filter((p): p is string => p !== null);
    if (parts.length) cells.push(`${name} ${parts.join(' / ')}`);
  }
  if (cells.length === 0) return '';
  return `${cells.join(' and ')} above ${cells.length === 1 && !cells[0].includes('/') ? 'is' : 'are'} computed over EVERY reading in the period, not over this sample. `;
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
    // MKT is keyed iff some page printed it — the server's number decides.
    sections.some((s) => printsMkt(s.input.temp)),
  );
  const report = await createReport(dataReportChrome(input.formatDateTime, legend));
  if (sections.length === 0) {
    addNote(report, 'No instruments were selected for this report.', 'muted');
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
      + `unaveraged reading, but these are NOT every stored reading in the period. ${extremesSentence(input)}`
      + `To print every stored reading, narrow the period or select an interval — no report from this page prints `
      + `more than ${MAX_REPORT_ROWS.toLocaleString()} rows.`,
      'red',
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
  /**
   * The header block (operator, 2026-10-05): Block / Area / Location / Inst ID
   * against Start Date / Start Time / End Date / End Time, the Data Report's
   * eight fields, ruled the same way. Optional only so an older caller still
   * renders; the trend page always passes it.
   */
  header?: { scope: AlarmReportScope; fmt: AlarmReportFormatters },
): Promise<ReportDoc> {
  const { shown, capped, total } = capRows(rows);
  const report = await createReport({
    title: 'Instrument Alarms',
    subtitle: instrument.code,
    reportKey: 'instrument-trend',
    formatDateTime,
  });
  if (header) {
    report.addTable({
      body: scopeTableRows(instrumentAlarmsHeaderPairs(header.scope, { from: period.from, to: period.to }, header.fmt)),
      columnStyles: scopeColumnStyles(),
    });
  } else {
    addInstrumentDetails(report, instrument, period);
  }
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
