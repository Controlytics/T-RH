/**
 * The BAR CHART widget's decisions, pure (dashboard builder phase 2).
 *
 * Readings binned into LOCAL hours, days or weeks and aggregated on the SERVER
 * (`GET /api/instruments/telemetry-buckets`). **Every bar is a COMPUTED value**,
 * and the widget says so on its face — "Hourly average", "Daily maximum",
 * "Weekly reading count" — and in each bar's tooltip ("from N readings"): the
 * `telemetry-aggregate.ts` rule, a derived value that looks like a recorded one
 * is a misrepresentation on a §11 system.
 *
 * - **Bucket edges are the server's** (local to the `datetime` config's zone).
 *   The axis lists every bucket the window TOUCHES, so a day with no reading is
 *   an empty slot and never silently dropped: the buckets between, before and
 *   after the returned ones are found by stepping the server's own
 *   `bucketSeconds` from the server's own bucket starts — arithmetic over the
 *   response, never a calendar computed here. ASSUMPTION: the configured zone
 *   has no daylight saving (the installation's zone is Asia/Kolkata), so every
 *   day bucket is `bucketSeconds` long. Under DST a filled slot could sit an
 *   hour off the server's edge; every RETURNED start is still on the axis (the
 *   fill is a union with them), so no bar is ever lost or misplaced.
 * - **A gap is `null`, never 0** — a bucket with no reading has no point, and a
 *   zero would be a reading nobody took.
 * - **A PARTIAL bucket** (`ts < from` or `ts + bucketSeconds > to`, judged on
 *   the RESPONSE's window, which is the window the data was computed for) is
 *   drawn in the same hue, lighter, and its tooltip says so in words.
 * - **Colours by the ASKED position (R6-1)**: all combined — the key's own colour,
 *   else its index in the widget's keys; each instrument — (instrument index ×
 *   key count + key index), so a series that comes back empty moves no other
 *   series' colour. One instrument asked: the key's colour, as the trend chart.
 * - **No verdict (R6-8)**: no limit lines and no status colour — an aggregate is
 *   not a reading and is never judged. Series colours only.
 * - **Decimals (R6-6)**: a count is a whole number. Otherwise a measured key
 *   prints at the server's decimals (the LARGEST of them when several
 *   instruments are combined — presentation precision of a computed number, not
 *   a judgement), and a raw key at the widget's decimals, else at the precision
 *   of the series' own values (`decimalsSeen`). A key measured on some combined
 *   instruments and raw on others prints at the measured instruments' decimals:
 *   the server administers that quantity's precision.
 */
import {
  BAR_SERIES_MAX, WIDGET_INSTRUMENTS_MAX, clampDecimals,
  type LatestKeyValue, type LatestValuesRow, type WidgetKey,
} from '@digilog/shared';
// Type-only, and erased from the build: nothing here pulls ECharts in statically.
import type { EChartsCoreOption } from 'echarts/core';
import { CHART_FONT_FAMILY, CHART_INK, SERIES_HEX } from './charts/chart-colors';
import { codeAxis, escapeHtml, type CodeAxis } from './comparison-model';
import { decimalsSeen, isMeasured } from './key-value';
import type { BarAgg, BarBucket, BarGroup, TelemetryBuckets } from './use-widget-data';
import { LOAD_FAILED, valueOf } from './widget-common';

/**
 * What a bar chart shows when its options do not say — the server's own
 * querystring defaults. The ONE copy: the Add widget dialog and the renderer
 * both read it.
 */
export const BAR_DEFAULTS: Readonly<{ bucket: BarBucket; agg: BarAgg; groupBy: BarGroup }> = {
  bucket: 'hour', agg: 'avg', groupBy: 'all',
};

/**
 * The chart's height, in px: the default bar chart panel (9 rows, 488 px) holds
 * 416 px inside its header, border and padding — the caption row (28), one note
 * line (24) and the chart, whole (render check). A second note scrolls the card.
 */
export const BAR_HEIGHT = 352;

/** How much lighter a partial bucket's bar is drawn: same hue, this opacity. */
export const PARTIAL_OPACITY = 0.4;

/** The tooltip's words for a bucket the window covers only in part. */
export const PARTIAL_NOTE = 'Partial bucket — the window covers only part of it';

const BUCKET_WORD: Record<BarBucket, string> = { hour: 'Hourly', day: 'Daily', week: 'Weekly' };
const AGG_WORD: Record<BarAgg, string> = { avg: 'average', min: 'minimum', max: 'maximum', count: 'reading count' };

/** What the bars are computed from, shown under the card title: "Daily average". */
export function barCaption(bucket: BarBucket, agg: BarAgg): string {
  return `${BUCKET_WORD[bucket]} ${AGG_WORD[agg]}`;
}

