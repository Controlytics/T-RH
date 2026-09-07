import { formatDecimals, INTERVALS, isOutOfRange } from '@digilog/shared';
import { formatSetPoint, outOfSpec } from '@/routes/dashboard/set-point';
import type { TableRow } from './trend-series';

/**
 * The DATA REPORT — the Time Series widget's download, built to the operator's
 * supplied reference (`Data Report.pdf` at the repo root, 2026-09-04) rather
 * than invented. Same approach as `routes/alarms/alarms-report.ts`, which was
 * built to `Alarm Report.pdf` on 2026-09-01: the reference's shape, transcribed
 * from its own text, as PURE functions the renderer lays out and the tests pin.
 *
 * That document's shape: the site header and the title "Temperature and RH
 * Data Report"; a two-column parameter block — Block / Area / Location / Inst ID
 * against Start Date / Start Time / End Date / End Time, then `Temp. Limit :
 * NMT 27` against `RH Limit : NMT 70`, then `Temp. Max : 22.9 , Temp. Min :
 * 21.2` against `RH Max : 63.0 , RH Min : 58.0`, then `Interval : 1 hour` on the
 * right alone; a four-column table — DATE, TIME, TEMPERATURE (°C), RELATIVE
 * HUMIDITY(%) — one row per interval; a legend (`Temp - Temperature, RH -
 * Relative Humidity`, `NMT - Not More Than`); and the end block: Printed By,
 * Printed Date & Time, Remarks.
 *
 * **The end block, the logo and the site name come from `createReport()`**, the
 * chrome every report in the product shares, and `pdf-report.ts` is untouched.
 * The parameter block reuses the alarm report's two-column table helpers
 * (`scopeTableRows`' shape, `scopeColumnStyles`) so the two reports rule
 * identically.
 *
 * **What is deliberately NOT copied from the reference.**
 * - Its dates read `27-05-2026` and its times `16:36` because that is what its
 *   own system emits. This app's dates are ADMINISTERED (`useDatetimeFormat`),
 *   so the formatters are injected — the same call the alarm report made.
 * - Its limits read `NMT 27`. Here a bound prints at the instrument's own
 *   administered precision through `formatSetPoint` — `NMT 27.0` on an
 *   instrument with one decimal — because that is how the dashboard, the trend
 *   cards and the alarm report all print the same bound, and a report that
 *   rounded it differently would be one document disagreeing with every screen.
 * - Its Max/Min are presumably the extremes of its own rows. Here they are the
 *   SERVER's extremes over EVERY reading in the period (`summaries`), never of
 *   the printed rows: with an interval selected the table holds one reading per
 *   bucket, and a maximum taken over those could sit below an excursion that
 *   fell between two of them — a §11 understatement with no tell. This is the
 *   rule the trend report already follows (`withServerSummary`).
 *
 * **Interval rows are FIRST STORED READINGS, never averages** (operator,
 * 2026-09-04, choosing the recommended option). Each row is a real reading at
 * its real timestamp, which is the rule this codebase keeps for a printed §11
 * record; the reference's hourly rows read the same way.
 *
 * **The schedule is anchored on the FIRST READING, and every slot prints
 * (operator, 2026-09-05).** *"at which time it started that was first data
 * point and from next on as per interval it should come … and if there is no
 * data at that interval show NA"*, and *"latest time values comes first"*. So:
 * the first row's time is the earliest reading in the period; each later slot
 * is one interval on from it, up to the period's end; a slot with no reading
 * prints `NA` at the slot's own time rather than vanishing — a gap in a log is
 * information, and a log that closes its gaps hides an outage. The table is
 * printed NEWEST FIRST. This replaces the 2026-09-04 rule (buckets aligned to
 * the period start, only buckets with a reading printed, oldest first).
 *
 * **A reading that crossed a limit prints BOLD, and so do the two fault words**
 * (`Error` for a non-numeric reading, `OL` for one outside the probe's span —
 * the administered words, the same ones the on-screen table shows). The words
 * are supplied by the caller from the one shared hook; nothing here defaults
 * them to a literal.
 */

