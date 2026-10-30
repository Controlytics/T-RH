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
 */
import { coerceReading, WIDGET_INSTRUMENTS_MAX, type LatestValuesRow, type WidgetKey } from '@digilog/shared';
// Type-only, and erased from the build: nothing here pulls ECharts in statically.
import type { EChartsCoreOption } from 'echarts/core';
import type { SensorWords } from '@/hooks/use-failure-text';
import { CHART_FONT_FAMILY, CHART_INK, SERIES_HEX } from './charts/chart-colors';
import { keyCell } from './key-value';
import { valueOf } from './widget-common';

/**
 * The chart's height, in px: the default comparison panel (9 rows, 488 px) shows
 * it whole with its "Showing X of Y" line — 408 px inside the card's header,
 * border and padding (render check).
 */
export const COMPARISON_HEIGHT = 376;

/** Before the chart's width is known: more instruments than this and the codes turn. */
const TURN_LABELS_ABOVE = 8;
/** An instrument code's width at the axis's 11 px semibold Inter, per character (an estimate, a little generous). */
const CODE_PX_PER_CHAR = 11 * 0.62;
/** The value axis and the grid's margins, out of the chart's width. */
const VALUE_AXIS_PX = 56;

/**
 * Do the instrument codes have to turn to stay readable? Measured against the
 * width each bar group gets — a count alone cannot know the panel: three codes
 * in a quarter-width card overlap, and ECharts then HIDES one, leaving a bar
 * nobody can name (render check, 2026-10-30). Unknown width: the count.
 */
export function labelsTurn(codes: readonly string[], width: number | null): boolean {
  if (codes.length === 0) return false;
  if (width === null || width <= 0) return codes.length > TURN_LABELS_ABOVE;
  const longest = Math.max(...codes.map((c) => c.length)) * CODE_PX_PER_CHAR;
  return longest > (width - VALUE_AXIS_PX) / codes.length - 8;
}

export interface ComparisonPoint {
  /** The bar's length, or null — a gap. */
  value: number | null;
  /** What the value card would print: the number, NA, a fault word or text. */
  text: string;
  unit: string | null;
}

export interface ComparisonSeries {
  name: string;
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
}

export function comparisonModel(
  rows: readonly LatestValuesRow[],
  keys: readonly WidgetKey[],
  words: SensorWords,
): ComparisonModel {
  const sent = rows.filter((row) => keys.some((key) => valueOf(row, key)?.ts != null));
  const drawn = sent.slice(0, WIDGET_INSTRUMENTS_MAX);
  const series = keys.map((key, n) => ({
    name: key.label ?? key.key,
    color: SERIES_HEX[Math.min(key.color ?? n, SERIES_HEX.length - 1)],
    points: drawn.map((row): ComparisonPoint => {
      const v = valueOf(row, key);
      const cell = keyCell(v, row.reporting, key, words);
      return { value: cell.fault ? null : coerceReading(v?.value), text: cell.text, unit: cell.unit };
    }),
  }));
  const units = new Set(series.flatMap((s) => s.points.filter((p) => p.value !== null).map((p) => p.unit)));
  return {
    codes: drawn.map((row) => row.code),
    total: sent.length,
    unit: units.size === 1 ? [...units][0] : null,
    series,
  };
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

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

export function buildComparisonOption(m: ComparisonModel, turned = labelsTurn(m.codes, null)): EChartsCoreOption {
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
        rotate: turned ? 45 : 0,
        // Every code while they fit; once turned, ECharts drops the ones that would overlap
        // (the tooltip still names each bar).
        interval: turned ? 'auto' : 0,
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
      name: s.name,
      data: s.points.map((p) => p.value),
      itemStyle: { color: s.color, borderRadius: [4, 4, 0, 0] },
      barMaxWidth: 28,
      barGap: '20%',
      barCategoryGap: '32%',
    })),
  };
}
