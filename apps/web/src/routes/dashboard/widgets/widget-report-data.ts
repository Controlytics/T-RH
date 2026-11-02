/**
 * What a dashboard widget's "Download report" PRINTS (2026-11-02) — spec
 * docs/superpowers/specs/2026-11-02-widget-report-templates-design.md §7-§8.
 *
 * Three parts:
 *
 * 1. `useWidgetReportPlan` — while the dialog is open: the widget's instruments
 *    (the widget's OWN query, one SWR key), the SERVER's resolution of which
 *    template each of their profiles uses (`GET /api/report-templates/resolve`),
 *    each profile's templates (the picker) and field catalogue. Nothing here
 *    decides a template; the server's answer is shown and used.
 *
 * 2. `collectWidgetReport` — on confirm: the widget's data for the dialog's
 *    period, asked through the SAME fetchers and URL builders the widget's own
 *    hooks use (`use-widget-data.ts`, `telemetryOverviewUrl`, `alarmListUrl`),
 *    and its picture. Fetched at confirm, not taken from the hooks on screen:
 *    a window widget's report is for the period chosen IN THE DIALOG (the
 *    history hooks hold the previous period's answer while a new one loads),
 *    and a paged widget's report is every page, not the one on screen.
 *
 * 3. `rowsFor<Type>` — pure: a server answer → rows of field id → printed text,
 *    by the widget's OWN cell rules (`keyCell`, `timeseriesCellText`, the
 *    alarm table's `alarm-display` wording, `instrumentLook`). Never a second
 *    formatting of a value: what the widget prints is what the report prints.
 *
 * THE ROW GRAIN is the shared contract (`WIDGET_REPORT_FIELDS`, Task 1) and the
 * builder's (`lib/widget-report.ts`, Task 3): rows of the per-key types name
 * their instrument (+ instant) in `ROW_GROUP` and carry the key's text in both
 * `reading.value` and `key:<name>`, so the builder can print them long or
 * collapse them; every instrument row also carries the template's `key:` /
 * `attr:` cells (`instrumentCells`) and names its instrument in
 * `REPORT_ROW_INSTRUMENT`, which decides its profile's section. A row of no
 * single instrument (a bar of "all", a slice, a figure) goes to the FIRST
 * section (ruling T1-C3).
 *
 * Nothing here may import `lib/widget-report.ts` or `lib/pdf-report.ts` for a
 * VALUE: they carry jsPDF, and this module is on the dashboard's main bundle.
 * The dialog imports the builder dynamically, on confirm.
 */
import useSWR from 'swr';
import {
  DATA_KEYS_PER_REQUEST_MAX, WIDGET_INSTRUMENTS_MAX, WIDGET_REPORT_FIELDS, coerceReading, formatDecimals,
  type AlarmTypeNames, type CustomWidget, type DataKeyRef, type LatestValuesRow, type ReportField,
  type ReportTemplateDocument, type WidgetKey, type WidgetType,
} from '@digilog/shared';
import type { WidgetReportRow } from '@/lib/widget-report';
import type { RasterImage } from '@/lib/svg-raster';
import { apiClient } from '@/lib/api-client';
import type { SensorWords } from '@/hooks/use-failure-text';
import type { AlarmWidgetFilterValue } from '@/routes/alarms/alarm-widget-filters';
import {
  alarmTypeText, clearedText, instrumentLabel, locationText, screenLimitText, statusText, triggeredText,
  type AlarmDisplayTexts, type AlarmRow, type AlarmStatusTexts,
} from '@/routes/alarms/alarm-display';
import { telemetryOverviewUrl, type OverviewRow } from '../use-telemetry';
import { widgetAlarmScope, type AlarmScope } from '../alarm-scope';
import { alarmListUrl } from '../selection-alarms';
import { instrumentLook } from './instrument-look';
import { isMeasured, keyCell } from './key-value';
import { timeseriesCellText } from './timeseries-table-widget';
import { trendPairs, trendPlot, type TrendPlotted } from './trend-chart-widget';
import { gaugePairs } from './gauge-model';
import {
  BAR_DEFAULTS, BAR_HEIGHT, barAxis, barModel, barPlan, buildBarOption, legendRows as barLegendRows, tooManyBarsText,
  type BarDateFormat, type BarModel,
} from './bar-chart-model';
import { COMPARISON_HEIGHT, buildComparisonOption, codeAxis, comparisonModel, legendRows } from './comparison-model';
import { alarmTypeLabel, alarmTypePieModel, buildPieOption, piePlan, statusPieModel, type PieSlice } from './pie-model';
import {
  alarmCountsUrl, fetchLatestValues, fetchWidgetHistory, overviewQueryFor, telemetryBucketsUrl, widgetTimeseriesUrl,
  type AlarmCounts, type InstrumentHistory, type TelemetryBuckets, type TimeseriesRow, type WidgetRange,
  type WidgetSelection, useWidgetInstrumentIds,
} from './use-widget-data';
import { groupDigits, valueOf } from './widget-common';

/**
 * The key naming a row's instrument (+ instant): `lib/widget-report.ts`'s
 * `REPORT_ROW_GROUP`, spelled here because that module carries jsPDF (a test
 * pins the two equal).
 */