export const DATA_REPORT_TITLE = 'Temperature and RH Data Report';

/**
 * This report's type scale — larger and heavier than the shared chrome's
 * default, with its column headings centred (operator, 2026-09-05: *"in data
 * report make headings to center and in header, and increase font sizes and
 * thickness"*). The reference prints its site line, title, labels and column
 * headings bold and visibly larger than its readings, which stay regular — so
 * the weight goes on the headings alone and the body only grows.
 *
 * Four columns on a portrait page leave room the alarm report's ten do not,
 * which is why this report can sit above the shared `tablePt` ceiling. Only
 * the keys named here move; everything else keeps `DEFAULT_TYPOGRAPHY`.
 */
export const DATA_REPORT_TYPOGRAPHY = {
  companyPt: 18,
  appNamePt: 11,
  titlePt: 15,
  labelPt: 10,
  tablePt: 10,
  tableHeadPt: 10.5,
  smallprintPt: 9,
  headingWeight: 'bold',
  tableHeadAlign: 'center',
} as const;

/**
 * The parameter block's LABEL column, wider than the alarm report's 26mm:
 * `Temp. Limit :` in 10pt bold needs ~28mm with its padding, and a label that
 * wraps onto two lines makes one field read as two.
 */
export const DATA_REPORT_LABEL_MM = 32;

/** The reference's four columns, verbatim, in order. */
export const DATA_REPORT_HEAD = ['DATE', 'TIME', 'TEMPERATURE (°C)', 'RELATIVE HUMIDITY(%)'];

/** What a value cell prints when the slot holds no reading (operator,
 *  2026-09-05: *"if there is no data at that interval show NA"*) — the same word
 *  the dashboard uses for a slot with nothing in it. */
export const DATA_REPORT_NO_DATA = 'NA';

/** The reference's own abbreviation key, verbatim. */
export const DATA_REPORT_LEGEND_BASE = [
  { abbr: 'Temp', meaning: 'Temperature' },
  { abbr: 'RH', meaning: 'Relative Humidity' },
];

/**
 * The legend, with NMT / NLT added only when a printed limit actually uses the
 * word. The reference lists NMT alone because only NMT bounds were in force on
 * its instrument; an NLT it never printed would be a key to nothing. `NA` is
 * keyed the same way — only when a cell printed it.
 */
export function dataReportLegend(
  limitTexts: readonly string[],
  printedNoData = false,
): { abbr: string; meaning: string }[] {
  const out = [...DATA_REPORT_LEGEND_BASE];
  if (limitTexts.some((t) => /\bNMT\b/.test(t))) out.push({ abbr: 'NMT', meaning: 'Not More Than' });
  if (limitTexts.some((t) => /\bNLT\b/.test(t))) out.push({ abbr: 'NLT', meaning: 'Not Less Than' });
  if (printedNoData) out.push({ abbr: DATA_REPORT_NO_DATA, meaning: 'No data' });
  return out;
}

export interface DataReportScope {
  blockName: string;
  areaName: string;
  /** The instrument's own `Location` attribute. */
  locationName: string;
  instrumentLabel: string;
}

export interface DataReportPeriod {
  /** ISO instants — the DIALOG's period, which is what the operator confirmed. */
  from: string;
  to: string;
}

export interface DataReportFormatters {
  formatDate: (iso: string) => string;
  formatTime: (iso: string) => string;
}

/** One slot's administered bounds and precision, as the server resolved them. */
export interface SlotBounds {
  min: number | null | undefined;
  max: number | null | undefined;
  decimals: number;
  /** The probe's declared SPAN — not the spec limit above it. A reading outside
   *  it is not a measurement and prints the out-of-range word. Undeclared =
   *  unbounded, the same rule the on-screen table and the range alarm use. */
  rangeLow?: number | null;
  rangeHigh?: number | null;
}

/** The two administered words that stand in for a reading that cannot be
 *  trusted — from `useSensorWords()`, never literals. */
export interface DataReportWords {
  /** RS485 / non-numeric reading (shipped default `Error`). */
  failure: string;
  /** Outside the probe's span (shipped default `OL`). */
  outOfRange: string;
}

