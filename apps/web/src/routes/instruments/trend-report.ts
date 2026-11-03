import type { AlarmRow, AlarmStatusTexts, AlarmDisplayTexts } from '@/routes/alarms/alarm-display';
import type { ChartImage } from './chart-image';
import type {
  DataReportScope, DataReportFormatters, DataReportWords, ReportSlotRow, SlotBounds, SlotExtremes,
} from './data-report';

/**
 * What the trend page and the Data Report page hand their three governed
 * reports — the Instrument Trend (the charts), the Data Report (the time
 * series widget, and the Data Report page's one-page-per-instrument document)
 * and the Instrument Alarms.
 *
 * Since 2026-11-03 (page reports on templates) those reports are DRAWN by
 * `page-reports.ts` over the ONE templated builder (`lib/templated-report.ts`),
 * from the template the server resolves for each instrument's profile — the
 * kind's built-in reproducing what these pages printed before, exactly (pinned
 * against frozen output in `__tests__/page-reports-builtin.test.ts`). The
 * hand-built renderers that stood here (`renderTrendReport`,
 * `renderDataReport(s)`, `renderAlarmsReport`) were deleted with that change;
 * these are the inputs the pages still build.
 *
 * None of this re-derives limits or decimals wording: everything is passed in
 * already resolved, the same values the screen shows. That extends to the
 * picture itself — the chart arrives as a PNG rasterised from the real
 * `TimeSeriesChart`, not redrawn from the same numbers. See `chart-image.ts`.
 */

export interface ReportPeriod {
  from: string;
  to: string;
  label: string;
}

/** One slot's picture. `image` is `null` when the slot had no readings to draw
 *  or the rasteriser could not produce a PNG — the report then says which,
 *  rather than leaving a gap that reads as "no data". */
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
 * No report prints a coverage note any more (operator, 2026-10-06: "remove
 * this text in trend reports", then "remove that note in data report also").
 * `coverage` still rides on the inputs, so the fact is in hand if a note is
 * ever asked for again.
 */
export interface ReportCoverage {
  /** Stored values the report received — the sample the chart and table hold. */
  returned: number;
  /** Stored values the period actually holds, from the endpoint's `historyTotal`. */
  total: number;
}

/**
 * The INSTRUMENT TREND: the ruled header block and the CHART the operator
 * saw, with its in-spec band. Until 2026-10-05 it also carried a per-slot
 * period summary and the readings table under the chart; the operator removed
 * both. The stored readings, value by value, are the Instrument Time Series
 * report's job, and this report says so in its subtitle.
 */
export interface TrendReportInput {
  /** 'Temperature', 'Humidity', or 'Temperature & Humidity' — names the SLOT this
   *  report covers (`{series}`), and is what distinguishes the reports in the audit trail. */
  slotLabel: string;
  charts: TrendChartSection[];
  // `rows` / `keys` (the readings table under the chart) and `tableIsAveraged`
  // left on 2026-10-05 (operator: "remove the readings table from trend") —
  // the stored readings are the Instrument Time Series report's job. The
  // `instrument` block (code / name / location / limits) left on 2026-11-03:
  // its only reader was the pre-2026-10-05 key-value header, and the code the
  // subtitle named is the header scope's `instrumentLabel`.
  period: ReportPeriod;
  formatDateTime: (d: string) => string;
  /**
   * The header block (operator, 2026-10-05: "make trend report header into
   * table properly as like alarm report header table"): Block / Area /
   * Location / Inst ID against Start Date / Time and End Date / Time, ruled
   * exactly as the alarm report's.
   */
  header: { scope: DataReportScope; fmt: DataReportFormatters };
  /**
   * The bucket the CHARTS were averaged over, or `null` at raw.
   *
   * Not cosmetic. A plotted point in an averaged chart is a derived number. The
   * screen discloses it (`ChartIntervalNote`); a printed §11 record that drops
   * the disclosure on the way to paper is worse, because the paper outlives the
   * screen.
   */
  averagedLabel: string | null;
  coverage: ReportCoverage;
}

/**
 * The DATA REPORT of one instrument, built to the operator's `Data Report.pdf`
 * (2026-09-04). The layout's pure parts are `data-report.ts`.
 *
 * `rows` arrive already scheduled (`scheduleRows`) and newest first — one
 * stored reading per interval slot when an interval is selected, every reading
 * at Raw. `temp`/`rh` carry the bounds the server resolved AND the period
 * extremes from the server's whole-range summary, never the extremes of
 * `rows`: with an interval selected the table holds one reading per slot, and a
 * maximum taken over those could sit below an excursion between two of them.
 *
 * `coverage` is what the rows were drawn from. The pages fetch EVERY reading in
 * the period before scheduling, so `returned === total`.
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

/**
 * The trend page's Instrument Alarms report — ONE instrument's alarms in the
 * period, worded exactly as the Alarms page and the trend widget word them
 * (`alarm-display.ts`).
 *
 * `statusTexts` must be the SAME configured wording the on-screen widget is
 * showing (`mapStatusTextsResponse()` over `/api/config/alarm-limits/
 * status-texts`), and `inactivityTexts` every OTHER administered wording (the
 * inactivity alarm's three value cells, the RS485 failure word, the type
 * names): a printed §11 record that describes an alarm differently from the
 * screen it was generated from is a record that does not match the system it
 * documents. `undefined` is only correct while that config is still loading;
 * the helpers then fall back to the shipped defaults.
 */
export interface InstrumentAlarmsReportInput {
  rows: AlarmRow[];
  period: ReportPeriod;
  formatDateTime: (d: string) => string;
  statusTexts?: AlarmStatusTexts;
  inactivityTexts?: AlarmDisplayTexts;
  /** The header block (operator, 2026-10-05): Block / Area / Location / Inst ID against Start / End Date and Time. */
  header: { scope: DataReportScope; fmt: DataReportFormatters };
}
