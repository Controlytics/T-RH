/**
 * The PIE CHART widget's decisions, pure (dashboard builder phase 2).
 *
 * Two subjects, both the SERVER's answers, counted and coloured here and never
 * judged here:
 *
 * - **Instrument status** (`statusPieModel`): one slice per `instrumentLook` key
 *   the selection's overview rows carry — the ONE mapping from the server's
 *   `status` / `reporting` / `judged` to a word and a colour (Task 4). A
 *   reporting instrument nothing judges is "Not judged", neutral; not reporting,
 *   "Offline". Slices in a fixed order, worst first; colours from `STATUS_HEX`
 *   (R7-3), never the series palette.
 * - **Active alarms by type** (`alarmTypePieModel`): the `byType` counts of
 *   `GET /api/alarms/counts`, a slice per type with an active alarm, in the
 *   server's order, each the next `ALARM_SERIES_HEX` colour — the series
 *   palette less its greens (R7-8: every slice is an alarm, and green reads "in
 *   limit") — named with the ADMINISTERED names (`alarmTypeOptions`, the Alarms
 *   page's own). More types than colours (R7-2): the largest keep a colour each
 *   and the rest share ONE neutral "Other" slice whose tooltip lists them — a
 *   colour never repeats in a pie. A slice's colour is its POSITION among the
 *   active types, so a type's colour can change as other types go to zero.
 * - "Partial data" and "Offline" share the status amber (STALE and PARTIAL share
 *   one dot app-wide); the Partial slice is STRIPED — on the ring, its legend
 *   icon and its tooltip swatch — so the two never read as one (R7-10).
 *
 * The legend is a key, not a filter (R7-1). Every option is built with the
 * app's colours passed explicitly.
 */
import type { AlarmTypeNames } from '@digilog/shared';
// Type-only, and erased from the build: nothing here pulls ECharts in statically.
import type { EChartsCoreOption } from 'echarts/core';
import { alarmTypeOptions } from '@/routes/alarms/alarm-display';
import type { OverviewRow } from '../use-telemetry';
import { ALARM_SERIES_HEX, CHART_FONT_FAMILY, CHART_INK, NEUTRAL_HEX, STATUS_HEX } from './charts/chart-colors';
import { escapeHtml } from './comparison-model';
import { instrumentLook, type InstrumentLookKey } from './instrument-look';
import type { AlarmCounts } from './use-widget-data';
import { groupDigits } from './widget-common';

export interface PieSlice {
  /** The `instrumentLook` key, the server's type token, or `OTHER`. */
  key: string;
  /** What the legend and the tooltip call it — unique within one pie. */
  label: string;
  count: number;
  hex: string;
  /** Drawn over the colour, so a slice that shares its colour stays told apart (R7-10). */
  pattern?: 'stripes';
  /** Only on "Other": each type it holds, and that type's count. */
  merged?: readonly { label: string; count: number }[];
}

/** The status slices' order: the worst first, "In limit" last. */
export const STATUS_PIE_ORDER: readonly InstrumentLookKey[] = ['OUT_OF_SPEC', 'PARTIAL', 'STALE', 'NO_DATA', 'NOT_JUDGED', 'OK'];

/**
 * The looks drawn striped (R7-10): PARTIAL shares STALE's amber, and the two sit
 * side by side in the fixed order.
 */
const STRIPED: ReadonlySet<InstrumentLookKey> = new Set(['PARTIAL']);

/** How many instruments read each way. The word and colour are `instrumentLook`'s; nothing is judged here. */
export function statusPieModel(rows: readonly Pick<OverviewRow, 'status' | 'reporting' | 'judged'>[]): PieSlice[] {
  const seen = new Map<InstrumentLookKey, { label: string; count: number }>();
  for (const row of rows) {
    const look = instrumentLook(row);
    const held = seen.get(look.key);
    if (held) held.count += 1;
    else seen.set(look.key, { label: look.classes.label, count: 1 });
  }
  return STATUS_PIE_ORDER.flatMap((key) => {
    const held = seen.get(key);
    if (!held) return [];
    const slice: PieSlice = { key, label: held.label, count: held.count, hex: STATUS_HEX[key] };
    return [STRIPED.has(key) ? { ...slice, pattern: 'stripes' } : slice];
  });
}

/**
 * What a type token is called: the Alarms page's administered name. A token the
 * server lists but nothing names prints the server's own token — never a blank.
 */
export function alarmTypeLabel(type: string, names: AlarmTypeNames | undefined): string {
  return alarmTypeOptions(names).find((o) => o.value === type)?.label ?? type;
}

export const OTHER_LABEL = 'Other';

/** A legend names each slice once: a repeated label (two types administered the same name) takes its key. */
function distinctLabels(slices: PieSlice[]): PieSlice[] {
  const used = new Set<string>();
  return slices.map((s) => {
    const label = used.has(s.label) ? `${s.label} (${s.key})` : s.label;
    used.add(label);
    return label === s.label ? s : { ...s, label };
  });
}

