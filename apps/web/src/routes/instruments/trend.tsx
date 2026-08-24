import { Link, useParams } from 'react-router-dom';
import useSWR from 'swr';
import { INTERVALS, TELEMETRY_DECIMALS_FALLBACK } from '@digilog/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { statusClasses, readingAge } from '@/routes/dashboard/status';
import { formatSetPoint } from '@/routes/dashboard/set-point';
import { useTrendPeriod, useInstrumentTrend, TREND_PRESETS } from './use-trend-data';

/**
 * The instrument trend page — limit-lined charts, raw paged history, alarms,
 * and latest-value cards, all in one place.
 *
 * Everything server-resolved (limits, their source, decimals, status) comes
 * straight off the telemetry-overview row and the annotated telemetry rows —
 * this page never re-derives any of it. See `use-trend-data.ts`.
 */

interface InstrumentSummary {
  id: string;
  code: string;
  name: string;
}

function CardSkeleton({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent><p className="text-sm text-slate-400">Loading…</p></CardContent>
    </Card>
  );
}

/**
 * One slot's (temperature or humidity) latest value: its reading at the
 * instrument's own decimals, how long ago it arrived, and the limits it is
 * judged against — with WHERE those limits came from, because a set point
 * with no visible source reads as asserted rather than resolved.
 */
function LatestValueCard({
  title,
  unit,
  reading,
  decimals,
  min,
  max,
  limitSource,
  roomCode,
}: {
  title: string;
  unit: string;
  reading: { value: number; ts: string } | null;
  decimals: number;
  min: number | null | undefined;
  max: number | null | undefined;
  limitSource: 'INSTRUMENT' | 'ROOM' | null;
  roomCode: string | null;
}) {
  const status = reading
    ? min != null && reading.value < min
      ? 'OUT_OF_SPEC'
      : max != null && reading.value > max
        ? 'OUT_OF_SPEC'
        : 'OK'
    : 'NO_DATA';
  const sc = statusClasses(status);
  const sourceText = limitSource === 'INSTRUMENT'
    ? 'from this instrument'
    : limitSource === 'ROOM'
      ? `from room ${roomCode ?? '—'}`
      : 'no limits set';

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold ${sc.bg} ${sc.text} ${sc.border}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${sc.dot}`} />
          {sc.label}
        </span>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-bold tabular-nums text-slate-800">
          {reading ? reading.value.toFixed(decimals) : '—'}
          <span className="ml-1 text-base font-medium text-slate-400">{unit}</span>
        </p>
        <p className="mt-1 text-xs text-slate-500">
          {reading ? readingAge(reading.ts) : 'No readings in this instrument’s history'}
        </p>
        <p className="mt-3 text-xs text-slate-500">
          Limits: <span className="font-medium text-slate-700">{formatSetPoint(min, max, decimals)}</span>{' '}
          <span className="text-slate-400">({sourceText})</span>
        </p>
      </CardContent>
    </Card>
  );
}

export function InstrumentTrend() {
  const { id } = useParams<{ id: string }>();
  const { data: inst } = useSWR<InstrumentSummary>(id ? `/api/instruments/${id}` : null);
  const { period, setPreset, setCustom, setInterval } = useTrendPeriod();
  const trend = useInstrumentTrend(id ?? '', period, 1, []);

  const fromLocal = period.from.slice(0, 16);
  const toLocal = period.to.slice(0, 16);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to={id ? `/instruments/${id}` : '/instruments'} className="text-xs text-slate-500 hover:text-slate-700">
            &larr; Back to instrument
          </Link>
          <h1 className="mt-0.5 font-mono text-2xl font-bold tracking-tight text-slate-800">
            {inst?.code ?? '…'} <span className="font-sans text-base font-normal text-slate-500">Trend</span>
          </h1>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 pt-6">
          <div className="flex flex-wrap gap-1.5">
            {TREND_PRESETS.map((p) => (
              <Button
                key={p.label}
                size="sm"
                variant={period.label === p.label ? 'default' : 'secondary'}
                onClick={() => setPreset(p.ms)}
              >
                {p.label}
              </Button>
            ))}
          </div>

          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            From
            <input
              type="datetime-local"
              value={fromLocal}
              onChange={(e) => e.target.value && setCustom(new Date(e.target.value).toISOString(), period.to)}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs [color-scheme:light]"
              aria-label="From"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            To
            <input
              type="datetime-local"
              value={toLocal}
              onChange={(e) => e.target.value && setCustom(period.from, new Date(e.target.value).toISOString())}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs [color-scheme:light]"
              aria-label="To"
            />
          </label>

          {/* The interval applies to the CHARTS only — labelled explicitly so a
              control that visibly does nothing to the table below it doesn't
              read as broken. */}
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            Chart interval
            <select
              value={period.intervalMs ?? ''}
              onChange={(e) => setInterval(e.target.value === '' ? null : Number(e.target.value))}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
              aria-label="Chart interval"
            >
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.seconds === null ? '' : i.seconds * 1000}>{i.label}</option>
              ))}
            </select>
          </label>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        {trend.overview ? (
          <>
            <LatestValueCard
              title="Temperature"
              unit="°C"
              reading={trend.overview.temperature}
              decimals={trend.overview.decimals.temperature ?? TELEMETRY_DECIMALS_FALLBACK}
              min={trend.overview.limits?.tempMin}
              max={trend.overview.limits?.tempMax}
              limitSource={trend.overview.limitSource}
              roomCode={trend.overview.room?.code ?? null}
            />
            <LatestValueCard
              title="Humidity"
              unit="%RH"
              reading={trend.overview.humidity}
              decimals={trend.overview.decimals.humidity ?? TELEMETRY_DECIMALS_FALLBACK}
              min={trend.overview.limits?.rhMin}
              max={trend.overview.limits?.rhMax}
              limitSource={trend.overview.limitSource}
              roomCode={trend.overview.room?.code ?? null}
            />
          </>
        ) : (
          <>
            <CardSkeleton title="Temperature" />
            <CardSkeleton title="Humidity" />
          </>
        )}
      </div>
    </div>
  );
}
