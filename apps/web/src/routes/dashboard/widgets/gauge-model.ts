/**
 * The GAUGE widget's decisions, pure (dashboard builder phase 2).
 *
 * One gauge is one instrument × key. Everything it SAYS comes from `keyCell` —
 * the text, the unit, the status word, the fault word — so a gauge and a value
 * card for the same reading cannot disagree. What it DRAWS is decided here:
 *
 * - **A measured key with a usable band** (both bounds, high above low) is
 *   `banded`. Its scale IS the band, by `bandGaugeState` — the trend page's
 *   latest-value card's one geometry: the arc sweeps from the low bound to the
 *   reading's place between the two, clamped, and does not extend past either
 *   bound. A high breach is therefore a full arc and a low breach an empty one;
 *   both are red (the verdict's colour), and the TRACK carries the red too, so a
 *   low breach still reads from the ring alone (band-gauge.tsx's rule). The arc
 *   colour is the verdict's — `STATUS_HEX[keyCell(…).tone]`, never re-judged here.
 * - **A measured key with no usable band** (no bound, one bound, high <= low) is
 *   `value-only`, coloured by the same verdict: neutral "Not assessed" when no
 *   bound is in force, exactly as `keyCell`. It draws NO arc: an arc means "a
 *   place inside an administered band", and there is none — the whole track is
 *   tinted in the verdict instead (a solid ring read as "at the high limit").
 * - **Out of limit**, either side, banded or not: the track is stronger than an
 *   in-limit one, so a low breach (no arc to see) reads red, not pale pink.
 * - **A raw key** (and every attribute) is NEUTRAL, always — offline included:
 *   amber is a status colour, and the status WORD already says "Offline". With
 *   the widget's own scale (`options.min` / `max`) it is `scaled` (placed by the
 *   same geometry, clamped, never a breach); without one it is `value-only`, its
 *   value on a neutral full ring (Review Focus 5).
 *
 * A faulted reading places NOTHING: `latest-values` sends a range fault WITH its
 * number (OL = 60), and that number is not a reading (`quantityVerdict`).
 */
import { clampDecimals, coerceReading, type LatestKeyValue, type LatestValuesRow, type WidgetKey } from '@digilog/shared';
// Type-only, and erased from the build: nothing here pulls ECharts in statically.
import type { EChartsCoreOption } from 'echarts/core';
import type { SensorWords } from '@/hooks/use-failure-text';
// The pure state module, never `band-gauge.tsx`: that is the trend page's card,
// and importing it here would put the whole card in the main bundle.
import { bandGaugeState } from '@/routes/instruments/band-gauge-state';
import type { StatusClasses } from '../status';
import { boundText, formatSetPoint, NOT_AVAILABLE } from '../set-point';
import { CHART_FONT_FAMILY, NEUTRAL_HEX, STATUS_HEX } from './charts/chart-colors';
import { keyCell } from './key-value';
import { valueOf } from './widget-common';

export type GaugeKind = 'banded' | 'scaled' | 'value-only';

/** The widget's scale for a key the server does not judge (`options.min` / `max`). */
export interface GaugeScale {
  min?: number;
  max?: number;
}

export interface GaugeModel {
  kind: GaugeKind;
  /** The scale's ends — the band's bounds, or the widget's scale; null on a value-only ring. */
  min: number | null;
  max: number | null;
  /** The number the arc places; null for no reading, a fault, or text. */
  value: number | null;
  /** 0–1 around the ring, clamped; null when nothing is placed. */
  position: number | null;
  /** A measured reading outside its band; never set for a raw key. */
  breach: 'low' | 'high' | null;
  /** The verdict is Out of limit (`keyCell`'s tone) — banded or value-only; never for a raw key. */
  outOfLimit: boolean;
  /** What prints in the middle — `keyCell`'s text: the number, NA, a fault word or text as received. */
  text: string;
  unit: string | null;
  fault: boolean;
  /** The ring's colour: a status colour ONLY for a measured key, else NEUTRAL_HEX. */
  color: string;
  /** The status word under the ring, and its classes — `keyCell`'s. */
  label: string;
  classes: StatusClasses;
  /** The line naming the scale: a measured key's limits, or the widget's scale. */
  scale: { label: 'Limits' | 'Scale'; text: string; unit: string | null } | null;
}

/** The ring's size, in px: the widget positions the number over its centre with the same numbers. */
export const GAUGE_SIZE = { height: 128, outerRadius: 60, stroke: 10 } as const;

/** band-gauge.tsx draws its track in the arc's colour at this opacity. */
const TRACK_ALPHA = 0.18;
/**
 * An out-of-limit track. At 0.18 a low breach (no arc) was a pale pink ring
 * beside the solid red of a high breach; chosen by looking at the two side by
 * side (fix round 1, M2).
 */
const BREACH_TRACK_ALPHA = 0.45;
/**
 * The neutral is pale already: at 0.18 its track would vanish on white, and at
 * 0.5 it sat too close to the neutral arc to read the arc's end (render check).
 */
const NEUTRAL_TRACK_ALPHA = 0.3;

/**
 * Is [lo, hi] a band the arc can sweep? Asked of `bandGaugeState` itself — with
 * the low bound standing in for the reading — so this is its rule, not a copy.
 */
function usableBand(lo: number | null | undefined, hi: number | null | undefined): boolean {
  return bandGaugeState(lo, lo, hi, 0).kind === 'banded';
}