export const ROW_GROUP = '#group';
/** The key naming a row's ONE instrument — it decides the row's profile section. Never a column (`#`). */
export const REPORT_ROW_INSTRUMENT = '#instrument';
/** What `instrument.code` says on a bar of every instrument combined (ruling T1-C3). */
export const ALL_INSTRUMENTS_LABEL = 'All instruments';

/** The page's administered formatter, for every printed instant. */
export type FormatDateTime = (iso: string) => string;
type Cells = ReadonlyMap<string, WidgetReportRow>;
const NO_CELLS: Cells = new Map();

const keyId = (k: { source: string; key: string }) => `${k.source === 'attribute' ? 'attr' : 'key'}:${k.key}`;

// ── Instrument cells ───────────────────────────────────────────────────────

/**
 * Each instrument's `key:<k>` / `attr:<k>` cells — its value of every key the
 * template prints — as the widget's cell rule prints them (`keyCell`: a
 * measured reading at the server's decimals or its fault word, a raw one as
 * received, an attribute as the server's display). An absent value has no
 * cell (the builder prints `—`).
 */
export function instrumentCells(
  rows: readonly LatestValuesRow[],
  words: SensorWords,
  /**
   * The WIDGET's keys: a value of one of them is printed by that key's
   * definition (its `decimals`), exactly as the widget prints it — never as
   * the bare float (fix wave 1: `1013.2500000000001` where the widget showed
   * `1013.3`; a collapsed row takes the first row's cell, so these must be the
   * widget's text too).
   */
  widgetKeys: readonly WidgetKey[] = [],
): Map<string, WidgetReportRow> {
  const out = new Map<string, WidgetReportRow>();
  for (const row of rows) {
    const cells: WidgetReportRow = {};
    for (const v of row.values) {
      if (v.value === null || v.value === undefined) continue;
      const def = widgetKeys.find((k) => k.source === v.source && k.key === v.key) ?? { source: v.source, key: v.key };
      cells[keyId(v)] = keyCell(v, row.reporting, def, words).text;
    }
    out.set(row.instrumentId, cells);
  }
  return out;
}

// ── Rows, per widget type ──────────────────────────────────────────────────

/** One row per KEY of each instrument — the four present-state key widgets. */
function latestKeyRows(
  rows: readonly LatestValuesRow[],
  keys: readonly WidgetKey[],
  words: SensorWords,
  fmt: FormatDateTime,
  cells: Cells,
  sentOnly: boolean,
): WidgetReportRow[] {
  const pairs = sentOnly
    ? gaugePairs(rows, keys).map(({ row, key }) => ({ row, key }))
    : rows.flatMap((row) => keys.map((key) => ({ row, key })));
  return pairs.map(({ row, key }) => {
    const v = valueOf(row, key);
    const cell = keyCell(v, row.reporting, key, words);
    return {
      ...cells.get(row.instrumentId),
      [ROW_GROUP]: row.instrumentId,
      [REPORT_ROW_INSTRUMENT]: row.instrumentId,
      'instrument.code': row.code,
      'instrument.area': row.functionalLocationName ?? null,
      'instrument.location': row.locationAttribute ?? null,
      'key.label': key.label ?? key.key,
      'reading.value': cell.text,
      'reading.unit': cell.unit,
      'reading.status': cell.label,
      'reading.ts': v?.ts ? fmt(v.ts) : null,
      // The widget's key keeps the widget's own text (its decimals, its fault word).
      [keyId(key)]: cell.text,
    };
  });
}

/** Value cards: a card per instrument × key, NA included. */
export const rowsForValueCards = (rows: readonly LatestValuesRow[], keys: readonly WidgetKey[], words: SensorWords, fmt: FormatDateTime, cells: Cells = NO_CELLS) =>
  latestKeyRows(rows, keys, words, fmt, cells, false);
/** Latest values table: a cell per instrument × key, NA included. */
export const rowsForLatestTable = (rows: readonly LatestValuesRow[], keys: readonly WidgetKey[], words: SensorWords, fmt: FormatDateTime, cells: Cells = NO_CELLS) =>
  latestKeyRows(rows, keys, words, fmt, cells, false);
/** Gauges: only the keys an instrument has SENT — the widget draws no ring for the rest (`gaugePairs`). */
export const rowsForGauge = (rows: readonly LatestValuesRow[], keys: readonly WidgetKey[], words: SensorWords, fmt: FormatDateTime, cells: Cells = NO_CELLS) =>
  latestKeyRows(rows, keys, words, fmt, cells, true);
/** Comparison bars: only what has been SENT, as the bars (a gap is no bar). */
export const rowsForComparisonBar = (rows: readonly LatestValuesRow[], keys: readonly WidgetKey[], words: SensorWords, fmt: FormatDateTime, cells: Cells = NO_CELLS) =>
  latestKeyRows(rows, keys, words, fmt, cells, true);

/**
 * Time series: one row per stored instant per widget key, the value by the
 * widget's own cell rule (`timeseriesCellText`). Every key the instant holds —
 * the widget's and the template's extra ones — is a `key:` cell of that
 * instant; attributes come from `cells`.
 */
