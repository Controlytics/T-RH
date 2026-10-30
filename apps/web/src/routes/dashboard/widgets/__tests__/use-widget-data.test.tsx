import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig, useSWRConfig } from 'swr';
import { registerSwrToast, swrConfig, unregisterSwrToast } from '@/lib/swr-config';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));

// Module-level constants: a fresh object per call makes an effect keyed on it
// re-run forever (the UI v3 vitest hang).
const OVERVIEW = { rows: [{ instrumentId: 'i-3' }, { instrumentId: 'i-1' }, { instrumentId: 'i-2' }], isLoading: false, error: undefined };
const SETTINGS = { overviewRefreshMs: 0, chartRefreshMs: 0 };
const overviewCalls: unknown[] = [];
vi.mock('../../use-telemetry', () => ({
  useTelemetryOverview: (opts: unknown) => { overviewCalls.push(opts); return OVERVIEW; },
  useTelemetrySettings: () => SETTINGS,
}));

import {
  chunk, catalogueUrl, useLatestValues, useWidgetInstrumentIds, useKeyCatalogue, useWidgetHistory, useWidgetTimeseries,
  useTelemetryBuckets, useAlarmCounts,
} from '../use-widget-data';

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

const ids = (n: number) => Array.from({ length: n }, (_, k) => `id-${k}`);

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  overviewCalls.length = 0;
});

describe('chunk', () => {
  it('splits into runs of n, the last one short', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 200)).toEqual([]);
  });
});

describe('useLatestValues', () => {
  it('300 ids → two latest-values requests, every row', async () => {
    post.mockImplementation(async (_url: string, body: { instrumentIds: string[] }) => ({
      data: body.instrumentIds.map((instrumentId) => ({ instrumentId, values: [] })),
    }));
    const keys = [{ source: 'telemetry' as const, key: 'p' }];
    const { result } = renderHook(() => useLatestValues(ids(300), keys), { wrapper });
    await waitFor(() => expect(result.current.rows).toHaveLength(300));
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][0]).toBe('/api/instruments/latest-values');
    expect(post.mock.calls[0][1].instrumentIds).toHaveLength(200);
    expect(post.mock.calls[1][1].instrumentIds).toHaveLength(100);
    expect(post.mock.calls[0][1].keys).toEqual([{ source: 'telemetry', key: 'p' }]);
  });

  it('sends the key refs only, never the display settings', async () => {
    post.mockResolvedValue({ data: [] });
    renderHook(() => useLatestValues(['a'], [{ source: 'telemetry', key: 'p', label: 'P', unit: 'kPa', decimals: 2, color: 1 }]), { wrapper });
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1].keys).toEqual([{ source: 'telemetry', key: 'p' }]);
  });

  it('no ids, no request', async () => {
    const { result } = renderHook(() => useLatestValues([], [{ source: 'telemetry', key: 'p' }]), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(post).not.toHaveBeenCalled();
    expect(result.current.rows).toEqual([]);
  });
});

describe('useWidgetInstrumentIds', () => {
  it("selection mode takes the overview's ids in order, scoped to the dashboard's selection", () => {
    const { result } = renderHook(
      () => useWidgetInstrumentIds({ mode: 'selection' }, { functionalLocationId: 'fl-1', directOnly: true }),
      { wrapper },
    );
    expect(result.current.ids).toEqual(['i-3', 'i-1', 'i-2']);
    expect(overviewCalls.at(-1)).toEqual({ functionalLocationId: 'fl-1', directOnly: true });
  });

  it('instruments mode is the stored list', () => {
    const { result } = renderHook(
      () => useWidgetInstrumentIds({ mode: 'instruments', ids: ['x', 'y'] }, { directOnly: false }),
      { wrapper },
    );
    expect(result.current.ids).toEqual(['x', 'y']);
  });
});

describe('the key catalogue', () => {
  it('asks for all, a direct-only location, a location, or ids', () => {
    expect(catalogueUrl({ all: true })).toBe('/api/instruments/data-keys?all=true');
    expect(catalogueUrl({ functionalLocationId: 'f', directOnly: true }))
      .toBe('/api/instruments/data-keys?functionalLocationId=f&functionalLocationDirect=true');
    expect(catalogueUrl({ functionalLocationId: 'f', directOnly: false })).toBe('/api/instruments/data-keys?functionalLocationId=f');
    expect(catalogueUrl({ instrumentIds: ['a', 'b'] })).toBe('/api/instruments/data-keys?instrumentIds=a%2Cb');
    expect(catalogueUrl(null)).toBeNull();
  });

  it('returns the server list', async () => {
    get.mockResolvedValue({ data: [{ source: 'telemetry', key: 'p' }] });
    const { result } = renderHook(() => useKeyCatalogue({ all: true }), { wrapper });
    await waitFor(() => expect(result.current.keys).toHaveLength(1));
    expect(get).toHaveBeenCalledWith('/api/instruments/data-keys?all=true');
  });
});