/** One slot's period extremes, over EVERY reading in the period. `null` when the
 *  slot had no numeric reading in the period — the cell then prints a dash.
 *  Named apart from the BOUNDS' `min`/`max` on purpose: a limit and an extreme
 *  are different facts, and one object carries both. */
export interface SlotExtremes {
  periodMax: number | null;
  periodMin: number | null;
}

/** A dash, never an empty cell: on paper a blank reads as a rendering fault. */
const orDash = (v: string) => (v.trim() ? v.trim() : '-');

/** `NMT 27.0`, `NLT 18.0`, `18.0 - 27.0`, or the set-point module's own word for
 *  "no bound" — ONE definition of how a bound is written, shared with the screens. */
export function limitText(b: SlotBounds): string {
  return formatSetPoint(b.min, b.max, b.decimals);
}

/** A reading at the slot's own resolved precision, or a dash. */
function num(v: number | null | undefined, decimals: number): string {
  return v == null ? '-' : (formatDecimals(v, decimals) ?? '-');
}

/** A bound that is IN FORCE — the same test `formatSetPoint` applies. */
const inForce = (b: number | null | undefined): b is number => typeof b === 'number' && Number.isFinite(b);

/**
 * The Max / Min cell pair for one slot: label cell, then the value cell in the
 * reference's own sentence shape (`22.9 , Temp. Min : 21.2`).
 *
 * An extreme prints ONLY for a bound that is in force (operator, 2026-09-07:
 * *"if Enable_Humid_NLT is disabled then dont show RH min in report, if nmt is
 * disabled then dont show max in report same like that in all data reports"*).
 * The server already withholds a disabled bound — `limits.rhMin` is null when
 * `Enable_Humid_NLT` is off — and this row follows the bound: a minimum nobody
 * judges against is not reported. A bound never administered reads the same as
 * one switched off, because the bound's PRESENCE is the one fact this module
 * sees; `limitEnabled` says why and must never gate display. With no bound in
 * force on the slot the pair is blank, like the reference's own last row —
 * not a dash, which would claim a field that does not exist. A DELIBERATE
 * departure from `Data Report.pdf`, which prints both extremes against
 * NMT-only limits.
 */
function extremesCells(name: 'Temp.' | 'RH', s: SlotBounds & SlotExtremes): [string, string] {
  const parts: [string, string][] = [];
  if (inForce(s.max)) parts.push([`${name} Max :`, num(s.periodMax, s.decimals)]);
  if (inForce(s.min)) parts.push([`${name} Min :`, num(s.periodMin, s.decimals)]);
  if (parts.length === 0) return ['', ''];
  const [first, ...rest] = parts;
  return [first[0], [first[1], ...rest.map(([label, value]) => `${label} ${value}`)].join(' , ')];
}

/** `Raw (every reading)` or the interval's own label — the SAME words the page's
 *  interval selector shows, from the one shared list. */
export function dataReportIntervalText(intervalMs: number | null): string {
  const spec = INTERVALS.find((i) => (i.seconds === null ? intervalMs === null : i.seconds * 1000 === intervalMs));
  return spec?.label ?? `${(intervalMs ?? 0) / 1000}s`;
}

/**
 * The parameter block as TABLE ROWS in the reference's own order and pairing —
 * label and value on one line, two fields per row, scope on the left and the
 * period on the right, exactly as `scopeTableRows` lays the alarm report's out.
 *
 * The Max/Min row keeps the reference's own sentence shape, `Temp. Max : 22.9 ,
 * Temp. Min : 21.2`, in one value cell: the reference prints both extremes on
 * one line, and splitting them into two rows would make this block a row
 * taller than the document it was asked to match — but each extreme prints
 * only for a bound in force (`extremesCells`). The last row is blank on the
 * left with `Interval` alone on the right, as the reference has it.
 */
