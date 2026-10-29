/**
 * Trend chart — every (instrument × telemetry key) series of the widget, on the
 * shared `TimeSeriesChart` (`variant="trend"`), over a period chosen in the
 * widget. Zoom REFETCHES the narrower window, as on the trend page.
 *
 * - Only readings that are numbers are plotted (`coerceReading`: a quoted number
 *   IS a number); the chart says how many it could not plot instead of dropping
 *   them silently (`count - numericCount`, from the server's summaries).
 * - Limit lines appear ONLY when every series is measured and shares the same
 *   bounds — one pair of lines on a chart of different bounds would be read as
 *   applying to all of them.
 * - A measured series prints at the server's decimals; a raw one at the widget's
 *   decimals, else at the precision the device actually sent (`decimalsSeen`).
 * - Current is the latest STORED reading (from latest-values), never a point of
 *   the sampled series; Min / Max / Average are the server's, over every reading.
 */
import { coerceReading, TREND_SERIES_MAX, type CustomWidget, type LatestKeyValue } from '@digilog/shared';
import { useSensorWords } from '@/hooks/use-failure-text';
import { SampledNote } from '@/routes/instruments/sampled-note';
import { TimeSeriesChart, seriesColor, type ChartSeries } from '../time-series-chart';
import { decimalsSeen, isMeasured, keyCell } from './key-value';
import { useWidgetHistory, type WidgetSelection } from './use-widget-data';
import {
  CapNote, LOAD_FAILED, NO_INSTRUMENTS, NO_KEY_YET, PeriodSelect, WidgetMessage, useWidgetRange, useWidgetRows, valueOf,
} from './widget-common';

interface Plotted {
  series: ChartSeries;
  instrumentId: string;
  key: string;
  latest: LatestKeyValue | undefined;
  current: string;
  /** The unit beside Current — none beside NA or a fault word. */
  currentUnit: string | null;
  unit: string | null;
}

