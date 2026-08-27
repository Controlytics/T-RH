import { useEffect, useMemo, useState } from 'react';
import { formatDecimals } from '@digilog/shared';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { pixelToTime, normalizeSelection } from './chart-zoom';

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
 *
 * Values are CSS custom properties (defined light-only in `app.css`), each with
 * the SAME literal colour as its own CSS fallback — `var(--chart-series-1,
 * #2a78d6)`, not a bare `var()`. The fallback is not decorative: the PDF export
 * (`routes/instruments/chart-image.ts`) serialises this chart's SVG into a
 * standalone document with no stylesheet attached, where an undefined custom
 * property resolves to nothing. The fallback is what keeps that export showing
 * the same colour the screen did, rather than a black or invisible line.
 */
/** The in-limit semantic, shared with the trend page's band gauge. Fixed, not
 *  themed: a site that themes the app purple must not get a purple limit. */
const LIMIT_LINE = 'var(--chart-limit-line, #15803D)';

export const SERIES_COLORS = [
  'var(--chart-series-1, #2a78d6)',
  'var(--chart-series-2, #eb6834)',
  'var(--chart-series-3, #1baf7a)',
  'var(--chart-series-4, #eda100)',
  'var(--chart-series-5, #e87ba4)',
  'var(--chart-series-6, #4a3aa7)',
] as const;

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
  /**
   * Optional identity override. The palette slot is normally the series' RANK
   * within one chart, which is right for the dashboard (many probes, one room).
   * The trend page draws each quantity in its own single-series chart, so rank
   * would make temperature and humidity BOTH slot 1 — one page, two blues, and
   * a humidity gauge accented orange beside a blue humidity line. Callers that
   * own a quantity's identity pass it; every other caller is unaffected.
   */
  color?: string;
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
  /**
   * Drag-to-zoom, OPTIONAL — a caller opts in by handling it.
   *
   * The chart reports the span the operator selected and does nothing else with
   * it: it does not fetch, and it does not own the range. **Zoom refetches; it
   * does not magnify.** The page turns this into a narrower request and the
   * server answers with the TRUE readings for that window, which on a
   * downsampled 30-day view is more detail than the chart currently holds.
   * Scaling up the points already in memory would draw bigger dots and claim a
   * resolution that was never received — on a §11 record, a picture asserting
   * detail it does not have. A chart that fetched would also be a second place
   * in this app that knows how to build a telemetry URL.
   *
   * Providing it is what makes the chart INTERACTIVE: without it there is no
   * drag, no selection rectangle and no fullscreen control, so the dashboard's
   * room view and the off-screen render behind the PDF export are untouched.
   */
  onZoom?: (from: Date, to: Date) => void;
  /** Provided only while the view IS zoomed — it is what renders "Reset zoom". */
  onResetZoom?: () => void;
}

const W = 900;
const H = 260;
const PAD = { top: 14, right: 62, bottom: 26, left: 46 };

/**
 * The narrowest span a drag may select.
 *
 * A click is a zero-width drag; a flick is a near-zero one. Either would set a
 * range the server holds nothing for, and the chart would blank on a gesture
 * the operator did not mean to make. The floor is on TIME, not pixels, so the
 * same short drag zooms on a 30-day window and is ignored on a 5-minute one.
 */
const MIN_ZOOM_SPAN_MS = 60_000;

