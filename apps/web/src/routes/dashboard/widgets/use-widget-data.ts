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
import useSWR from 'swr';
import {
  DATA_KEYS_INSTRUMENTS_MAX, MAX_SERIES_POINTS,
  type CustomWidget, type DataKeyInfo, type DataKeyRef, type LatestValuesRow, type WidgetKey,
} from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useTelemetryOverview, useTelemetrySettings } from '../use-telemetry';

/** The dashboard's current drill-down — `nav.functionalLocationId` / `nav.directOnly`. */
export interface WidgetSelection {
  functionalLocationId?: string;
  directOnly: boolean;
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
  });
  if (source.mode === 'instruments') return { ids: source.ids, loading: false };
  return { ids: rows.map((r) => r.instrumentId), loading: isLoading };
}

const refsOf = (keys: readonly (DataKeyRef | WidgetKey)[]): DataKeyRef[] => keys.map((k) => ({ source: k.source, key: k.key }));

/** Each instrument's current value for each key — the server's verdict inputs included. */
export function useLatestValues(
  ids: readonly string[],
  keys: readonly (DataKeyRef | WidgetKey)[],
): { rows: LatestValuesRow[]; loading: boolean; error: unknown } {
  const { overviewRefreshMs } = useTelemetrySettings();
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
    { refreshInterval: overviewRefreshMs, keepPreviousData: true },
  );
  return { rows: data ?? [], loading: isLoading, error };
}

export type CatalogueSelector =
  | { instrumentIds: string[] }
  | { functionalLocationId: string; directOnly: boolean }
  | { all: true }
  | null;

/** The one builder of the catalogue URL. */
export function catalogueUrl(selector: CatalogueSelector): string | null {
  if (!selector) return null;
  const qs = new URLSearchParams();
  if ('all' in selector) qs.set('all', 'true');
  else if ('instrumentIds' in selector) qs.set('instrumentIds', selector.instrumentIds.join(','));
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
    { refreshInterval: chartRefreshMs, keepPreviousData: true },
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
    { refreshInterval: chartRefreshMs, keepPreviousData: true },
  );
  return { rows: data?.data ?? [], total: data?.total ?? 0, loading: isLoading };
}
