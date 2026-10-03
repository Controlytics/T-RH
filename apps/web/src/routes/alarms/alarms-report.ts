import type { ReportDoc } from '@/lib/pdf-report';
import { formatDecimals } from '@digilog/shared';
import { alarmTypeText, triggeredText, type AlarmRow, type AlarmDisplayTexts } from './alarm-display';

/**
 * The ALARM REPORT, built to the operator's supplied reference (`Alarm Report.pdf`
 * at the repo root, 2026-09-01) rather than invented.
 *
 * That document's shape, transcribed from its own text: a two-column parameter
 * block (Block / Area / Location / Inst ID against Start Date / Start Time / End
 * Date / End Time), then a seven-column table — DATE, TIME, DESCRIPTION, UOM, PV
 * VALUE, HIGH SET POINT VALUE, LOW SET POINT VALUE — then a legend
 * ("PV Value : Present Value", "UOM : Units of Measurement") and the end block:
 * Printed By, Printed Date & Time, Remarks.
 *
 * **Almost all of the end block already existed.** `createReport()` prints
 * `Printed By: <username>`, the printed timestamp and an empty bordered Remarks
 * box for handwriting, and it takes the legend as config. So this module supplies
 * the parameter block and the table, and passes the legend — it does not
 * reimplement the chrome, and `pdf-report.ts` is deliberately untouched: it is
 * shared by every report in the product.
 *
 * **What is deliberately NOT copied from the reference.** Its dates read
 * `28-05-2026` and its times `16:00`, because that is the format its own system
 * emits. This app's dates are ADMINISTERED (`useDatetimeFormat`), and hardcoding a
 * format here would make one report disagree with every screen that shows the
 * same alarm — so the formatters are passed in. Its "Unit Name : Gagillapur"
 * header is likewise the site branding, which `createReport` already renders from
 * this installation's own configuration.
 */

/** The reference's own abbreviation key, verbatim. */
export const ALARM_REPORT_LEGEND = [
  { abbr: 'PV Value', meaning: 'Present Value' },
  { abbr: 'UOM', meaning: 'Units of Measurement' },
];

/** The seven the reference has, present at every scope. */
export const ALARM_REPORT_HEAD = [
  // Renamed from HIGH/LOW SET POINT VALUE (operator, 2026-09-01) — shorter, and
  // "limit" is this system's own word for the bound everywhere else.
  'DATE', 'TIME', 'DESCRIPTION', 'UOM', 'PV VALUE', 'HIGH LIMIT', 'LOW LIMIT',
];

/**
 * How far the operator narrowed the download.
 *
 * `all` is treated exactly as `block`: with nothing selected the Block varies
 * too, but an eleventh column does not fit an A4 page and the Block is readable
 * from the Area beside it.
 */
export type ReportLevel = 'instrument' | 'area' | 'block' | 'all';

export function reportLevel(f: { blockId: string; areaId: string; instrumentId: string }): ReportLevel {
  if (f.instrumentId) return 'instrument';
  if (f.areaId) return 'area';
  if (f.blockId) return 'block';
  return 'all';
}

/**
 * The placement columns, which are exactly the facts that VARY across the rows
 * (operator, 2026-09-01).
 *
 * Filter to one instrument and its ID, Area and Location are the same on every
 * row — so they belong in the header's parameter block, where they are stated
 * once, and a column repeating one value down a page is wasted width on a report
 * whose width was the complaint. Filter to an Area and the Area is constant but
 * the instrument and its Location are not. Filter to a Block and only the Block
 * is constant.
 *
 * One rule, and the operator's three cases fall out of it rather than being
 * enumerated separately.
 */
export const EXTRA_COLUMNS: Record<ReportLevel, string[]> = {
  instrument: [],
  area: ['INSTRUMENT ID', 'LOCATION'],
  block: ['INSTRUMENT ID', 'AREA', 'LOCATION'],
  all: ['INSTRUMENT ID', 'AREA', 'LOCATION'],
};

export type LimitColumn = 'HIGH LIMIT' | 'LOW LIMIT';
const NO_HIDDEN: ReadonlySet<LimitColumn> = new Set();