describe('history', () => {
  const range = { from: '2026-10-28T00:00:00.000Z', to: '2026-10-28T12:00:00.000Z' };

  it('is one request per instrument with the keys filter, and an instrument that fails is left out', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.includes('/b/')) throw Object.assign(new Error('Not found'), { status: 404 });
      return { history: [{ key: 'p', value: 1, ts: range.from }], summaries: {}, historyTotal: 1, historySampled: false };
    });
    const { result } = renderHook(() => useWidgetHistory(['a', 'b'], ['p', 'q'], range), { wrapper });
    await waitFor(() => expect(result.current.byInstrument.size).toBe(1));
    expect(get).toHaveBeenCalledTimes(2);
    const url = get.mock.calls.find((c) => String(c[0]).includes('/a/'))![0] as string;
    expect(url).toContain('/api/instruments/a/telemetry?');
    expect(url).toContain('keys=p%2Cq');
    expect(url).toContain('points=');
    expect(result.current.byInstrument.has('b')).toBe(false);
  });

  it('the time series table is one paged telemetry-history request', async () => {
    get.mockResolvedValue({ data: [{ instrumentId: 'a', ts: range.to, values: { p: 1 } }], total: 31 });
    const { result } = renderHook(() => useWidgetTimeseries(['a', 'b'], ['p'], range, 2, 10), { wrapper });
    await waitFor(() => expect(result.current.total).toBe(31));
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain('/api/instruments/telemetry-history?');
    expect(url).toContain('instrumentIds=a%2Cb');
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=10');
    expect(result.current.rows).toHaveLength(1);
  });
});

