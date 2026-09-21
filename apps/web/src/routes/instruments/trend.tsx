import { useState } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import useSWR from 'swr';
import { Droplet, Thermometer } from 'lucide-react';
import {
  INTERVALS, MAX_SERIES_POINTS, TELEMETRY_DECIMALS_FALLBACK,
  PERIOD_PRESETS, DEFAULT_PERIOD, coerceReading,
  type InactivityColumnTexts,
} from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useReauth } from '@/hooks/use-reauth';
import { useSensorWords, useAlarmTypeNames } from '@/hooks/use-failure-text';
import { ReauthDialog } from '@/components/reauth-dialog';
import { ExportMenu } from '@/components/ExportMenu';
import { ReportDownloadDialog, type ReportDownloadRequest } from '@/components/report-download-dialog';
import { submitReportForReview } from '@/lib/report-review';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { useTrendWidgets } from '@/hooks/use-trend-widgets';
import { WidgetSettingsButton } from './widget-settings-button';
import { formatSetPoint } from '@/routes/dashboard/set-point';
import { TimeSeriesChart, SERIES_COLORS } from '@/routes/dashboard/time-series-chart';
import {
  triggeredText, statusText, alarmTypeText, limitText, clearedText,
  mapStatusTextsResponse, mapInactivityTextsResponse,
  type AlarmRow, type AlarmStatusTexts, type AlarmStatusTextsResponse,
  type InactivityTextsResponse, type AlarmDisplayTexts,
} from '@/routes/alarms/alarm-display';
import { useTrendPeriod, useInstrumentTrend, TREND_PRESETS, TABLE_PAGE_SIZE, type TelemetryLongRow } from './use-trend-data';
import { toChartSeries, toTableRows, toTableRowsWithErrors, rawCountForKey, type TableRow as PivotRow } from './trend-series';
import { summariseSlot, withServerSummary, type ServerSlotSummary } from './trend-summary';
import { intervalLabel } from './chart-interval-note';
import {
  renderTrendReport, renderDataReport, renderAlarmsReport,
  type ReportInstrument, type TrendChartSection,
} from './trend-report';
import { resolveBlockArea, type LocationNode } from './data-report';
import { fetchDataReportRows, slotExtremes } from './data-report-fetch';
import { renderChartToPng } from './chart-image';
import { BandGauge } from './band-gauge';
import { TrendChartCard } from './trend-chart-card';
import { TimeseriesTableCard } from './timeseries-table-card';
import { AlarmsWidget } from './alarms-widget';
import { PageHero } from '@/components/ui/page-hero';
import { statusClasses, readingAge } from '@/routes/dashboard/status';
import { usePanels } from '@/hooks/use-panels';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { trendCrumbs, originFrom } from './trend-breadcrumbs';
import { ALL_RECORDS_PARAM } from '@digilog/shared';

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
 * Per-slot, because the reportType string this maps to is what the §11 audit
 * row records: two different downloads both logged as "Instrument Trend"
 * leaves an audit trail that cannot say which report a given row was. A
 * `both` value — the page header's combined charts document — existed until
 * 2026-09-07, when the operator asked for the header download to be the Data
 * Report instead ("in that report trends also coming remove those and add
 * interval feature"); the one document an operator signing off a period files
 * is now the readings, not pictures of them.
 */
type TrendSlot = 'temperature' | 'humidity';

const TREND_SLOT_LABEL: Record<TrendSlot, string> = {
  temperature: 'Temperature',
  humidity: 'Humidity',
};

type PendingReport =
  | { kind: 'trend'; slot: TrendSlot }
  | { kind: 'timeseries' }
  | { kind: 'alarms' };

/** Rows this page actually charts/pivots are all numeric — a non-numeric
 *  reading (a raw JSON blob on some other key) has no place on an axis or in
 *  a numeric table column, so it is filtered out rather than coerced. */
function numericRows(rows: TelemetryLongRow[]): { key: string; value: number; ts: string }[] {
  // Through `coerceReading`, the ONE definition of a reading — so a QUOTED
  // number plots here exactly as it does on the dashboard and in the alarms.
  return rows.flatMap((r) => {
    const value = coerceReading(r.value);
    return value === null ? [] : [{ key: r.key, value, ts: r.ts }];
  });
}

/*
 * `latestValueForKey()` was removed 2026-09-01, with the last of its callers.
 *
 * It answered "the latest STORED reading for this key", for the summary strips'
 * "Current" and the time-series card's last-reading band. Both surfaces were
 * removed earlier the same day; the two consts feeding it went with the card's
 * dead `last` prop, leaving the helper reachable from nothing.
 *
 * **The rule it existed to enforce is NOT gone and must not be relearned the
 * hard way:** a "last reading" is taken from the RAW rows, never from a chart
 * series, because `toChartSeries` bucket-averages when an interval is selected
 * and a mean labelled "Current" is a derived number presented as a stored one.
 * That reasoning now lives in one place only — the doc comment on
 * `TimeSeriesChart`'s own `lastReading` prop (`dashboard/time-series-chart.tsx`).
 * Read it there before reinstating any last-reading readout on this page.
 */

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
  /** The authoritative Block > Area placement; resolved to names through the
   *  functional-location tree for the Data Report's parameter block. */
  functionalLocationId?: string | null;
}