/**
 * The limit columns this report cannot fill on ANY row — every cell would be
 * `BOUND_NOT_SHOWN` — and so does not print (2026-09-07). A column that at
 * least one row fills stays, its other rows blank; `N/A` is a value (a bound
 * nobody administered, the reference's own word) and keeps its column. No rows
 * hides nothing: the empty-state row is width-matched to the full head.
 */
export function hiddenLimitColumns(rows: readonly AlarmRow[]): ReadonlySet<LimitColumn> {
  if (rows.length === 0) return NO_HIDDEN;
  const points = rows.map(setPoints);
  const hidden = new Set<LimitColumn>();
  if (points.every((p) => p.high === BOUND_NOT_SHOWN)) hidden.add('HIGH LIMIT');
  if (points.every((p) => p.low === BOUND_NOT_SHOWN)) hidden.add('LOW LIMIT');
  return hidden;
}

export function reportHead(level: ReportLevel, hidden: ReadonlySet<LimitColumn> = NO_HIDDEN): string[] {
  return [...EXTRA_COLUMNS[level], ...ALARM_REPORT_HEAD.filter((h) => !hidden.has(h as LimitColumn))];
}

/**
 * What a limit column prints when the alarm fired against NO bound of that kind —
 * an inactivity alarm, a failed probe, or a bound nobody ever administered.
 *
 * This is the wording the operator's own `Alarm Report.pdf` uses in its LOW SET
 * POINT VALUE column, verbatim, and it is kept for the case where nobody knows
 * whether a bound was in force: it claims nothing.
 *
 * **Distinct from a bound that was SWITCHED OFF**, which prints
 * {@link BOUND_NOT_SHOWN}. The two cases must stay tellable apart — one says
 * there was never a bound, the other says there was one and NMT/NLT turned it off.
 */
export const NOT_APPLICABLE = 'N/A';

/**
 * What a SWITCHED-OFF bound prints — nothing.
 *
 * Operator, 2026-09-02: *"if temperature and humidity NMT and NLT s are true then
 * show both High and low limits in the alarm report, if any one is disabled then
 * dont show that limits in report"*. A bound whose `Enable_Temp_NMT` /
 * `Enable_Temp_NLT` / `Enable_Humid_NMT` / `Enable_Humid_NLT` attribute was off at
 * raise time is not printed at all.
 *
 * **This REVERSES the administered `disabledLimitText` wording** asked for on
 * 2026-09-01 ("show NA in report … for only disabled limits"). That word now has
 * no consumer; the setting is left in place rather than removed here, because a
 * config def is the operator's call and removing one is a twelve-touchpoint job.
 *
 * EMPTY, not a dash, since 2026-09-07 (operator, of the Data Report's rule
 * "if value was not there dont show that boxes in report": *"same for alarm
 * report also"*). It printed a dash from 2026-09-02, under this file's `orDash`
 * rule that a blank on paper reads as a rendering fault; the operator wants the
 * cell absent instead. When EVERY row leaves a limit column empty the column is
 * not printed at all (`hiddenLimitColumns`), so the grid stays a rectangle —
 * the first attempt drew the empty cell without a border and the operator
 * reported "table was not forming properly". `orDash` still applies to the
 * PLACEMENT fields, which are always labelled.
 *
 * Why this is safe against §11: it withholds a bound that could never have raised
 * this alarm — the same rule `telemetry-overview` already follows for a disabled
 * bound, and the reason `limitSnapshot` freezes the flags rather than reading them
 * live. It never invents or suppresses a bound that WAS in force.
 */
export const BOUND_NOT_SHOWN = '';

export interface AlarmReportScope {
  blockName: string;
  areaName: string;
  /** The instrument's own `Location` attribute, when one instrument is in scope. */
  locationName: string;
  instrumentLabel: string;
}

export interface AlarmReportPeriod {
  /** ISO instants — the DIALOG's period, which is what the operator confirmed. */
  from: string;
  to: string;
}

export interface AlarmReportFormatters {
  formatDate: (iso: string) => string;
  formatTime: (iso: string) => string;
}

/** A dash, never an empty cell: a blank reads as a rendering fault rather than as
 *  "not filtered". The reference leaves them empty; this is the one place its
 *  layout is improved on, and it is the same rule the screens follow. */
