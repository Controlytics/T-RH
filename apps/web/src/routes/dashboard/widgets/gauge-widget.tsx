/**
 * Gauges — one ring per instrument × key, at most `GAUGES_SHOWN_MAX`, saying how
 * many it did not draw. What each ring draws and says is `gauge-model.ts`; this
 * file lays it out: the instrument and key on top, the number over the ring's
 * centre (the page's Inter, tabular figures), the status word and the scale
 * under it. Present state only: no period, no window.
 */
import { useMemo } from 'react';
import { GAUGES_SHOWN_MAX, type CustomWidget, type LatestKeyValue, type WidgetKey } from '@digilog/shared';
import { useSensorWords, type SensorWords } from '@/hooks/use-failure-text';
import { LazyEChart } from './charts/lazy-echart';
import { GAUGE_SIZE, buildGaugeOption, gaugeModel, gaugePairs, readingSize, type GaugeScale } from './gauge-model';
import type { WidgetSelection } from './use-widget-data';
import { CapNote, LOAD_FAILED, NO_INSTRUMENTS, NO_KEY_YET, WidgetMessage, useWidgetRows } from './widget-common';

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

  return (
    <div className="space-y-2">
      <CapNote shown={shown.length} total={pairs.length} noun="gauges" />
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(11rem,1fr))]">
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
  const { kind, position, color } = m;
  const option = useMemo(() => buildGaugeOption({ kind, position, color }), [kind, position, color]);
  const label = widgetKey.label ?? widgetKey.key;
  const title = `${code} · ${label}`;
  const reading = m.unit ? `${m.text} ${m.unit}` : m.text;

  return (
    <figure
      data-testid="gauge"
      data-kind={m.kind}
      className="flex min-w-0 flex-col rounded-[var(--radius-card)] border border-slate-200 bg-white px-3 pb-3 pt-2.5 shadow-[var(--elev-1)]"
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
        {/* Over the ring's centre. The chart's label already reads it out. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span
            data-testid="gauge-value"
            className={`max-w-[6rem] truncate font-extrabold leading-none tracking-tight tabular-nums ${readingSize(m.text)} ${m.fault ? 'text-red-600' : 'text-slate-900'}`}
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
        <p
          data-testid="gauge-scale"
          className="mt-0.5 truncate text-center text-[0.6875rem] text-slate-500"
          title={`${m.scale.label} ${m.scale.text}${m.scale.unit ? ` ${m.scale.unit}` : ''}`}
        >
          <span className="font-semibold uppercase tracking-[0.06em] text-slate-400">{m.scale.label}</span>
          <span className="ml-1.5 tabular-nums">{m.scale.text}{m.scale.unit ? ` ${m.scale.unit}` : ''}</span>
        </p>
      )}
    </figure>
  );
}
