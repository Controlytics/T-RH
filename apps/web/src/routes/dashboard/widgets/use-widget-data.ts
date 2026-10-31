/**
 * Where a built widget's data comes from (widget data keys, phase 2).
 *
 * Every value is the SERVER's answer from the Phase 1 routes, with the viewer's
 * own scope applied there: a widget grants nothing, and an instrument the viewer
 * may not see is simply absent from these responses.
 *
 * The 200-instrument cap on `latest-values` is met by BATCHING, never by
 * cutting: the plant is ~320 instruments, and a widget following "All
 * Instruments" must reach every one of them (Phase 1 ruling, settled here).
 */
import useSWR, { type SWRConfiguration } from 'swr';
import { swrConfig } from '@/lib/swr-config';
import {
  DATA_KEYS_INSTRUMENTS_MAX, MAX_SERIES_POINTS,
  type CustomWidget, type DashboardTimeWindow, type DataKeyInfo, type DataKeyRef, type LatestValuesRow, type WidgetKey,
  type WIDGET_BAR_AGGS, type WIDGET_BAR_BUCKETS, type WIDGET_BAR_GROUPS,
} from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useTelemetryOverview, useTelemetrySettings, type OverviewRow } from '../use-telemetry';
import { ALARM_REFRESH_MS, alarmScopeSelectsNothing, applyAlarmScope, type AlarmScope } from '../alarm-scope';
import { isRefusal } from './refusal';

/** Retries pending, per SWR cache: one retry chain per key, however many failures arrive. */
const PENDING_RETRIES = new WeakMap<object, Set<string>>();

/** When SWR's merged config carries no cache (it always does at run time), one shared bucket of pending retries. */
const NO_CACHE = {};

/**
 * The ONE polling and retry policy of the widget data hooks (fix round 1, I-1 /
 * I-3). Dashboards stay open all day on unattended screens, and SWR 2.4 STOPS
 * polling a key whose cache holds an error (its poll `execute()` skips while
 * `getCache().error` is set) while the app's `errorRetryCount: 2` gives up after
 * two retries — so a widget used to freeze, or sit on "Could not load this
 * widget.", until someone focused the window. Here:
 *
 * - a FAILURE is retried at the widget's own refresh cadence, indefinitely (a
 *   cadence of 0 falls back to the configured `errorRetryInterval`, never a
 *   tight loop), with ONE retry chain per key in each SWR cache: a failure that
 *   arrives while a retry is pending (a focus, a mutate) starts no second chain;
 * - it is reported through the app's `onError` (`lib/swr-config.ts`: the "Load
 *   Error" toast and its console line) ONCE per outage — on its first failure —
 *   not on every retry. The per-hook `onError` is silent, so only this path
 *   reports; the app handler stays as it is for every other route;
 * - a REFUSAL (`isRefusal`) is never retried and never reported: the widget
 *   states it in its own body (the bar chart prints a 400's words), and a global
 *   toast for a state the card already explains is noise.
 *
 * Options, not a hook: it reads nothing from React, so the many tests that mock
 * `swr`'s default export alone render the pages that poll through it.
 */
export function widgetPolling(refreshMs: number): SWRConfiguration {
  return {
    refreshInterval: refreshMs,
    keepPreviousData: true,
    shouldRetryOnError: (error: unknown) => !isRefusal(error),
    // Reported from onErrorRetry instead, so an outage is reported once.
    onError: () => {},
    onErrorRetry: (error, key, config, revalidate, opts) => {
      // The merged config SWR hands in carries its cache; one pending set per cache.
      const cache = (config as { cache?: object }).cache ?? NO_CACHE;
      const pending = PENDING_RETRIES.get(cache) ?? new Set<string>();
      PENDING_RETRIES.set(cache, pending);
      if (pending.has(key)) return;
      if (opts.retryCount === 1) swrConfig.onError?.(error, key, config as Parameters<NonNullable<typeof swrConfig.onError>>[2]);
      pending.add(key);
      setTimeout(() => {
        pending.delete(key);
        revalidate(opts);
      }, refreshMs > 0 ? refreshMs : config.errorRetryInterval);
    },
  };
}