const orDash = (v: string) => (v.trim() ? v.trim() : '-');

/**
 * The parameter block, in the reference's own order and pairing.
 *
 * `addKeyValue(pairs, 2)` lays these out two per row, which reproduces the
 * reference's two columns: scope on the left, period on the right.
 */
export function scopePairs(
  scope: AlarmReportScope,
  period: AlarmReportPeriod,
  fmt: AlarmReportFormatters,
): [string, string][] {
  return [
    ['Block', orDash(scope.blockName)], ['Start Date', fmt.formatDate(period.from)],
    ['Area', orDash(scope.areaName)], ['Start Time', fmt.formatTime(period.from)],
    ['Location', orDash(scope.locationName)], ['End Date', fmt.formatDate(period.to)],
    ['Inst ID', orDash(scope.instrumentLabel)], ['End Time', fmt.formatTime(period.to)],
  ];
}

/**
 * The parameter block as TABLE ROWS, label and value on ONE line (operator,
 * 2026-09-01: *"header part like Block, area, start date, etc these all should
 * show in one table, title and value should come in one Line, like
 * Block : CWH Block"*).
 *
 * It was `addKeyValue`, which stacks a small grey caption ABOVE its value — two
 * lines per field and no ruling. This is a headless four-column table, so each
 * row reads `Block : CWH Block   Start Date : 27-05-2026` and the values still
 * line up down the page, which a single joined string would not do.
 *
 * The colon lives on the LABEL cell rather than being a column of its own: a
 * third column of colons would be ruled like data and would take width from the
 * values on a portrait page.
 */
export function scopeTableRows(pairs: readonly [string, string][]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const [lk, lv] = pairs[i];
    const right = pairs[i + 1];
    out.push(right
      ? [`${lk} :`, lv, `${right[0]} :`, right[1]]
      // An odd trailing field pads rather than short-rowing: autotable would
      // otherwise stretch its last cell across the missing columns.
      : [`${lk} :`, lv, '', '']);
  }
  return out;
}

/** The default A4 portrait text column: 210mm less two 14mm margins. */
export const CONTENT_WIDTH_MM = 182;
const SCOPE_LABEL_MM = 26;

/**
 * All FOUR columns pinned, so the block's centre line lands in the CENTRE.
 *
 * Operator, 2026-09-01: *"Block table central line side is not in center it is on
 * one side"*. Only the two label columns were pinned; autotable then divided the
 * REMAINING width between the two value columns by their content, so a short
 * Block name against a long date pushed the divider well off centre and the block
 * read as two unequal panes.
 *
 * Each half is an equal share of the content width, split into a fixed label and
 * whatever is left. Derived from the page rather than hardcoded, because this
 * chrome is shared and the other reports are landscape.
 */
export function scopeColumnStyles(contentWidth = CONTENT_WIDTH_MM, labelWidth = SCOPE_LABEL_MM) {
  const value = contentWidth / 2 - labelWidth;
  return {
    0: { cellWidth: labelWidth, fontStyle: 'bold' as const },
    1: { cellWidth: value },
    2: { cellWidth: labelWidth, fontStyle: 'bold' as const },
    3: { cellWidth: value },
  };
}

/** °C for temperature, %RH for humidity — the same legends the alarms table puts
 *  in its column headers, so the paper and the screen name one unit. */
export function uomFor(a: AlarmRow): string {
  if (a.metric === 'TEMPERATURE') return '°C';
  if (a.metric === 'HUMIDITY') return '%RH';
  return '-';
}

/**
 * The two set-point columns.
 *
 * Read from the FROZEN `ruleSnapshot`, never from live configuration: a §11
 * record must read back against the bound it actually fired on, and the
 * administered limit may have been changed since.
 *
 * `thresholdHigh`/`thresholdLow` are used when the snapshot carries them; older
 * rows carry a single `limit` plus its `limitKind`, and then the OTHER column is
 * `N/A` — which is exactly what the reference shows for its High Temperature and
 * RH High rows. A source with no numeric bound at all (inactivity, a failed
 * probe) is `N/A` in both, because it did not fire against one.
 */