/** The latest-value card's own footprint, so the page does not jump when the
 *  overview lands. Same padding, same ring, same footer band. */
function GaugeSkeleton({ title }: { title: string }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-slate-200 bg-white p-4 pt-6 shadow-[var(--elev-1)]">
      <span className="sr-only" role="status">Loading {title}…</span>
      <div className="flex items-start gap-7">
        <Skeleton className="h-[84px] w-[84px] shrink-0 rounded-full" />
        <div className="flex-1">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-2 h-16 w-40" />
          <Skeleton className="mt-4 h-4 w-20" />
        </div>
      </div>
      <Skeleton className="mt-6 h-[88px] w-full rounded-lg" />
    </section>
  );
}

/**
 * The three states a chart can be in BEFORE it can honestly say "No data
 * available".
 *
 * `TimeSeriesChart` renders that message whenever its series hold no points,
 * which is also true while the fetch is in flight and while it is failing. On a
 * §11 surface those are three different claims: "the range holds nothing" is a
 * statement about the record, and the other two are "we do not know yet". So
 * loading and error are answered here, above the chart, and only a RESOLVED,
 * empty response reaches the chart's own empty state.
 *
 * A FAILED REVALIDATION IS NOT A FAILED LOAD. SWR keeps `data` when a refetch
 * of the same key errors — a focus revalidation, a Retry, an errorRetry — so a
 * chart that loaded correctly can be sitting there fully drawn while `error` is
 * set. Replacing it with "could not be loaded" would be this component's own
 * defect mirrored: a false statement about readings that ARE in hand. So the
 * error CARD renders only when there is nothing to show (`hasData` false);
 * otherwise the chart stays and carries a quiet "could not be refreshed" line
 * with the same retry. A stale chart that says it is stale is honest; a blank
 * one claiming the readings are unavailable is not.
 *
 * Wrapped rather than pushed into `TimeSeriesChart` itself: that component is
 * shared with the dashboard's room view and the off-screen PDF render, neither
 * of which has a fetch to be loading or failing.
 */
function ChartPanel({
  isLoading, error, hasData, onRetry, title, children,
}: {
  isLoading: boolean;
  error: unknown;
  /** Whether the chart request has readings in hand from an earlier success. */
  hasData: boolean;
  onRetry: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (error && !hasData) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-6">
        <div>
          <p className="text-sm font-medium text-red-800">{title}</p>
          <p className="mt-1 text-xs text-red-700">These readings could not be loaded, so nothing is shown.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  if (error) {
    return (
      <>
        <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-amber-700">
          <span>These readings could not be refreshed. Showing the last ones that loaded.</span>
          <Button variant="link" size="inline" type="button" onClick={onRetry}>Retry</Button>
        </p>
        {children}
      </>
    );
  }
  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <p className="text-sm font-medium text-slate-700">{title}</p>
        <span className="sr-only" role="status">Loading…</span>
        <Skeleton className="mt-4 h-40 w-full" />
      </div>
    );
  }
  return <>{children}</>;
}

interface TelemetryKeyOption {
  key: string;
  slot: 'temperature' | 'humidity' | null;
  lastSeen: string;
}


// The alarms widget moved to ./alarms-widget on 2026-09-01, when it was
// rebuilt on the Alarms page's own table (routes/alarms/alarm-table.tsx) so
// the two screens cannot describe one event differently. Its props are
// unchanged; only the definition left this file.