/** Active alarms by type — the server's counts; only a type with an active alarm is a slice. */
export function alarmTypePieModel(byType: AlarmCounts['byType'], names: AlarmTypeNames | undefined): PieSlice[] {
  const active = byType
    .filter((t) => t.active > 0)
    .map((t) => ({ key: t.type, label: alarmTypeLabel(t.type, names), count: t.active }));
  const colours = ALARM_SERIES_HEX;
  if (active.length <= colours.length) {
    return distinctLabels(active.map((s, n) => ({ ...s, hex: colours[n] })));
  }
  // R7-2: the largest keep a colour each (a tie goes to the server's earlier type).
  const keep = new Set(
    active
      .map((s, n) => ({ count: s.count, n }))
      .sort((a, b) => b.count - a.count || a.n - b.n)
      .slice(0, colours.length - 1)
      .map((x) => x.n),
  );
  const kept = active.filter((_, n) => keep.has(n)).map((s, n) => ({ ...s, hex: colours[n] }));
  const rest = active.filter((_, n) => !keep.has(n));
  return distinctLabels([
    ...kept,
    {
      key: 'OTHER',
      label: OTHER_LABEL,
      count: rest.reduce((sum, s) => sum + s.count, 0),
      hex: NEUTRAL_HEX,
      merged: rest.map(({ label, count }) => ({ label, count })),
    },
  ]);
}

/**
 * The chart's height when its legend fits, in px: the default pie panel (8
 * rows, 432 px) holds 360 px inside its header, border and padding — the chart
 * and, when there is one, a notes line (24) above it (render check).
 */
export const PIE_HEIGHT = 336;
/** The ring's box never shrinks below this; a legend taller than the rest grows the chart (the card scrolls). */
export const PIE_RING_MIN_PX = 168;
/** One legend row: a 12 px label and the gap to the next row. */
export const PIE_LEGEND_ROW_PX = 24;
/** Between the ring's box and the legend's first row. */
const LEGEND_GAP_PX = 12;
/**
 * Under the legend's last row: at `bottom: 0` the SVG's edge cut its descenders
 * off — "Not judged" read "Not iudged" (render check).
 */
export const LEGEND_BOTTOM_PX = 6;
/** A legend label's width at 12 px semibold Inter, per character (an estimate, a little generous) — the bar legend's. */
const PX_PER_CHAR = 12 * 0.62;
/** Beside each label: its 10 px icon and the 5 px before the text. */
const ITEM_ICON_PX = 10 + 5;
/** Between two legend items on a row. */
const ITEM_GAP_PX = 16;
/** A shortened name keeps at least this many characters. */
const MIN_NAME_CHARS = 6;

export interface PiePlan {
  /** Each slice's legend text, in slice order: its name (shortened to fit, never its count) and its count. */
  texts: string[];
  /** Rows the legend wraps to at the chart's width. */
  rows: number;
  /** The legend's height, below the ring. */
  legendPx: number;
  /** The chart's height. */
  height: number;
}

/**
 * How the legend fits the chart's MEASURED width. A name too long for one row
 * (`RS485 Temperature Failure / RS485 Humidity Failure` in a quarter-width card)
 * is shortened with an ellipsis — the slice's tooltip and the legend's own
 * tooltip name it in full — and its count is never cut. Rows are estimated as
 * ECharts wraps them (padding 0, so at the full width); the chart grows when
 * they would crush the ring. Unknown width (the first frame): nothing shortened,
 * one row.
 */
export function piePlan(slices: readonly PieSlice[], width: number | null): PiePlan {
  const known = width !== null && width > 0;
  const budget = known ? Math.max(MIN_NAME_CHARS + 4, Math.floor((width - ITEM_ICON_PX) / PX_PER_CHAR)) : Infinity;
  const texts = slices.map((s) => {
    const count = groupDigits(s.count);
    const full = `${s.label}  ${count}`;
    if (full.length <= budget) return full;
    const keep = Math.max(MIN_NAME_CHARS, budget - count.length - 3);
    return `${s.label.slice(0, keep).trimEnd()}…  ${count}`;
  });
  let rows = texts.length > 0 ? 1 : 0;
  if (known) {
    let x = 0;
    for (const t of texts) {
      const item = ITEM_ICON_PX + t.length * PX_PER_CHAR;
      if (x > 0 && x + item > width) {
        rows += 1;
        x = 0;
      }
      x += item + ITEM_GAP_PX;
    }
  }
  const legendPx = rows * PIE_LEGEND_ROW_PX;
  const height = Math.max(PIE_HEIGHT, PIE_RING_MIN_PX + LEGEND_GAP_PX + legendPx + LEGEND_BOTTOM_PX);
  return { texts, rows, legendPx, height };
}

export type PieSubject = { subject: 'status'; total: number } | { subject: 'alarm_types' };

/** "1 instrument", "1,380 instruments" — the count grouped, the noun agreeing with it. */
export const plural = (n: number, one: string, many: string) => `${groupDigits(n)} ${n === 1 ? one : many}`;