export function setPoints(a: AlarmRow): { high: string; low: string } {
  // No cast: `highEnabled`/`lowEnabled` are declared on the snapshot type, so a
  // fixture that omits them fails the build rather than silently reading undefined.
  const s = a.ruleSnapshot;
  const dp = s?.decimals ?? undefined;
  // The bound's own FROZEN text (`60 (For Reference)`) prints in the number's
  // place, as on every set point (operator, 2026-10-03: "show that text in
  // reports"). Frozen with the number, so an edit tomorrow cannot re-caption
  // this row; a bare number prints at the frozen precision as before.
  const show = (v: number | null | undefined, text?: string | null) => {
    if (typeof v !== 'number') return null;
    if (typeof text === 'string' && text.trim()) return text;
    return formatDecimals(v, dp ?? 1) ?? String(v);
  };

  let high = show(s?.thresholdHigh, s?.thresholdHighText);
  let low = show(s?.thresholdLow, s?.thresholdLowText);

  if (high === null && low === null && typeof s?.limit === 'number') {
    const kind = (s.limitKind ?? a.limitKind ?? '').toUpperCase();
    if (kind === 'HIGH') high = show(s.limit, s.thresholdHighText);
    else if (kind === 'LOW') low = show(s.limit, s.thresholdLowText);
  }

  /**
   * A bound that was SWITCHED OFF is not shown; one that was never administered
   * prints `N/A`. Both arrive as a null threshold, which is why the snapshot
   * freezes `highEnabled`/`lowEnabled` alongside — the flags are the only thing
   * that can tell the two apart, and rows raised before they existed carry
   * neither, so they fall through to `N/A` rather than asserting a bound was
   * disabled when nobody knows.
   *
   * A NUMBER always wins over both: the flag only ever explains an ABSENCE, so a
   * bound switched off AFTER this alarm froze its value still prints that value.
   */
  const word = (v: string | null, enabled: boolean | null | undefined) => {
    if (v !== null) return v;
    return enabled === false ? BOUND_NOT_SHOWN : NOT_APPLICABLE;
  };
  return { high: word(high, s?.highEnabled), low: word(low, s?.lowEnabled) };
}

/**
 * One table row per alarm, in the reference's column order.
 *
 * DESCRIPTION and PV VALUE come from `alarmTypeText` and `triggeredText`, the
 * SAME helpers the Alarms page renders — so a printed row cannot say something
 * different from the row the operator was looking at when they pressed Download.
 * That is the property worth protecting here; the rest is layout.
 */
export function reportRows(
  rows: readonly AlarmRow[],
  fmt: AlarmReportFormatters,
  texts?: AlarmDisplayTexts,
  level: ReportLevel = 'instrument',
  hidden: ReadonlySet<LimitColumn> = NO_HIDDEN,
): string[][] {
  return rows.map((a) => {
    const { high, low } = setPoints(a);
    // The leading cells mirror `EXTRA_COLUMNS` for this level, in the same order.
    // Built from one switch so a column and its cell cannot drift apart.
    const extras = level === 'instrument' ? []
      : level === 'area'
        ? [orDash(a.instrumentCode ?? ''), orDash(a.locationAttribute ?? '')]
        : [orDash(a.instrumentCode ?? ''), orDash(a.locationName ?? ''), orDash(a.locationAttribute ?? '')];
    return [
      ...extras,
      fmt.formatDate(a.raisedAt),
      fmt.formatTime(a.raisedAt),
      alarmTypeText(a, texts),
      uomFor(a),
      triggeredText(a, texts),
      // The two limit cells follow `reportHead`'s filter exactly, so a row and
      // its head cannot disagree about which columns exist.
      ...(hidden.has('HIGH LIMIT') ? [] : [high]),
      ...(hidden.has('LOW LIMIT') ? [] : [low]),
    ];
  });
}

/**
 * The disclosure line printed when the export could not cover the whole period.
 *
 * IN THE REPORT, not a toast: the paper is the record, and a toast does not
 * survive printing. A signed report silently covering 500 of 3,000 alarms is the
 * defect class this codebase has already fixed twice — the trend page's
 * `ORDER BY ts DESC` cap and the Alarms page's own client-side counts.
 */
