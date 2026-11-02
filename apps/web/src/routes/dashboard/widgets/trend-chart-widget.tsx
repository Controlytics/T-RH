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
import {
  coerceReading, TREND_SERIES_MAX,
  type CustomWidget, type DataKeyJudged, type LatestKeyValue, type LatestValuesRow, type WidgetKey,
} from '@digilog/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useSensorWords, type SensorWords } from '@/hooks/use-failure-text';
import { SampledNote } from '@/routes/instruments/sampled-note';
import { TimeSeriesChart, seriesColor, type ChartSeries } from '../time-series-chart';
import { decimalsSeen, isMeasured, keyCell } from './key-value';
import { useWidgetHistory, type InstrumentHistory, type WidgetSelection } from './use-widget-data';
import {
  LOAD_FAILED, NO_INSTRUMENTS, NO_KEY_YET, PeriodSelect, WidgetMessage, WidgetNotes, keyColorSlots, useWidgetRange, useWidgetRows, valueOf,
} from './widget-common';
import { usePublishWidgetRange } from './widget-report-view';

export interface TrendPlotted {
  series: ChartSeries;
  instrumentId: string;
  key: string;
  /** The instrument's row — its code and Location, for the widget's report. */
  row: LatestValuesRow;
  widgetKey: WidgetKey;
  latest: LatestKeyValue | undefined;
  current: string;
  /** The unit beside Current — none beside NA or a fault word. */
  currentUnit: string | null;
  unit: string | null;
}

export interface TrendPair { row: LatestValuesRow; key: WidgetKey }

/**
 * Which series a trend chart draws: every (instrument × telemetry key) whose
 * instrument has SENT the key — a key a few instruments carry must not be cut
 * behind empty series of instruments that never sent it (review 2026-10-29) —
 * the first `TREND_SERIES_MAX` of them. The widget and its report (2026-11-02)
 * both ask this, so the printed series are the drawn ones.
 */
export function trendPairs(rows: readonly LatestValuesRow[], telemetryKeys: readonly WidgetKey[]): { pairs: TrendPair[]; shown: TrendPair[] } {
  const pairs = rows.flatMap((row) => telemetryKeys
    .filter((key) => valueOf(row, key)?.ts != null)
    .map((key) => ({ row, key })));
  return { pairs, shown: pairs.slice(0, TREND_SERIES_MAX) };
}

/**
 * The drawn series of a trend chart — points, decimals, colour, Current — and
 * the shared limits and unit, from the instruments' latest values and their
 * history. Pure: the widget draws it, and its report prints the same series
 * and the same picture (`renderChartToPng` mounts the same chart).
 *
 * A key's chosen colour names the KEY only when one instrument is drawn; across
 * several instruments every series takes its own palette slot, or the lines for
 * one key would be indistinguishable. On one instrument a key without a colour
 * takes a slot no key chose (fix round 1, m-7 — `key.color ?? index` drew a key
 * in the colour another key had been given).
 */
export function trendPlot(
  shown: readonly TrendPair[],
  telemetryKeys: readonly WidgetKey[],
  byInstrument: ReadonlyMap<string, InstrumentHistory>,
  words: SensorWords,
): { plotted: TrendPlotted[]; shared: DataKeyJudged | null; unit: string } {
  const singleInstrument = new Set(shown.map((p) => p.row.instrumentId)).size === 1;
  const keySlots = keyColorSlots(telemetryKeys);
  const plotted: TrendPlotted[] = shown.flatMap(({ row, key }, index) => {
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
        color: seriesColor(singleInstrument ? keySlots[telemetryKeys.indexOf(key)] : index),
        points,
      },
      instrumentId: row.instrumentId,
      key: key.key,
      row,
      widgetKey: key,
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
  return { plotted, shared, unit: units.size === 1 ? [...units][0] : '' };
}

export function TrendChartWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  const { rows, loading, error, empty, refreshFailed } = useWidgetRows(widget, selection);
  const { preset, setPreset, range, zoomed, zoomTo, resetZoom } = useWidgetRange(widget.options.period, selection.window);
  usePublishWidgetRange(widget.id, range);
  const words = useSensorWords();

  const telemetryKeys = widget.keys.filter((k) => k.source === 'telemetry');
  const { pairs, shown: shownPairs } = trendPairs(rows, telemetryKeys);
  const historyIds = [...new Set(shownPairs.map((p) => p.row.instrumentId))];
  const { byInstrument, loading: historyLoading } = useWidgetHistory(historyIds, telemetryKeys.map((k) => k.key), range);

  if (loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (error) return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (empty) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;
  if (pairs.length === 0) return <WidgetMessage>{NO_KEY_YET}</WidgetMessage>;

  const { plotted, shared, unit } = trendPlot(shownPairs, telemetryKeys, byInstrument, words);

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
        <PeriodSelect name={`widget-period-${widget.id}`} value={preset} onChange={setPreset} withDashboard={selection.window !== undefined} />
        {zoomed && (
          <button type="button" onClick={resetZoom} className="text-xs font-semibold text-[var(--theme-primary)] hover:underline">
            Reset zoom
          </button>
        )}
        <WidgetNotes cap={{ shown: shownPairs.length, total: pairs.length, noun: 'series' }} refreshFailed={refreshFailed} />
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
      {/* The app's table (ruling R5, 2026-10-29) — see latest-table-widget.
          Compact (`size="default"`, shorter rows): it is a summary under the
          chart, not the widget's subject. */}
      <Table size="default" data-testid="trend-widget-strip">
        <TableHeader>
          <tr>
            <TableHead scope="col" className="h-9">Series</TableHead>
            <TableHead scope="col" className="h-9 text-right">Current</TableHead>
            <TableHead scope="col" className="h-9 text-right">Min</TableHead>
            <TableHead scope="col" className="h-9 text-right">Max</TableHead>
            <TableHead scope="col" className="h-9 text-right">Average</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {plotted.map((p) => {
            const s = byInstrument.get(p.instrumentId)!.summaries[p.key];
            const d = p.series.decimals;
            return (
              <TableRow key={p.series.id}>
                <TableCell className="py-2">
                  <span aria-hidden className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: p.series.color }} />
                  {p.series.label}
                </TableCell>
                <TableCell className="py-2 text-right tabular-nums font-semibold">{p.current}{p.currentUnit ? ` ${p.currentUnit}` : ''}</TableCell>
                <TableCell className="py-2 text-right tabular-nums">{fmt(s?.min, d)}</TableCell>
                <TableCell className="py-2 text-right tabular-nums">{fmt(s?.max, d)}</TableCell>
                <TableCell className="py-2 text-right tabular-nums">{fmt(s?.avg, d)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
