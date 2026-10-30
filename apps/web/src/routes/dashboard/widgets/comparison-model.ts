/**
 * The COMPARISON BARS widget's decisions, pure (dashboard builder phase 2).
 *
 * Each instrument's latest value of each key, side by side: the instruments on
 * the category axis in the server's order, one bar series per key.
 *
 * - **Series colours, never verdicts, and no limit lines** (plan ruling P4): the
 *   bounds of several instruments may disagree, and one line or one red bar
 *   drawn for one of them would misstate the others. A bar is a length; the
 *   tooltip says what the value card would.
 * - **A value that is not a number is a GAP (`null`), never 0** — text, true /
 *   false, a key never sent, and a FAULTED measured reading (a range fault arrives
 *   with its number, OL = 60, and that number is not a reading).
 * - **The tooltip prints `keyCell`'s text and unit**: the server's unit for a
 *   measured key, the widget's for a raw one, and NA / the fault word / the text
 *   as received for a gap — escaped, because device text and labels are typed by
 *   someone else.
 * - At most `WIDGET_INSTRUMENTS_MAX` instruments are drawn, spent only on
 *   instruments that have SENT one of the keys (the trend chart's rule); the
 *   widget says how many it drew of how many.
 * - A key no DRAWN instrument has sent is not drawn as an empty series. Only a
 *   key no instrument of the WIDGET has sent is named in `unsent` ("No readings
 *   for …"): one sent only past the cap HAS readings, and "Showing 50 of N"
 *   already says why it is not drawn (fix round 2 — the note was false there).
 * - Mixed units: each legend name carries its own unit ("Temperature (°C)"),
 *   since the value axis can name only one.
 */
import { coerceReading, WIDGET_INSTRUMENTS_MAX, type LatestValuesRow, type WidgetKey } from '@digilog/shared';
// Type-only, and erased from the build: nothing here pulls ECharts in statically.
import type { EChartsCoreOption } from 'echarts/core';
import type { SensorWords } from '@/hooks/use-failure-text';
import { CHART_FONT_FAMILY, CHART_INK, SERIES_HEX } from './charts/chart-colors';
import { keyCell } from './key-value';
import { keyColorSlots, keysNotSent, valueOf } from './widget-common';

/**
 * The chart's height, in px: the default comparison panel (9 rows, 488 px) shows
 * it whole with its "Showing X of Y" line — 408 px inside the card's header,
 * border and padding (render check).
 */
export const COMPARISON_HEIGHT = 376;

/** Before the chart's width is known: more instruments than this and the codes turn. */
const TURN_LABELS_ABOVE = 8;
/** A category label's width at the axis's 11 px semibold Inter, per character (an estimate, a little generous). */
export const CODE_PX_PER_CHAR = 11 * 0.62;
/** The value axis and the grid's margins, out of the chart's width. */
export const VALUE_AXIS_PX = 56;
/** How far apart two shown codes must sit ACROSS their text: an 11 px line and its air. */
const CODE_LINE_PX = 16;

/** How the instrument codes stand on the axis: the turn, and ECharts' `interval` (codes skipped between two shown). */
export interface CodeAxis {
  rotate: 0 | 45 | 90;
  interval: number | 'auto';
}

/**
 * How the codes stand, measured against the width each bar group gets — a count
 * alone cannot know the panel (three codes in a quarter-width card overlapped and
 * ECharts HID one, leaving a bar nobody could name). Never a block (review M3):
 *
 * - level, every code, while the longest fits its bar group;
 * - else turned 45°, every code, while neighbours stay a line apart across the
 *   text (`per · sin 45°`);
 * - else UPRIGHT with a stride: every (interval + 1)th code, the smallest stride
 *   that keeps shown codes a line apart. The tooltip names every bar.
 *
 * Unknown width (the first frame): the count decides, and ECharts thins.
 */
export function codeAxis(codes: readonly string[], width: number | null): CodeAxis {
  const n = codes.length;
  if (n === 0) return { rotate: 0, interval: 0 };
  if (width === null || width <= 0) return n > TURN_LABELS_ABOVE ? { rotate: 45, interval: 'auto' } : { rotate: 0, interval: 0 };
  const per = (width - VALUE_AXIS_PX) / n;
  const longest = Math.max(...codes.map((c) => c.length)) * CODE_PX_PER_CHAR;
  if (longest <= per - 8) return { rotate: 0, interval: 0 };
  if (per * Math.SQRT1_2 >= CODE_LINE_PX) return { rotate: 45, interval: 0 };
  return { rotate: 90, interval: Math.max(0, Math.ceil(CODE_LINE_PX / per) - 1) };
}

export interface ComparisonPoint {
  /** The bar's length, or null — a gap. */
  value: number | null;
  /** What the value card would print: the number, NA, a fault word or text. */
  text: string;
  unit: string | null;
}

export interface ComparisonSeries {
  /** The key's label — the tooltip's, whose values carry their own units. */
  name: string;
  /** The legend's name: the label, with the series' unit when the axis cannot name one. */
  legendName: string;
  color: string;
  points: ComparisonPoint[];
}