export function truncationNote(shown: number, total: number): string | null {
  if (shown >= total) return null;
  return `This report shows the ${shown.toLocaleString()} most recent of ${total.toLocaleString()} `
    + 'alarms in the selected period. Narrow the period or the selection to cover the rest.';
}

/**
 * Column widths for PORTRAIT A4 (operator, 2026-09-01: *"give report as A4/letter
 * size, present width is high"* — it was landscape).
 *
 * Only the columns that would otherwise take more than their share are pinned:
 * DATE, TIME and the two set points hold short fixed-width strings, so capping
 * them leaves DESCRIPTION and the placement columns the room they need to wrap
 * rather than truncate. Indices are resolved against the head for THIS level,
 * because the extra columns shift every base column right.
 */
export function columnWidths(level: ReportLevel, hidden: ReadonlySet<LimitColumn> = NO_HIDDEN): Record<number, { cellWidth: number | 'wrap' }> {
  const head = reportHead(level, hidden);
  const narrow: Record<string, number> = {
    DATE: 17, TIME: 12, UOM: 12,
    'PV VALUE': 16, 'HIGH LIMIT': 18, 'LOW LIMIT': 18,
  };
  const out: Record<number, { cellWidth: number | 'wrap' }> = {};
  /**
   * INSTRUMENT ID takes `'wrap'` — autotable's "size this column to its widest
   * cell and do not break it" (operator, 2026-09-01: *"instrument ID name should
   * come fully"*). It was pinned to 26mm, and a code like `CWH/RDU/046-00` is
   * wider than that at the raised font size, so it broke across two lines.
   * A NUMBER cannot express this: any fixed width is a guess about the longest
   * code on an installation whose codes we do not control.
   */
  const idAt = head.indexOf('INSTRUMENT ID');
  if (idAt >= 0) out[idAt] = { cellWidth: 'wrap' };
  head.forEach((h, i) => {
    if (narrow[h]) out[i] = { cellWidth: narrow[h] };
  });
  return out;
}

export function buildAlarmsReport(
  doc: ReportDoc,
  opts: {
    rows: readonly AlarmRow[];
    total: number;
    scope: AlarmReportScope;
    period: AlarmReportPeriod;
    fmt: AlarmReportFormatters;
    texts?: AlarmDisplayTexts;
    level?: ReportLevel;
  },
): void {
  const level = opts.level ?? 'instrument';
  // A limit column no row can fill is not printed (2026-09-07).
  const hidden = hiddenLimitColumns(opts.rows);
  doc.addTable({
    body: scopeTableRows(scopePairs(opts.scope, opts.period, opts.fmt)),
    columnStyles: scopeColumnStyles(),
  });

  const note = truncationNote(opts.rows.length, opts.total);
  if (note) {
    doc.addSectionTitle(note);
  }

  doc.addTable({
    head: reportHead(level, hidden),
    columnStyles: columnWidths(level, hidden),
    body: opts.rows.length
      ? reportRows(opts.rows, opts.fmt, opts.texts, level, hidden)
      // A report of an empty period must SAY it is empty. A table with a header
      // and no rows reads as a rendering failure on paper, where there is no
      // other state to check it against.
      // Width-matched to the head for THIS level, or the empty-state row lands
      // under the wrong columns.
      : [reportHead(level, hidden).map((_, i) => (i === reportHead(level, hidden).indexOf('DESCRIPTION')
        ? 'No alarms in the selected period' : '-'))],
  });
}

/**
 * What the download dialog opens on.
 *
 * The page's own Raised-between filter when the operator set one — so the dialog
 * agrees with the table behind it — and otherwise the last 24 hours, which is a
 * period rather than "everything ever": a report with no bounds is not a report
 * of a period, and this one prints its Start and End on the paper.
 *
 * The values are `datetime-local` wall-clock text, the shape both the filter
 * inputs and the dialog use; `localInputToIso` converts at the point of sending.
 */
export function reportSeedPeriod(
  f: { from: string; to: string },
  now: Date = new Date(),
): { from: string; to: string; label: string } {
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 16);
  const from = f.from || local(new Date(now.getTime() - 24 * 3_600_000));
  const to = f.to || local(now);
  return { from, to, label: 'Selected period' };
}