/** Where `value` sits on [lo, hi] by bandGaugeState's geometry; null when nothing is placed. */
function placed(value: number | null, lo: number, hi: number, decimals: number) {
  if (value === null) return { position: null, breach: null };
  const s = bandGaugeState(value, lo, hi, decimals);
  return s.kind === 'banded' ? { position: s.position, breach: s.breach } : { position: null, breach: null };
}

export function gaugeModel(
  v: LatestKeyValue | undefined,
  key: WidgetKey,
  scale: GaugeScale,
  reporting: boolean,
  words: SensorWords,
): GaugeModel {
  const cell = keyCell(v, reporting, key, words);
  const said = { text: cell.text, unit: cell.unit, fault: cell.fault, label: cell.label, classes: cell.classes };
  // keyCell's tone is a verdict ONLY for a measured key (its doc); a raw cell's STALE is not one.
  const outOfLimit = cell.judged && cell.tone === 'OUT_OF_SPEC';

  if (v && v.judged && cell.judged) {
    const { limitMin: lo, limitMax: hi, limitMinText, limitMaxText } = v.judged;
    const decimals = clampDecimals(v.decimals);
    const value = cell.fault ? null : coerceReading(v.value);
    const color = STATUS_HEX[cell.tone];
    const limits = formatSetPoint(lo, hi, decimals, { min: limitMinText, max: limitMaxText });
    // A bound printed as its TEXT ("27 (For Reference)") may carry its own unit.
    const texted = boundText(lo, limitMinText, decimals) !== boundText(lo, null, decimals)
      || boundText(hi, limitMaxText, decimals) !== boundText(hi, null, decimals);
    const line = limits === NOT_AVAILABLE ? null : { label: 'Limits' as const, text: limits, unit: texted ? null : v.unit };
    if (usableBand(lo, hi)) {
      return { kind: 'banded', min: lo!, max: hi!, value, ...placed(value, lo!, hi!, decimals), outOfLimit, color, scale: line, ...said };
    }
    return { kind: 'value-only', min: null, max: null, value, position: null, breach: null, outOfLimit, color, scale: line, ...said };
  }

  const value = coerceReading(v?.value);
  const { min, max } = scale;
  if (typeof min === 'number' && typeof max === 'number' && usableBand(min, max)) {
    const end = (n: number) => (typeof key.decimals === 'number' ? n.toFixed(key.decimals) : String(n));
    return {
      kind: 'scaled', min, max, value,
      // Off the widget's scale is clamped to its end — never a breach: nothing judges a raw key.
      position: placed(value, min, max, 0).position,
      breach: null,
      outOfLimit: false,
      color: NEUTRAL_HEX,
      scale: { label: 'Scale', text: `${end(min)} - ${end(max)}`, unit: key.unit ?? null },
      ...said,
    };
  }
  return { kind: 'value-only', min: null, max: null, value, position: null, breach: null, outOfLimit: false, color: NEUTRAL_HEX, scale: null, ...said };
}

function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * The ring — and ONLY the ring: the number, unit, title and words are the page's
 * (Inter, tabular figures, testable), drawn over its centre. A full circle swept
 * clockwise from 12 o'clock, as the trend page's latest-value card draws its band.
 *
 * - An ARC only where there is a band or a scale to place the value in.
 * - Nothing judges it (neutral): a scaled track behind a neutral arc, or — with
 *   no scale — the neutral ring itself (Review Focus 5).
 * - A verdict: the track tinted in it, stronger when out of limit; a value-only
 *   measured key has the tinted track and no arc (ruling M2/M7).
 *
 * Reads only `kind`, `position`, `color` and `outOfLimit`: the widget memoises
 * the option on exactly those, so a poll that changes nothing drawn does not redraw.
 */
export function buildGaugeOption(m: Pick<GaugeModel, 'kind' | 'position' | 'color' | 'outOfLimit'>): EChartsCoreOption {
  const ring = m.kind === 'value-only';
  const sweep = !ring && m.position !== null && m.position > 0;
  const track = m.color === NEUTRAL_HEX
    ? (ring ? NEUTRAL_HEX : withAlpha(NEUTRAL_HEX, NEUTRAL_TRACK_ALPHA))
    : withAlpha(m.color, m.outOfLimit ? BREACH_TRACK_ALPHA : TRACK_ALPHA);
  return {
    color: [m.color],
    textStyle: { fontFamily: CHART_FONT_FAMILY },
    series: [{
      type: 'gauge',
      startAngle: 90,
      endAngle: -270,
      min: 0,
      max: 1,
      center: ['50%', '50%'],
      radius: GAUGE_SIZE.outerRadius,
      silent: true,
      axisLine: { lineStyle: { width: GAUGE_SIZE.stroke, color: [[1, track]] } },
      progress: { show: sweep, roundCap: true, width: GAUGE_SIZE.stroke, itemStyle: { color: m.color } },
      pointer: { show: false },
      anchor: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      title: { show: false },
      detail: { show: false },
      data: [{ value: sweep ? m.position : 0 }],
    }],
  };
}

export interface GaugePair {
  row: LatestValuesRow;
  key: WidgetKey;
  value: LatestKeyValue;
}

/**
 * The gauges to draw: instrument by instrument (the server's order), key by key —
 * only a key the instrument has SENT, as the trend chart and the time series
 * table spend their caps. Without it a widget following a whole area spends its
 * 24 on NA dials for a key one instrument carries, and cuts that one.
 */
export function gaugePairs(rows: readonly LatestValuesRow[], keys: readonly WidgetKey[]): GaugePair[] {
  return rows.flatMap((row) => keys.flatMap((key) => {
    const value = valueOf(row, key);
    return value && value.ts != null ? [{ row, key, value }] : [];
  }));
}