describe('useTelemetryBuckets', () => {
  const range = { from: '2026-10-28T00:00:00.000Z', to: '2026-10-29T00:00:00.000Z' };
  const BUCKETS = {
    from: range.from, to: range.to, bucket: 'hour', agg: 'avg', timezone: 'Asia/Kolkata', bucketSeconds: 3600,
    series: [{ instrumentId: null, key: 'p', points: [{ ts: '2026-10-28T00:30:00.000Z', value: 1.5, readings: 12, instruments: 2 }] }],
  };

  it('is one telemetry-buckets request with every parameter, and returns the server answer as it came', async () => {
    get.mockResolvedValue(BUCKETS);
    const { result } = renderHook(() => useTelemetryBuckets(['a', 'b'], ['p', 'q'], range, 'day', 'max', 'instrument'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(get).toHaveBeenCalledTimes(1);
    const url = get.mock.calls[0][0] as string;
    expect(url.split('?')[0]).toBe('/api/instruments/telemetry-buckets');
    expect(Object.fromEntries(new URLSearchParams(url.split('?')[1]))).toEqual({
      instrumentIds: 'a,b', keys: 'p,q', from: range.from, to: range.to, bucket: 'day', agg: 'max', groupBy: 'instrument',
    });
    expect(result.current.data).toEqual(BUCKETS);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it('no instruments or no keys, no request', async () => {
    const { result: noIds } = renderHook(() => useTelemetryBuckets([], ['p'], range, 'hour', 'avg', 'all'), { wrapper });
    const { result: noKeys } = renderHook(() => useTelemetryBuckets(['a'], [], range, 'hour', 'avg', 'all'), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(get).not.toHaveBeenCalled();
    expect(noIds.current).toEqual({ data: undefined, loading: false, error: undefined });
    expect(noKeys.current.data).toBeUndefined();
  });

  it("moving to no instruments drops the previous selection's buckets (keepPreviousData must not leak)", async () => {
    get.mockResolvedValue(BUCKETS);
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useTelemetryBuckets(ids, ['p'], range, 'hour', 'avg', 'all'),
      { wrapper, initialProps: { ids: ['a'] } },
    );
    await waitFor(() => expect(result.current.data).toEqual(BUCKETS));
    rerender({ ids: [] });
    expect(result.current).toEqual({ data: undefined, loading: false, error: undefined });
  });

  it('a refused request is the error, not an empty chart', async () => {
    const refused = Object.assign(new Error('That window holds more than 1,000 hours'), { status: 400 });
    get.mockRejectedValue(refused);
    const { result } = renderHook(() => useTelemetryBuckets(['a'], ['p'], range, 'hour', 'avg', 'all'), { wrapper });
    await waitFor(() => expect(result.current.error).toBe(refused));
    expect(result.current.data).toBeUndefined();
  });
});

describe('useAlarmCounts', () => {
  const COUNTS = {
    quadrants: { activeUnack: 3, activeAck: 5, clearedUnack: 7, clearedAck: 11 },
    byType: [{ type: 'HIGH_TEMPERATURE', active: 2, unacknowledged: 1 }],
  };

  it('asks /api/alarms/counts with the alarm table filter set, and returns the server answer', async () => {
    get.mockResolvedValue(COUNTS);
    const { result } = renderHook(
      () => useAlarmCounts({ functionalLocationId: 'fl-1', directOnly: true, profileId: 'p-1', instrumentIds: ['a', 'b'] }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual(COUNTS));
    expect(get).toHaveBeenCalledWith(
      '/api/alarms/counts?functionalLocationId=fl-1&functionalLocationDirect=true&profileId=p-1&instrumentIds=a%2Cb',
    );
  });

  it('a WidgetSelection over everything asks with no filter', async () => {
    get.mockResolvedValue(COUNTS);
    renderHook(() => useAlarmCounts({ directOnly: false }), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get.mock.calls[0][0]).toBe('/api/alarms/counts');
  });

  it('an EMPTY fixed list asks nothing - never the whole estate', async () => {
    const { result } = renderHook(() => useAlarmCounts({ directOnly: false, instrumentIds: [] }), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(get).not.toHaveBeenCalled();
    expect(result.current).toEqual({ data: undefined, loading: false, error: undefined });
  });

  it("moving to an EMPTY list drops the previous selection's counts (keepPreviousData must not leak)", async () => {
    get.mockResolvedValue(COUNTS);
    const { result, rerender } = renderHook(
      ({ scope }: { scope: { directOnly: boolean; instrumentIds?: string[] } }) => useAlarmCounts(scope),
      { wrapper, initialProps: { scope: { directOnly: false, instrumentIds: ['a'] } } },
    );
    await waitFor(() => expect(result.current.data).toEqual(COUNTS));
    rerender({ scope: { directOnly: false, instrumentIds: [] } });
    expect(result.current).toEqual({ data: undefined, loading: false, error: undefined });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('a refused request (no ALARM_READ) is the error', async () => {
    const forbidden = Object.assign(new Error('Forbidden'), { status: 403 });
    get.mockRejectedValue(forbidden);
    const { result } = renderHook(() => useAlarmCounts({ directOnly: false }), { wrapper });
    await waitFor(() => expect(result.current.error).toBe(forbidden));
  });
});

describe('the widget data hooks: ONE retry policy (fix round 1, I-1 / I-3)', () => {
  // The APP's SWR configuration (errorRetryCount 2, the global toast and
  // console.error), so the hooks' own policy is proved to override it.
  const appWrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ ...swrConfig, provider: () => new Map(), dedupingInterval: 0, isVisible: () => true, isOnline: () => true }}>
      {children}
    </SWRConfig>
  );
  const range = { from: '2026-10-28T00:00:00.000Z', to: '2026-10-29T00:00:00.000Z' };
  const BUCKETS = {
    from: range.from, to: range.to, bucket: 'hour', agg: 'avg', timezone: 'Asia/Kolkata', bucketSeconds: 3600,
    series: [{ instrumentId: null, key: 'p', points: [{ ts: '2026-10-28T00:30:00.000Z', value: 1.5, readings: 12, instruments: 2 }] }],
  };
  const COUNTS = { quadrants: { activeUnack: 0, activeAck: 0, clearedUnack: 0, clearedAck: 0 }, byType: [] };
  const toast = vi.fn();
  let consoleError: MockInstance;
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const down = () => Object.assign(new Error('Internal Server Error'), { status: 500 });

  beforeEach(() => {
    vi.useFakeTimers();
    toast.mockReset();
    registerSwrToast(toast);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    unregisterSwrToast();
    consoleError.mockRestore();
    SETTINGS.chartRefreshMs = 0;
    SETTINGS.overviewRefreshMs = 0;
  });

  it("buckets: a failed request is retried at the widget's refresh cadence until it succeeds — past the app's two retries — then polling resumes", async () => {
    SETTINGS.chartRefreshMs = 10_000;
    get.mockRejectedValueOnce(down()).mockRejectedValueOnce(down()).mockRejectedValueOnce(down()).mockRejectedValueOnce(down())
      .mockResolvedValue(BUCKETS);
    const { result } = renderHook(() => useTelemetryBuckets(['a'], ['p'], range, 'hour', 'avg', 'all'), { wrapper: appWrapper });
    await tick(0);
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeDefined();
    await tick(9_000);
    expect(get).toHaveBeenCalledTimes(1);
    await tick(1_000);
    expect(get).toHaveBeenCalledTimes(2);
    await tick(30_000);
    expect(get).toHaveBeenCalledTimes(5);
    expect(result.current.data).toEqual(BUCKETS);
    expect(result.current.error).toBeUndefined();
    await tick(10_000);
    expect(get).toHaveBeenCalledTimes(6);
    // One outage, one report — not one per retry.
    expect(toast).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('buckets: a refused window (400) is not retried, and raises no global toast and no console error', async () => {
    SETTINGS.chartRefreshMs = 10_000;
    const refused = Object.assign(new Error('That window holds more than 1,000 hours; choose a larger bucket or a shorter window'), { status: 400 });
    get.mockRejectedValue(refused);
    const { result } = renderHook(() => useTelemetryBuckets(['a'], ['p'], range, 'hour', 'avg', 'all'), { wrapper: appWrapper });
    await tick(0);
    await tick(120_000);
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe(refused);
    expect(toast).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('buckets: the answer carries the request it answers, so a held answer can be told from the current one', async () => {
    get.mockResolvedValue(BUCKETS);
    const { result } = renderHook(() => useTelemetryBuckets(['a', 'b'], ['p', 'q'], range, 'day', 'max', 'instrument'), { wrapper: appWrapper });
    await tick(0);
    expect(result.current.request).toEqual({
      instrumentIds: ['a', 'b'], keys: ['p', 'q'], from: range.from, to: range.to, bucket: 'day', agg: 'max', groupBy: 'instrument',
    });
  });

  it('latest values (phase 1): the same policy — retried at the overview cadence until the rows come back', async () => {
    SETTINGS.overviewRefreshMs = 5_000;
    const rows = { data: [{ instrumentId: 'a', values: [] }] };
    post.mockRejectedValueOnce(down()).mockRejectedValueOnce(down()).mockRejectedValueOnce(down()).mockResolvedValue(rows);
    const { result } = renderHook(() => useLatestValues(['a'], [{ source: 'telemetry', key: 'p' }]), { wrapper: appWrapper });
    await tick(0);
    await tick(4_000);
    expect(post).toHaveBeenCalledTimes(1);
    await tick(11_000);
    expect(post).toHaveBeenCalledTimes(4);
    expect(result.current.rows).toEqual(rows.data);
    expect(result.current.error).toBeUndefined();
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('alarm counts: a refusal (403, no ALARM_READ) is not retried and is silent', async () => {
    get.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    const { result } = renderHook(() => useAlarmCounts({ directOnly: false }), { wrapper: appWrapper });
    await tick(0);
    await tick(300_000);
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeDefined();
    expect(toast).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('alarm counts and the time series table poll and retry by the same policy', async () => {
    get.mockRejectedValueOnce(down()).mockResolvedValue(COUNTS);
    const counts = renderHook(() => useAlarmCounts({ directOnly: false }), { wrapper: appWrapper });
    await tick(0);
    await tick(30_000);
    expect(counts.result.current.data).toEqual(COUNTS);
    counts.unmount();
    get.mockReset();
    SETTINGS.chartRefreshMs = 10_000;
    get.mockRejectedValueOnce(down()).mockRejectedValueOnce(down()).mockRejectedValueOnce(down())
      .mockResolvedValue({ data: [{ instrumentId: 'a', ts: range.from, values: {} }], total: 1 });
    const series = renderHook(() => useWidgetTimeseries(['a'], ['p'], range, 1, 25), { wrapper: appWrapper });
    await tick(0);
    await tick(30_000);
    expect(get).toHaveBeenCalledTimes(4);
    expect(series.result.current.total).toBe(1);
  });

  it('a second failure while a retry is already pending starts no second retry chain, and reports nothing more', async () => {
    SETTINGS.chartRefreshMs = 10_000;
    get.mockRejectedValue(down());
    const { result } = renderHook(() => ({
      buckets: useTelemetryBuckets(['a'], ['p'], range, 'hour', 'avg', 'all'),
      mutate: useSWRConfig().mutate,
    }), { wrapper: appWrapper });
    await tick(0);
    await tick(3_000);
    // A revalidation from elsewhere (a focus, a mutate) fails while the retry is pending.
    await act(async () => { await result.current.mutate((k) => typeof k === 'string' && k.includes('telemetry-buckets')); });
    expect(get).toHaveBeenCalledTimes(2);
    await tick(22_000);
    // t = 10 s and t = 20 s: ONE chain. A second would have fired at 13 s and 23 s.
    expect(get).toHaveBeenCalledTimes(4);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('a refresh interval of 0 never retries in a tight loop', async () => {
    SETTINGS.chartRefreshMs = 0;
    get.mockRejectedValue(down());
    renderHook(() => useTelemetryBuckets(['a'], ['p'], range, 'hour', 'avg', 'all'), { wrapper: appWrapper });
    await tick(0);
    await tick(4_000);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
