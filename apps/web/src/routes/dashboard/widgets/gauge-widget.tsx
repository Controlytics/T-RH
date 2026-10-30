/**
 * Gauges — one ring per instrument × key, at most `GAUGES_SHOWN_MAX`, saying how
 * many it did not draw and which keys nobody has sent. What each ring draws and
 * says is `gauge-model.ts`; this file lays it out: the instrument and key on
 * top, the value over the ring's centre (the page's Inter, tabular figures), the
 * status word and the scale under it. Present state only: no period, no window.
 */
import { useMemo } from 'react';
import { GAUGES_SHOWN_MAX, type CustomWidget, type LatestKeyValue, type WidgetKey } from '@digilog/shared';
import { useSensorWords, type SensorWords } from '@/hooks/use-failure-text';
import { FAULT_INK } from '../status';
import { LazyEChart } from './charts/lazy-echart';
import { GAUGE_SIZE, buildGaugeOption, gaugeModel, gaugePairs, type GaugeScale } from './gauge-model';
import type { WidgetSelection } from './use-widget-data';
import {
  CapNote, LOAD_FAILED, NO_INSTRUMENTS, NO_KEY_YET, NoReadingsNote, WidgetMessage, keysNotSent, useWidgetRows,
} from './widget-common';

/**
 * A tile's width, in px (the ring is px). `min` holds the ring with the tile's
 * padding and border; the grid AUTO-FITS columns of at least `min` and shares
 * the row out, so a full row has no empty track at its end. `max` caps a tile
 * that has a wide row to itself — one gauge in a full-width panel stays a gauge.
 */
export const GAUGE_TILE_PX = { min: 160, max: 220 } as const;

/**
 * The widest the value may be, in px: the ring's hole (2 × (outer radius −
 * stroke) = 100) less a little air.
 */
export const READING_BOX_PX = 2 * (GAUGE_SIZE.outerRadius - GAUGE_SIZE.stroke) - 6;

/**
 * The value's size in the ring, stepped down by length so it is never CLIPPED
 * and, up to 20 characters, never broken mid-digit: the band gauge's rule
 * ("neither wraps the line nor clips digits off a §11 reading") at a ring's
 * size. Each step holds its length in READING_BOX_PX at 0.55 em a character
 * (tabular, extrabold, tight — measured off the render). 20 covers a measured key
 * at the 10-decimal ceiling and a float as a Modbus reader sends it
 * (`1013.2500000000001`). Longer than 20 — a 24-character fault word
 * (`RS485_FAILURE_TEXT_MAX`), device text — wraps anyway, so it goes back up to
 * a readable 11 px rather than wrapping at the smallest step (render check).
 *
 * PX, deliberately, against the app's rem rule: the root size grows to 16 px on
 * a wide screen (`app.css`) but the ring is a fixed 120 px, so rem text would
 * outgrow its hole.
 */
export function readingSize(text: string): string {
  const n = text.length;
  return n <= 5 ? 'text-[24px]'
    : n <= 7 ? 'text-[19px]'
      : n <= 9 ? 'text-[15px]'
        : n <= 12 ? 'text-[12px]'
          : n <= 14 ? 'text-[11px]'
            : n <= 16 ? 'text-[10px]'
              : n <= 18 ? 'text-[9px]'
                : n <= 20 ? 'text-[8px]'
                  : 'text-[11px]';
}