/**
 * THE rule that a present-state widget's data is THIS request's answer (Task 7
 * fix round 1, I-1). SWR's `keepPreviousData` hands a key with nothing cached the
 * PREVIOUS key's data — together with the NEW key's error when its first request
 * fails — and a drill-down from Block A to Block B whose request failed drew
 * Block A's alarm counts, pies and tiles as Block B's, "Showing the last ones
 * that loaded". With it off, a hook returns only the current key's own data, and
 * the key (the URL) IS the whole request — scope, instruments — so the answer a
 * widget holds always answers the request it makes now: a new scope loading
 * shows the widget's loading state, a new scope failing "Could not load this
 * widget.", and a failed REFRESH of the same scope keeps its last answer, said
 * (`answerState`). Used by `useAlarmCounts` and `useWidgetOverview` — the alarm
 * counts, both pies and the status grid. The bar chart keeps `keepPreviousData`:
 * its rolling window is a new key every minute, so it compares requests itself
 * (`heldAnswers`) and hands the result to the same `answerState`.
 */
export const THIS_REQUEST_ONLY = { keepPreviousData: false } as const;

/** The dashboard's current drill-down — `nav.functionalLocationId` / `nav.directOnly`. */
export interface WidgetSelection {
  functionalLocationId?: string;
  directOnly: boolean;
  /** A dashboard over one profile. */
  profileId?: string;
  /** A dashboard over a fixed list; `[]` is NOTHING, never everything. */
  instrumentIds?: string[];
  /** The dashboard's time window; absent on the home dashboard. */
  window?: DashboardTimeWindow;
}

export function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let k = 0; k < xs.length; k += n) out.push(xs.slice(k, k + n));
  return out;
}

/**
 * The instruments a widget covers, in display order.
 *
 * "Follow the dashboard selection" reads the SAME overview query the readings
 * table makes for that selection — one SWR key, so no extra request — and takes
 * its ids in the server's order. The overview hook is called in both modes
 * (hooks cannot be conditional); in instruments mode its rows are unused.
 */
export function useWidgetInstrumentIds(
  source: CustomWidget['source'],
  selection: WidgetSelection,
): { ids: string[]; loading: boolean } {
  const { rows, isLoading } = useTelemetryOverview({
    functionalLocationId: selection.functionalLocationId,
    directOnly: selection.directOnly,
    profileId: selection.profileId,
    instrumentIds: selection.instrumentIds,
  });
  if (source.mode === 'instruments') return { ids: source.ids, loading: false };
  return { ids: rows.map((r) => r.instrumentId), loading: isLoading };
}

/**
 * The overview rows — the server's `status` / `reporting` / `judged` per
 * instrument, in the server's order — that the status widgets (status grid,
 * status pie) draw.
 *
 * Following the selection it is the readings table's OWN query (one SWR key, no
 * extra request); over picked instruments it asks for exactly those ids, as
 * `widgetAlarmScope` does, and never the selection's rows (the same rule). One
 * call with its arguments chosen, never a conditional hook. The overview hook's
 * own polling and retry are the readings table's, unchanged; only
 * `THIS_REQUEST_ONLY` differs — the rows are always this request's (I-1).
 */
export function useWidgetOverview(
  source: CustomWidget['source'],
  selection: WidgetSelection,
): { rows: OverviewRow[]; loading: boolean; error: unknown } {
  const { rows, isLoading, error } = useTelemetryOverview(overviewQueryFor(source, selection), THIS_REQUEST_ONLY);
  return { rows, loading: isLoading && rows.length === 0, error };
}

/** What a widget asks the overview for — the one mapping from a widget's source and the dashboard's selection. */
export interface OverviewQuery {
  functionalLocationId?: string;
  directOnly?: boolean;
  profileId?: string;
  instrumentIds?: string[];
}