const counted = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Each instrument would draw more series than the palette has colours. */
export function tooManyBarsText(instruments: number, keys: number): string {
  return `Too many bars: ${counted(instruments, 'instrument', 'instruments')} × ${counted(keys, 'key', 'keys')}. `
    + 'Show all instruments combined, or choose fewer.';
}

export interface BarPlan {
  /** The instruments asked for, in the selection's order. */
  asked: LatestValuesRow[];
  /** How many instruments have sent one of the keys — the asked ones and the rest. */
  total: number;
  /** Each instrument, more series than `BAR_SERIES_MAX`: nothing is asked. */
  tooMany: { instruments: number; keys: number } | null;
}

/**
 * Which instruments a bar chart asks for. Only those that have SENT one of the
 * keys (the trend chart's rule — one that never sent cannot add a bar), the
 * first `WIDGET_INSTRUMENTS_MAX` of them (the server refuses more); the widget
 * says "Showing X of Y instruments" when it cut.
 */
export function barPlan(rows: readonly LatestValuesRow[], keys: readonly WidgetKey[], groupBy: BarGroup): BarPlan {
  const sent = rows.filter((row) => keys.some((key) => valueOf(row, key)?.ts != null));
  if (groupBy === 'instrument' && sent.length * keys.length > BAR_SERIES_MAX) {
    return { asked: [], total: sent.length, tooMany: { instruments: sent.length, keys: keys.length } };
  }
  return { asked: sent.slice(0, WIDGET_INSTRUMENTS_MAX), total: sent.length, tooMany: null };
}

/** A refusal (400) is said in the server's own words; anything else is the generic failure. */
export function barLoadProblem(error: unknown): string {
  const e = error as { status?: unknown; message?: unknown } | null | undefined;
  if (e && e.status === 400 && typeof e.message === 'string' && e.message.trim() !== '') return e.message;
  return LOAD_FAILED;
}

/**
 * Every bucket start the window touches, in ms, ascending: the returned starts,
 * and the empty buckets between, before and after them, stepped from those
 * starts by the server's `bucketSeconds` (see the no-DST assumption above). A
 * bucket starting exactly at `to` covers one instant and is not filled — if a
 * reading lies there the server returned it, and it is on the axis.
 */
function bucketStarts(resp: TelemetryBuckets): number[] {
  const step = resp.bucketSeconds * 1000;
  const from = Date.parse(resp.from);
  const to = Date.parse(resp.to);
  const returned = [...new Set(resp.series.flatMap((s) => s.points.map((p) => Date.parse(p.ts))))].sort((a, b) => a - b);
  if (returned.length === 0 || !(step > 0)) return returned;
  const out: number[] = [];
  for (let t = returned[0] - step; t + step > from; t -= step) out.unshift(t);
  returned.forEach((t, n) => {
    out.push(t);
    const next = returned[n + 1];
    if (next !== undefined) for (let u = t + step; u < next - step / 2; u += step) out.push(u);
  });
  for (let t = returned[returned.length - 1] + step; t < to; t += step) out.push(t);
  return out;
}

export interface BarPoint {
  /** The server's computed value. */
  value: number;
  /** How many readings it was computed from. */
  readings: number;
  /** How many instruments contributed (all combined). */
  instruments: number;
}

export interface BarSeries {
  /** The tooltip's name: the key's label, or "<code> · <label>" for each instrument. */
  name: string;
  /** The legend's: the name, with the unit when the value axis cannot name one. */
  legendName: string;
  color: string;
  unit: string | null;
  decimals: number;
  /** One per category; `null` is a gap. */
  points: (BarPoint | null)[];
}

export interface BarModel {
  agg: BarAgg;
  groupBy: BarGroup;
  /** The bucket starts, UTC ISO instants, ascending. */
  categories: string[];
  /** The axis labels: the date (day, week) or the date and time (hour), administered format. */
  labels: string[];
  /** Per category: the window covers only part of the bucket. */
  partial: boolean[];
  /** The value axis's unit, when every series shares one (a count has none). */
  unit: string | null;
  series: BarSeries[];
  /** The labels of the keys with no readings in the window, in the widget's key order. */
  unsent: string[];
}

/** `useDatetimeFormat()`'s two formatters — passed in, so this stays pure. */
export interface BarDateFormat {
  formatDate: (value: string) => string;
  formatDateTime: (value: string) => string;
}