export function InstrumentTrend() {
  const { id } = useParams<{ id: string }>();
  // Panel assignment, resolved server-side. Gates RENDERING only — the data
  // fetching below is untouched, so a hidden panel changes what is shown while
  // the signed PDF report still covers the whole record.
  const { showPanel } = usePanels();
  // Where the reader came from, for the breadcrumb. See trend-breadcrumbs.ts.
  const location = useLocation();
  const { data: inst } = useSWR<InstrumentSummary>(id ? `/api/instruments/${id}` : null);
  const { period, setPreset, setCustom, setInterval } = useTrendPeriod();
  const [page, setPage] = useState(1);
  /**
   * The raw table's page resets whenever the WINDOW changes.
   *
   * Without this, changing the range while on page 5 keeps sending
   * `offset=200` into a window that may hold 30 readings: a populated chart
   * above an empty table, with nothing on screen hinting that paging is the
   * reason. Placed here, on the range itself, rather than inside `onZoom` —
   * the preset buttons and the From/To inputs change the range too, and
   * fixing only the new path would leave the two older ones broken while
   * looking fixed.
   *
   * Adjusted during RENDER (React's documented "state derived from a change"
   * pattern), not in an effect: an effect would let one fetch go out at the
   * stale offset before the correction lands.
   */
  const rangeKey = `${period.from}|${period.to}`;
  const [seenRangeKey, setSeenRangeKey] = useState(rangeKey);
  if (seenRangeKey !== rangeKey) {
    setSeenRangeKey(rangeKey);
    setPage(1);
  }
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
  const trend = useInstrumentTrend(id ?? '', period, page, []);
  /**
   * Error + retry for the chart fetch, from the hook that OWNS the request.
   *
   * This page used to re-issue `useSWR` with a hand-copied copy of the hook's
   * chart key to get at these two. SWR deduped it to one subscription, so it
   * worked — but the key then lived in two files, and the day the hook's URL
   * shape changed, Retry would have gone on silently mutating a request nothing
   * was watching. One owner of the key.
   */
  const trendError = trend.error;
  const retryTrend = trend.retry;
  const { data: keyOptions } = useSWR<{ data: TelemetryKeyOption[] }>(id ? `/api/instruments/${id}/telemetry-keys` : null);
  const { formatDateTime, formatDate, formatTime } = useDatetimeFormat();
  // Blocks and their Areas, for the Data Report's Block / Area lines. The same
  // key the alarm filters use, so SWR dedupes it.
  const { data: locationTree } = useSWR<{ data: LocationNode[] }>('/api/functional-locations');
  /**
   * The administered wording and per-widget date/time formats for the five
   * widgets below.
   *
   * ONE read for the page, passed DOWN as props — the same way `sensorWords`,
   * `statusTexts`, `inactivityTexts` and `failureWord` already reach them. The
   * widgets stay presentational and cannot render a word the page has not
   * resolved.
   *
   * Every value here is already non-blank: `resolveTrendWidgetTexts` applies the
   * shipped default to an empty field, on the server and again in the browser
   * while the request is in flight. **No component below may default a label.**
   */
  const widgets = useTrendWidgets();
  /**
   * A formatter per widget, each carrying that widget's own format override.
   *
   * `useDatetimeFormat` falls through to the site-wide setting for any field the
   * override leaves blank, and an unconfigured widget's override IS blank — so
   * these five are the page's one formatter until somebody sets one. SWR dedupes
   * on the config key, so this is still a single request. The TIMEZONE is not
   * overridable and is the same in all of them.
   */
  const fmtTempCard = useDatetimeFormat(widgets.formats.tempCard);
  const fmtHumidCard = useDatetimeFormat(widgets.formats.humidCard);
  const fmtTimeseries = useDatetimeFormat(widgets.formats.timeseries);
  const reauth = useReauth();
  const { toast } = useToast();
  // Same endpoint, same mapping, as `routes/alarms/index.tsx` — the ONE place
  // the API's `status*`-prefixed keys are reconciled with the unprefixed
  // `AlarmStatusTexts` `statusText()` reads. `undefined` while loading; the
  // fallback is `statusText()`'s own, not re-implemented here.
  const { data: statusTextsResponse } = useSWR<AlarmStatusTextsResponse>('/api/config/alarm-limits/status-texts');
  const statusTexts = statusTextsResponse ? mapStatusTextsResponse(statusTextsResponse) : undefined;
  // Likewise for the three inactivity column wordings — same endpoint and same
  // mapping as the Alarms page, so this widget and the signed PDF below cannot
  // word an inactivity alarm differently from the page it was opened from.
  const { data: inactivityTextsResponse } = useSWR<InactivityTextsResponse>('/api/config/inactivity-alarms/display-texts');
  const sensorWords = useSensorWords();
  const typeNames = useAlarmTypeNames();
  const failureWord = sensorWords.failure;
  // ONE bag of administered wordings for every alarm row on this page, so the
  // widget and the signed PDF below cannot word the same alarm two ways.
  const inactivityTexts: AlarmDisplayTexts = {
    ...(inactivityTextsResponse ? mapInactivityTextsResponse(inactivityTextsResponse) : {}),
    sensorFailure: sensorWords.failure,
    outOfRange: sensorWords.outOfRange,
    typeNames,
  };

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
  const tableKeys = [tempKey, humidKey].filter((k): k is string => k !== null);
  // RAW rows, NOT `numericRows`. This table says it lists every reading in the
  // range, and filtering here silently dropped exactly the broken ones an
  // engineer opens it to find. The CHART above still filters — you cannot plot a
  // word — which is why the two build their rows differently on purpose.
  const tableRows = toTableRowsWithErrors(trend.tableRows, tableKeys);

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
   * truncated recent tail. Both consequences of that are handled, and both
   * were §11 defects rather than cosmetic ones (2026-08-27, task 3b):
   *  - the report's coverage banner no longer says the report covers "the
   *    most recent portion" of the period, because it no longer does; it
   *    discloses a whole-period SAMPLE instead (`ReportCoverage`), and
   *  - `summaries` is carried back with the rows so the printed statistics —
   *    including the out-of-limit counts — come from SQL over every reading
   *    in the range rather than over the sample. A count of excursions taken
   *    over a sample understates the record it is signed as describing.
   */
  const fetchTelemetryForPeriod = async (from: string, to: string) => {
    const res = await apiClient.get<{
      history: TelemetryLongRow[];
      historyTotal: number;
      /** Per key, computed server-side over the WHOLE range — never derived here. */
      summaries?: Record<string, ServerSlotSummary>;
    }>(
      `/api/instruments/${id}/telemetry?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&points=${MAX_SERIES_POINTS}`,
    );
    return res;
  };

  const fetchAlarmsForPeriod = async (from: string, to: string): Promise<AlarmRow[]> => {
    const res = await apiClient.get<{ data: AlarmRow[] }>(`/api/alarms?instrumentId=${id}&${ALL_RECORDS_PARAM}`);
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
    serverSummaries: Record<string, ServerSlotSummary> | undefined,
  ): Promise<{ section: TrendChartSection; plotted: { ts: string; value: number }[] }> => {
    // The summary is computed from `rows` (the report's own STORED readings,
    // never the averaged points the chart plots): the minimum of a set of
    // means is not the minimum of the record, and an excursion that
    // averaging smoothed away must not vanish from the one block of the
    // report a §11 reader treats as authoritative.
    //
    // `rows` is a SAMPLED subset of the period (LTTB-downsampled to
    // MAX_SERIES_POINTS per key), so every figure computed from it is a
    // figure over the sample. `withServerSummary` replaces every one the
    // server computed over the whole range — the readings count, minimum,
    // maximum, mean and the three out-of-limit counts — and keeps only
    // `first`/`last`, which are value+timestamp PAIRS the endpoint does not
    // return and which the sampler preserves verbatim at the range's
    // endpoints.
    //
    // The limits passed here are the screen's (from the overview payload) and
    // are what `summariseSlot` would judge against; the PRINTED bounds and
    // counts both come from the server's own resolution instead, so the
    // report cannot quote a count from one answer and a limit from another.
    const summary = key
      ? withServerSummary(
        summariseSlot(rows, key, title, unit, decimals, min, max),
        serverSummaries?.[key],
      )
      : null;

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

      if (which.kind === 'trend') {
        const wantTemp = which.slot === 'temperature';
        const wantHumid = which.slot === 'humidity';
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
            fetched.summaries,
          );
          charts.push(r.section);
          if (tempKey) plottedLong.push(...r.plotted.map((pt) => ({ key: tempKey, value: pt.value, ts: pt.ts })));
        }
        if (wantHumid) {
          const r = await chartSectionFor(
            'Humidity', '%RH', humidKey, humidDecimals,
            trend.overview?.limits?.rhMin, trend.overview?.limits?.rhMax, rows, reportSpanMs, HUMID_COLOR,
            fetched.summaries,
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
        // A REQUEST, not a file (2026-09-07): the frozen document goes to the
        // approver; the requester downloads it, signed, from the Reports page.
        // Names the SLOT: two trend reports both requested as "Instrument
        // Trend" would leave a record that cannot say which one a row is.
        const snapshot = report.getSnapshot();
        await submitReportForReview({
          snapshot, reportType: `Instrument Trend — ${slotLabel}`, title: snapshot.title, subtitle: snapshot.subtitle,
          requestMeta: { period: reportPeriod, recordCount: pivoted.length, instrumentCodes: [instrument.code] },
          remarks: req.remarks, assignee: req.assignee, password,
        });
      } else if (which.kind === 'timeseries') {
        // THE DATA REPORT (2026-09-04) — the Time Series widget's download,
        // built to the operator's `Data Report.pdf`. See `data-report.ts`.
        //
        // The interval is the DIALOG's (2026-09-05), seeded from the page's
        // chart interval; the dialog always offers it for this report.
        const reportInterval = req.intervalMs !== undefined ? req.intervalMs : period.intervalMs;
        // The rows and extremes, fetched by the ONE helper the Instruments
        // page's history widget also uses — every stored reading in the period
        // on the paged path (so a non-numeric reading can print its failure
        // word), the whole-range Max/Min from the sampled path, laid on the
        // interval schedule. See `data-report-fetch.ts` for why two requests.
        const slotKeys = [tempKey, humidKey].filter((k): k is string => k !== null);
        const { rows, coverage, summaries } = await fetchDataReportRows({
          instrumentId: id, from: reportPeriod.from, to: reportPeriod.to, intervalMs: reportInterval, slotKeys,
        });
        const extremes = (key: string | null) => slotExtremes(summaries, key);
        const placement = resolveBlockArea(locationTree?.data ?? [], inst?.functionalLocationId ?? null);
        const report = await renderDataReport({
          scope: {
            ...placement,
            // The Location ATTRIBUTE — the same fact the dashboard's Location
            // column and the alarm report print; never the superseded
            // `Instrument.location` column.
            locationName: trend.overview?.locationAttribute ?? '',
            instrumentLabel: instrument.code,
          },
          period: reportPeriod,
          fmt: { formatDate, formatTime },
          formatDateTime,
          temp: {
            key: tempKey, min: trend.overview?.limits?.tempMin, max: trend.overview?.limits?.tempMax, decimals: tempDecimals,
            // The probe's SPAN, distinct from the spec limits — a reading outside
            // it prints the out-of-range word, exactly as the on-screen table does.
            rangeLow: trend.overview?.rangeBounds?.temperatureLow ?? null,
            rangeHigh: trend.overview?.rangeBounds?.temperatureHigh ?? null,
            ...extremes(tempKey),
          },
          rh: {
            key: humidKey, min: trend.overview?.limits?.rhMin, max: trend.overview?.limits?.rhMax, decimals: humidDecimals,
            rangeLow: trend.overview?.rangeBounds?.humidityLow ?? null,
            rangeHigh: trend.overview?.rangeBounds?.humidityHigh ?? null,
            ...extremes(humidKey),
          },
          rows,
          intervalMs: reportInterval,
          coverage,
          words: sensorWords,
        });
        // A REQUEST, not a file (2026-09-07). The type is UNCHANGED: rows
        // already logged under it are this same document.
        const snapshot = report.getSnapshot();
        await submitReportForReview({
          snapshot, reportType: 'Instrument Time Series', title: snapshot.title, subtitle: snapshot.subtitle,
          requestMeta: { period: reportPeriod, intervalMs: reportInterval, recordCount: rows.length, instrumentCodes: [instrument.code] },
          remarks: req.remarks, assignee: req.assignee, password,
        });
      } else {
        const rows = await fetchAlarmsForPeriod(reportPeriod.from, reportPeriod.to);
        const report = await renderAlarmsReport(rows, instrument, reportPeriod, formatDateTime, statusTexts, inactivityTexts);
        const snapshot = report.getSnapshot();
        await submitReportForReview({
          snapshot, reportType: 'Instrument Alarms', title: snapshot.title, subtitle: snapshot.subtitle,
          requestMeta: { period: reportPeriod, recordCount: rows.length, instrumentCodes: [instrument.code] },
          remarks: req.remarks, assignee: req.assignee, password,
        });
        }
      });
      setPendingReport(null);
      toast.success('Sent for approval', `The request is with ${req.assigneeLabel || 'the approver'} — see Reports.`);
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
  // The band's status word: server-resolved, never re-judged here.
  const heroStatus = trend.overview?.status ? statusClasses(trend.overview.status) : null;
  const placementText = [inst?.location, inst?.area, inst?.block]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' · ');

  /**
   * The chart cards' "<where> • <code>" subtitle, before deduplication.
   *
   * The drawn ROOM comes first because it is what the reference names
   * ("Dissolution & UV Room"), then the free-text placement. `room.code` is
   * offered as well but is very often the instrument's OWN code on this
   * installation with `label` blank — `chartCardSubtitle` drops it in exactly
   * that case rather than rendering `X • X`.
   */
  const chartCardLocationParts = [
    trend.overview?.room?.label,
    trend.overview?.room?.code,
    placementText,
  ];

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
      {/* UI v3 (2026-09-21): the shared band IS the identity strip — what
          record is this, where is it, and is it reporting right now, before a
          single number is read. The crumbs ride inside it; the old strip's own
          'Back to instrument' link went, because the crumb trail's instrument
          link is that same hop. The status word is `statusClasses`', never a
          second vocabulary, and the status itself is SERVER-resolved — this
          page never re-judges it. */}
      <PageHero
        title={inst?.code ?? '…'}
        crumbs={trendCrumbs(originFrom(location.state), id ?? null, inst?.code ?? null)}
        // The page's download is the DATA REPORT — the same document, dialog
        // (period, interval, remarks) and audit type as the Time Series card
        // below. It was the combined-charts document until 2026-09-07
        // (operator: "in that report trends also coming remove those and add
        // interval feature"); the per-chart downloads stay on their own cards.
        actions={<ExportMenu surface="instrument-trend" onExportPdf={() => setPendingReport({ kind: 'timeseries' })} />}
        meta={
          <>
            <span className="text-[0.8125rem] text-white/80">
              {inst?.name ?? ''}
              {placementText && <span className="text-white/55"> · {placementText}</span>}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-white/85">
              {heroStatus && (
                <>
                  <span className={`h-1.5 w-1.5 rounded-full ${heroStatus.dot}`} aria-hidden="true" />
                  <span className="font-semibold text-white">{heroStatus.label}</span>
                  <span className="text-white/60">·</span>
                </>
              )}
              <span className="tabular-nums">
                {latestReadingTs ? `updated ${readingAge(latestReadingTs)}` : 'no readings yet'}
              </span>
            </span>
          </>
        }
      />

      {/* NO page-level error banner. The chart fetch is the only request this
          error belongs to — the gauges, the raw table and the alarms widget
          each have their own — so it is reported on the charts it actually
          blanks (`ChartPanel`), where the reader is already looking, rather
          than once at the top AND again on every chart below. */}

      {/* One quiet row: everything that changes WHAT is shown, and nothing
          that says anything about the readings themselves. */}
      <div className="flex flex-wrap items-end gap-4 rounded-[var(--radius-card)] border border-slate-200 bg-white px-5 py-4 shadow-[var(--elev-1)]">
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
            className="ctl ctl-sm font-mono tabular-nums [color-scheme:light]"
            aria-label="From"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          To
          <input
            type="datetime-local"
            value={toLocal}
            onChange={(e) => e.target.value && setCustom(period.from, new Date(e.target.value).toISOString())}
            className="ctl ctl-sm font-mono tabular-nums [color-scheme:light]"
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
            className="ctl ctl-sm"
            aria-label="Chart interval"
          >
            {INTERVALS.map((i) => (
              <option key={i.value} value={i.seconds === null ? '' : i.seconds * 1000}>{i.label}</option>
            ))}
          </select>
        </label>
      </div>

      {/* The latest-value cards. The number leads, per the operator's
          reference, but it never travels alone: the arc places it between its
          two bounds and the panel underneath names them, because the limits
          are what an alarm is a departure from and what the whole record
          exists to evidence. Both cards are fed straight from the overview
          row — limits, their source and the decimals all arrive resolved.

          Panel-gated: hiding this changes what is SHOWN. The readings behind it
          are still fetched and still reach the PDF report — instrument_scope is
          what withholds data, never this. */}
      {showPanel('trend_gauges') && (
      <div className="grid gap-4 lg:grid-cols-2">
        {trend.overview ? (
          <>
            <BandGauge
              label={widgets.labels.tempCardTitle}
              settingsButton={<WidgetSettingsButton widget="tempCard" />}
              unit="°C"
              reading={trend.overview.temperature}
              decimals={trend.overview.decimals.temperature ?? TELEMETRY_DECIMALS_FALLBACK}
              min={trend.overview.limits?.tempMin}
              max={trend.overview.limits?.tempMax}
              limitSource={trend.overview.limitSource}
              roomCode={trend.overview.room?.code ?? null}
              instrumentStatus={trend.overview.status}
              accent={TEMP_COLOR}
              icon={<Thermometer className="h-9 w-9" strokeWidth={2} aria-hidden="true" />}
              // Both faults leave the numeric slot null. The SERVER decides
              // which one it is; the card only picks the administered word.
              sensorError={trend.overview.sensorError?.temperature}
              rangeError={trend.overview.rangeError?.temperature}
              sensorWords={sensorWords}
              // This CARD's own administered formatter. The date format and the
              // clock may be overridden per widget; the timezone never is, and
              // still comes from `/api/config/datetime/current`.
              formatTs={fmtTempCard.formatDateTime}
            />
            <BandGauge
              label={widgets.labels.humidCardTitle}
              settingsButton={<WidgetSettingsButton widget="humidCard" />}
              unit="%RH"
              reading={trend.overview.humidity}
              decimals={trend.overview.decimals.humidity ?? TELEMETRY_DECIMALS_FALLBACK}
              min={trend.overview.limits?.rhMin}
              max={trend.overview.limits?.rhMax}
              limitSource={trend.overview.limitSource}
              roomCode={trend.overview.room?.code ?? null}
              instrumentStatus={trend.overview.status}
              accent={HUMID_COLOR}
              icon={<Droplet className="h-9 w-9" strokeWidth={2} aria-hidden="true" />}
              sensorError={trend.overview.sensorError?.humidity}
              rangeError={trend.overview.rangeError?.humidity}
              sensorWords={sensorWords}
              // This card's own administered formatter — see the temperature
              // card above.
              formatTs={fmtHumidCard.formatDateTime}
              // The one page-load moment, staggered between the two slots.
              delayMs={80}
            />
          </>
        ) : (
          <>
            {/* The loading placeholders carry the ADMINISTERED titles too, or
                the card would visibly rename itself once the overview lands. */}
            <GaugeSkeleton title={widgets.labels.tempCardTitle} />
            <GaugeSkeleton title={widgets.labels.humidCardTitle} />
          </>
        )}
      </div>
      )}