export function rowsForTimeseriesTable(
  history: readonly TimeseriesRow[],
  byId: ReadonlyMap<string, LatestValuesRow>,
  keys: readonly WidgetKey[],
  extraKeys: readonly string[],
  fmt: FormatDateTime,
  cells: Cells = NO_CELLS,
): WidgetReportRow[] {
  const all: WidgetKey[] = [...keys, ...extraKeys.filter((k) => !keys.some((w) => w.key === k)).map((key) => ({ source: 'telemetry' as const, key }))];
  return history.flatMap((r) => {
    const row = byId.get(r.instrumentId);
    const atInstant: WidgetReportRow = {};
    for (const k of all) {
      if (r.values[k.key] !== undefined) atInstant[`key:${k.key}`] = timeseriesCellText(row, k, r.values[k.key]);
    }
    return keys.map((key) => {
      const value = r.values[key.key];
      const latest = row ? valueOf(row, key) : undefined;
      const unit = coerceReading(value) === null ? null
        : latest && isMeasured(latest) ? latest.unit : key.unit ?? null;
      return {
        ...cells.get(r.instrumentId),
        ...atInstant,
        [ROW_GROUP]: `${r.instrumentId}@${r.ts}`,
        [REPORT_ROW_INSTRUMENT]: r.instrumentId,
        'reading.ts': fmt(r.ts),
        'instrument.code': row?.code ?? null,
        'key.label': key.label ?? key.key,
        'reading.value': timeseriesCellText(row, key, value),
        'reading.unit': unit,
        [`key:${key.key}`]: timeseriesCellText(row, key, value),
      };
    });
  });
}

/** Trend chart: one row per DRAWN series, the server's range figures at the series' decimals (the widget's strip). */
export function rowsForTrendChart(
  plotted: readonly TrendPlotted[],
  byInstrument: ReadonlyMap<string, InstrumentHistory>,
  cells: Cells = NO_CELLS,
): WidgetReportRow[] {
  const fixed = (v: number | null | undefined, d: number) => (typeof v === 'number' ? formatDecimals(v, d) : null);
  return plotted.map((p) => {
    const s = byInstrument.get(p.instrumentId)?.summaries[p.key];
    const d = p.series.decimals;
    return {
      ...cells.get(p.instrumentId),
      [ROW_GROUP]: p.instrumentId,
      [REPORT_ROW_INSTRUMENT]: p.instrumentId,
      'instrument.code': p.row.code,
      'instrument.location': p.row.locationAttribute ?? null,
      'key.label': p.widgetKey.label ?? p.key,
      'reading.unit': p.unit,
      'summary.min': fixed(s?.min, d),
      'summary.max': fixed(s?.max, d),
      'summary.avg': fixed(s?.avg, d),
      'summary.count': s ? s.count : null,
    };
  });
}

/**
 * Bar chart: one row per BAR, in time order then series order — the server's
 * computed value at the series' decimals, and the readings behind it. A
 * partial bucket says so. A series of every instrument combined names no
 * instrument (`All instruments`) and goes to the first section.
 */
export function rowsForBarChart(model: BarModel, codeOf: (instrumentId: string) => string | undefined, cells: Cells = NO_CELLS): WidgetReportRow[] {
  return model.categories.flatMap((_, n) => model.series.flatMap((s) => {
    const p = s.points[n];
    if (!p) return [];
    const mine: WidgetReportRow = s.instrumentId
      ? { ...cells.get(s.instrumentId), [REPORT_ROW_INSTRUMENT]: s.instrumentId, 'instrument.code': codeOf(s.instrumentId) ?? null }
      : { 'instrument.code': ALL_INSTRUMENTS_LABEL };
    return [{
      ...mine,
      'bucket.ts': model.partial[n] ? `${model.labels[n]} (partial)` : model.labels[n],
      'series.label': s.name,
      'bucket.value': formatDecimals(p.value, s.decimals),
      'reading.unit': s.unit,
      'bucket.readings': p.readings,
    }];
  }));
}

/** Alarm table: one row per alarm, every cell worded as the alarm table words it (`alarm-display.ts`). */
export function rowsForAlarmTable(
  alarms: readonly AlarmRow[],
  texts: AlarmDisplayTexts,
  statusTexts: AlarmStatusTexts | undefined,
  fmt: FormatDateTime,
  cells: Cells = NO_CELLS,
): WidgetReportRow[] {
  return alarms.map((a) => ({
    ...cells.get(a.instrumentId),
    [REPORT_ROW_INSTRUMENT]: a.instrumentId,
    'instrument.code': instrumentLabel(a),
    'alarm.type': alarmTypeText(a, texts),
    'instrument.location': locationText(a),
    'alarm.raisedAt': fmt(a.raisedAt),
    'alarm.value': triggeredText(a, texts),
    'alarm.limit': screenLimitText(a, texts),
    'alarm.clearedAt': a.clearedAt ? fmt(a.clearedAt) : null,
    'alarm.clearedValue': clearedText(a, texts),
    'alarm.status': statusText(a, statusTexts),
    'alarm.acknowledgedBy': a.acknowledgedBy ?? null,
    'alarm.acknowledgedAt': a.acknowledgedAt ? fmt(a.acknowledgedAt) : null,
  }));
}

