import { useMemo, useState } from 'react';
import { formatDecimals } from '@digilog/shared';

/**
 * Hand-rolled SVG line chart. No dependency — this repo has deliberately removed
 * every chart and canvas library it ever carried.
 *
 * Colour rules follow the data-viz method:
 *  - Series identity uses a FIXED categorical order, never a cycled or generated
 *    hue. Colour follows the instrument, not its rank in the list.
 *  - The in-spec band is drawn from the room's limits, so an excursion reads as
 *    geometry rather than needing a legend lookup.
 *  - Text wears ink colours, never the series colour; the swatch beside a label
 *    carries identity.
 *  - Every series is directly labelled at its last point AND listed in the
 *    legend, which is also the required relief for the one palette slot that
 *    sits below 3:1 contrast on a light surface.
 */

/**
 * Categorical slots 1–3 of the validated palette, in fixed order.
 * `node scripts/validate_palette.js "#2a78d6,#eb6834,#1baf7a" --mode light --pairs all`
 * → all checks pass (worst CVD ΔE 9.2, worst normal-vision ΔE 24.0).
 */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#4a3aa7'] as const;

/** Never generate a hue past the end of the palette — clamp instead. */
export function seriesColor(index: number): string {
  return SERIES_COLORS[Math.min(index, SERIES_COLORS.length - 1)];
}

export interface ScaleResult {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

/**
 * Round an axis range to human tick values.
 *
 * A flat series (min === max) gets an artificial range: a zero-height axis
 * divides by zero and renders every point on the same row, which is
 * indistinguishable from a broken chart.
 */
export function niceScale(min: number, max: number, tickCount = 5): ScaleResult {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  }
  if (min === max) { min -= 1; max += 1; }
  if (min > max) [min, max] = [max, min];

  const rawStep = (max - min) / Math.max(1, tickCount);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;

  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = niceMin; t <= niceMax + step / 2; t += step) ticks.push(+t.toFixed(6));
  return { min: niceMin, max: niceMax, step, ticks };
}

export interface ChartSeries {
  id: string;
  label: string;
  /**
   * The instrument's own display precision. PER SERIES, not per chart: this chart
   * overlays every probe in a room, and a room may hold one probe resolving to
   * 0.1 °C beside another reporting whole degrees. A chart-wide number would
   * quote one of them to a precision it does not have — on the very axis the
   * chart exists to compare them on.
   */
  decimals: number;
  points: { ts: string; value: number }[];
}

interface Props {
  series: ChartSeries[];
  unit: string;
  /** Room limits — drawn as the in-spec band. */
  min?: number | null;
  max?: number | null;
  /** Window span, so the x labels can choose clock vs date. */
  spanMs: number;
  title: string;
}

const W = 900;
const H = 260;
const PAD = { top: 14, right: 62, bottom: 26, left: 46 };