/**
 * The overview query of a widget: over picked instruments exactly those ids,
 * else the dashboard's selection as it stands (the readings table's own query,
 * so one SWR key). `useWidgetOverview` asks it; the floor plan widget hands the
 * same query to `FloorplanView`, so the plan draws the rows the widget judged.
 */
export function overviewQueryFor(source: CustomWidget['source'], selection: WidgetSelection): OverviewQuery {
  return source.mode === 'instruments'
    ? { instrumentIds: source.ids }
    : {
      functionalLocationId: selection.functionalLocationId,
      directOnly: selection.directOnly,
      profileId: selection.profileId,
      instrumentIds: selection.instrumentIds,
    };
}

const refsOf = (keys: readonly (DataKeyRef | WidgetKey)[]): DataKeyRef[] => keys.map((k) => ({ source: k.source, key: k.key }));

/** Each instrument's current value for each key — the server's verdict inputs included. */
export function useLatestValues(
  ids: readonly string[],
  keys: readonly (DataKeyRef | WidgetKey)[],
): { rows: LatestValuesRow[]; loading: boolean; error: unknown } {
  const { overviewRefreshMs } = useTelemetrySettings();
  const polling = widgetPolling(overviewRefreshMs);
  const refs = refsOf(keys);
  const swrKey = ids.length > 0 && refs.length > 0
    ? ['widget-latest-values', ids.join(','), JSON.stringify(refs)]
    : null;
  const { data, error, isLoading } = useSWR<LatestValuesRow[]>(
    swrKey,
    async () => {
      const pages = await Promise.all(
        chunk(ids, DATA_KEYS_INSTRUMENTS_MAX).map((instrumentIds) =>
          apiClient.post<{ data: LatestValuesRow[] }>('/api/instruments/latest-values', { instrumentIds, keys: refs })),
      );
      return pages.flatMap((p) => p.data);
    },
    polling,
  );
  return { rows: data ?? [], loading: isLoading, error };
}

export type CatalogueSelector =
  | { instrumentIds: string[] }
  | { profileId: string }
  | { functionalLocationId: string; directOnly: boolean }
  | { all: true }
  | null;

/** The one builder of the catalogue URL. */
export function catalogueUrl(selector: CatalogueSelector): string | null {
  if (!selector) return null;
  const qs = new URLSearchParams();
  if ('all' in selector) qs.set('all', 'true');
  else if ('instrumentIds' in selector) qs.set('instrumentIds', selector.instrumentIds.join(','));
  else if ('profileId' in selector) qs.set('profileId', selector.profileId);
  else {
    qs.set('functionalLocationId', selector.functionalLocationId);
    if (selector.directOnly) qs.set('functionalLocationDirect', 'true');
  }
  return `/api/instruments/data-keys?${qs.toString()}`;
}

/** Every key the selected instruments have sent or carry — a new key appears by itself. */
export function useKeyCatalogue(selector: CatalogueSelector): { keys: DataKeyInfo[]; loading: boolean } {
  const url = catalogueUrl(selector);
  const { data, isLoading } = useSWR<{ data: DataKeyInfo[] }>(url, (u: string) => apiClient.get<{ data: DataKeyInfo[] }>(u));
  return { keys: data?.data ?? [], loading: isLoading };
}

export interface WidgetRange {
  from: string;
  to: string;
}

export interface KeySummary {
  count: number;
  numericCount: number;
  min: number | null;
  max: number | null;
  avg: number | null;
}

export interface InstrumentHistory {
  history: { key: string; value: unknown; ts: string }[];
  summaries: Record<string, KeySummary>;
  historySampled: boolean;
  historyTotal: number;
}

/**
 * The chart path of `GET /:id/telemetry`, one request per instrument, with the
 * `keys` filter. An instrument whose request fails (out of scope, deleted) is
 * LEFT OUT — absent, like every out-of-scope instrument — rather than failing the
 * whole widget.
 */
