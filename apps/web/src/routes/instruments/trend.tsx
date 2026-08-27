import { useState } from 'react';
import { useParams } from 'react-router-dom';
import useSWR from 'swr';
import {
  formatDecimals, INTERVALS, MAX_SERIES_POINTS, TELEMETRY_DECIMALS_FALLBACK,
  PERIOD_PRESETS, DEFAULT_PERIOD,
} from '@digilog/shared';
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
import { formatSetPoint } from '@/routes/dashboard/set-point';
import { TimeSeriesChart, SERIES_COLORS } from '@/routes/dashboard/time-series-chart';
import {
  severityTone, triggeredText, statusText, alarmTypeText, limitText, clearedText,
  mapStatusTextsResponse,
  type AlarmRow, type AlarmStatusTexts, type AlarmStatusTextsResponse,
} from '@/routes/alarms/alarm-display';
import { useTrendPeriod, useInstrumentTrend, TREND_PRESETS, TABLE_PAGE_SIZE, type TelemetryLongRow } from './use-trend-data';
import { toChartSeries, toTableRows, rawCountForKey, type TableRow as PivotRow } from './trend-series';
import { summariseSlot } from './trend-summary';
import { ChartIntervalNote, intervalLabel } from './chart-interval-note';
import { useExtraKeys } from './use-extra-keys';
import {
  renderTrendReport, renderTimeSeriesReport, renderAlarmsReport,
  type ReportInstrument, type TrendChartSection,
} from './trend-report';
import { renderChartToPng } from './chart-image';
import { BandGauge } from './band-gauge';
import { TrendHeader } from './trend-header';
import { SampledNote } from './sampled-note';

/**
 * Series identity, fixed. Temperature is palette slot 1 and humidity slot 2
 * across this app — the gauge accent, the chart line and the printed chart all
 * read the same two constants, so no two surfaces can disagree about which
 * colour means which quantity.
 */
/** What "Reset zoom" falls back to when this session never chose a preset —
 *  the page's own default period, not a number invented here. */
const DEFAULT_PERIOD_MS = PERIOD_PRESETS.find((p) => p.value === DEFAULT_PERIOD)!.ms;

const TEMP_COLOR = SERIES_COLORS[0];
const HUMID_COLOR = SERIES_COLORS[1];

/**
 * Which of the two administered slots a trend download covers.
 *
 * Per-slot, not one report for both, because the reportType string this maps to
 * is what the §11 audit row records: three different downloads all logged as
 * "Instrument Trend" leaves an audit trail that cannot say which report a given
 * row was. `both` is kept as well — an operator signing off on a period usually
 * wants one document covering it, and dropping it would have made that two
 * signatures for one decision.
 */
type TrendSlot = 'temperature' | 'humidity' | 'both';

const TREND_SLOT_LABEL: Record<TrendSlot, string> = {
  temperature: 'Temperature',
  humidity: 'Humidity',
  both: 'Temperature & Humidity',
};

type PendingReport =
  | { kind: 'trend'; slot: TrendSlot }
  | { kind: 'timeseries' }
  | { kind: 'alarms' };

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
  /** Free-text placement (spec D8). Caption only — `functionalLocationId` is
   *  the authoritative grouping and is not what a header line is for. */
  location?: string | null;
  area?: string | null;
  block?: string | null;
}