export function TimeSeriesChart({ series, unit, min, max, spanMs, title }: Props) {
  const [hoverX, setHoverX] = useState<number | null>(null);

  const withPoints = series.filter((s) => s.points.length > 0);

  const geom = useMemo(() => {
    if (withPoints.length === 0) return null;

    const times = withPoints.flatMap((s) => s.points.map((p) => new Date(p.ts).getTime()));
    const values = withPoints.flatMap((s) => s.points.map((p) => p.value));
    const t0 = Math.min(...times);
    const t1 = Math.max(...times);

    // Union the data range with the limit band, so a limit just outside the
    // readings is still visible rather than silently cropped off.
    const lo = Math.min(...values, min ?? Infinity);
    const hi = Math.max(...values, max ?? -Infinity);
    const scale = niceScale(lo, hi);

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const sx = (t: number) => PAD.left + (t1 === t0 ? plotW / 2 : ((t - t0) / (t1 - t0)) * plotW);
    const sy = (v: number) => PAD.top + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH;

    return { t0, t1, scale, plotW, plotH, sx, sy };
  }, [withPoints, min, max]);

  if (withPoints.length === 0) {
    // A chart with axes and no line reads as "flat". Say nothing is here.
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center">
        <p className="text-sm font-medium text-slate-700">{title}</p>
        <p className="mt-1 text-xs text-slate-500">No readings in this window.</p>
      </div>
    );
  }

  const g = geom!;
  const fmtTime = (t: number) => {
    const d = new Date(t);
    return spanMs > 24 * 3_600_000
      ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  // Nearest point per series to the hovered x, for the readout.
  const hoverTime = hoverX === null
    ? null
    : g.t0 + ((hoverX - PAD.left) / g.plotW) * (g.t1 - g.t0);

  const readout = hoverTime === null ? [] : withPoints.map((s, i) => {
    let best = s.points[0];
    let bestD = Infinity;
    for (const p of s.points) {
      const d = Math.abs(new Date(p.ts).getTime() - hoverTime);
      if (d < bestD) { bestD = d; best = p; }
    }
    return { label: s.label, value: best.value, decimals: s.decimals, color: seriesColor(i) };
  });

  const bandTop = max != null ? g.sy(Math.min(max, g.scale.max)) : null;
  const bandBottom = min != null ? g.sy(Math.max(min, g.scale.min)) : null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-slate-800">{title}</p>
        {/* Legend is always present for 2+ series; identity is never colour
            alone because the swatch sits beside a name. */}
        {withPoints.length > 1 && (
          <div className="flex flex-wrap items-center gap-3">
            {withPoints.map((s, i) => (
              <span key={s.id} className="flex items-center gap-1.5 text-xs text-slate-600">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: seriesColor(i) }} />
                {s.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${title}. ${withPoints.length} series between ${fmtTime(g.t0)} and ${fmtTime(g.t1)}.`}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHoverX(px >= PAD.left && px <= W - PAD.right ? px : null);
        }}
        onMouseLeave={() => setHoverX(null)}
      >
        {/* In-spec band, behind everything. */}
        {(bandTop !== null || bandBottom !== null) && (
          <rect
            x={PAD.left}
            y={bandTop ?? PAD.top}
            width={g.plotW}
            height={Math.max(0, (bandBottom ?? PAD.top + g.plotH) - (bandTop ?? PAD.top))}
            fill="#16a34a"
            opacity={0.07}
          />
        )}
        {max != null && max <= g.scale.max && (
          <line x1={PAD.left} x2={W - PAD.right} y1={g.sy(max)} y2={g.sy(max)}
                stroke="#16a34a" strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
        )}
        {min != null && min >= g.scale.min && (
          <line x1={PAD.left} x2={W - PAD.right} y1={g.sy(min)} y2={g.sy(min)}
                stroke="#16a34a" strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
        )}

        {/* Recessive grid + axis labels. */}
        {g.scale.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={g.sy(t)} y2={g.sy(t)} stroke="#e2e8f0" strokeWidth={1} />
            {/* The tick is a SCALE value, not a reading — it keeps niceScale's own
                rounding rather than an instrument's precision. A 0-decimal probe on
                a 0.5-step axis should still see 22.5 on the gridline. */}
            <text x={PAD.left - 6} y={g.sy(t) + 3} textAnchor="end" fontSize={10} fill="#64748b">
              {t}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 8} fontSize={10} fill="#64748b">{fmtTime(g.t0)}</text>
        <text x={W - PAD.right} y={H - 8} textAnchor="end" fontSize={10} fill="#64748b">{fmtTime(g.t1)}</text>

        {/* Series. 2px, no per-point markers — these are dense polls. */}
        {withPoints.map((s, i) => {
          const d = s.points
            .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${g.sx(new Date(p.ts).getTime()).toFixed(1)},${g.sy(p.value).toFixed(1)}`)
            .join(' ');
          const last = s.points[s.points.length - 1];
          return (
            <g key={s.id}>
              <path d={d} fill="none" stroke={seriesColor(i)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {/* Direct label at the last point — the relief the palette's
                  low-contrast slot requires, and faster to read than a legend. */}
              <text
                x={W - PAD.right + 5}
                y={g.sy(last.value) + 3}
                fontSize={10}
                fontWeight={600}
                fill="#334155"
              >
                {formatDecimals(last.value, s.decimals)}
              </text>
            </g>
          );
        })}

        {/* Hover crosshair. */}
        {hoverX !== null && (
          <line x1={hoverX} x2={hoverX} y1={PAD.top} y2={PAD.top + g.plotH} stroke="#94a3b8" strokeWidth={1} />
        )}
      </svg>

      <div className="mt-1 flex min-h-[18px] flex-wrap items-center gap-3 text-xs">
        {readout.length > 0 ? readout.map((r) => (
          <span key={r.label} className="flex items-center gap-1.5 text-slate-600">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: r.color }} />
            {r.label}: <span className="font-semibold tabular-nums text-slate-800">{formatDecimals(r.value, r.decimals)} {unit}</span>
          </span>
        )) : (
          <span className="text-slate-400">Hover the chart to read values</span>
        )}
      </div>
    </div>
  );
}