/**
 * The stripes over a striped slice (R7-10): white, diagonal, over the slice's own
 * colour, so the status amber stays the status amber. ECharts draws a `decal` on
 * the slice and, given the same on its legend entry, on its legend icon.
 */
export const STRIPE_DECAL = {
  symbol: 'rect',
  symbolSize: 1,
  dashArrayX: [1, 0],
  // 1 px of white in every 4: thin enough that the 10 px legend icon still reads
  // as an amber square, striped (2 px read as an amber slash: render check).
  dashArrayY: [1, 3],
  rotation: -Math.PI / 4,
  color: 'rgba(255, 255, 255, 0.85)',
} as const;

/** The same stripes in CSS, for the tooltip's swatch. */
const STRIPE_CSS = 'background-image:repeating-linear-gradient(-45deg,rgba(255,255,255,0.85) 0 1px,transparent 1px 4px);';

/** One slice's tooltip: its name, then what it counts — "3 of 12 instruments", "4 active alarms" — and, for "Other", each type it holds. */
export function pieTooltip(slice: PieSlice, about: PieSubject): string {
  const head = '<div style="display:flex;align-items:center;gap:8px">'
    + `<span style="flex:none;width:8px;height:8px;border-radius:2px;background-color:${slice.hex};${slice.pattern ? STRIPE_CSS : ''}"></span>`
    + `<b style="color:${CHART_INK.strong}">${escapeHtml(slice.label)}</b></div>`;
  const what = about.subject === 'status'
    ? `${groupDigits(slice.count)} of ${plural(about.total, 'instrument', 'instruments')}`
    : `${plural(slice.count, 'active alarm', 'active alarms')}`;
  const body = `<div style="margin-top:4px;color:${CHART_INK.body};font-variant-numeric:tabular-nums">${escapeHtml(what)}</div>`;
  const merged = (slice.merged ?? []).map((m) => '<div style="display:flex;gap:16px;margin-top:2px;font-size:11px">'
    + `<span style="flex:1;color:${CHART_INK.muted}">${escapeHtml(m.label)}</span>`
    + `<b style="color:${CHART_INK.strong};font-variant-numeric:tabular-nums">${groupDigits(m.count)}</b></div>`).join('');
  return head + body + merged;
}

export function buildPieOption(slices: readonly PieSlice[], about: PieSubject, plan: PiePlan): EChartsCoreOption {
  const textOf = new Map(slices.map((s, n) => [s.label, plan.texts[n] ?? s.label]));
  return {
    color: slices.map((s) => s.hex),
    textStyle: { fontFamily: CHART_FONT_FAMILY },
    legend: {
      bottom: LEGEND_BOTTOM_PX,
      left: 'center',
      // Wraps at the full chart width — the width `piePlan` estimates against.
      padding: 0,
      // A key, not a filter (R7-1): a hidden slice would still be in the counts.
      selectedMode: false,
      // The striped slice's legend icon wears its stripes too (R7-10).
      data: slices.map((s) => (s.pattern ? { name: s.label, itemStyle: { decal: STRIPE_DECAL } } : { name: s.label })),
      formatter: (name: string) => textOf.get(name) ?? name,
      // A shortened name, in full.
      tooltip: { show: true },
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      itemGap: ITEM_GAP_PX,
      textStyle: { color: CHART_INK.body, fontSize: 12, fontWeight: 600, fontFamily: CHART_FONT_FAMILY },
    },
    tooltip: {
      trigger: 'item',
      confine: true,
      backgroundColor: '#ffffff',
      borderColor: CHART_INK.rule,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: CHART_INK.body, fontSize: 12, fontFamily: CHART_FONT_FAMILY },
      extraCssText: 'border-radius:8px;box-shadow:0 8px 20px rgba(15,23,43,0.10);',
      formatter: (p: { dataIndex: number; name?: string }) => {
        const slice = slices[p.dataIndex] ?? slices.find((s) => s.label === p.name);
        // The legend's tooltip comes here too: it names the entry in full.
        return slice ? pieTooltip(slice, about) : escapeHtml(p.name ?? '');
      },
    },
    series: [{
      type: 'pie',
      // The ring sits in the box above the legend.
      top: 0,
      bottom: plan.legendPx + LEGEND_GAP_PX + LEGEND_BOTTOM_PX,
      left: 0,
      right: 0,
      center: ['50%', '50%'],
      radius: ['56%', '88%'],
      avoidLabelOverlap: false,
      // The legend and the tooltip name every slice; a label around the ring would clip in a small card.
      label: { show: false },
      labelLine: { show: false },
      emphasis: { scale: true, scaleSize: 4, label: { show: false } },
      // A white edge keeps neighbours of one colour apart (Partial data and
      // Offline share amber; No data and Not judged are two greys).
      itemStyle: { borderColor: '#ffffff', borderWidth: 2, borderRadius: 3 },
      // One instrument of hundreds is still a slice you can see and point at.
      minAngle: 3,
      data: slices.map((s) => ({
        name: s.label,
        value: s.count,
        itemStyle: s.pattern ? { color: s.hex, decal: STRIPE_DECAL } : { color: s.hex },
      })),
    }],
  };
}
