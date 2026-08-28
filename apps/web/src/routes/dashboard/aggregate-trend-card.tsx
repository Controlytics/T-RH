import useSWR from 'swr';
import { TimeSeriesChart } from './time-series-chart';
import {
  derivedNote, limitNote, shouldDrawBand, sparseMessage, peakReporting,
  type AggregateBounds, type AggregatePoint,
} from './aggregate-trend';

/**
 * The dashboard's aggregate trend: min / mean / max across whatever the viewer has
 * drilled into, narrowed by their instrument visibility scope.
 *
 * **EVERY VALUE ON THIS CHART IS COMPUTED.** None of them is a stored reading, and
 * the card says so above the plot. The per-instrument trend page is one click away
 * and is where the actual record lives — this answers "is this area holding
 * spec?", not "what did instrument X read at 14:32?".
 *
 * Design: docs/superpowers/specs/2026-08-28-dashboard-aggregate-widgets-design.md
 */

const WINDOWS = ['1h', '6h', '24h', '7d'] as const;
type Window = (typeof WINDOWS)[number];

const TEMP_COLOR = 'var(--chart-series-1, #2a78d6)';
const HUMID_COLOR = 'var(--chart-series-2, #eb6834)';

interface AggregateBody {
  from: string;
  to: string;
  instrumentCount: number;
  series: { temperature: AggregatePoint[]; humidity: AggregatePoint[] };
  limits: { temperature: AggregateBounds | null; humidity: AggregateBounds | null };
  limitsMixed: { temperature: boolean; humidity: boolean };
}

function SlotChart({
  title, unit, color, points, bounds, mixed, selectionCount, spanMs,
}: {
  title: string;
  unit: string;
  color: string;
  points: AggregatePoint[];
  bounds: AggregateBounds | null;
  mixed: boolean;
  selectionCount: number;
  spanMs: number;
}) {
  const band = shouldDrawBand(points);
  const note = limitNote(bounds, mixed);

  // Too few instruments reporting: show the COUNT, not a band. A spread drawn from
  // one sensor while the label claims a selection of thirty is the kind of chart
  // that gets believed.
  if (!band) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <p className="text-sm font-medium text-slate-700">{title}</p>
        <p className="mt-2 text-sm text-slate-500">{sparseMessage(points, selectionCount)}</p>
      </div>
    );
  }

  return (
    <div>
      <TimeSeriesChart
        title={title}
        unit={unit}
        spanMs={spanMs}
        min={bounds?.min ?? null}
        max={bounds?.max ?? null}
        envelope={{
          points: points.map((p) => ({ ts: p.ts, lo: p.min, hi: p.max })),
          color,
        }}
        series={[{
          id: 'mean',
          label: 'Mean',
          color,
          // A mean across instruments has no single instrument's precision behind
          // it, so it is shown to one decimal rather than borrowing a number that
          // belongs to one probe and not the others.
          decimals: 1,
          points: points.map((p) => ({ ts: p.ts, value: p.mean })),
        }]}
      />
      <p className="mt-1 text-[11px] text-slate-500">
        Shaded area is the minimum-to-maximum spread. Peak of{' '}
        <strong>{peakReporting(points)}</strong> of {selectionCount} instruments reporting.
        {note ? ` ${note}` : ''}
      </p>
    </div>
  );
}

export function AggregateTrendCard({
  functionalLocationId, directOnly, window: win, onWindowChange,
}: {
  functionalLocationId?: string;
  directOnly?: boolean;
  window: Window;
  onWindowChange: (w: Window) => void;
}) {
  const qs = new URLSearchParams({ window: win });
  if (functionalLocationId) qs.set('functionalLocationId', functionalLocationId);
  if (directOnly) qs.set('functionalLocationDirect', 'true');

  const { data, isLoading } = useSWR<AggregateBody>(
    `/api/instruments/telemetry-aggregate?${qs.toString()}`,
    // Matches the other live dashboard surfaces: polling, not a socket. There is
    // no browser-facing push channel in this fork.
    { refreshInterval: 60_000 },
  );

  const spanMs = data ? new Date(data.to).getTime() - new Date(data.from).getTime() : 0;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500">
            Trend — spread across this selection
          </h2>
          {data && (
            <p className="mt-0.5 text-[11px] text-slate-500">{derivedNote(data.instrumentCount)}</p>
          )}
        </div>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => onWindowChange(w)}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition-all ${
                w === win ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      {isLoading && !data ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading…</div>
      ) : data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <SlotChart
            title="Temperature (°C)"
            unit="°C"
            color={TEMP_COLOR}
            points={data.series.temperature}
            bounds={data.limits.temperature}
            mixed={data.limitsMixed.temperature}
            selectionCount={data.instrumentCount}
            spanMs={spanMs}
          />
          <SlotChart
            title="Humidity (%RH)"
            unit="%RH"
            color={HUMID_COLOR}
            points={data.series.humidity}
            bounds={data.limits.humidity}
            mixed={data.limitsMixed.humidity}
            selectionCount={data.instrumentCount}
            spanMs={spanMs}
          />
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          Trend data is unavailable.
        </div>
      )}
    </section>
  );
}