export function GaugeWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  const { rows, loading, error, empty } = useWidgetRows(widget, selection);
  const words = useSensorWords();

  if (loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (error) return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (empty) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;

  const pairs = gaugePairs(rows, widget.keys);
  if (pairs.length === 0) return <WidgetMessage>{NO_KEY_YET}</WidgetMessage>;
  const shown = pairs.slice(0, GAUGES_SHOWN_MAX);
  const scale: GaugeScale = { min: widget.options.min, max: widget.options.max };
  // A key no instrument here has sent has no gauge: said, never silently missing.
  const unsent = keysNotSent(rows, widget.keys).map((k) => k.label ?? k.key);

  return (
    <div className="space-y-2">
      <CapNote shown={shown.length} total={pairs.length} noun="gauges" />
      <NoReadingsNote labels={unsent} />
      {/* A LITERAL class (Tailwind cannot see an interpolated one); its 160px is
          GAUGE_TILE_PX.min, and gauge-widget.test pins the two together. */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
        {shown.map(({ row, key, value }) => (
          <GaugeTile
            key={`${row.instrumentId}:${key.source}:${key.key}`}
            code={row.code}
            reporting={row.reporting}
            widgetKey={key}
            value={value}
            scale={scale}
            words={words}
          />
        ))}
      </div>
    </div>
  );
}

function GaugeTile({ code, reporting, widgetKey, value, scale, words }: {
  code: string;
  reporting: boolean;
  widgetKey: WidgetKey;
  value: LatestKeyValue;
  scale: GaugeScale;
  words: SensorWords;
}) {
  const m = gaugeModel(value, widgetKey, scale, reporting, words);
  // Keyed on what the ring DRAWS, never on object identity: every poll hands
  // new objects with (usually) the same content, and a new option is a redraw.
  const { kind, position, color, outOfLimit } = m;
  const option = useMemo(
    () => buildGaugeOption({ kind, position, color, outOfLimit }),
    [kind, position, color, outOfLimit],
  );
  const label = widgetKey.label ?? widgetKey.key;
  const title = `${code} · ${label}`;
  const reading = m.unit ? `${m.text} ${m.unit}` : m.text;
  // Text as a device sent it: neither a number, nor NA, nor an administered fault word.
  const rawText = m.value === null && !m.fault && value.value !== null && value.value !== undefined;

  return (
    <figure
      data-testid="gauge"
      data-kind={m.kind}
      style={{ maxWidth: GAUGE_TILE_PX.max }}
      className="flex w-full min-w-0 flex-col justify-self-center rounded-[var(--radius-card)] border border-slate-200 bg-white px-3 pb-3 pt-2.5 shadow-[var(--elev-1)]"
    >
      {/* Two lines, each truncating on its own: on one line a 14-character code
          left no room for the key, which is half of what tells two gauges apart
          (render check, 2026-10-30). The separator is there for a screen reader. */}
      <figcaption data-testid="gauge-title" title={title} className="min-w-0">
        <span className="block truncate text-xs font-bold leading-5 text-slate-800">{code}</span>
        <span className="sr-only"> · </span>
        <span className="block truncate text-[0.6875rem] font-semibold uppercase leading-4 tracking-[0.06em] text-slate-500">{label}</span>
      </figcaption>
      <div className="relative mt-1" style={{ height: GAUGE_SIZE.height }}>
        <LazyEChart option={option} height={GAUGE_SIZE.height} ariaLabel={`${title}: ${reading}`} />
        {/* Over the ring's centre. The chart's label already reads it out. The
            overlay lets the pointer through to the chart… */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          {/* …but the value takes it back (`pointer-events-auto`), or its title —
              the ONLY way to read clamped device text in full — could never show
              (review I1). Never `truncate`: a reading is sized to the ring
              (READING_BOX_PX), a fault word may wrap; only TEXT a device sent is
              clamped, at three lines, with the whole of it in the title. */}
          <span
            data-testid="gauge-value"
            title={m.text}
            style={{ maxWidth: READING_BOX_PX }}
            className={`pointer-events-auto whitespace-normal text-center font-extrabold leading-[1.1] tracking-tight tabular-nums [overflow-wrap:anywhere] ${readingSize(m.text)} ${m.fault ? FAULT_INK : 'text-slate-900'} ${rawText ? 'line-clamp-3' : ''}`}
          >
            {m.text}
          </span>
          {m.unit && <span data-testid="gauge-unit" className="mt-1 text-xs font-semibold text-slate-400">{m.unit}</span>}
        </div>
      </div>
      <p data-testid="gauge-status" className={`mt-2 flex items-center justify-center gap-1.5 text-xs font-bold ${m.classes.text}`}>
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${m.classes.dot}`} />
        {m.label}
      </p>
      {m.scale && (
        // Wraps, never truncates: a bound at ten decimals is still a bound.
        <p
          data-testid="gauge-scale"
          className="mt-0.5 break-words text-center text-[0.6875rem] text-slate-500"
          title={`${m.scale.label} ${m.scale.text}${m.scale.unit ? ` ${m.scale.unit}` : ''}`}
        >
          <span className="font-semibold uppercase tracking-[0.06em] text-slate-400">{m.scale.label}</span>
          <span className="ml-1.5 tabular-nums">{m.scale.text}{m.scale.unit ? ` ${m.scale.unit}` : ''}</span>
        </p>
      )}
    </figure>
  );
}
