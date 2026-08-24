import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import useSWR from 'swr';
import { formatDecimals, INTERVALS, MAX_SERIES_POINTS, TELEMETRY_DECIMALS_FALLBACK } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { ExportMenu } from '@/components/ExportMenu';
import { ReportDownloadDialog, type ReportDownloadRequest } from '@/components/report-download-dialog';
import { logReportExport } from '@/lib/report-export-log';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { statusClasses, readingAge } from '@/routes/dashboard/status';
import { formatSetPoint } from '@/routes/dashboard/set-point';
import { TimeSeriesChart } from '@/routes/dashboard/time-series-chart';
import {
  severityTone, triggeredText, statusText, alarmTypeText, limitText, clearedText,
  mapStatusTextsResponse,
  type AlarmRow, type AlarmStatusTexts, type AlarmStatusTextsResponse,
} from '@/routes/alarms/alarm-display';
import { useTrendPeriod, useInstrumentTrend, TREND_PRESETS, TABLE_PAGE_SIZE, type TelemetryLongRow } from './use-trend-data';
import { toChartSeries, toTableRows, type TableRow as PivotRow } from './trend-series';
import { ChartIntervalNote } from './chart-interval-note';
import { useExtraKeys } from './use-extra-keys';
import { renderTrendReport, renderTimeSeriesReport, renderAlarmsReport, type ReportInstrument } from './trend-report';

/** Rows this page actually charts/pivots are all numeric — a non-numeric
 *  reading (a raw JSON blob on some other key) has no place on an axis or in
 *  a numeric table column, so it is filtered out rather than coerced. */
function numericRows(rows: TelemetryLongRow[]): { key: string; value: number; ts: string }[] {
  return rows.filter((r): r is TelemetryLongRow & { value: number } => typeof r.value === 'number')
    .map((r) => ({ key: r.key, value: r.value, ts: r.ts }));
}

/** The raw key this instrument reports a slot under, from whichever annotated
 *  rows are in hand. Administered server-side (`loadAliases()`); never guessed here. */
function keyForSlot(rows: TelemetryLongRow[], slot: 'temperature' | 'humidity'): string | null {
  return rows.find((r) => r.slot === slot)?.key ?? null;
}

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

interface TelemetryKeyOption {
  key: string;
  slot: 'temperature' | 'humidity' | null;
  lastSeen: string;
}

/**
 * The per-user "add a key" picker.
 *
 * Offers ONLY what `GET /:id/telemetry-keys` says this instrument has actually
 * sent — a free-text field would invite a key that has never existed and a
 * chart that can never draw. The two administered slots are excluded: they
 * already have their own cards/charts above and must not be offerable twice.
 */
function ExtraKeyPicker({
  options, extraKeys, onAdd, onRemove,
}: {
  options: TelemetryKeyOption[];
  extraKeys: string[];
  onAdd: (k: string) => void;
  onRemove: (k: string) => void;
}) {
  const [pending, setPending] = useState('');
  const offerable = options.filter((o) => o.slot === null && !extraKeys.includes(o.key));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-slate-600">Additional keys:</span>
      {extraKeys.map((k) => (
        <span key={k} className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
          {k}
          <button type="button" onClick={() => onRemove(k)} aria-label={`Remove ${k}`} className="text-slate-400 hover:text-slate-700">×</button>
        </span>
      ))}
      {offerable.length > 0 && (
        <span className="flex items-center gap-1.5">
          <select
            value={pending}
            onChange={(e) => setPending(e.target.value)}
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
            aria-label="Additional telemetry key"
          >
            <option value="">Choose a key…</option>
            {offerable.map((o) => <option key={o.key} value={o.key}>{o.key}</option>)}
          </select>
          <Button size="sm" variant="secondary" disabled={!pending} onClick={() => { onAdd(pending); setPending(''); }}>
            Add
          </Button>
        </span>
      )}
    </div>
  );
}

/**
 * This instrument's alarms for the current period.
 *
 * `GET /api/alarms` has no date filter yet (added by the separate Alarms
 * plan) — the period is applied CLIENT-SIDE here for now, filtering on
 * `raisedAt`. Every word on this row comes from `alarm-display.ts`, the same
 * vocabulary the Alarms page itself uses, so this widget cannot describe the
 * same event differently.
 */