export function useWidgetHistory(
  ids: readonly string[],
  keys: readonly string[],
  range: WidgetRange,
): { byInstrument: Map<string, InstrumentHistory>; loading: boolean } {
  const { chartRefreshMs } = useTelemetrySettings();
  const polling = widgetPolling(chartRefreshMs);
  const swrKey = ids.length > 0 && keys.length > 0
    ? ['widget-history', ids.join(','), keys.join(','), range.from, range.to]
    : null;
  const { data, isLoading } = useSWR<Map<string, InstrumentHistory>>(
    swrKey,
    async () => {
      const qs = (id: string) => {
        const q = new URLSearchParams({ from: range.from, to: range.to, points: String(MAX_SERIES_POINTS), keys: keys.join(',') });
        return `/api/instruments/${id}/telemetry?${q.toString()}`;
      };
      const settled = await Promise.allSettled(ids.map((id) => apiClient.get<InstrumentHistory>(qs(id))));
      const out = new Map<string, InstrumentHistory>();
      settled.forEach((r, n) => {
        if (r.status === 'fulfilled') {
          out.set(ids[n], {
            history: r.value.history ?? [],
            summaries: r.value.summaries ?? {},
            historySampled: r.value.historySampled === true,
            historyTotal: r.value.historyTotal ?? 0,
          });
        }
      });
      return out;
    },
    polling,
  );
  return { byInstrument: data ?? new Map(), loading: isLoading };
}

export interface TimeseriesRow {
  instrumentId: string;
  ts: string;
  values: Record<string, unknown>;
}

/** Several instruments' readings, merged and paged on the SERVER, newest first. */
export function useWidgetTimeseries(
  ids: readonly string[],
  keys: readonly string[],
  range: WidgetRange,
  page: number,
  pageSize: number,
): { rows: TimeseriesRow[]; total: number; loading: boolean } {
  const { chartRefreshMs } = useTelemetrySettings();
  const polling = widgetPolling(chartRefreshMs);
  const q = new URLSearchParams({
    instrumentIds: ids.join(','),
    keys: keys.join(','),
    from: range.from,
    to: range.to,
    limit: String(pageSize),
    offset: String(Math.max(page - 1, 0) * pageSize),
  });
  const url = ids.length > 0 && keys.length > 0 ? `/api/instruments/telemetry-history?${q.toString()}` : null;
  const { data, isLoading } = useSWR<{ data: TimeseriesRow[]; total: number }>(
    url,
    (u: string) => apiClient.get<{ data: TimeseriesRow[]; total: number }>(u),
    polling,
  );
  return { rows: data?.data ?? [], total: data?.total ?? 0, loading: isLoading };
}

export type BarBucket = (typeof WIDGET_BAR_BUCKETS)[number];
export type BarAgg = (typeof WIDGET_BAR_AGGS)[number];
export type BarGroup = (typeof WIDGET_BAR_GROUPS)[number];

/** One bucket: the server's COMPUTED value, and how many readings it came from. */
export interface TelemetryBucketPoint {
  /** The bucket's start, a UTC instant (the edge is local to the configured timezone). */
  ts: string;
  value: number;
  readings: number;
  instruments: number;
}

export interface TelemetryBucketSeries {
  /** `null` when the series is every instrument combined (`groupBy=all`). */
  instrumentId: string | null;
  key: string;
  /** Only buckets that hold a reading; a gap is a gap, never a zero. */
  points: TelemetryBucketPoint[];
}

/** `GET /api/instruments/telemetry-buckets`, as the server returns it. */
export interface TelemetryBuckets {
  from: string;
  to: string;
  bucket: BarBucket;
  agg: BarAgg;
  /** The zone the edges were drawn in (`UTC` when the configured one is unknown). */
  timezone: string;
  bucketSeconds: number;
  series: TelemetryBucketSeries[];
}

/** The request a buckets answer answers — read back from its own URL. */
export interface BucketRequest {
  instrumentIds: string[];
  keys: string[];
  from: string;
  to: string;
  bucket: BarBucket;
  agg: BarAgg;
  groupBy: BarGroup;
}