/** Pie chart: one row per slice; "Other" names the types it holds. The share is of the whole ring. */
export function rowsForPieChart(slices: readonly PieSlice[]): WidgetReportRow[] {
  const total = slices.reduce((sum, s) => sum + s.count, 0);
  return slices.map((s) => ({
    'slice.label': s.merged?.length ? `${s.label} (${s.merged.map((m) => `${m.label} ${groupDigits(m.count)}`).join(', ')})` : s.label,
    'slice.count': s.count,
    'slice.share': total > 0 ? formatDecimals((s.count / total) * 100, 1) : null,
  }));
}

/** Alarm counts: Active, Unacknowledged, then each type the server lists with its active count — the widget's figures. */
export function rowsForAlarmCounts(data: AlarmCounts, names: AlarmTypeNames | undefined): WidgetReportRow[] {
  const q = data.quadrants;
  return [
    { 'count.label': 'Active', 'count.value': q.activeUnack + q.activeAck },
    { 'count.label': 'Unacknowledged', 'count.value': q.activeUnack + q.clearedUnack },
    ...data.byType.map((t) => ({ 'count.label': `Active — ${alarmTypeLabel(t.type, names)}`, 'count.value': t.active })),
  ];
}

function overviewRow(row: OverviewRow, cells: Cells): WidgetReportRow {
  return {
    ...cells.get(row.instrumentId),
    [ROW_GROUP]: row.instrumentId,
    [REPORT_ROW_INSTRUMENT]: row.instrumentId,
    'instrument.code': row.code,
    'instrument.area': row.functionalLocationName ?? null,
    'instrument.location': row.locationAttribute ?? null,
    // The ONE mapping the status widgets share — the server's verdict in the widget's word.
    'instrument.status': instrumentLook(row).classes.label,
  };
}

/** Status grid: one row per instrument, in the server's order. */
export const rowsForStatusGrid = (rows: readonly OverviewRow[], cells: Cells = NO_CELLS): WidgetReportRow[] =>
  rows.map((row) => overviewRow(row, cells));

/** Instrument list: one row per instrument, with when it last reported. */
export const rowsForInstrumentList = (rows: readonly OverviewRow[], fmt: FormatDateTime, cells: Cells = NO_CELLS): WidgetReportRow[] =>
  rows.map((row) => ({ ...overviewRow(row, cells), 'instrument.lastSeen': row.lastSeenAt ? fmt(row.lastSeenAt) : null }));

// ── Templates → what to fetch, rows → sections ─────────────────────────────

/**
 * The keys and attributes the chosen templates print beyond the widget's own:
 * every SHOWN `key:` / `attr:` column and every `attr:` info row, once each, in
 * the order first met. A hidden column prints nothing, so it is not asked for.
 */
export function reportRefs(documents: readonly ReportTemplateDocument[]): DataKeyRef[] {
  const seen = new Set<string>();
  const out: DataKeyRef[] = [];
  const add = (id: string) => {
    if (seen.has(id)) return;
    if (id.startsWith('key:')) out.push({ source: 'telemetry', key: id.slice(4) });
    else if (id.startsWith('attr:')) out.push({ source: 'attribute', key: id.slice(5) });
    else return;
    seen.add(id);
  };
  for (const d of documents) for (const c of d.columns) if (c.show) add(c.id);
  for (const d of documents) for (const r of d.infoBlock) add(r.source);
  return out;
}

/** Rows into their profile's section, in order; a row of no instrument (or an unknown one) into the FIRST. */
export function sectionRows(rows: readonly WidgetReportRow[], sections: readonly { instrumentIds: readonly string[] }[]): WidgetReportRow[][] {
  const out = sections.map(() => [] as WidgetReportRow[]);
  if (sections.length === 0) return out;
  const index = new Map<string, number>();
  sections.forEach((s, n) => s.instrumentIds.forEach((id) => { if (!index.has(id)) index.set(id, n); }));
  for (const row of rows) {
    const id = row[REPORT_ROW_INSTRUMENT];
    out[typeof id === 'string' ? index.get(id) ?? 0 : 0].push(row);
  }
  return out;
}

// ── Fetching, at confirm ───────────────────────────────────────────────────

/**
 * Latest values for any number of keys: `fetchLatestValues` (the widgets' own
 * fetcher, which batches instruments) once per `DATA_KEYS_PER_REQUEST_MAX`
 * keys, each instrument's values merged back into one row in the keys' order.
 */
export async function fetchLatestValuesAllKeys(ids: readonly string[], refs: readonly DataKeyRef[]): Promise<LatestValuesRow[]> {
  const groups: DataKeyRef[][] = [];
  for (let k = 0; k < refs.length; k += DATA_KEYS_PER_REQUEST_MAX) groups.push(refs.slice(k, k + DATA_KEYS_PER_REQUEST_MAX));
  const answers = await Promise.all(groups.map((g) => fetchLatestValues(ids, g)));
  const byId = new Map<string, LatestValuesRow>();
  for (const answer of answers) {
    for (const row of answer) {
      const held = byId.get(row.instrumentId);
      if (held) held.values.push(...row.values);
      else byId.set(row.instrumentId, { ...row, values: [...row.values] });
    }
  }
  return [...byId.values()];
}