export function TrendChartWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  const { rows, loading, error, empty } = useWidgetRows(widget, selection);
  const { preset, setPreset, range, zoomed, zoomTo, resetZoom } = useWidgetRange(widget.options.period);
  const words = useSensorWords();

  const telemetryKeys = widget.keys.filter((k) => k.source === 'telemetry');
  // Only instruments that have SENT the key: a key a few instruments carry must
  // not be cut behind empty series of instruments that never sent it
  // (review 2026-10-29).
  const pairs = rows.flatMap((row) => telemetryKeys
    .filter((key) => valueOf(row, key)?.ts != null)
    .map((key) => ({ row, key })));
  const shownPairs = pairs.slice(0, TREND_SERIES_MAX);
  const historyIds = [...new Set(shownPairs.map((p) => p.row.instrumentId))];
  // A key's chosen colour names the KEY only when one instrument is drawn; across
  // several instruments every series takes its own palette slot, or the lines
  // for one key would be indistinguishable.
  const singleInstrument = historyIds.length === 1;
  const { byInstrument, loading: historyLoading } = useWidgetHistory(historyIds, telemetryKeys.map((k) => k.key), range);

  if (loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (error) return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (empty) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;
  if (pairs.length === 0) return <WidgetMessage>{NO_KEY_YET}</WidgetMessage>;

  const plotted: Plotted[] = shownPairs.flatMap(({ row, key }, index) => {
    const h = byInstrument.get(row.instrumentId);
    if (!h) return [];
    const points = h.history
      .filter((r) => r.key === key.key)
      .map((r) => ({ ts: r.ts, value: coerceReading(r.value) }))
      .filter((p): p is { ts: string; value: number } => p.value !== null)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    const latest = valueOf(row, key);
    const measured = latest !== undefined && isMeasured(latest);
    const decimals = measured && latest.decimals !== null
      ? latest.decimals
      : key.decimals ?? decimalsSeen(points.map((p) => p.value));
    const cell = keyCell(latest, row.reporting, key, words);
    return [{
      series: {
        id: `${row.instrumentId}:${key.key}`,
        label: `${row.code} · ${key.label ?? key.key}`,
        decimals,
        color: seriesColor(singleInstrument ? key.color ?? index : index),
        points,
      },
      instrumentId: row.instrumentId,
      key: key.key,
      latest,
      current: cell.text,
      currentUnit: cell.unit,
      unit: measured ? latest.unit : key.unit ?? null,
    }];
  });

  const bounds = plotted.map((p) => (p.latest && isMeasured(p.latest) ? p.latest.judged : null));
  const shared = bounds.length > 0 && bounds.every((b) => b !== null
    && b.limitMin === bounds[0]!.limitMin && b.limitMax === bounds[0]!.limitMax) ? bounds[0] : null;
  const units = new Set(plotted.map((p) => p.unit ?? ''));
  const unit = units.size === 1 ? [...units][0] : '';

  let notPlotted = 0;
  let sampled = false;
  let totalReadings = 0;
  let shownReadings = 0;
  for (const p of plotted) {
    const h = byInstrument.get(p.instrumentId)!;
    const s = h.summaries[p.key];
    if (s) {
      notPlotted += Math.max(0, s.count - s.numericCount);
      totalReadings += s.count;
    }
    shownReadings += h.history.filter((r) => r.key === p.key).length;
    if (h.historySampled) sampled = true;
  }

  const fmt = (v: number | null | undefined, d: number) => (typeof v === 'number' ? v.toFixed(d) : '—');
  const spanMs = new Date(range.to).getTime() - new Date(range.from).getTime();

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <PeriodSelect name={`widget-period-${widget.id}`} value={preset} onChange={setPreset} />
        {zoomed && (
          <button type="button" onClick={resetZoom} className="text-xs font-semibold text-[var(--theme-primary)] hover:underline">
            Reset zoom
          </button>
        )}
        <CapNote shown={shownPairs.length} total={pairs.length} noun="series" />
      </div>
      {historyLoading && plotted.length === 0 ? (
        <WidgetMessage>Loading…</WidgetMessage>
      ) : (
        <TimeSeriesChart
          variant="trend"
          title={widget.title}
          series={plotted.map((p) => p.series)}
          unit={unit}
          min={shared?.limitMin ?? null}
          max={shared?.limitMax ?? null}
          minText={shared?.limitMinText ?? null}
          maxText={shared?.limitMaxText ?? null}
          spanMs={spanMs}
          onZoom={zoomTo}
          onResetZoom={resetZoom}
        />
      )}
      {notPlotted > 0 && (
        <p className="text-xs font-medium text-slate-600" data-testid="widget-not-plotted">
          {notPlotted.toLocaleString()} text readings not plotted
        </p>
      )}
      {sampled && <SampledNote shown={shownReadings} total={totalReadings} />}
      <div className="overflow-x-auto">
        <table className="tbl tbl-grid w-full text-xs" data-testid="trend-widget-strip">
          <thead>
            <tr>
              <th scope="col" className="text-left">Series</th>
              <th scope="col" className="text-right">Current</th>
              <th scope="col" className="text-right">Min</th>
              <th scope="col" className="text-right">Max</th>
              <th scope="col" className="text-right">Average</th>
            </tr>
          </thead>
          <tbody>
            {plotted.map((p) => {
              const s = byInstrument.get(p.instrumentId)!.summaries[p.key];
              const d = p.series.decimals;
              return (
                <tr key={p.series.id}>
                  <td>
                    <span aria-hidden className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: p.series.color }} />
                    {p.series.label}
                  </td>
                  <td className="text-right tabular-nums font-semibold">{p.current}{p.currentUnit ? ` ${p.currentUnit}` : ''}</td>
                  <td className="text-right tabular-nums">{fmt(s?.min, d)}</td>
                  <td className="text-right tabular-nums">{fmt(s?.max, d)}</td>
                  <td className="text-right tabular-nums">{fmt(s?.avg, d)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