/** The precision and unit of one series (R6-6): `covers` is the instruments behind it. */
function seriesNumbers(
  agg: BarAgg,
  key: WidgetKey,
  covers: readonly LatestValuesRow[],
  values: readonly number[],
): { decimals: number; unit: string | null } {
  if (agg === 'count') return { decimals: 0, unit: null };
  const measured = covers
    .map((row) => valueOf(row, key))
    .filter((v): v is LatestKeyValue => v !== undefined && isMeasured(v));
  if (measured.length === 0) return { decimals: key.decimals ?? decimalsSeen(values), unit: key.unit ?? null };
  const administered = measured.filter((v) => v.decimals !== null).map((v) => clampDecimals(v.decimals));
  const units = new Set(measured.map((v) => v.unit));
  return {
    decimals: administered.length > 0 ? Math.max(...administered) : key.decimals ?? decimalsSeen(values),
    unit: units.size === 1 ? [...units][0] : null,
  };
}

export function barModel(
  resp: TelemetryBuckets,
  keys: readonly WidgetKey[],
  asked: readonly LatestValuesRow[],
  groupBy: BarGroup,
  fmt: BarDateFormat,
): BarModel {
  const starts = bucketStarts(resp);
  const slot = new Map(starts.map((t, n) => [t, n]));
  const step = resp.bucketSeconds * 1000;
  const from = Date.parse(resp.from);
  const to = Date.parse(resp.to);
  const categories = starts.map((t) => new Date(t).toISOString());
  const label = resp.bucket === 'hour' ? fmt.formatDateTime : fmt.formatDate;

  // The series ASKED, in the asked order: its position is its colour (R6-1).
  const owners: (LatestValuesRow | null)[] = groupBy === 'instrument' ? [...asked] : [null];
  const byKey = owners.length === 1;
  const plotted = owners.flatMap((owner, i) => keys.flatMap((key, k) => {
    const id = owner ? owner.instrumentId : null;
    const got = resp.series.find((s) => s.instrumentId === id && s.key === key.key);
    if (!got || got.points.length === 0) return [];
    const points: (BarPoint | null)[] = starts.map(() => null);
    for (const p of got.points) {
      const n = slot.get(Date.parse(p.ts));
      if (n !== undefined) points[n] = { value: p.value, readings: p.readings, instruments: p.instruments };
    }
    const position = byKey ? key.color ?? k : i * keys.length + k;
    const keyLabel = key.label ?? key.key;
    const series: Omit<BarSeries, 'legendName'> = {
      name: owner ? `${owner.code} · ${keyLabel}` : keyLabel,
      color: SERIES_HEX[Math.min(position, SERIES_HEX.length - 1)],
      ...seriesNumbers(resp.agg, key, owner ? [owner] : asked, got.points.map((p) => p.value)),
      points,
    };
    return [{ key, series }];
  }));

  const units = new Set(plotted.map((p) => p.series.unit));
  const unit = units.size === 1 ? [...units][0] : null;
  return {
    agg: resp.agg,
    groupBy,
    categories,
    labels: categories.map((c) => label(c)),
    partial: starts.map((t) => t < from || t + step > to),
    unit,
    series: plotted.map(({ series: s }) => ({
      ...s,
      // The axis names one shared unit; when it cannot, each legend entry names its own.
      legendName: unit === null && s.unit ? `${s.name} (${s.unit})` : s.name,
    })),
    // "No readings" = asked minus returned (R6-2): for each instrument, a key
    // counts as read when ANY asked instrument returned it.
    unsent: keys.filter((key) => !plotted.some((p) => p.key === key)).map((key) => key.label ?? key.key),
  };
}

/**
 * One bucket's tooltip: its date (and time), PARTIAL in words when it is, then
 * each series' computed value and what it was computed from. Escaped: labels
 * are typed by someone else.
 */
export function barTooltip(m: BarModel, index: number): string {
  const head = `<div style="font-weight:700;color:${CHART_INK.strong}">${escapeHtml(m.labels[index] ?? '')}</div>`;
  const partial = m.partial[index]
    ? `<div style="margin-top:2px;font-size:11px;color:${CHART_INK.muted}">${escapeHtml(PARTIAL_NOTE)}</div>`
    : '';
  const lines = m.series.map((s) => {
    const p = s.points[index] ?? null;
    const shown = p ? `${p.value.toFixed(s.decimals)}${s.unit ? ` ${s.unit}` : ''}` : 'No readings';
    const basis = p
      ? [`from ${counted(p.readings, 'reading', 'readings')}`,
        ...(m.groupBy === 'all' ? [counted(p.instruments, 'instrument', 'instruments')] : [])].join(' · ')
      : null;
    return '<div style="display:flex;align-items:center;gap:8px;margin-top:6px">'
      + `<span style="flex:none;width:8px;height:8px;border-radius:2px;background:${s.color}"></span>`
      + `<span style="flex:1;color:${CHART_INK.body}">${escapeHtml(s.name)}</span>`
      + `<b style="margin-left:16px;color:${CHART_INK.strong};font-variant-numeric:tabular-nums">${escapeHtml(shown)}</b>`
      + '</div>'
      + (basis ? `<div style="margin-left:16px;font-size:11px;color:${CHART_INK.muted}">${escapeHtml(basis)}</div>` : '');
  });
  return head + partial + lines.join('');
}