{      /* Charts SIDE BY SIDE at `lg` and up (operator, 2026-09-01). This
          REVERSES the rule that stood here before, which read "FULL WIDTH and
          stacked — never side by side", on the ground that a trend is read along
          the time axis and halving that axis costs the page its purpose.

          That cost is real and is now accepted: each chart gets roughly half the
          horizontal resolution, so short excursions are harder to separate by
          eye. Two things blunt it — the axis still spans the SAME period, so
          nothing is hidden, only compressed; and drag-to-zoom REFETCHES at the
          narrower range rather than magnifying, so reading a detail is one drag
          away and returns true readings rather than bigger dots. They stack
          again below `lg`, where half a viewport would be unreadable.

          Limits come straight off the overview row — never re-derived here —
          which is what makes the in-limit band agree with the gauge above it.
          `intervalMs` only affects these; the raw table below stays unaveraged
          regardless of the selection. */}
      {showPanel('trend_charts') && (
      <>
      <h2 className="text-[0.6875rem] font-semibold uppercase tracking-[0.09em] text-slate-500">Charts</h2>
      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        {/* TimeSeriesChart has no subtitle/caption slot of its own (it is shared
            with the dashboard, which has no need of this disclosure), so the
            note renders immediately above it — right against the chart's own
            title — rather than changing the shared component for one caller. */}
        {/* Per-slot download, now the DOWNLOAD ICON in each card's own header.
            The combined control in the page header above still covers both slots
            in one signed document; this one produces a report for THIS widget
            alone and keeps its own reportType, so the §11 audit trail can still
            tell the three downloads apart. */}
        <TrendChartCard
          title={widgets.labels.tempChartTitle}
          settingsButton={<WidgetSettingsButton widget="tempChart" />}
          icon={<Thermometer className="h-6 w-6" strokeWidth={2} aria-hidden="true" />}
          accent={TEMP_COLOR}
          // Server-resolved and taken as given — the same value the page header
          // and both band gauges print. This page never re-judges a status.
          status={trend.overview?.status ?? null}
          locationParts={chartCardLocationParts}
          code={inst?.code ?? '—'}
          onExportPdf={() => setPendingReport({ kind: 'trend', slot: 'temperature' })}
        >
          {/* The averaging disclosure was REMOVED 2026-09-01 (operator). It
              read "Averaged over {label} — the table below shows every reading."
              and it said that a plotted point in an averaged chart is a DERIVED
              number, not a stored one.

              What still carries that, and is why the record is unharmed:
              averaging is OPT-IN and defaults to raw, so an untouched chart
              plots stored readings; the interval control on this page names the
              bucket the reader chose; and the SIGNED PDF keeps its own
              independent disclosure (`averagedLabel` in `trend-report.ts`),
              which is the copy that outlives the screen.

              What is genuinely lost: someone reading this screen over another
              person's shoulder, or a screenshot of it, no longer sees that the
              line is means rather than measurements. Restore
              `<ChartIntervalNote>` here if that matters. */}
          <ChartPanel
            title={widgets.labels.tempChartTitle}
            isLoading={trend.chartsLoading}
            error={trendError}
            hasData={trend.chartRows.length > 0}
            onRetry={retryTrend}
          >
            <TimeSeriesChart
              variant="trend"
              title={widgets.labels.tempChartTitle}
              // This CHART's own date/time format override, for its tooltip.
              // Blank fields inherit the site-wide setting; the timezone always
              // does. Every other caller of this component passes nothing.
              dateTimeFormat={widgets.formats.tempChart}
              unit="°C"
              spanMs={spanMs}
              min={trend.overview?.limits?.tempMin}
              max={trend.overview?.limits?.tempMax}
              series={tempSeries ? [{ ...tempSeries, color: TEMP_COLOR }] : []}
              // The latest STORED reading, not the last plotted point — which is
              // a bucket MEAN whenever a chart interval is selected. Same value
              // the summary strip's "Current" prints, from the same helper.
              onZoom={onZoom}
              onResetZoom={onResetZoom}
            />
          </ChartPanel>
        </TrendChartCard>
        <TrendChartCard
          title={widgets.labels.humidChartTitle}
          settingsButton={<WidgetSettingsButton widget="humidChart" />}
          icon={<Droplet className="h-6 w-6" strokeWidth={2} aria-hidden="true" />}
          accent={HUMID_COLOR}
          status={trend.overview?.status ?? null}
          locationParts={chartCardLocationParts}
          code={inst?.code ?? '—'}
          onExportPdf={() => setPendingReport({ kind: 'trend', slot: 'humidity' })}
        >
          <ChartPanel
            title={widgets.labels.humidChartTitle}
            isLoading={trend.chartsLoading}
            error={trendError}
            hasData={trend.chartRows.length > 0}
            onRetry={retryTrend}
          >
            <TimeSeriesChart
              variant="trend"
              title={widgets.labels.humidChartTitle}
              dateTimeFormat={widgets.formats.humidChart}
              unit="%RH"
              spanMs={spanMs}
              min={trend.overview?.limits?.rhMin}
              max={trend.overview?.limits?.rhMax}
              series={humidSeries ? [{ ...humidSeries, color: HUMID_COLOR }] : []}
              onZoom={onZoom}
              onResetZoom={onResetZoom}
            />
            {/* The sampling disclosure was REMOVED 2026-09-01 (operator).
                It read "Showing N of M readings. Zoom in to see every reading
                for a shorter period." and it was a deliberate §11 statement:
                a wide range is DOWNSAMPLED, so the chart plots a subset and the
                line said so.

                What is unchanged, and is what keeps the page honest without it:
                sampling is by SELECTION (`lttb`), so every plotted point is a
                STORED reading at its stored timestamp — never an average
                dressed as a measurement; the axis still spans the whole period;
                drag-to-zoom REFETCHES the narrower window and returns the true
                readings; and the out-of-limit counts and min/max come from SQL
                over EVERY reading in the range, so a sampled chart still cannot
                understate an excursion. The signed PDF keeps its own wording.

                Restore `<SampledNote>` here if a chart ever plots a subset in a
                way those four do not cover. */}
          </ChartPanel>
        </TrendChartCard>
      </div>

      </>
      )}

      {/* STACKED, not side by side (operator, 2026-09-01). Both of these are
          wide tables — the time series carries a timestamp plus a column per
          administered slot, the alarms widget nine columns — and at half a page
          each they scrolled sideways inside their own cards. A table you have to
          scroll horizontally to read is one nobody reads. The two band gauges
          above stay two-up: they are a pair of single figures, not tables. */}
      <div className="grid gap-4">
      {/* Raw paged time-series. RAW ONLY — no averaging, no gap filling: a gap
          in the record stays a gap, never the previous value repeated. */}
      {showPanel('trend_historian_table') && (
        <TimeseriesTableCard
          rows={tableRows}
          slots={[
            {
              key: tempKey, heading: widgets.labels.timeseriesTemperatureHeading, decimals: tempDecimals,
              // Straight off the server-resolved overview. A bound the
              // instrument switches off (`Enable_Temp_NMT` = 0) arrives NULL,
              // and the card treats a NULL as "not judged" — it must never be
              // filled back in here.
              min: trend.overview?.limits?.tempMin, max: trend.overview?.limits?.tempMax,
              // The probe's SPAN, distinct from the spec limits above it. A
              // reading outside the span is not a measurement, so the table
              // prints the administered word rather than the number — and the
              // word comes from config, never a literal here.
              rangeLow: trend.overview?.rangeBounds?.temperatureLow ?? null,
              rangeHigh: trend.overview?.rangeBounds?.temperatureHigh ?? null,
              outOfRangeWord: sensorWords.outOfRange,
            },
            {
              key: humidKey, heading: widgets.labels.timeseriesHumidityHeading, decimals: humidDecimals,
              min: trend.overview?.limits?.rhMin, max: trend.overview?.limits?.rhMax,
              rangeLow: trend.overview?.rangeBounds?.humidityLow ?? null,
              rangeHigh: trend.overview?.rangeBounds?.humidityHigh ?? null,
              outOfRangeWord: sensorWords.outOfRange,
            },
          ]}
          failureWord={failureWord}
          title={widgets.labels.timeseriesTitle}
          subtitle={widgets.labels.timeseriesSubtitle}
          timestampHeading={widgets.labels.timeseriesTimestampHeading}
          settingsButton={<WidgetSettingsButton widget="timeseries" />}
          // This WIDGET's own administered formatter — see the card's doc
          // comment for why this cell may not call `toLocaleString`.
          formatTs={fmtTimeseries.formatDateTime}
          onExportPdf={() => setPendingReport({ kind: 'timeseries' })}
          page={page}
          pageSize={TABLE_PAGE_SIZE}
          totalItems={trend.historyTotal}
          onPageChange={setPage}
        />
      )}

      {id && showPanel('trend_alarms') && (
        <AlarmsWidget
          instrumentId={id}
          period={period}
          limits={trend.overview?.limits}
          onExportPdf={() => setPendingReport({ kind: 'alarms' })}
          statusTexts={statusTexts}
          inactivityTexts={inactivityTexts}
          labels={widgets.labels}
          dateTimeFormat={widgets.formats.alarms}
          settingsButton={<WidgetSettingsButton widget="alarms" />}
        />
      )}
      </div>

      <ReportDownloadDialog
        open={pendingReport !== null}
        reportName={reportDialogName}
        showPeriod
        initialPeriod={{ from: period.from, to: period.to, label: period.label }}
        // Only the Data Report is built per interval; the trend and alarm
        // reports take the page's chart interval and the period alone.
        showInterval={pendingReport?.kind === 'timeseries'}
        initialIntervalMs={period.intervalMs}
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