/** One printed report covers at most this many alarms / instants; more is SAID in the PDF (the Alarms page's rule). */
export const ALARM_REPORT_MAX = 5000;
export const TIMESERIES_REPORT_MAX = 5000;
const REPORT_PAGE = 500;

/** Every alarm of a scope under the table's filters, page by page, to `ALARM_REPORT_MAX`. */
export async function fetchAllAlarms(scope: AlarmScope, filters: AlarmWidgetFilterValue): Promise<{ rows: AlarmRow[]; total: number }> {
  const rows: AlarmRow[] = [];
  let total = 0;
  for (let page = 1; rows.length < ALARM_REPORT_MAX; page += 1) {
    const url = alarmListUrl(scope, filters, page, REPORT_PAGE);
    if (!url) return { rows: [], total: 0 };
    const res = await apiClient.get<{ data: AlarmRow[]; total: number }>(url);
    total = res.total ?? 0;
    rows.push(...(res.data ?? []));
    if ((res.data ?? []).length < REPORT_PAGE || rows.length >= total) break;
  }
  return { rows: rows.slice(0, ALARM_REPORT_MAX), total };
}

async function fetchAllTimeseries(ids: readonly string[], keys: readonly string[], range: WidgetRange): Promise<{ rows: TimeseriesRow[]; total: number }> {
  const rows: TimeseriesRow[] = [];
  let total = 0;
  for (let offset = 0; rows.length < TIMESERIES_REPORT_MAX; offset += REPORT_PAGE) {
    const url = widgetTimeseriesUrl(ids, keys, range, REPORT_PAGE, offset);
    if (!url) return { rows: [], total: 0 };
    const res = await apiClient.get<{ data: TimeseriesRow[]; total: number }>(url);
    total = res.total ?? 0;
    rows.push(...(res.data ?? []));
    if ((res.data ?? []).length < REPORT_PAGE || rows.length >= total) break;
  }
  return { rows: rows.slice(0, TIMESERIES_REPORT_MAX), total };
}

async function fetchOverview(widget: CustomWidget, selection: WidgetSelection): Promise<OverviewRow[]> {
  const url = telemetryOverviewUrl(overviewQueryFor(widget.source, selection));
  return url ? (await apiClient.get<{ data: OverviewRow[] }>(url)).data ?? [] : [];
}

/** The width an off-screen chart is drawn at, in px — a full-width card, so axis labels stand as on a wide screen. */
export const REPORT_CHART_WIDTH = 900;

/** An ECharts option → PNG, drawn off-screen at a fixed size (the chunk is fetched like a drawn chart's). */
async function chartPicture(option: unknown, height: number): Promise<RasterImage | null> {
  const [{ renderChartSvg }, { svgMarkupToPng }] = await Promise.all([import('./charts/lazy-echart'), import('@/lib/svg-raster')]);
  try {
    const svg = await renderChartSvg(option as never, REPORT_CHART_WIDTH, height);
    return svgMarkupToPng(svg, { width: REPORT_CHART_WIDTH, height });
  } catch (e) {
    // Said in the PDF by the caller ("The chart picture could not be drawn").
    console.warn('[report] the chart could not be drawn:', e);
    return null;
  }
}

export interface CollectInput {
  widget: CustomWidget;
  selection: WidgetSelection;
  /** The widget's instruments, in its order (`useWidgetInstrumentIds`). */
  ids: readonly string[];
  /** The dialog's period — window-following types only. */
  period: WidgetRange | null;
  /** The alarm table's filters as the viewer has them. */
  alarmFilters: AlarmWidgetFilterValue;
  /** What the chosen templates print beyond the widget's keys (`reportRefs`). */
  refs: readonly DataKeyRef[];
  words: SensorWords;
  alarm: { texts: AlarmDisplayTexts; statusTexts: AlarmStatusTexts | undefined; typeNames: AlarmTypeNames | undefined };
  dates: BarDateFormat;
  /** The floor plan the widget is drawing, on the page (the floor plan widget's picture). */
  floorplanSvg?: () => SVGSVGElement | null;
}

export interface Collected {
  rows: WidgetReportRow[];
  /** What the widget draws, rasterised; null when it draws no picture or it could not be drawn. */
  image: RasterImage | null;
  /** Lines printed UNDER the report: every cap and every missing picture, said — never silent. */
  notes: string[];
}

const PICTURE_MISSING = 'The chart picture could not be drawn by this browser. The table still lists every value.';