function GaugeSkeleton({ title }: { title: string }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500">{title}</p>
      <p className="mt-3 text-sm text-slate-400">Loading…</p>
    </section>
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
  /**
   * The preset the operator last chose, so "Reset zoom" can put it back.
   *
   * Not read back out of the URL: once zoomed, the URL holds a concrete custom
   * window and the preset that produced it is gone. On a shared zoomed link
   * there was no prior choice in THIS session, so reset falls back to the
   * page's default period rather than inventing one.
   */
  const [lastPresetMs, setLastPresetMs] = useState<number>(DEFAULT_PERIOD_MS);
  const choosePreset = (ms: number) => { setLastPresetMs(ms); setPreset(ms); };
  /**
   * Zoom = set the range and REFETCH. The chart hands up the window the drag
   * covered; `setCustom` is the range setter the manual From/To inputs already
   * use, so a zoom goes down the path that already works, is linkable, and
   * survives a refresh. Nothing magnifies the points already drawn — the
   * server answers the narrower request with the true readings for it.
   */
  const onZoom = (from: Date, to: Date) => setCustom(from.toISOString(), to.toISOString());
  /**
   * Offered only while the window IS custom — which is what makes the chart
   * render its "Reset zoom" button, so the button never appears on a view
   * there is nothing to reset to. A hand-typed custom range counts as zoomed;
   * that is one signal, not two, and resetting it is just as sensible.
   */
  const onResetZoom = period.label === 'Custom' ? () => choosePreset(lastPresetMs) : undefined;
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

  // Hoisted out of the chart JSX below so both the chart and `SampledNote`
  // read off the same computation, not two recomputations that could drift.
  const tempSeries = tempKey ? toChartSeries(chartRows, tempKey, tempDecimals, 'Temperature', period.intervalMs) : null;
  const humidSeries = humidKey ? toChartSeries(chartRows, humidKey, humidDecimals, 'Humidity', period.intervalMs) : null;
  /**
   * `SampledNote`'s `shown` prop: "raw readings this chart is representing" —
   * NOT `series.points.length`, which is the number of MARKS drawn. Those two
   * differ whenever a chart interval is selected: `toChartSeries` buckets the
   * series for display, so `points.length` collapses to the bucket count (12
   * buckets for a 3,600-reading hour at 5-minute buckets) while the chart
   * still represents every one of those 3,600 readings — bucketing averages
   * for display, it does not drop data the way server-side sampling does.
   * Using the bucket count here made the note read "Showing 12 of 3,600
   * readings" directly under `ChartIntervalNote`'s "the table below shows
   * every reading" — two contradictory §11 claims in one card.
   *
   * Computed from `trend.chartRows` (UNFILTERED, before this page's
   * numeric-only filter) rather than `chartRows`/`tempSeries.points`, so a
   * non-numeric reading on this key counts the same way the server's
   * `summaries[key].count` counts it (`count(*)`, no numeric guard) — see
   * `rawCountForKey`'s own doc comment for why that avoids a false "sampled"
   * reading when nothing was actually dropped by the server.
   */
  const tempRawCount = tempKey ? rawCountForKey(trend.chartRows, tempKey) : 0;
  const humidRawCount = humidKey ? rawCountForKey(trend.chartRows, humidKey) : 0;

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
  const [pendingReport, setPendingReport] = useState<PendingReport | null>(null);

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
  /**
   * Rows for the DIALOG's chosen period, WITH the period's true row count.
   *
   * `points` (not `limit`) puts this on the same CHART path the on-screen
   * charts use (see `use-trend-data.ts`): every reading in the range is read
   * server-side and downsampled to MAX_SERIES_POINTS per key, with the true
   * `historyTotal` computed over the WHOLE range — not the old `limit=500`
   * path, which capped server-side at 500 rows ordered `ts DESC` and came
   * back holding only the period's most recent tail (measured on this
   * install, a 30-day window held 7,646 rows and 500 came back).
   *
   * This changes what `rows` IS for the report built from it below: it is
   * now a representative sample spread across the whole period, not a
   * truncated recent tail. `ReportCoverage`'s "INCOMPLETE PERIOD" banner
   * (`trend-report.ts`) was written for the old truncation and still reads
   * "this report was built from the N most recent stored values ... The
   * chart, the summary and the table below all describe that most recent
   * portion only" — that wording is no longer accurate once `rows` can be a
   * whole-range sample. Not fixed here; flagged for the team lead.
   */
  const fetchTelemetryForPeriod = async (from: string, to: string) => {
    const res = await apiClient.get<{ history: TelemetryLongRow[]; historyTotal: number }>(
      `/api/instruments/${id}/telemetry?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&points=${MAX_SERIES_POINTS}`,
    );
    return res;
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

  /**
   * One slot's picture for the PDF, or a stated reason there isn't one.
   *
   * Built from the REPORT's own rows and the page's current chart interval, so
   * the printed chart is the chart the operator was looking at — same limits off
   * the overview row, same bucket, same component (`chart-image.ts` mounts
   * `TimeSeriesChart` itself rather than re-drawing it).
   */
  const chartSectionFor = async (
    title: string,
    unit: string,
    key: string | null,
    decimals: number,
    min: number | null | undefined,
    max: number | null | undefined,
    rows: { key: string; value: number; ts: string }[],
    reportSpanMs: number,
    color: string,
  ): Promise<{ section: TrendChartSection; plotted: { ts: string; value: number }[] }> => {
    // The summary is computed from `rows` (the report's own STORED readings,
    // never the averaged points the chart plots): the minimum of a set of
    // means is not the minimum of the record, and an excursion that
    // averaging smoothed away must not vanish from the one block of the
    // report a §11 reader treats as authoritative.
    //
    // Since `fetchTelemetryForPeriod` moved onto the `points=` chart path,
    // `rows` can itself be a SAMPLED subset of the period (LTTB-downsampled
    // to MAX_SERIES_POINTS per key) rather than every stored reading — so
    // `summary.count`, and `belowCount`/`aboveCount`/`outOfSpecCount`, are
    // counts over the SAMPLED series, not necessarily over every reading in
    // the period. Nothing in the printed report currently says this (see the
    // doc comment on `fetchTelemetryForPeriod`); not redesigning that here.
    const summary = key ? summariseSlot(rows, key, title, unit, decimals, min, max) : null;

    if (!key) {
      return {
        section: {
          title,
          image: null,
          summary: null,
          unavailableReason: `This instrument reports no ${title.toLowerCase()} key, so there is no series to plot.`,
        },
        plotted: [],
      };
    }
    // Same colour the screen drew. `renderChartToPng` mounts this very
    // component, so a colour set on only one of the two would put a chart in the
    // §11 record that does not look like the chart it documents.
    const series = { ...toChartSeries(rows, key, decimals, title, period.intervalMs), color };
    if (series.points.length === 0) {
      return {
        section: { title, image: null, summary, unavailableReason: 'No readings in this period, so there is nothing to plot.' },
        plotted: [],
      };
    }
    const image = await renderChartToPng({ title, unit, spanMs: reportSpanMs, min, max, series: [series] });
    return {
      section: {
        title,
        image,
        summary,
        unavailableReason: image
          ? ''
          : 'The chart could not be rendered by this browser. The summary and the readings below still describe this period.',
      },
      plotted: series.points,
    };
  };

  const runDownload = async (req: ReportDownloadRequest) => {
    const which = pendingReport;
    // NOT a silent return. Before this threw, a download in this state saved
    // nothing and said nothing — the dialog just went back to idle, which is
    // indistinguishable from a download that worked, and a §11 export that
    // fails invisibly is the worst failure mode it has.
    if (!which || !id) {
      throw new Error('This download could not be started because the page has no instrument loaded. Reload the page and try again.');
    }
    const reportPeriod = { from: req.period.from, to: req.period.to, label: req.period.label };

    try {
      await reauth.executeWithResult('DOWNLOAD_REPORT', async (password) => {
      const instrument = instrumentInfo();
      const stamp = new Date().toISOString().slice(0, 10);

      if (which.kind === 'trend') {
        const wantTemp = which.slot === 'temperature' || which.slot === 'both';
        const wantHumid = which.slot === 'humidity' || which.slot === 'both';
        const fetched = await fetchTelemetryForPeriod(reportPeriod.from, reportPeriod.to);
        const rows = numericRows(fetched.history);
        const keysMeta = [
          wantTemp && tempKey ? { key: tempKey, label: 'Temperature (°C)', decimals: tempDecimals } : null,
          wantHumid && humidKey ? { key: humidKey, label: 'Humidity (%RH)', decimals: humidDecimals } : null,
        ].filter((k): k is { key: string; label: string; decimals: number } => k !== null);
        // The DIALOG's period, not the page's — the operator may have widened it
        // before confirming, and the chart's x-axis must cover what it printed.
        const reportSpanMs = Math.max(1, new Date(reportPeriod.to).getTime() - new Date(reportPeriod.from).getTime());

        const charts: TrendChartSection[] = [];
        // Long rows rebuilt from the points each chart ACTUALLY plotted, so the
        // table under an averaged chart holds those same averaged points. Two
        // blocks of one report quoting different values for one instant, with
        // nothing saying why, is the defect this report was rewritten to remove.
        const plottedLong: { key: string; value: number; ts: string }[] = [];
        if (wantTemp) {
          const r = await chartSectionFor(
            'Temperature', '°C', tempKey, tempDecimals,
            trend.overview?.limits?.tempMin, trend.overview?.limits?.tempMax, rows, reportSpanMs, TEMP_COLOR,
          );
          charts.push(r.section);
          if (tempKey) plottedLong.push(...r.plotted.map((pt) => ({ key: tempKey, value: pt.value, ts: pt.ts })));
        }
        if (wantHumid) {
          const r = await chartSectionFor(
            'Humidity', '%RH', humidKey, humidDecimals,
            trend.overview?.limits?.rhMin, trend.overview?.limits?.rhMax, rows, reportSpanMs, HUMID_COLOR,
          );
          charts.push(r.section);
          if (humidKey) plottedLong.push(...r.plotted.map((pt) => ({ key: humidKey, value: pt.value, ts: pt.ts })));
        }
        // Through the same tested pivot the screen uses, rather than a second
        // merge written for this one caller.
        const pivoted = toTableRows(plottedLong, keysMeta.map((k) => k.key));

        const slotLabel = TREND_SLOT_LABEL[which.slot];
        const report = await renderTrendReport({
          slotLabel, charts, rows: pivoted, keys: keysMeta, instrument,
          period: reportPeriod, formatDateTime,
          averagedLabel: intervalLabel(period.intervalMs),
          tableIsAveraged: period.intervalMs !== null,
          // `fetched.history.length`, NOT `rows.length`. `rows` has already had
          // non-numeric readings dropped, while `historyTotal` counts every
          // stored value in the period — comparing the two would report
          // "INCOMPLETE PERIOD" whenever this instrument sent a single
          // non-numeric key, with nothing actually truncated. This database
          // holds such a reading today. A false truncation warning in a §11
          // record is its own misrepresentation, and it teaches the reader to
          // ignore the banner that matters.
          coverage: { returned: fetched.history.length, total: fetched.historyTotal ?? fetched.history.length },
        });
        // Fail-closed: the audit write happens BEFORE the file is saved.
        await logReportExport({
          // Names the SLOT. Three trend reports all logged as "Instrument Trend"
          // would leave an audit trail that cannot say which one a row is.
          reportType: `Instrument Trend — ${slotLabel}`, format: 'PDF', recordCount: pivoted.length,
          period: reportPeriod.label, startDate: reportPeriod.from, endDate: reportPeriod.to,
          remarks: req.remarks, password,
        });
        // `slot` is an internal enum value; 'both' is not a document name an
        // operator would file, so the filename carries the slot's own words.
        const slotFile = slotLabel.toLowerCase().replace(/\s*&\s*/g, '-').replace(/\s+/g, '-');
        report.save(`instrument-trend-${slotFile}-${instrument.code}-${stamp}.pdf`);
      } else if (which.kind === 'timeseries') {
        const rawRows = await fetchTelemetryForPeriod(reportPeriod.from, reportPeriod.to);
        const rows = numericRows(rawRows.history);
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
        report.save(`instrument-time-series-${instrument.code}-${stamp}.pdf`);
      } else {
        const rows = await fetchAlarmsForPeriod(reportPeriod.from, reportPeriod.to);
        const report = await renderAlarmsReport(rows, instrument, reportPeriod, formatDateTime, statusTexts);
        await logReportExport({
          reportType: 'Instrument Alarms', format: 'PDF', recordCount: rows.length,
          period: reportPeriod.label, startDate: reportPeriod.from, endDate: reportPeriod.to,
          remarks: req.remarks, password,
        });
        report.save(`instrument-alarms-${instrument.code}-${stamp}.pdf`);
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

  const reportDialogName = pendingReport === null ? ''
    : pendingReport.kind === 'trend' ? `Instrument Trend — ${TREND_SLOT_LABEL[pendingReport.slot]}`
      : pendingReport.kind === 'timeseries' ? 'Instrument Time Series'
        : 'Instrument Alarms';

  // Free-text placement (spec D8) as a caption line. Whatever is recorded, in
  // the order a reader narrows down a location; nothing is invented when a
  // field is blank.
  const placementText = [inst?.location, inst?.area, inst?.block]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' · ');

  // "Is it talking?" is answered by the MOST RECENT of the two slots — an
  // instrument still sending humidity is reporting, whatever temperature did.
  const readingTimes = [trend.overview?.temperature?.ts, trend.overview?.humidity?.ts]
    .filter((t): t is string => typeof t === 'string');
  const latestReadingTs = readingTimes.length
    ? readingTimes.reduce((a, b) => (a > b ? a : b))
    : null;

  return (
    // The page ground, cooler than the shell's slate so the white cards lift
    // off it. The negative margins EXACTLY cancel `<main>`'s own padding
    // (`p-3 sm:p-4 lg:p-6`, app-layout.tsx) and the same padding is re-applied
    // inside, so the band is full-bleed without moving anything on the page.
    <div
      className="-m-3 min-h-full space-y-5 p-3 sm:-m-4 sm:p-4 lg:-m-6 lg:p-6"
      style={{ backgroundColor: '#F7F8FA' }}
    >
      {/* The identity strip. What record is this, where is it, and is it
          reporting right now — before a single number is read. */}
      <TrendHeader
        code={inst?.code ?? '…'}
        name={inst?.name ?? ''}
        placement={placementText}
        // Server-resolved; this page never re-judges an instrument's status.
        status={trend.overview?.status ?? null}
        lastReadingTs={latestReadingTs}
        backTo={id ? `/instruments/${id}` : '/instruments'}
        // The COMBINED download — one document covering the period, which is
        // what an operator signing off on that period files. The per-widget
        // downloads stay on their own widgets below.
        actions={<ExportMenu surface="instrument-trend" onExportPdf={() => setPendingReport({ kind: 'trend', slot: 'both' })} />}
      />

      {/* One quiet row: everything that changes WHAT is shown, and nothing
          that says anything about the readings themselves. */}
      <div className="flex flex-wrap items-end gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="flex flex-wrap gap-1.5">
          {TREND_PRESETS.map((p) => (
            <Button
              key={p.label}
              size="sm"
              variant={period.label === p.label ? 'default' : 'secondary'}
              onClick={() => choosePreset(p.ms)}
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
            className="rounded-lg border border-slate-200 px-2 py-1.5 font-mono text-xs tabular-nums [color-scheme:light]"
            aria-label="From"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          To
          <input
            type="datetime-local"
            value={toLocal}
            onChange={(e) => e.target.value && setCustom(period.from, new Date(e.target.value).toISOString())}
            className="rounded-lg border border-slate-200 px-2 py-1.5 font-mono text-xs tabular-nums [color-scheme:light]"
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
      </div>

      {/* The band gauges. The page leads with the BAND, not the number: the
          limits are what an alarm is a departure from and what the whole
          record exists to evidence. Both are fed straight from the overview
          row — limits, their source and the decimals all arrive resolved. */}
      <div className="grid gap-4 lg:grid-cols-2">
        {trend.overview ? (
          <>
            <BandGauge
              label="Temperature"
              unit="°C"
              reading={trend.overview.temperature}
              decimals={trend.overview.decimals.temperature ?? TELEMETRY_DECIMALS_FALLBACK}
              min={trend.overview.limits?.tempMin}
              max={trend.overview.limits?.tempMax}
              limitSource={trend.overview.limitSource}
              roomCode={trend.overview.room?.code ?? null}
              instrumentStatus={trend.overview.status}
              accent={TEMP_COLOR}
            />
            <BandGauge
              label="Humidity"
              unit="%RH"
              reading={trend.overview.humidity}
              decimals={trend.overview.decimals.humidity ?? TELEMETRY_DECIMALS_FALLBACK}
              min={trend.overview.limits?.rhMin}
              max={trend.overview.limits?.rhMax}
              limitSource={trend.overview.limitSource}
              roomCode={trend.overview.room?.code ?? null}
              instrumentStatus={trend.overview.status}
              accent={HUMID_COLOR}
              // The one page-load moment, staggered between the two slots.
              delayMs={80}
            />
          </>
        ) : (
          <>
            <GaugeSkeleton title="Temperature" />
            <GaugeSkeleton title="Humidity" />
          </>
        )}
      </div>

      {/* Charts, FULL WIDTH and stacked — never side by side. A trend is read
          along the time axis; halving that axis to fit two charts on a row
          costs the page the very thing it is for.

          Limits come straight off the overview row — never re-derived here —
          which is what makes the in-limit band agree with the gauge above it.
          `intervalMs` only affects these; the raw table below stays unaveraged
          regardless of the selection. */}
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500">Charts</h2>
      <div className="space-y-5">
        {/* TimeSeriesChart has no subtitle/caption slot of its own (it is shared
            with the dashboard, which has no need of this disclosure), so the
            note renders immediately above it — right against the chart's own
            title — rather than changing the shared component for one caller. */}
        <div>
          {/* Per-slot download. The combined control in the header above covers
              both slots in one signed document; this one produces a report for
              THIS widget alone, and is logged under its own reportType so the
              audit trail can tell the three apart. */}
          <div className="mb-1 flex items-start justify-between gap-2">
            <ChartIntervalNote intervalMs={period.intervalMs} />
            <ExportMenu surface="instrument-trend" onExportPdf={() => setPendingReport({ kind: 'trend', slot: 'temperature' })} />
          </div>
          <TimeSeriesChart
            title="Temperature"
            unit="°C"
            spanMs={spanMs}
            min={trend.overview?.limits?.tempMin}
            max={trend.overview?.limits?.tempMax}
            series={tempSeries ? [{ ...tempSeries, color: TEMP_COLOR }] : []}
            onZoom={onZoom}
            onResetZoom={onResetZoom}
          />
          <SampledNote
            shown={tempRawCount}
            total={tempKey ? (trend.summaries[tempKey]?.count ?? 0) : 0}
          />
        </div>
        <div>
          <div className="mb-1 flex items-start justify-between gap-2">
            <ChartIntervalNote intervalMs={period.intervalMs} />
            <ExportMenu surface="instrument-trend" onExportPdf={() => setPendingReport({ kind: 'trend', slot: 'humidity' })} />
          </div>
          <TimeSeriesChart
            title="Humidity"
            unit="%RH"
            spanMs={spanMs}
            min={trend.overview?.limits?.rhMin}
            max={trend.overview?.limits?.rhMax}
            series={humidSeries ? [{ ...humidSeries, color: HUMID_COLOR }] : []}
            onZoom={onZoom}
            onResetZoom={onResetZoom}
          />
          <SampledNote
            shown={humidRawCount}
            total={humidKey ? (trend.summaries[humidKey]?.count ?? 0) : 0}
          />
        </div>
      </div>

      {/* The per-user extra keys, with their charts, kept together and below
          the two administered slots — they are an addition to the record this
          page governs, not part of it. */}
      <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <ExtraKeyPicker
          options={keyOptions?.data ?? []}
          extraKeys={extra.keys}
          onAdd={extra.add}
          onRemove={extra.remove}
        />
        {/* Extra keys carry no administered limits, so no in-limit band — the
            picker only offers keys that are not one of the two governed slots,
            so there is nothing resolved to draw here. Nor any series colour:
            these have no app-wide identity to keep. */}
        {extra.keys.length > 0 && (
          <div className="mt-4 space-y-5">
            {extra.keys.map((k) => (
              <div key={k}>
                <ChartIntervalNote intervalMs={period.intervalMs} />
                <TimeSeriesChart
                  title={k}
                  unit=""
                  spanMs={spanMs}
                  series={[toChartSeries(chartRows, k, TELEMETRY_DECIMALS_FALLBACK, k, period.intervalMs)]}
                  // Same page range, so the extra-key charts zoom it too —
                  // otherwise a drag would work on two charts of a stack and
                  // silently do nothing on the rest.
                  onZoom={onZoom}
                  onResetZoom={onResetZoom}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
      {/* Raw paged time-series. RAW ONLY — no averaging, no gap filling: a gap
          in the record stays a gap, never the previous value repeated. */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Time series (raw readings)</CardTitle>
          <ExportMenu surface="instrument-trend" onExportPdf={() => setPendingReport({ kind: 'timeseries' })} />
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
          onExportPdf={() => setPendingReport({ kind: 'alarms' })}
          statusTexts={statusTexts}
        />
      )}
      </div>

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
