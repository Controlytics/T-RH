import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import useSWR from 'swr';
import {
  PERIOD_PRESETS,
  INTERVALS,
  DEFAULT_PERIOD,
  DEFAULT_INTERVAL,
  MAX_SERIES_POINTS,
  intervalSpec,
  isIntervalKey,
  resolvePeriod,
  type IntervalKey,
} from '@digilog/shared';
import { useTelemetryOverview, type OverviewRow } from '@/routes/dashboard/use-telemetry';

/**
 * The trend page's own period vocabulary, built on top of the shared
 * `telemetry-period` primitives rather than re-deriving preset math here.
 *
 * `from`/`to` are always CONCRETE ISO instants, never a live-relative preset
 * name. That is what makes the page linkable: an operator sending "look at
 * this excursion" sends the exact window, and reloading the link shows the
 * same minutes rather than a "last 24 hours" that has since slid forward.
 */
export interface TrendPeriod {
  from: string;
  to: string;
  label: string;
  /** Chart aggregation bucket in ms; null = raw (every stored reading). */
  intervalMs: number | null;
}

export const TREND_PRESETS: { label: string; ms: number }[] =
  PERIOD_PRESETS.map((p) => ({ label: p.label, ms: p.ms }));

function intervalMsFor(key: IntervalKey): number | null {
  const spec = intervalSpec(key);
  return spec.seconds === null ? null : spec.seconds * 1000;
}

/** The nearest known interval key for a bucket width, defaulting when the ms value is unrecognised. */
function intervalKeyForMs(ms: number | null): IntervalKey {
  if (ms === null) return 'raw';
  return INTERVALS.find((i) => i.seconds !== null && i.seconds * 1000 === ms)?.value ?? DEFAULT_INTERVAL;
}

function readPeriod(params: URLSearchParams): TrendPeriod {
  const from = params.get('from');
  const to = params.get('to');
  const intervalParam = params.get('interval');
  const interval = isIntervalKey(intervalParam) ? intervalParam : DEFAULT_INTERVAL;
  const intervalMs = intervalMsFor(interval);

  if (from && to) {
    return { from, to, label: params.get('label') ?? 'Custom', intervalMs };
  }
  // No window in the URL yet — seed the default preset relative to now, once.
  const defaultSpec = PERIOD_PRESETS.find((p) => p.value === DEFAULT_PERIOD)!;
  const range = resolvePeriod(DEFAULT_PERIOD, new Date());
  return { from: range.from.toISOString(), to: range.to.toISOString(), label: defaultSpec.label, intervalMs };
}

/**
 * Period + chart-interval state, held in the URL query string.
 *
 * `setPreset`/`setCustom` both resolve to a CONCRETE range immediately and
 * write it into the URL — the preset name itself is never the stored state,
 * only the sugar that produced it (see the `TrendPeriod` doc comment above).
 */
export function useTrendPeriod(): {
  period: TrendPeriod;
  setPreset: (ms: number) => void;
  setCustom: (from: string, to: string) => void;
  setInterval: (ms: number | null) => void;
} {
  const [params, setParams] = useSearchParams();
  const period = useMemo(() => readPeriod(params), [params]);

  const setPreset = (ms: number) => {
    const now = new Date();
    const spec = TREND_PRESETS.find((p) => p.ms === ms);
    const next = new URLSearchParams(params);
    next.set('from', new Date(now.getTime() - ms).toISOString());
    next.set('to', now.toISOString());
    next.set('label', spec?.label ?? 'Custom');
    setParams(next, { replace: true });
  };

  const setCustom = (from: string, to: string) => {
    const next = new URLSearchParams(params);
    next.set('from', from);
    next.set('to', to);
    next.set('label', 'Custom');
    setParams(next, { replace: true });
  };

  const setInterval = (ms: number | null) => {
    const next = new URLSearchParams(params);
    next.set('interval', intervalKeyForMs(ms));
    setParams(next, { replace: true });
  };

  return { period, setPreset, setCustom, setInterval };
}

/** One telemetry reading, LONG format — matches `GET /:id/telemetry`'s `history`/`latest` rows. */
export interface TelemetryLongRow {
  key: string;
  value: unknown;
  ts: string;
  slot?: 'temperature' | 'humidity' | null;
  decimals?: number | null;
}

export const TABLE_PAGE_SIZE = 50;

/** Per-key aggregates over the WHOLE requested range, computed in SQL — never
 *  over just the (possibly sampled) rows returned. Chart path only. */
export interface TelemetrySummary {
  count: number;
  /** Readings that are numbers (a quoted number is one); `count - numericCount`
   *  is how many a chart could not plot. On the wire since phase 1. */
  numericCount?: number;
  min: number;
  max: number;
  avg: number;
  first: string;
  last: string;
}