/** The widget's data for its report: asked through the widget's own fetchers, mapped by its own cell rules. */
export async function collectWidgetReport(input: CollectInput): Promise<Collected> {
  const { widget, selection, words, dates } = input;
  const fmt = dates.formatDateTime;
  const notes: string[] = [];
  const extras = input.refs.filter((r) => !widget.keys.some((k) => k.source === r.source && k.key === r.key));
  const cellsFor = async (ids: readonly string[]) => (input.refs.length
    ? instrumentCells(await fetchLatestValuesAllKeys(ids, input.refs), words, widget.keys)
    : new Map<string, WidgetReportRow>());
  /** The widget's latest values in its order (`useWidgetRows`' order), and every template cell. */
  const latest = async () => {
    const rows = await fetchLatestValuesAllKeys(input.ids, [...widget.keys, ...extras]);
    const byId = new Map(rows.map((r) => [r.instrumentId, r]));
    const ordered = input.ids.map((id) => byId.get(id)).filter((r): r is LatestValuesRow => r !== undefined);
    // The widget's own keys only, as the widget holds them (its cells are its own text).
    const own = ordered.map((r) => ({ ...r, values: widget.keys.map((k) => valueOf(r, k)).filter((v): v is NonNullable<typeof v> => v !== undefined) }));
    return { own, cells: instrumentCells(ordered, words, widget.keys) };
  };

  switch (widget.type) {
    case 'value_cards':
    case 'latest_table':
    case 'gauge': {
      const { own, cells } = await latest();
      const rows = widget.type === 'gauge' ? rowsForGauge(own, widget.keys, words, fmt, cells)
        : widget.type === 'value_cards' ? rowsForValueCards(own, widget.keys, words, fmt, cells)
          : rowsForLatestTable(own, widget.keys, words, fmt, cells);
      return { rows, image: null, notes };
    }
    case 'comparison_bar': {
      const { own, cells } = await latest();
      const model = comparisonModel(own, widget.keys, words);
      let image: RasterImage | null = null;
      if (model.codes.length > 0) {
        const option = buildComparisonOption(model, codeAxis(model.codes, REPORT_CHART_WIDTH), legendRows(model.series.map((s) => s.legendName), REPORT_CHART_WIDTH));
        image = await chartPicture(option, COMPARISON_HEIGHT);
        if (!image) notes.push(PICTURE_MISSING);
      }
      if (model.codes.length < model.total) notes.push(`The chart shows ${model.codes.length} of ${model.total} instruments, as the widget does; the table lists every one.`);
      return { rows: rowsForComparisonBar(own, widget.keys, words, fmt, cells), image, notes };
    }
    case 'trend_chart': {
      if (!input.period) throw new Error('A trend chart report needs a period.');
      const { own, cells } = await latest();
      const telemetryKeys = widget.keys.filter((k) => k.source === 'telemetry');
      const { pairs, shown } = trendPairs(own, telemetryKeys);
      const historyIds = [...new Set(shown.map((p) => p.row.instrumentId))];
      const byInstrument = await fetchWidgetHistory(historyIds, telemetryKeys.map((k) => k.key), input.period);
      const { plotted, shared, unit } = trendPlot(shown, telemetryKeys, byInstrument, words);
      if (pairs.length > shown.length) notes.push(`Showing ${shown.length} of ${pairs.length} series, as the widget draws them.`);
      const notPlotted = plotted.reduce((n, p) => {
        const s = byInstrument.get(p.instrumentId)?.summaries[p.key];
        return n + (s ? Math.max(0, s.count - s.numericCount) : 0);
      }, 0);
      if (notPlotted > 0) notes.push(`${groupDigits(notPlotted)} text readings are not plotted; they are counted under Readings.`);
      if (plotted.some((p) => byInstrument.get(p.instrumentId)?.historySampled)) {
        notes.push('The chart is drawn from a sample of the readings; Minimum, Maximum, Average and Readings are over every reading in the period.');
      }
      let image: RasterImage | null = null;
      if (plotted.some((p) => p.series.points.length > 0)) {
        const [{ renderChartToPng }, { CHART_HEIGHTS }] = await Promise.all([
          import('@/routes/instruments/chart-image'), import('../time-series-chart'),
        ]);
        image = await renderChartToPng({
          title: widget.title,
          unit,
          spanMs: Date.parse(input.period.to) - Date.parse(input.period.from),
          min: shared?.limitMin ?? null,
          max: shared?.limitMax ?? null,
          minText: shared?.limitMinText ?? null,
          maxText: shared?.limitMaxText ?? null,
          series: plotted.map((p) => p.series),
          height: CHART_HEIGHTS.trend,
        });
        if (!image) notes.push(PICTURE_MISSING);
        // The chart's legend is HTML beside its SVG, so the raster has none: with
        // several lines, the key is drawn under the picture (which line is which).
        if (image && plotted.length > 1) {
          const { pictureWithLegend } = await import('@/lib/svg-raster');
          const keyed = await pictureWithLegend(image, plotted.map((p) => ({ label: p.series.label, color: p.series.color ?? '' })));
          if (keyed) image = keyed;
          else notes.push("The chart's key could not be drawn by this browser; the table names each series.");
        }
      }
      return { rows: rowsForTrendChart(plotted, byInstrument, cells), image, notes };
    }
    case 'timeseries_table': {
      if (!input.period) throw new Error('A time series report needs a period.');
      const { own, cells } = await latest();
      const keys = widget.keys.filter((k) => k.source === 'telemetry');
      const carriers = own.filter((r) => keys.some((k) => valueOf(r, k)?.ts != null));
      const queried = carriers.slice(0, WIDGET_INSTRUMENTS_MAX);
      if (queried.length < carriers.length) notes.push(`Readings of the first ${queried.length} of ${carriers.length} instruments, as the widget asks for them.`);
      const wanted = [...keys.map((k) => k.key), ...extras.filter((r) => r.source === 'telemetry').map((r) => r.key).filter((k) => !keys.some((w) => w.key === k))];
      const asked = wanted.slice(0, DATA_KEYS_PER_REQUEST_MAX);
      if (asked.length < wanted.length) notes.push(`Not read (more than ${DATA_KEYS_PER_REQUEST_MAX} keys in one request): ${wanted.slice(asked.length).join(', ')}.`);
      const { rows: history, total } = await fetchAllTimeseries(queried.map((r) => r.instrumentId), asked, input.period);
      if (history.length < total) notes.push(`The first ${groupDigits(history.length)} of ${groupDigits(total)} stored instants, newest first.`);
      const byId = new Map(own.map((r) => [r.instrumentId, r]));
      // The instruments' attributes only: a `key:` cell of a time series row is the INSTANT's value.
      const attrs = new Map([...cells].map(([id, c]) => [id, Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith('attr:')))]));
      return { rows: rowsForTimeseriesTable(history, byId, keys, asked.slice(keys.length), fmt, attrs), image: null, notes };
    }
    case 'bar_chart': {
      if (!input.period) throw new Error('A bar chart report needs a period.');
      const { own, cells } = await latest();
      const bucket = widget.options.bucket ?? BAR_DEFAULTS.bucket;
      const agg = widget.options.agg ?? BAR_DEFAULTS.agg;
      const groupBy = widget.options.groupBy ?? BAR_DEFAULTS.groupBy;
      const keys = widget.keys.filter((k) => k.source === 'telemetry');
      const plan = barPlan(own, keys, groupBy);
      if (plan.tooMany) {
        notes.push(tooManyBarsText(plan.tooMany.instruments, plan.tooMany.keys));
        return { rows: [], image: null, notes };
      }
      if (plan.asked.length < plan.total) notes.push(`Showing ${plan.asked.length} of ${plan.total} instruments, as the widget asks for them.`);
      const url = telemetryBucketsUrl(plan.asked.map((r) => r.instrumentId), keys.map((k) => k.key), input.period, bucket, agg, groupBy);
      if (!url) return { rows: [], image: null, notes };
      const resp = await apiClient.get<TelemetryBuckets>(url);
      const model = barModel(resp, keys, plan.asked, groupBy, dates);
      if (model.unsent.length) notes.push(`No readings for ${model.unsent.join(', ')} in this period.`);
      let image: RasterImage | null = null;
      if (model.series.length > 0) {
        image = await chartPicture(buildBarOption(model, barAxis(model, REPORT_CHART_WIDTH), barLegendRows(model.series.map((s) => s.legendName), REPORT_CHART_WIDTH)), BAR_HEIGHT);
        if (!image) notes.push(PICTURE_MISSING);
      }
      const codes = new Map(own.map((r) => [r.instrumentId, r.code]));
      return { rows: rowsForBarChart(model, (id) => codes.get(id), cells), image, notes };
    }
    case 'alarm_table': {
      const { rows: alarms, total } = await fetchAllAlarms(widgetAlarmScope(widget.source, selection), input.alarmFilters);
      if (alarms.length < total) notes.push(`The first ${groupDigits(alarms.length)} of ${groupDigits(total)} alarms, newest first.`);
      const cells = await cellsFor([...new Set(alarms.map((a) => a.instrumentId))]);
      return { rows: rowsForAlarmTable(alarms, input.alarm.texts, input.alarm.statusTexts, fmt, cells), image: null, notes };
    }
    case 'pie_chart': {
      let slices: PieSlice[];
      let about: Parameters<typeof buildPieOption>[1];
      if (widget.options.of === 'alarm_types') {
        const url = alarmCountsUrl(widgetAlarmScope(widget.source, selection));
        const counts = url ? await apiClient.get<AlarmCounts>(url) : { quadrants: { activeUnack: 0, activeAck: 0, clearedUnack: 0, clearedAck: 0 }, byType: [] };
        slices = alarmTypePieModel(counts.byType, input.alarm.typeNames);
        about = { subject: 'alarm_types' };
      } else {
        const rows = await fetchOverview(widget, selection);
        slices = statusPieModel(rows);
        about = { subject: 'status', total: rows.length };
      }
      let image: RasterImage | null = null;
      if (slices.length > 0) {
        const plan = piePlan(slices, REPORT_CHART_WIDTH);
        image = await chartPicture(buildPieOption(slices, about, plan), plan.height);
        if (!image) notes.push(PICTURE_MISSING);
      }
      return { rows: rowsForPieChart(slices), image, notes };
    }
    case 'alarm_counts': {
      const url = alarmCountsUrl(widgetAlarmScope(widget.source, selection));
      if (!url) return { rows: [], image: null, notes };
      return { rows: rowsForAlarmCounts(await apiClient.get<AlarmCounts>(url), input.alarm.typeNames), image: null, notes };
    }
    case 'status_grid':
    case 'instrument_list': {
      const rows = await fetchOverview(widget, selection);
      const cells = await cellsFor(rows.map((r) => r.instrumentId));
      return {
        rows: widget.type === 'status_grid' ? rowsForStatusGrid(rows, cells) : rowsForInstrumentList(rows, fmt, cells),
        image: null,
        notes,
      };
    }
    case 'text_card':
      return { rows: [{ text: widget.options.text ?? '' }], image: null, notes };
    case 'floorplan': {
      const svg = input.floorplanSvg?.() ?? null;
      if (!svg) return { rows: [], image: null, notes: ['The floor plan is not on screen, so no picture of it could be printed.'] };
      const { svgElementToPng } = await import('@/lib/svg-raster');
      const image = await svgElementToPng(svg);
      return { rows: [], image, notes: image ? notes : ['The floor plan picture could not be drawn by this browser.'] };
    }
  }
}