export function dataReportParameterRows(input: {
  scope: DataReportScope;
  period: DataReportPeriod;
  temp: SlotBounds & SlotExtremes;
  rh: SlotBounds & SlotExtremes;
  intervalMs: number | null;
  fmt: DataReportFormatters;
}): string[][] {
  const { scope, period, temp, rh, fmt } = input;
  return [
    ['Block :', orDash(scope.blockName), 'Start Date :', fmt.formatDate(period.from)],
    ['Area :', orDash(scope.areaName), 'Start Time :', fmt.formatTime(period.from)],
    ['Location :', orDash(scope.locationName), 'End Date :', fmt.formatDate(period.to)],
    ['Inst ID :', orDash(scope.instrumentLabel), 'End Time :', fmt.formatTime(period.to)],
    ['Temp. Limit :', limitText(temp), 'RH Limit :', limitText(rh)],
    [...extremesCells('Temp.', temp), ...extremesCells('RH', rh)],
    ['', '', 'Interval :', dataReportIntervalText(input.intervalMs)],
  ];
}

/**
 * One printed row: the slot's own time, and the stored reading that fills it —
 * or `null` when nothing was received in that interval, which prints `NA`.
 */
export interface ReportSlotRow<T extends { ts: string } = TableRow> {
  /** The reading's own timestamp when there is one; the SLOT's scheduled
   *  instant when there is not. */
  ts: string;
  row: T | null;
}

/**
 * The rows the report prints, NEWEST FIRST.
 *
 * Raw (`intervalMs` null): every stored row.
 *
 * With an interval: a schedule of slots one interval apart, ANCHORED ON THE
 * FIRST READING in the period and running to the period's end (inclusive —
 * the reference's 16:36-to-16:36 day prints both ends). Each slot holds the
 * FIRST stored reading inside it, or nothing. Every slot is returned, so a
 * silent hour prints as a row of `NA` at the time the reading was due rather
 * than disappearing; the operator's words, 2026-09-05, in the module comment.
 *
 * Operates on PIVOTED rows (one per timestamp, every key's value on it) rather
 * than on long rows per key: scheduling each key separately could put a
 * temperature from 16:36:00 and a humidity from 16:36:30 on one printed line
 * under a single time, which would be a row that never existed.
 *
 * Returned rows are the input objects themselves — a printed reading is a
 * stored reading, never a rebuilt one.
 */
export function scheduleRows<T extends { ts: string }>(
  rows: readonly T[],
  intervalMs: number | null,
  periodToIso: string,
): ReportSlotRow<T>[] {
  const asc = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));
  if (intervalMs === null || intervalMs <= 0) {
    return asc.reverse().map((r) => ({ ts: r.ts, row: r }));
  }
  if (asc.length === 0) return [];
  const anchor = new Date(asc[0].ts).getTime();
  const end = new Date(periodToIso).getTime();
  // The first reading of each slot, by slot index from the anchor.
  const firstInSlot = new Map<number, T>();
  for (const r of asc) {
    const slot = Math.floor((new Date(r.ts).getTime() - anchor) / intervalMs);
    if (!firstInSlot.has(slot)) firstInSlot.set(slot, r);
  }
  // Every slot from the anchor to the period's end, then the slots any
  // reading fell into beyond it (a reading past `periodToIso`, which the
  // server's range filter should never return, is kept rather than dropped —
  // a clock disagreement must not remove readings from a signed record).
  const lastScheduled = Math.max(0, Math.floor((end - anchor) / intervalMs));
  const lastSlot = Math.max(lastScheduled, ...firstInSlot.keys());
  const out: ReportSlotRow<T>[] = [];
  for (let k = lastSlot; k >= 0; k--) {
    const r = firstInSlot.get(k);
    out.push(r ? { ts: r.ts, row: r } : { ts: new Date(anchor + k * intervalMs).toISOString(), row: null });
  }
  return out;
}

/** The printed table: its cells, and which of them print BOLD. */
export interface DataReportBody {
  cells: string[][];
  /** `bold[row][col]` — true for a reading outside its limit and for either
   *  fault word. Same shape as `cells` so the renderer can index it blindly. */
  bold: boolean[][];
  /** Whether any cell printed `NA`, so the legend can key it. */
  printedNoData: boolean;
}