function bucketRequestOf(url: string): BucketRequest {
  const q = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  const list = (name: string) => (q.get(name) ?? '').split(',').filter((s) => s !== '');
  return {
    instrumentIds: list('instrumentIds'),
    keys: list('keys'),
    from: q.get('from') ?? '',
    to: q.get('to') ?? '',
    bucket: q.get('bucket') as BarBucket,
    agg: q.get('agg') as BarAgg,
    groupBy: q.get('groupBy') as BarGroup,
  };
}

/**
 * Readings binned into local hours, days or weeks, aggregated on the SERVER —
 * every value is derived and says how many readings are behind it. No instruments
 * or no keys asks nothing. The server refuses more than `WIDGET_INSTRUMENTS_MAX`
 * instruments or 1,000 buckets with a 400, which arrives here as `error`.
 *
 * `request` is what `data` answers. Under `keepPreviousData` the answer on hand
 * may be an EARLIER request's (a new window loading, or one that failed), and the
 * widget must know which before it draws it as the current one.
 */
export function useTelemetryBuckets(
  ids: readonly string[],
  keys: readonly string[],
  range: WidgetRange,
  bucket: BarBucket,
  agg: BarAgg,
  groupBy: BarGroup,
): { data: TelemetryBuckets | undefined; request: BucketRequest | undefined; loading: boolean; error: unknown } {
  const { chartRefreshMs } = useTelemetrySettings();
  const polling = widgetPolling(chartRefreshMs);
  const q = new URLSearchParams({
    instrumentIds: ids.join(','),
    keys: keys.join(','),
    from: range.from,
    to: range.to,
    bucket,
    agg,
    groupBy,
  });
  const url = ids.length > 0 && keys.length > 0 ? `/api/instruments/telemetry-buckets?${q.toString()}` : null;
  const { data, error, isLoading } = useSWR<{ response: TelemetryBuckets; request: BucketRequest }>(
    url,
    async (u: string) => ({ response: await apiClient.get<TelemetryBuckets>(u), request: bucketRequestOf(u) }),
    polling,
  );
  // `keepPreviousData` hands a NULL key the last key's data: asking nothing must
  // show nothing, never the previous selection's bars.
  return url
    ? { data: data?.response, request: data?.request, loading: isLoading, error }
    : { data: undefined, request: undefined, loading: false, error: undefined };
}

/** `GET /api/alarms/counts`, as the server returns it. */
export interface AlarmCounts {
  quadrants: { activeUnack: number; activeAck: number; clearedUnack: number; clearedAck: number };
  byType: { type: string; active: number; unacknowledged: number }[];
}

/**
 * The alarm counts of a selection — asked with the SAME scope filters the alarm
 * table sends (`applyAlarmScope`), so the two cannot count different alarms. A
 * `WidgetSelection` is a scope as it stands; a widget with its own instruments
 * passes `widgetAlarmScope(widget.source, selection)`. An empty fixed list asks
 * nothing. A viewer without ALARM_READ gets the 403 as `error`. The data is only
 * ever THIS request's answer (`THIS_REQUEST_ONLY`, I-1).
 */
export function useAlarmCounts(selection: AlarmScope): { data: AlarmCounts | undefined; loading: boolean; error: unknown } {
  const polling = widgetPolling(ALARM_REFRESH_MS);
  const qs = new URLSearchParams();
  applyAlarmScope(qs, selection);
  // The string, not `URLSearchParams.size`: `size` is undefined before Chrome 113
  // / Safari 17, and there an empty-looking query would ask for everything in view.
  const query = qs.toString();
  const url = alarmScopeSelectsNothing(selection)
    ? null
    : query ? `/api/alarms/counts?${query}` : '/api/alarms/counts';
  const { data, error, isLoading } = useSWR<AlarmCounts>(
    url,
    (u: string) => apiClient.get<AlarmCounts>(u),
    { ...polling, ...THIS_REQUEST_ONLY },
  );
  // An empty list counts nothing, never the previous selection's alarms.
  return url ? { data, loading: isLoading, error } : { data: undefined, loading: false, error: undefined };
}