// ── The plan, while the dialog is open ─────────────────────────────────────

/** A row of `GET /api/report-templates` — the server's, as returned. */
export interface ReportTemplateRow {
  id: string;
  profileId: string;
  widgetType: WidgetType;
  name: string;
  isDefault: boolean;
  document: unknown;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface PlanSection {
  profileId: string;
  profileName: string;
  /** The widget's instruments of this profile that the viewer can see, in the widget's order. */
  instrumentIds: string[];
  /** The server's resolution: the profile's default template for the type, or null = the built-in. */
  resolved: ReportTemplateRow | null;
  /** Every template this profile has for the type (the picker). */
  templates: ReportTemplateRow[];
  /** This profile's field catalogue ids (`[]` for a type with no fields). */
  availableIds: string[];
}

/** `/resolve` takes at most this many ids; a selection of ~320 is asked in runs and merged. */
const RESOLVE_IDS_MAX = 200;

interface ResolvedSection { profileId: string; profileName: string; instrumentIds: string[]; template: ReportTemplateRow | null }

async function resolveSections(type: WidgetType, ids: readonly string[]): Promise<ResolvedSection[]> {
  const merged = new Map<string, ResolvedSection>();
  for (let k = 0; k < ids.length; k += RESOLVE_IDS_MAX) {
    const qs = new URLSearchParams({ widgetType: type, instrumentIds: ids.slice(k, k + RESOLVE_IDS_MAX).join(',') });
    const { sections } = await apiClient.get<{ sections: ResolvedSection[] }>(`/api/report-templates/resolve?${qs.toString()}`);
    for (const s of sections ?? []) {
      const held = merged.get(s.profileId);
      if (held) held.instrumentIds.push(...s.instrumentIds);
      else merged.set(s.profileId, { ...s, instrumentIds: [...s.instrumentIds] });
    }
  }
  return [...merged.values()];
}

async function profileDetails(type: WidgetType, profileIds: readonly string[], withCatalogue: boolean) {
  return Promise.all(profileIds.map(async (profileId) => {
    const qs = new URLSearchParams({ profileId, widgetType: type }).toString();
    const [list, catalogue] = await Promise.all([
      apiClient.get<{ data: ReportTemplateRow[] }>(`/api/report-templates?${qs}`),
      withCatalogue ? apiClient.get<{ fields: ReportField[] }>(`/api/report-templates/catalogue?${qs}`) : Promise.resolve({ fields: [] as ReportField[] }),
    ]);
    return { profileId, templates: list.data ?? [], availableIds: (catalogue.fields ?? []).map((f) => f.id) };
  }));
}

/**
 * Which template each of the widget's profiles uses — the server's answer —
 * with each profile's templates and catalogue. Every type resolves its
 * selection, a text card included (fix wave 1): the sections' instrument ids
 * are the VISIBLE instruments the widget covers, and they scope the report's
 * approval request like any other. A text card prints the built-in, so its
 * profiles' template lists and catalogues are not asked.
 */
export function useWidgetReportPlan(widget: CustomWidget, selection: WidgetSelection): {
  ids: string[];
  sections: PlanSection[];
  loading: boolean;
  error: unknown;
} {
  const { ids, loading: idsLoading, error: idsError } = useWidgetInstrumentIds(widget.source, selection);
  const wanted = !idsLoading && !idsError;
  const resolved = useSWR<ResolvedSection[]>(
    wanted && ids.length > 0 ? ['widget-report-resolve', widget.type, ids.join(',')] : null,
    () => resolveSections(widget.type, ids),
    { revalidateOnFocus: false },
  );
  const profileIds = (resolved.data ?? []).map((s) => s.profileId);
  const fieldless = WIDGET_REPORT_FIELDS[widget.type].length === 0;
  const pickable = widget.type !== 'text_card';
  const details = useSWR(
    pickable && profileIds.length > 0 ? ['widget-report-templates', widget.type, profileIds.join(',')] : null,
    () => profileDetails(widget.type, profileIds, !fieldless),
    { revalidateOnFocus: false },
  );
  const sections: PlanSection[] = (resolved.data ?? []).map((s) => {
    const d = details.data?.find((x) => x.profileId === s.profileId);
    return {
      profileId: s.profileId,
      profileName: s.profileName,
      instrumentIds: s.instrumentIds,
      resolved: s.template,
      templates: d?.templates ?? [],
      availableIds: d?.availableIds ?? [],
    };
  });
  const asked = wanted && ids.length > 0;
  const loading = idsLoading
    || (asked && resolved.data === undefined && !resolved.error)
    || (pickable && profileIds.length > 0 && details.data === undefined && !details.error);
  return { ids, sections, loading, error: idsError ?? resolved.error ?? details.error };
}