export function TimeSeriesChart({ series, unit, min, max, spanMs, title, onZoom, onResetZoom }: Props) {
  const { formatDateTime } = useDatetimeFormat();
  const [hoverX, setHoverX] = useState<number | null>(null);
  /** Drag in progress, in viewBox x — null when not dragging. */
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const interactive = typeof onZoom === 'function';

  // Escape leaves fullscreen. A fixed full-viewport overlay with no keyboard
  // way out is a trap for anyone not using a mouse.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

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
        <p className="mt-1 text-xs text-slate-500">No data available</p>
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

  // Nearest point per series to the hovered x, for the readout. Same pixel→time
  // map the zoom uses, so a hover readout and a zoom edge can never disagree
  // about which instant a given column of the plot is.
  const hoverTime = hoverX === null ? null : pixelToTime(hoverX, PAD.left, g.plotW, g.t0, g.t1);

  /** Pointer x in viewBox units — the SVG scales to its container, so client px are not plot px. */
  const viewX = (e: { clientX: number; currentTarget: { getBoundingClientRect(): DOMRect } }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * W;
  };

  const endDrag = () => {
    if (!drag) return;
    const sel = normalizeSelection(
      pixelToTime(drag.a, PAD.left, g.plotW, g.t0, g.t1),
      pixelToTime(drag.b, PAD.left, g.plotW, g.t0, g.t1),
      MIN_ZOOM_SPAN_MS,
    );
    // Cleared unconditionally: a rejected drag must not leave its rectangle
    // painted over a chart that did not change.
    setDrag(null);
    if (sel) onZoom?.(new Date(sel.from), new Date(sel.to));
  };

  // Drawn selection, clamped to the plot so a drag that runs off the edge shows
  // the edge it will actually select rather than spilling over the axis labels.
  const clampPlot = (px: number) => Math.min(W - PAD.right, Math.max(PAD.left, px));
  const dragRect = drag && Math.abs(drag.b - drag.a) > 0.5
    ? { x: Math.min(clampPlot(drag.a), clampPlot(drag.b)), w: Math.abs(clampPlot(drag.b) - clampPlot(drag.a)) }
    : null;

  const readout = hoverTime === null ? [] : withPoints.map((s, i) => {
    let best = s.points[0];
    let bestD = Infinity;
    for (const p of s.points) {
      const d = Math.abs(new Date(p.ts).getTime() - hoverTime);
      if (d < bestD) { bestD = d; best = p; }
    }
    // `best.ts` — the READING's own timestamp, not the pixel-derived hover
    // instant `pixelToTime` produced. The nearest stored point is what the
    // reader is actually being shown a value for; the hovered pixel is only
    // how they picked it.
    return { label: s.label, value: best.value, decimals: s.decimals, color: s.color ?? seriesColor(i), ts: best.ts };
  });

  /**
   * The precision a LIMIT is printed at.
   *
   * A limit belongs to the chart, not to any one series — this chart may
   * overlay several probes in a room against one room spec. The FINEST of the
   * series' own precisions is used, because rounding a 27.05 limit to "27" on
   * a chart drawn for a 2-decimal probe would print a bound the record does
   * not hold. `formatDecimals` (not `toFixed`) because `decimals` traces back
   * to an operator-typed instrument attribute and `toFixed` throws outside
   * 0…100 — inside this render that would blank the whole chart.
   */
  const limitDecimals = Math.max(0, ...withPoints.map((s) => s.decimals));
  const limitText = (v: number) => formatDecimals(v, limitDecimals) ?? String(v);

  const bandTop = max != null ? g.sy(Math.min(max, g.scale.max)) : null;
  const bandBottom = min != null ? g.sy(Math.max(min, g.scale.min)) : null;

  return (
    <div
      className={
        fullscreen
          ? 'fixed inset-0 z-50 flex flex-col overflow-auto bg-white p-5'
          : 'rounded-xl border border-slate-200 bg-white p-3'
      }
    >
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-slate-800">{title}</p>
        <div className="flex flex-wrap items-center gap-3">
          {/* Legend is always present for 2+ series; identity is never colour
              alone because the swatch sits beside a name. */}
          {withPoints.length > 1 && withPoints.map((s, i) => (
            <span key={s.id} className="flex items-center gap-1.5 text-xs text-slate-600">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color ?? seriesColor(i) }} />
              {s.label}
            </span>
          ))}
          {/* Controls exist only for a caller that handles zoom — see `onZoom`.
              This is what keeps the dashboard's room view and the off-screen
              render behind the PDF export exactly as they were. */}
          {interactive && (
            <>
              {onResetZoom && (
                <button
                  type="button"
                  onClick={onResetZoom}
                  className="rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Reset zoom
                </button>
              )}
              <button
                type="button"
                onClick={() => setFullscreen((v) => !v)}
                aria-pressed={fullscreen}
                className="rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              </button>
            </>
          )}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        // `h-auto w-full` in BOTH states, deliberately. Stretching the SVG to
        // fill the fullscreen height (`flex-1` + `preserveAspectRatio="meet"`)
        // letterboxes the viewBox inside the element on any container whose
        // ratio differs from 900:260 — and `viewX` divides by the ELEMENT's
        // width, so every pixel→time conversion would be off by the
        // letterboxing. Hover would name the wrong instant and a drag would
        // select the wrong window, with nothing on screen to say so. Spanning
        // the viewport width at natural height keeps `viewX` exact in both
        // states; the container scrolls (`overflow-auto`) if that overflows.
        className={`h-auto w-full${interactive ? ' cursor-crosshair touch-none' : ''}`}
        role="img"
        aria-label={`${title}. ${withPoints.length} series between ${fmtTime(g.t0)} and ${fmtTime(g.t1)}.`}
        onMouseMove={(e) => {
          const px = viewX(e);
          setHoverX(px >= PAD.left && px <= W - PAD.right ? px : null);
        }}
        onMouseLeave={() => setHoverX(null)}
        // Pointer events, with capture, deliberately: a drag that leaves the
        // plot area must keep tracking so it can select the EDGE (which is what
        // `pixelToTime`'s clamp is for). Cancelling on mouse-leave would make
        // "from here to the end" — the most natural gesture on a trend — do
        // nothing at all.
        onPointerDown={interactive ? (e) => {
          if (e.button !== 0) return;
          const px = viewX(e);
          if (px < PAD.left || px > W - PAD.right) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setDrag({ a: px, b: px });
        } : undefined}
        onPointerMove={interactive && drag ? (e) => setDrag({ a: drag.a, b: viewX(e) }) : undefined}
        onPointerUp={interactive ? endDrag : undefined}
        onPointerCancel={interactive ? () => setDrag(null) : undefined}
      >
        {/* In-spec band, behind everything. */}
        {(bandTop !== null || bandBottom !== null) && (
          <rect
            x={PAD.left}
            y={bandTop ?? PAD.top}
            width={g.plotW}
            height={Math.max(0, (bandBottom ?? PAD.top + g.plotH) - (bandTop ?? PAD.top))}
            fill={LIMIT_LINE}
            opacity={0.07}
          />
        )}
        {/* The limit lines, each carrying its own VALUE.
            A dashed line with no number beside it is a boundary the reader has
            to infer from the y-axis — on the one chart whose whole question is
            "did it ever leave its limits?". The label rides in the plot area
            with a white halo (`paintOrder`) so it stays legible where the
            series crosses under it, rather than in the right margin where the
            direct series labels already sit. */}
        {max != null && max <= g.scale.max && (
          <g>
            <line x1={PAD.left} x2={W - PAD.right} y1={g.sy(max)} y2={g.sy(max)}
                  stroke={LIMIT_LINE} strokeWidth={1} strokeDasharray="4 3" opacity={0.75} />
            <text
              x={PAD.left + 4} y={g.sy(max) - 4} fontSize={10} fontWeight={600}
              fill={LIMIT_LINE} stroke="#fff" strokeWidth={3} paintOrder="stroke"
            >
              {`Max ${limitText(max)}`}
            </text>
          </g>
        )}
        {min != null && min >= g.scale.min && (
          <g>
            <line x1={PAD.left} x2={W - PAD.right} y1={g.sy(min)} y2={g.sy(min)}
                  stroke={LIMIT_LINE} strokeWidth={1} strokeDasharray="4 3" opacity={0.75} />
            <text
              x={PAD.left + 4} y={g.sy(min) + 11} fontSize={10} fontWeight={600}
              fill={LIMIT_LINE} stroke="#fff" strokeWidth={3} paintOrder="stroke"
            >
              {`Min ${limitText(min)}`}
            </text>
          </g>
        )}

        {/* Recessive grid + axis labels. */}
        {g.scale.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={g.sy(t)} y2={g.sy(t)} stroke="var(--chart-grid-line, #e2e8f0)" strokeWidth={1} />
            {/* The tick is a SCALE value, not a reading — it keeps niceScale's own
                rounding rather than an instrument's precision. A 0-decimal probe on
                a 0.5-step axis should still see 22.5 on the gridline. */}
            <text x={PAD.left - 6} y={g.sy(t) + 3} textAnchor="end" fontSize={10} fill="var(--chart-axis-text, #64748b)">
              {t}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 8} fontSize={10} fill="var(--chart-axis-text, #64748b)">{fmtTime(g.t0)}</text>
        <text x={W - PAD.right} y={H - 8} textAnchor="end" fontSize={10} fill="var(--chart-axis-text, #64748b)">{fmtTime(g.t1)}</text>

        {/* Series. 2px, no per-point markers — these are dense polls. */}
        {withPoints.map((s, i) => {
          const d = s.points
            .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${g.sx(new Date(p.ts).getTime()).toFixed(1)},${g.sy(p.value).toFixed(1)}`)
            .join(' ');
          const last = s.points[s.points.length - 1];
          return (
            <g key={s.id}>
              <path d={d} fill="none" stroke={s.color ?? seriesColor(i)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {/* Direct label at the last point — the relief the palette's
                  low-contrast slot requires, and faster to read than a legend. */}
              <text
                x={W - PAD.right + 5}
                y={g.sy(last.value) + 3}
                fontSize={10}
                fontWeight={600}
                fill="var(--chart-value-label, #334155)"
              >
                {formatDecimals(last.value, s.decimals)}
              </text>
            </g>
          );
        })}

        {/* Hover crosshair. */}
        {hoverX !== null && (
          <line x1={hoverX} x2={hoverX} y1={PAD.top} y2={PAD.top + g.plotH} stroke="var(--chart-crosshair, #94a3b8)" strokeWidth={1} />
        )}

        {/* Selection, drawn only WHILE dragging — nothing is emitted otherwise,
            so the SVG the PDF export serialises is unchanged. Neutral ink: the
            selection is chrome, not data, and must not read as a limit band. */}
        {dragRect && (
          <g>
            <rect x={dragRect.x} y={PAD.top} width={dragRect.w} height={g.plotH} fill="var(--chart-selection, #334155)" opacity={0.12} />
            <line x1={dragRect.x} x2={dragRect.x} y1={PAD.top} y2={PAD.top + g.plotH} stroke="var(--chart-selection, #334155)" strokeWidth={1} />
            <line x1={dragRect.x + dragRect.w} x2={dragRect.x + dragRect.w} y1={PAD.top} y2={PAD.top + g.plotH}
                  stroke="var(--chart-selection, #334155)" strokeWidth={1} />
          </g>
        )}
      </svg>

      <div className="mt-1 flex min-h-[18px] flex-wrap items-center gap-3 text-xs">
        {readout.length > 0 ? readout.map((r) => (
          <span key={r.label} className="flex items-center gap-1.5 text-slate-600">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: r.color }} />
            {r.label}: <span className="font-semibold tabular-nums text-slate-800">{formatDecimals(r.value, r.decimals)} {unit}</span>
            {/* The reading's own timestamp — not the pixel the pointer happens to
                sit on — so the hover readout names the exact instant it is
                quoting a value for. */}
            <span className="tabular-nums text-slate-400">{formatDateTime(r.ts)}</span>
          </span>
        )) : (
          <span className="text-slate-400">
            {interactive
              // Said, not left to be discovered: a drag that silently refetches
              // is otherwise indistinguishable from the page reloading itself.
              ? 'Hover the chart to read values · drag across it to zoom into that window'
              : 'Hover the chart to read values'}
          </span>
        )}
      </div>
    </div>
  );
}