/** One legend row's height, in px: a 12 px label and the legend's 16 px item gap, as ECharts lays it out. */
export const LEGEND_ROW_PX = 26;
/** A legend label's width at 12 px semibold Inter, per character (an estimate, a little generous). */
const LEGEND_PX_PER_CHAR = 12 * 0.62;
/** Beside each label: its 10 px icon, the 5 px before the text, the 16 px to the next item. */
const LEGEND_ITEM_EXTRA_PX = 10 + 5 + 16;

/**
 * How many rows the legend wraps to at the chart's width — the plot starts below
 * the last of them. Each instrument's names are long ("CWH/RDU/101-01 ·
 * Temperature"), and three in a third-width card wrap to three rows that ran
 * into the plot (render check). One series has no legend; an unknown width (the
 * first frame) is one row.
 */
export function legendRows(names: readonly string[], width: number | null): number {
  if (names.length <= 1) return 0;
  if (width === null || width <= 0) return 1;
  let rows = 1;
  let x = 0;
  for (const name of names) {
    const item = name.length * LEGEND_PX_PER_CHAR + LEGEND_ITEM_EXTRA_PX;
    // The last item on a row needs no gap after it.
    if (x > 0 && x + item - 16 > width) {
      rows += 1;
      x = 0;
    }
    x += item;
  }
  return rows;
}

type TooltipParams = { dataIndex: number } | { dataIndex: number }[];

export function buildBarOption(
  m: BarModel,
  axis: CodeAxis = codeAxis(m.labels, null),
  rows: number = m.series.length > 1 ? 1 : 0,
): EChartsCoreOption {
  const legend = m.series.length > 1;
  return {
    color: m.series.map((s) => s.color),
    textStyle: { fontFamily: CHART_FONT_FAMILY },
    // Room above the plot for every legend row, then for the unit's name over the value axis.
    grid: { left: 4, right: 12, top: (legend ? rows * LEGEND_ROW_PX : 0) + (m.unit ? 28 : 14), bottom: 4, containLabel: true },
    legend: {
      show: legend,
      top: 0,
      left: 0,
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 16,
      textStyle: { color: CHART_INK.body, fontSize: 12, fontWeight: 600, fontFamily: CHART_FONT_FAMILY },
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(98, 116, 142, 0.08)' } },
      backgroundColor: '#ffffff',
      borderColor: CHART_INK.rule,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: CHART_INK.body, fontSize: 12, fontFamily: CHART_FONT_FAMILY },
      extraCssText: 'border-radius:8px;box-shadow:0 8px 20px rgba(15,23,43,0.10);',
      formatter: (params: TooltipParams) => barTooltip(m, Array.isArray(params) ? params[0]?.dataIndex ?? 0 : params.dataIndex),
    },
    xAxis: {
      type: 'category',
      data: m.labels,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: CHART_INK.axis } },
      axisLabel: {
        color: CHART_INK.body,
        fontSize: 11,
        fontWeight: 600,
        margin: 10,
        // codeAxis decides (Task 5's rule): level, 45°, or upright with a stride.
        rotate: axis.rotate,
        interval: axis.interval,
        hideOverlap: true,
      },
    },
    yAxis: {
      type: 'value',
      name: m.unit ?? '',
      nameGap: 12,
      nameTextStyle: { color: CHART_INK.muted, fontSize: 11, fontWeight: 600, align: 'left' },
      // A count steps by whole readings.
      ...(m.agg === 'count' ? { minInterval: 1 } : {}),
      axisLabel: { color: CHART_INK.muted, fontSize: 11 },
      splitLine: { lineStyle: { color: CHART_INK.rule, type: 'dashed' } },
    },
    series: m.series.map((s) => ({
      type: 'bar',
      name: s.legendName,
      // A gap is null; a partial bucket is the same hue, lighter.
      data: s.points.map((p, n) => {
        if (p === null) return null;
        return m.partial[n] ? { value: p.value, itemStyle: { opacity: PARTIAL_OPACITY } } : p.value;
      }),
      itemStyle: { color: s.color, borderRadius: [4, 4, 0, 0] },
      barMaxWidth: 28,
      barGap: '20%',
      barCategoryGap: '32%',
    })),
  };
}