/**
 * One value cell, and whether it prints bold.
 *
 * Precedence, the same as the on-screen table's `ValueCell`: a reading outside
 * the probe's span prints the out-of-range word (it IS a number, it is not a
 * measurement); a non-numeric reading prints the failure word; no reading at
 * all prints `NA`; otherwise the number at the slot's precision. The two words
 * and a number that crossed its limit are bold (operator, 2026-09-05: *"which
 * ever value is crossed the limit that value should show bold … Error and OL
 * also show bold"*). `NA` is not — it is an absence, not a finding.
 */
export function dataReportCell(
  row: TableRow | null,
  key: string | null,
  bounds: SlotBounds,
  words: DataReportWords,
): { text: string; bold: boolean } {
  if (!row || !key) return { text: DATA_REPORT_NO_DATA, bold: false };
  const v = row.values[key];
  if (typeof v === 'number' && isOutOfRange(v, bounds.rangeLow ?? null, bounds.rangeHigh ?? null)) {
    return { text: words.outOfRange, bold: true };
  }
  if (row.errors?.[key]) return { text: words.failure, bold: true };
  if (v == null) return { text: DATA_REPORT_NO_DATA, bold: false };
  return { text: num(v, bounds.decimals), bold: outOfSpec(v, bounds.min, bounds.max) };
}

/**
 * The table body in the reference's column order: DATE, TIME, the temperature
 * reading, the humidity reading. A slot this instrument does not report (null
 * key) prints `NA` down its column rather than being dropped — the column set
 * is the reference's, not the instrument's.
 */
export function dataReportRows(
  slots: readonly ReportSlotRow[],
  keys: { temp: string | null; rh: string | null },
  bounds: { temp: SlotBounds; rh: SlotBounds },
  fmt: DataReportFormatters,
  words: DataReportWords,
): DataReportBody {
  const cells: string[][] = [];
  const bold: boolean[][] = [];
  let printedNoData = false;
  for (const s of slots) {
    const t = dataReportCell(s.row, keys.temp, bounds.temp, words);
    const h = dataReportCell(s.row, keys.rh, bounds.rh, words);
    if (t.text === DATA_REPORT_NO_DATA || h.text === DATA_REPORT_NO_DATA) printedNoData = true;
    cells.push([fmt.formatDate(s.ts), fmt.formatTime(s.ts), t.text, h.text]);
    bold.push([false, false, t.bold, h.bold]);
  }
  return { cells, bold, printedNoData };
}

/** A report of an empty period must SAY it is empty — a header with no rows
 *  reads as a rendering failure on paper. Width-matched to the head. */
export function emptyDataReportRow(): string[] {
  return ['-', '-', 'No readings in the selected period', '-'];
}

/**
 * Column widths for PORTRAIT A4. DATE and TIME hold short fixed-width strings,
 * so they are pinned and the two reading columns share what is left. Every cell
 * is centred, as every cell in the reference is.
 */
export function dataReportColumnStyles(): Record<number, { cellWidth?: number; halign: 'center' }> {
  return {
    0: { cellWidth: 40, halign: 'center' },
    1: { cellWidth: 30, halign: 'center' },
    2: { halign: 'center' },
    3: { halign: 'center' },
  };
}

/** A node of `GET /api/functional-locations` — Blocks with their Areas. */
export interface LocationNode { id: string; name: string; children?: LocationNode[] }

/**
 * The Block and Area an instrument sits in, resolved BY ID through the tree —
 * never by matching an Area's name, since two Blocks may hold Areas with the
 * same name. An instrument placed directly on a Block names the Block alone.
 * The same walk `useFilterScopeLabels` makes for the alarm report.
 */
export function resolveBlockArea(
  tree: readonly LocationNode[],
  functionalLocationId: string | null | undefined,
): { blockName: string; areaName: string } {
  if (!functionalLocationId) return { blockName: '', areaName: '' };
  for (const b of tree) {
    if (b.id === functionalLocationId) return { blockName: b.name, areaName: '' };
    const hit = (b.children ?? []).find((a) => a.id === functionalLocationId);
    if (hit) return { blockName: b.name, areaName: hit.name };
  }
  return { blockName: '', areaName: '' };
}
