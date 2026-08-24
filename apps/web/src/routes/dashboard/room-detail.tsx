import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDecimals } from '@digilog/shared';
import { statusClasses, readingAge } from './status';
import {
  useRoomHistory,
  useTelemetrySettings,
  type OverviewRow,
  useTelemetryOverview,
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

/**
 * "18.0 – 25.0 °C", or nothing when no bound is set for that slot.
 *
 * At the same precision as the readings it bounds — a header reading "18 – 25"
 * over a chart of 21.5s invites the question of whether the limit is really a
 * whole number.
 */
function limitText(min: number | null, max: number | null, unit: string, decimals: number): string | null {
  if (min == null && max == null) return null;
  const f = (n: number) => formatDecimals(n, decimals) ?? String(n);
  if (min != null && max != null) return `${f(min)} – ${f(max)} ${unit}`;
  if (min != null) return `min ${f(min)} ${unit}`;
  return `max ${f(max!)} ${unit}`;
}

export function RoomDetail({ floorplanId, roomId, onBack }: Props) {
  const [window, setWindow] = useState<HistoryWindow>('1h');
  const { history, isLoading, error, refreshMs } = useRoomHistory(floorplanId, roomId, window);
  const { rows } = useTelemetryOverview();
  const settings = useTelemetrySettings();

  const room = history?.room;
  const roomRows = rows.filter((r) => r.room?.id === roomId);

  const toChart = (slot: 'temperature' | 'humidity'): ChartSeries[] =>
    (history?.series ?? [])
      .filter((s) => s.slot === slot)
      .map((s) => ({
        id: `${s.instrumentId}-${s.slot}`,
        label: s.instrumentCode,
        decimals: s.decimals,
        points: s.points,
      }));

  /**
   * The band to shade, or null.
   *
   * This chart overlays EVERY instrument in the room, and since 2026-08-19 each
   * one can carry its own limits — so there is not necessarily a single spec to
   * draw. One band belonging to only some of the lines would be read as applying
   * to all of them, which on a compliance chart is a claim about readings that
   * were never judged against it.
   *
   * So: shade only where every instrument in the room agrees, and say so in
   * words when they do not. Falls back to the ROOM's own bound when no overview
   * row has arrived yet — that is the only thing known at that moment, and it is
   * what this chart drew before instruments could specify anything.
   */
  const agreedBound = (pick: (l: NonNullable<OverviewRow['limits']>) => number | null): number | null => {
    if (roomRows.length === 0) return null;
    const values = roomRows.map((r) => (r.limits ? pick(r.limits) : null));
    const first = values[0];
    return values.every((v) => v === first) ? first : null;
  };
  const bounds = roomRows.length === 0
    ? {
        tempMin: room?.tempMin ?? null, tempMax: room?.tempMax ?? null,
        rhMin: room?.rhMin ?? null, rhMax: room?.rhMax ?? null,
      }
    : {
        tempMin: agreedBound((l) => l.tempMin), tempMax: agreedBound((l) => l.tempMax),
        rhMin: agreedBound((l) => l.rhMin), rhMax: agreedBound((l) => l.rhMax),
      };

  /** Do the instruments here disagree about their spec? Then no band is drawn. */
  const mixedSpecs = roomRows.length > 1 && roomRows.some((r) =>
    JSON.stringify(r.limits) !== JSON.stringify(roomRows[0].limits));

  /** The precision to quote a SHARED bound at — only meaningful when the
   *  instruments agree on it, so it falls back to the site default when they
   *  don't (in which case no band is drawn anyway). */
  const agreedDecimals = (slot: 'temperature' | 'humidity'): number => {
    if (roomRows.length === 0) return settings[slot === 'temperature' ? 'temperatureDecimals' : 'humidityDecimals'];
    const values = roomRows.map((r) => r.decimals[slot]);
    return values.every((v) => v === values[0]) ? values[0]
      : settings[slot === 'temperature' ? 'temperatureDecimals' : 'humidityDecimals'];
  };
  const tempLimits = limitText(bounds.tempMin, bounds.tempMax, '°C', agreedDecimals('temperature'));
  const rhLimits = limitText(bounds.rhMin, bounds.rhMax, '%RH', agreedDecimals('humidity'));

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
            {mixedSpecs
              ? 'Instruments here specify different limits — no shared band is drawn'
              : tempLimits || rhLimits
              ? [tempLimits, rhLimits].filter(Boolean).join(' · ')
              : 'No limits set — this room is never reported out of limit.'}
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
                  {formatSlot(r.temperature, r.decimals.temperature, '°C')}
                  <span className="mx-1.5 text-slate-300">|</span>
                  {formatSlot(r.humidity, r.decimals.humidity, '%RH')}
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
            min={bounds.tempMin}
            max={bounds.tempMax}
            spanMs={SPAN_MS[window]}
          />
          <TimeSeriesChart
            title="Humidity"
            unit="%RH"
            series={toChart('humidity')}
            min={bounds.rhMin}
            max={bounds.rhMax}
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