export function AlarmsWidget({
  instrumentId, period, onExportPdf, statusTexts,
}: {
  instrumentId: string;
  period: { from: string; to: string };
  onExportPdf: () => void;
  /** Configured status wording, from the same `/api/config/alarm-limits/status-texts`
   *  the Alarms page reads — `undefined` while loading, in which case `statusText()`
   *  falls back to the shipped defaults on its own. Never a second vocabulary. */
  statusTexts: AlarmStatusTexts | undefined;
}) {
  const { formatDate, formatTime } = useDatetimeFormat();
  const { data } = useSWR<{ data: AlarmRow[] }>(instrumentId ? `/api/alarms?instrumentId=${instrumentId}&limit=500` : null);
  const stamp = (v: string) => `${formatDate(v)} ${formatTime(v)}`;

  const from = new Date(period.from).getTime();
  const to = new Date(period.to).getTime();
  const rows = (data?.data ?? []).filter((a) => {
    const raised = new Date(a.raisedAt).getTime();
    return raised >= from && raised <= to;
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Alarms in this period</CardTitle>
        <ExportMenu surface="instrument-trend" onExportPdf={onExportPdf} />
      </CardHeader>
      <CardContent className="px-0 pt-0">
        {rows.length === 0 ? (
          <p className="px-6 text-sm text-slate-500">No alarms raised in this window.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Raised</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Limit</TableHead>
                <TableHead>Cleared</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{alarmTypeText(a)}</TableCell>
                  <TableCell>
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${severityTone(a.severity)}`}>
                      {a.severity}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{stamp(a.raisedAt)}</TableCell>
                  <TableCell className="tabular-nums">{triggeredText(a)}</TableCell>
                  <TableCell className="tabular-nums">{limitText(a)}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{a.clearedAt ? stamp(a.clearedAt) : '—'}{' '}{a.clearedAt && <span className="tabular-nums text-slate-500">({clearedText(a)})</span>}</TableCell>
                  <TableCell>
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${severityTone(a.severity)}`}>
                      {statusText(a, statusTexts)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function InstrumentTrend() {
  const { id } = useParams<{ id: string }>();
  const { data: inst } = useSWR<InstrumentSummary>(id ? `/api/instruments/${id}` : null);
  const { period, setPreset, setCustom, setInterval } = useTrendPeriod();
  const [page, setPage] = useState(1);
  const extra = useExtraKeys(id ?? '');
  const trend = useInstrumentTrend(id ?? '', period, page, extra.keys);
  const { data: keyOptions } = useSWR<{ data: TelemetryKeyOption[] }>(id ? `/api/instruments/${id}/telemetry-keys` : null);
  const { formatDateTime } = useDatetimeFormat();
  const reauth = useReauth();
  // Same endpoint, same mapping, as `routes/alarms/index.tsx` — the ONE place
  // the API's `status*`-prefixed keys are reconciled with the unprefixed
  // `AlarmStatusTexts` `statusText()` reads. `undefined` while loading; the
  // fallback is `statusText()`'s own, not re-implemented here.
  const { data: statusTextsResponse } = useSWR<AlarmStatusTextsResponse>('/api/config/alarm-limits/status-texts');
  const statusTexts = statusTextsResponse ? mapStatusTextsResponse(statusTextsResponse) : undefined;

  const fromLocal = period.from.slice(0, 16);
  const toLocal = period.to.slice(0, 16);

  const chartRows = numericRows(trend.chartRows);
  const tempKey = keyForSlot(trend.chartRows, 'temperature');
  const humidKey = keyForSlot(trend.chartRows, 'humidity');
  const tempDecimals = trend.overview?.decimals.temperature ?? TELEMETRY_DECIMALS_FALLBACK;
  const humidDecimals = trend.overview?.decimals.humidity ?? TELEMETRY_DECIMALS_FALLBACK;
  const spanMs = Math.max(1, new Date(period.to).getTime() - new Date(period.from).getTime());

  // Extra keys carry no administered decimals/limits — there is nothing
  // resolved server-side for a key nobody has declared as a slot, so they
  // render at the shared fallback precision and with no in-spec band.
  const tableKeys = [tempKey, humidKey, ...extra.keys].filter((k): k is string => k !== null);
  const tableRows = toTableRows(numericRows(trend.tableRows), tableKeys);

  // ── Governed downloads (Task 8) ──────────────────────────────────────────
  // One dialog instance, reused for whichever of the three widgets the
  // operator picked — `pendingReport` says which. The dialog does not prompt
  // for reauth itself; `runDownload` wraps the whole fetch+build+log+save in
  // `reauth.execute('DOWNLOAD_REPORT', …)`, the one reauth pattern this app
  // uses everywhere else.
  const [pendingReport, setPendingReport] = useState<'trend' | 'timeseries' | 'alarms' | null>(null);

  const instrumentInfo = (): ReportInstrument => ({
    code: inst?.code ?? id ?? '',
    name: inst?.name ?? '',
    locationText: trend.overview?.room
      ? `Room ${trend.overview.room.code}${trend.overview.room.label ? ` (${trend.overview.room.label})` : ''}`
      : 'Not placed on a floorplan',
    limitsText: trend.overview
      ? `Temp ${formatSetPoint(trend.overview.limits?.tempMin, trend.overview.limits?.tempMax, tempDecimals)} / `
        + `RH ${formatSetPoint(trend.overview.limits?.rhMin, trend.overview.limits?.rhMax, humidDecimals)} `
        + `(${trend.overview.limitSource === 'INSTRUMENT' ? 'from this instrument'
          : trend.overview.limitSource === 'ROOM' ? `from room ${trend.overview.room?.code ?? '—'}` : 'no limits set'})`
      : 'Unknown',
  });

  // Fetch fresh rows for the DIALOG's chosen period — it may differ from the
  // page's, since the operator can change it in the dialog before confirming.
  const fetchTelemetryForPeriod = async (from: string, to: string) => {
    const res = await apiClient.get<{ history: TelemetryLongRow[] }>(
      `/api/instruments/${id}/telemetry?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${MAX_SERIES_POINTS}`,
    );
    return res.history;
  };

  const fetchAlarmsForPeriod = async (from: string, to: string): Promise<AlarmRow[]> => {
    const res = await apiClient.get<{ data: AlarmRow[] }>(`/api/alarms?instrumentId=${id}&limit=500`);
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    return res.data.filter((a) => {
      const raised = new Date(a.raisedAt).getTime();
      return raised >= fromMs && raised <= toMs;
    });
  };

  const runDownload = async (req: ReportDownloadRequest) => {
    const which = pendingReport;
    if (!which || !id) return;
    const reportPeriod = { from: req.period.from, to: req.period.to, label: req.period.label };

    try {
      await reauth.executeWithResult('DOWNLOAD_REPORT', async (password) => {
      const instrument = instrumentInfo();

      if (which === 'trend') {
        const rows = numericRows(await fetchTelemetryForPeriod(reportPeriod.from, reportPeriod.to));
        const keysMeta = [
          tempKey ? { key: tempKey, label: 'Temperature (°C)', decimals: tempDecimals } : null,
          humidKey ? { key: humidKey, label: 'Humidity (%RH)', decimals: humidDecimals } : null,
        ].filter((k): k is { key: string; label: string; decimals: number } => k !== null);
        const pivoted = toTableRows(rows, keysMeta.map((k) => k.key));
        const report = await renderTrendReport(pivoted, keysMeta, instrument, reportPeriod, formatDateTime);
        // Fail-closed: the audit write happens BEFORE the file is saved.
        await logReportExport({
          reportType: 'Instrument Trend', format: 'PDF', recordCount: pivoted.length,
          period: reportPeriod.label, startDate: reportPeriod.from, endDate: reportPeriod.to,
          remarks: req.remarks, password,
        });
        report.save(`instrument-trend-${instrument.code}-${new Date().toISOString().slice(0, 10)}.pdf`);
      } else if (which === 'timeseries') {
        const rawRows = await fetchTelemetryForPeriod(reportPeriod.from, reportPeriod.to);
        const rows = numericRows(rawRows);
        const keysMeta = [
          tempKey ? { key: tempKey, label: 'Temperature (°C)', decimals: tempDecimals } : null,
          humidKey ? { key: humidKey, label: 'Humidity (%RH)', decimals: humidDecimals } : null,
          ...extra.keys.map((k) => ({ key: k, label: k, decimals: TELEMETRY_DECIMALS_FALLBACK })),
        ].filter((k): k is { key: string; label: string; decimals: number } => k !== null);
        const pivoted: PivotRow[] = toTableRows(rows, keysMeta.map((k) => k.key));
        const report = await renderTimeSeriesReport(pivoted, keysMeta, instrument, reportPeriod, formatDateTime);
        await logReportExport({
          reportType: 'Instrument Time Series', format: 'PDF', recordCount: pivoted.length,
          period: reportPeriod.label, startDate: reportPeriod.from, endDate: reportPeriod.to,
          remarks: req.remarks, password,
        });
        report.save(`instrument-time-series-${instrument.code}-${new Date().toISOString().slice(0, 10)}.pdf`);
      } else {
        const rows = await fetchAlarmsForPeriod(reportPeriod.from, reportPeriod.to);
        const report = await renderAlarmsReport(rows, instrument, reportPeriod, formatDateTime, statusTexts);
        await logReportExport({
          reportType: 'Instrument Alarms', format: 'PDF', recordCount: rows.length,
          period: reportPeriod.label, startDate: reportPeriod.from, endDate: reportPeriod.to,
          remarks: req.remarks, password,
        });
        report.save(`instrument-alarms-${instrument.code}-${new Date().toISOString().slice(0, 10)}.pdf`);
        }
      });
      setPendingReport(null);
    } catch (e: any) {
      // A cancelled reauth prompt is not a failure — drop the pending download
      // quietly. Any other error rethrows so `ReportDownloadDialog`'s own
      // catch surfaces it INSIDE the dialog and keeps it open, rather than the
      // dialog silently closing on a download whose audit write never landed.
      if (e?.error === 'REAUTH_CANCELLED') { setPendingReport(null); return; }
      throw e;
    }
  };

  const reportDialogName = pendingReport === 'trend' ? 'Instrument Trend'
    : pendingReport === 'timeseries' ? 'Instrument Time Series'
      : 'Instrument Alarms';

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

      <Card>
        <CardContent className="pt-6">
          <ExtraKeyPicker
            options={keyOptions?.data ?? []}
            extraKeys={extra.keys}
            onAdd={extra.add}
            onRemove={extra.remove}
          />
        </CardContent>
      </Card>

      {/* Charts. Limits come straight off the overview row — never re-derived
          here — which is what makes the in-spec band agree with the alarm
          printed on the cards above. `intervalMs` only affects these two; the
          raw table below stays unaveraged regardless of the selection. */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Charts</h2>
        <ExportMenu surface="instrument-trend" onExportPdf={() => setPendingReport('trend')} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {/* TimeSeriesChart has no subtitle/caption slot of its own (it is shared
            with the dashboard, which has no need of this disclosure), so the
            note renders immediately above it — right against the chart's own
            title — rather than changing the shared component for one caller. */}
        <div>
          <ChartIntervalNote intervalMs={period.intervalMs} />
          <TimeSeriesChart
            title="Temperature"
            unit="°C"
            spanMs={spanMs}
            min={trend.overview?.limits?.tempMin}
            max={trend.overview?.limits?.tempMax}
            series={tempKey ? [toChartSeries(chartRows, tempKey, tempDecimals, 'Temperature', period.intervalMs)] : []}
          />
        </div>
        <div>
          <ChartIntervalNote intervalMs={period.intervalMs} />
          <TimeSeriesChart
            title="Humidity"
            unit="%RH"
            spanMs={spanMs}
            min={trend.overview?.limits?.rhMin}
            max={trend.overview?.limits?.rhMax}
            series={humidKey ? [toChartSeries(chartRows, humidKey, humidDecimals, 'Humidity', period.intervalMs)] : []}
          />
        </div>
        {/* Extra keys carry no administered limits, so no in-spec band — the
            picker above only offers keys that are not one of the two governed
            slots, so there is nothing resolved to draw here. */}
        {extra.keys.map((k) => (
          <div key={k}>
            <ChartIntervalNote intervalMs={period.intervalMs} />
            <TimeSeriesChart
              title={k}
              unit=""
              spanMs={spanMs}
              series={[toChartSeries(chartRows, k, TELEMETRY_DECIMALS_FALLBACK, k, period.intervalMs)]}
            />
          </div>
        ))}
      </div>

      {/* Raw paged time-series. RAW ONLY — no averaging, no gap filling: a gap
          in the record stays a gap, never the previous value repeated. */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Time series (raw readings)</CardTitle>
          <ExportMenu surface="instrument-trend" onExportPdf={() => setPendingReport('timeseries')} />
        </CardHeader>
        <CardContent className="px-0 pt-0">
          {tableRows.length === 0 ? (
            <p className="px-6 text-sm text-slate-500">No readings in this window.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  {tempKey && <TableHead>Temperature (°C)</TableHead>}
                  {humidKey && <TableHead>Humidity (%RH)</TableHead>}
                  {extra.keys.map((k) => <TableHead key={k}>{k}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {tableRows.map((row) => (
                  <TableRow key={row.ts}>
                    <TableCell className="text-sm">{new Date(row.ts).toLocaleString()}</TableCell>
                    {tempKey && (
                      <TableCell className="tabular-nums">
                        {row.values[tempKey] == null ? '—' : formatDecimals(row.values[tempKey], tempDecimals)}
                      </TableCell>
                    )}
                    {humidKey && (
                      <TableCell className="tabular-nums">
                        {row.values[humidKey] == null ? '—' : formatDecimals(row.values[humidKey], humidDecimals)}
                      </TableCell>
                    )}
                    {extra.keys.map((k) => (
                      <TableCell key={k} className="tabular-nums">
                        {row.values[k] == null ? '—' : formatDecimals(row.values[k], TELEMETRY_DECIMALS_FALLBACK)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Pagination
            page={page}
            pageSize={TABLE_PAGE_SIZE}
            totalItems={trend.historyTotal}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>

      {id && (
        <AlarmsWidget
          instrumentId={id}
          period={period}
          onExportPdf={() => setPendingReport('alarms')}
          statusTexts={statusTexts}
        />
      )}

      <ReportDownloadDialog
        open={pendingReport !== null}
        reportName={reportDialogName}
        showPeriod
        initialPeriod={{ from: period.from, to: period.to, label: period.label }}
        onCancel={() => setPendingReport(null)}
        onConfirm={runDownload}
      />

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Download Report"
      />
    </div>
  );
}