export interface ComparisonModel {
  /** The instrument codes drawn, in order. */
  codes: string[];
  /** How many instruments have sent one of the keys (the drawn ones and the rest). */
  total: number;
  /** The value axis's unit, when every plotted value shares one. */
  unit: string | null;
  series: ComparisonSeries[];
  /** The labels of the keys NO instrument of the widget has sent, in the widget's key order. */
  unsent: string[];
}

export function comparisonModel(
  rows: readonly LatestValuesRow[],
  keys: readonly WidgetKey[],
  words: SensorWords,
): ComparisonModel {
  const sent = rows.filter((row) => keys.some((key) => valueOf(row, key)?.ts != null));
  const drawn = sent.slice(0, WIDGET_INSTRUMENTS_MAX);
  // Not DRAWN: no drawn instrument has the key, so no series for it.
  const undrawnKeys = keysNotSent(drawn, keys);
  // The colour is the KEY's (its slot among the widget's keys), so dropping a key
  // moves no colour; a key's chosen colour is its own, and a key without one
  // never takes a slot another key chose (fix round 1, m-7).
  const slots = keyColorSlots(keys);
  const plotted = keys
    .map((key, n) => ({ key, color: SERIES_HEX[Math.min(slots[n], SERIES_HEX.length - 1)] }))
    .filter(({ key }) => !undrawnKeys.includes(key))
    .map(({ key, color }) => ({
      name: key.label ?? key.key,
      color,
      points: drawn.map((row): ComparisonPoint => {
        const v = valueOf(row, key);
        const cell = keyCell(v, row.reporting, key, words);
        return { value: cell.fault ? null : coerceReading(v?.value), text: cell.text, unit: cell.unit };
      }),
    }));
  const unitsOf = (points: readonly ComparisonPoint[]) => new Set(points.filter((p) => p.value !== null).map((p) => p.unit));
  const all = unitsOf(plotted.flatMap((s) => s.points));
  const unit = all.size === 1 ? [...all][0] : null;
  const series = plotted.map((s) => {
    const own = unitsOf(s.points);
    const ownUnit = own.size === 1 ? [...own][0] : null;
    // The axis names one shared unit; when it cannot, each legend entry names its own.
    return { ...s, legendName: unit === null && ownUnit ? `${s.name} (${ownUnit})` : s.name };
  });
  return {
    codes: drawn.map((row) => row.code),
    total: sent.length,
    unit,
    series,
    // "No readings" is a statement about the WIDGET's instruments, every one of them
    // (the gauge's rule), never only the drawn ones.
    unsent: keysNotSent(rows, keys).map((key) => key.label ?? key.key),
  };
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** For an ECharts tooltip, which is HTML: device text and labels are typed by someone else. */
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** The tooltip for one instrument: its code, then each key as the value card prints it. */
export function comparisonTooltip(m: ComparisonModel, index: number): string {
  const lines = m.series.map((s) => {
    const p = s.points[index];
    const shown = p ? (p.unit ? `${p.text} ${p.unit}` : p.text) : '';
    return '<div style="display:flex;align-items:center;gap:8px;margin-top:4px">'
      + `<span style="flex:none;width:8px;height:8px;border-radius:2px;background:${s.color}"></span>`
      + `<span style="flex:1;color:${CHART_INK.body}">${escapeHtml(s.name)}</span>`
      + `<b style="margin-left:16px;color:${CHART_INK.strong};font-variant-numeric:tabular-nums">${escapeHtml(shown)}</b>`
      + '</div>';
  });
  return `<div style="font-weight:700;color:${CHART_INK.strong}">${escapeHtml(m.codes[index] ?? '')}</div>${lines.join('')}`;
}

type TooltipParams = { dataIndex: number } | { dataIndex: number }[];

export function buildComparisonOption(m: ComparisonModel, axis: CodeAxis = codeAxis(m.codes, null)): EChartsCoreOption {
  const legend = m.series.length > 1;
  return {
    color: m.series.map((s) => s.color),
    textStyle: { fontFamily: CHART_FONT_FAMILY },
    // Room above the plot for the legend row, then for the unit's name over the value axis.
    grid: { left: 4, right: 12, top: (legend ? 28 : 0) + (m.unit ? 28 : 14), bottom: 4, containLabel: true },
    legend: {
      show: legend,
      top: 0,
      left: 0,
      // A key, not a filter (fix round 1, m-5): a hidden series would still be in the tooltip.
      selectedMode: false,
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
      formatter: (params: TooltipParams) => comparisonTooltip(m, Array.isArray(params) ? params[0]?.dataIndex ?? 0 : params.dataIndex),
    },
    xAxis: {
      type: 'category',
      data: m.codes,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: CHART_INK.axis } },
      axisLabel: {
        color: CHART_INK.body,
        fontSize: 11,
        fontWeight: 600,
        margin: 10,
        // codeAxis decides: level, 45°, or upright with a stride (the tooltip names every bar).
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
      axisLabel: { color: CHART_INK.muted, fontSize: 11 },
      splitLine: { lineStyle: { color: CHART_INK.rule, type: 'dashed' } },
    },
    series: m.series.map((s) => ({
      type: 'bar',
      name: s.legendName,
      data: s.points.map((p) => p.value),
      itemStyle: { color: s.color, borderRadius: [4, 4, 0, 0] },
      barMaxWidth: 28,
      barGap: '20%',
      barCategoryGap: '32%',
    })),
  };
}
