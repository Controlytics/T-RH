import { useState } from 'react';
import { Link } from 'react-router-dom';
import { statusClasses, readingAge } from './status';
import {
  useRoomHistory,
  useTelemetryOverview,
  useTelemetrySettings,
  formatSlot,
  HISTORY_WINDOWS,
  type HistoryWindow,
} from './use-telemetry';
import { TimeSeriesChart, type ChartSeries } from './time-series-chart';

/**
 * One room: which instruments are in it, what they read now, and what they have
 * been doing.
 *
 * Both charts are fed by a SINGLE request for the whole room — a
 * three-instrument room would otherwise poll six endpoints every few seconds.
 */

const SPAN_MS: Record<HistoryWindow, number> = {
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
};

interface Props {
  floorplanId: string;
  roomId: string;
  onBack: () => void;
}

/** "18.0 – 25.0 °C", or nothing when the room sets no bound for that slot. */
function limitText(min: number | null, max: number | null, unit: string): string | null {
  if (min == null && max == null) return null;
  if (min != null && max != null) return `${min} – ${max} ${unit}`;
  if (min != null) return `min ${min} ${unit}`;
  return `max ${max} ${unit}`;
}

export function RoomDetail({ floorplanId, roomId, onBack }: Props) {
  const [window, setWindow] = useState<HistoryWindow>('1h');
  const { history, isLoading, error, refreshMs } = useRoomHistory(floorplanId, roomId, window);
  const { rows } = useTelemetryOverview();
  const { temperatureDecimals, humidityDecimals } = useTelemetrySettings();

  const room = history?.room;
  const roomRows = rows.filter((r) => r.room?.id === roomId);

  const toChart = (slot: 'temperature' | 'humidity'): ChartSeries[] =>
    (history?.series ?? [])
      .filter((s) => s.slot === slot)
      .map((s) => ({ id: `${s.instrumentId}-${s.slot}`, label: s.instrumentCode, points: s.points }));

  const tempLimits = limitText(room?.tempMin ?? null, room?.tempMax ?? null, '°C');
  const rhLimits = limitText(room?.rhMin ?? null, room?.rhMax ?? null, '%RH');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <button
            onClick={onBack}
            className="mb-1 text-sm font-medium text-slate-500 hover:text-slate-800"
          >
            ← Back to floor
          </button>
          <h3 className="text-lg font-semibold text-slate-800">
            {room?.code ?? 'Room'}
            {room?.label && <span className="ml-2 font-normal text-slate-500">{room.label}</span>}
          </h3>
          <p className="text-xs text-slate-500">
            {tempLimits || rhLimits
              ? [tempLimits, rhLimits].filter(Boolean).join(' · ')
              : 'No limits set — this room is never reported out of spec.'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1">
            {HISTORY_WINDOWS.map((w) => (
              <button
                key={w.value}
                onClick={() => setWindow(w.value)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  window === w.value ? 'bg-slate-800 text-white' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Could not load this room&rsquo;s history.
        </div>
      )}

      {roomRows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
          <p className="text-sm font-medium text-slate-700">No instruments in this room.</p>
          <p className="mt-1 text-xs text-slate-500">
            Assign one on{' '}
            <Link to="/config/floorplans" className="font-medium underline" style={{ color: 'var(--theme-primary)' }}>
              Configuration → Floorplans
            </Link>.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {roomRows.map((r) => {
            const c = statusClasses(r.status);
            const latest = [r.temperature?.ts, r.humidity?.ts].filter(Boolean).sort().pop() ?? null;
            return (
              <div key={r.instrumentId} className={`rounded-xl border p-3 ${c.bg} ${c.border}`}>
                <div className="flex items-center justify-between gap-2">
                  <Link to={`/instruments/${r.instrumentId}`} className="text-sm font-semibold text-slate-800 hover:underline">
                    {r.code}
                  </Link>
                  <span className={`flex items-center gap-1 text-[11px] font-medium ${c.text}`}>
                    <span className={`h-2 w-2 rounded-full ${c.dot}`} />
                    {c.label}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">{r.name}</p>
                <p className="mt-2 text-sm font-semibold tabular-nums text-slate-800">
                  {formatSlot(r.temperature, temperatureDecimals, '°C')}
                  <span className="mx-1.5 text-slate-300">|</span>
                  {formatSlot(r.humidity, humidityDecimals, '%RH')}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">{readingAge(latest)}</p>
              </div>
            );
          })}
        </div>
      )}

      {isLoading && !history ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
          Loading history…
        </div>
      ) : (
        <div className="space-y-3">
          <TimeSeriesChart
            title="Temperature"
            unit="°C"
            series={toChart('temperature')}
            min={room?.tempMin ?? null}
            max={room?.tempMax ?? null}
            spanMs={SPAN_MS[window]}
          />
          <TimeSeriesChart
            title="Humidity"
            unit="%RH"
            series={toChart('humidity')}
            min={room?.rhMin ?? null}
            max={room?.rhMax ?? null}
            spanMs={SPAN_MS[window]}
          />
        </div>
      )}

      <p className="text-xs text-slate-500">
        {history?.bucketSeconds
          ? `Averaged into ${Math.round(history.bucketSeconds / 60)}-minute buckets. `
          : ''}
        Updates every {Math.round(refreshMs / 1000)}s.
      </p>
    </div>
  );
}