interface TelemetryResponse {
  latest: TelemetryLongRow[];
  history: TelemetryLongRow[];
  historyTotal: number;
  /**
   * Chart path only (`points` was sent). True when any key's plotted series
   * is a subset of what the range actually holds — sampled down, or hit the
   * server's hard cap.
   *
   * Deliberately NOT surfaced on `InstrumentTrendData` below. It is a single
   * flag over ALL keys in the response, so it cannot say which key's chart
   * was sampled — and `SampledNote`'s own per-key `shown < total` comparison
   * (against `summaries[key].count`, both counted the same way server-side)
   * is a strictly more precise signal for "was THIS chart's data sampled"
   * than this boolean could ever be. Typed here only because it is part of
   * the wire response; a prop that looked load-bearing on the hook but was
   * never read was worse than not exposing it at all.
   */
  historySampled?: boolean;
  /** Chart path only, keyed by telemetry key. */
  summaries?: Record<string, TelemetrySummary>;
}

export interface InstrumentTrendData {
  /** This instrument's row from the telemetry overview — latest values, resolved
   *  limits + their source, and resolved decimals. Never re-derived here. */
  overview: OverviewRow | null;
  /** Every key, across the WHOLE period, sampled down to `MAX_SERIES_POINTS` per key — feeds the charts. */
  chartRows: TelemetryLongRow[];
  /** Every key, for just the current PAGE of the period — feeds the raw table. */
  tableRows: TelemetryLongRow[];
  /** The true count across the whole period, for paging the table (never `tableRows.length`). */
  historyTotal: number;
  /** Per-key true aggregates over the WHOLE range, for the summary strip — never
   *  derived from `chartRows`, which may be sampled. */
  summaries: Record<string, TelemetrySummary>;
  isLoading: boolean;
  /**
   * The CHART request's own in-flight flag, separate from `isLoading`.
   *
   * The charts must not blank because the table's page fetch is slow: gating a
   * chart skeleton on the combined flag would replace a fully loaded chart
   * with "Loading…" every time the operator paged the table underneath it.
   */
  chartsLoading: boolean;
  /**
   * The CHART request's error, and its retry.
   *
   * Exposed here rather than left to the page to re-issue `useSWR` with a
   * hand-copied key: the key would then live in two files, and the failure
   * when they drifted would be silent — a Retry button quietly mutating a
   * request nothing was watching. One owner of the key, one subscription.
   */
  error: unknown;
  retry: () => void;
}

/**
 * Data for one instrument's trend page: latest-value cards, charts, and the
 * raw paged table, all sourced from the LONG-format telemetry endpoint plus
 * the shared telemetry-overview row for limits/decimals/status.
 *
 * `extraKeys` is accepted here (not just read further down the tree) because
 * the endpoint returns EVERY key in one combined, unfiltered response — there
 * is no per-key request to make. What `extraKeys` selects is which of those
 * already-present keys Task 7's picker renders a chart/column for; it does
 * not change what gets fetched, so it is not read in this function today.
 * Kept in the signature so that stays documented rather than silently true.
 */
/**
 * `page` is 1-based, matching `components/ui/pagination.tsx` (`Pagination`'s
 * own convention) — the table page control the trend page reuses.
 */
export function useInstrumentTrend(
  id: string,
  period: TrendPeriod,
  page: number,
  _extraKeys: string[],
): InstrumentTrendData {
  const { rows: overviewRows, isLoading: overviewLoading } = useTelemetryOverview();
  const overview = overviewRows.find((r) => r.instrumentId === id) ?? null;

  // Chart series need the whole period, not just the visible table page —
  // `points` (not `limit`) puts this on the CHART path: every reading in the
  // range is read server-side and downsampled to MAX_SERIES_POINTS per key,
  // with true min/max/avg computed over the whole range, not the sampled
  // slice. `limit` here would hit the legacy TABLE path instead, which caps
  // at 500 rows ordered newest-first — a 7/30-day window would come back
  // holding roughly the last day, with nothing in the response saying so.
  const chartKey = id
    ? `/api/instruments/${id}/telemetry?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}&points=${MAX_SERIES_POINTS}`
    : null;
  const { data: chartData, isLoading: chartLoading, error: chartError, mutate: chartMutate } =
    useSWR<TelemetryResponse>(chartKey);

  const offset = Math.max(page - 1, 0) * TABLE_PAGE_SIZE;
  const tableKey = id
    ? `/api/instruments/${id}/telemetry?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}&limit=${TABLE_PAGE_SIZE}&offset=${offset}`
    : null;
  const { data: tableData, isLoading: tableLoading } = useSWR<TelemetryResponse>(tableKey);

  return {
    overview,
    chartRows: chartData?.history ?? [],
    tableRows: tableData?.history ?? [],
    // From the TABLE response, never the chart one — the chart path's own
    // `historyTotal` counts the same whole-range readings, but the table's
    // paging must stay driven by its own fetch regardless of what the chart
    // request returns or when it resolves.
    historyTotal: tableData?.historyTotal ?? 0,
    summaries: chartData?.summaries ?? {},
    isLoading: overviewLoading || chartLoading || tableLoading,
    chartsLoading: chartLoading,
    error: chartError,
    retry: () => { void chartMutate(); },
  };
}
