import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { registerSwrToast, swrConfig, unregisterSwrToast } from '@/lib/swr-config';
import { useFloorplans, useTelemetryOverview } from '../use-telemetry';

/**
 * The overview's URL and its EMPTY list, with real SWR. The hook uses the global
 * fetcher, so the wrapper supplies one that records every URL it is asked.
 */
const asked: string[] = [];
const ROWS = { data: [{ instrumentId: 'i-1' }] };
const fetcher = vi.fn(async (url: string) => {
  asked.push(url);
  return url.startsWith('/api/instruments/telemetry-overview') ? ROWS : {};
});
const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, fetcher }}>{children}</SWRConfig>
);
const overviewUrls = () => asked.filter((u) => u.startsWith('/api/instruments/telemetry-overview'));

beforeEach(() => {
  asked.length = 0;
  fetcher.mockClear();
});

describe('useTelemetryOverview', () => {
  it('everything in view asks the bare route; a scope asks it with the query', async () => {
    renderHook(() => useTelemetryOverview({}), { wrapper });
    renderHook(() => useTelemetryOverview({ functionalLocationId: 'fl-1', directOnly: true }), { wrapper });
    await waitFor(() => expect(overviewUrls()).toHaveLength(2));
    expect(overviewUrls()).toContain('/api/instruments/telemetry-overview');
    expect(overviewUrls()).toContain('/api/instruments/telemetry-overview?functionalLocationId=fl-1&functionalLocationDirect=true');
  });

  it("moving to an EMPTY list reads no rows - never the previous selection's (keepPreviousData must not leak)", async () => {
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useTelemetryOverview({ instrumentIds: ids }),
      { wrapper, initialProps: { ids: ['i-1'] } },
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    rerender({ ids: [] });
    expect(result.current.rows).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(overviewUrls()).toEqual(['/api/instruments/telemetry-overview?instrumentIds=i-1']);
  });
});

/**
 * R7-11 (final fix wave): the overview — behind the readings table, the floor
 * plan, every widget's instruments and the built dashboard's count — and the
 * floor plans are on THE dashboards' polling and retry policy (`lib/polling.ts`).
 * SWR 2.4 stops polling a key that holds an error and the app gives up after two
 * retries, so these froze after an outage until the window was focused.
 */
describe('the dashboards’ retry policy (R7-11)', () => {
  const calls: string[] = [];
  let fail = 0;
  let failWith: unknown;
  const policyFetcher = vi.fn(async (url: string) => {
    if (url.startsWith('/api/config/')) return {};
    calls.push(url);
    if (fail > 0) { fail -= 1; throw failWith; }
    return url.startsWith('/api/floorplans') ? { data: [] } : ROWS;
  });
  // The APP's SWR configuration (errorRetryCount 2, the global toast and its
  // console line), so the hooks' own policy is proved to override it.
  const appWrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{
      ...swrConfig, fetcher: policyFetcher, provider: () => new Map(), dedupingInterval: 0,
      isVisible: () => true, isOnline: () => true,
    }}
    >
      {children}
    </SWRConfig>
  );
  const toast = vi.fn();
  let consoleError: MockInstance;
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const down = () => Object.assign(new Error('Internal Server Error'), { status: 500 });

  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
    fail = 0;
    failWith = undefined;
    policyFetcher.mockClear();
    toast.mockReset();
    registerSwrToast(toast);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    unregisterSwrToast();
    consoleError.mockRestore();
  });

  it('a failed overview is retried at the overview cadence (5 s) past the app’s two retries, then polling resumes; one report', async () => {
    fail = 4;
    failWith = down();
    const { result } = renderHook(() => useTelemetryOverview({}), { wrapper: appWrapper });
    await tick(0);
    expect(calls).toHaveLength(1);
    expect(result.current.error).toBeDefined();
    await tick(4_000);
    expect(calls).toHaveLength(1);
    await tick(1_000);
    expect(calls).toHaveLength(2);
    await tick(15_000);
    expect(calls).toHaveLength(5);
    expect(result.current.rows).toEqual(ROWS.data);
    expect(result.current.error).toBeUndefined();
    // Polling resumed after the outage.
    await tick(5_000);
    expect(calls).toHaveLength(6);
    // One outage, one report — not one per retry.
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('a refused overview (403) is not retried and raises no toast and no console line', async () => {
    fail = 100;
    failWith = Object.assign(new Error('Forbidden'), { status: 403 });
    const { result } = renderHook(() => useTelemetryOverview({}), { wrapper: appWrapper });
    await tick(0);
    await tick(60_000);
    expect(calls).toHaveLength(1);
    expect(result.current.error).toBe(failWith);
    expect(toast).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('the policy is spread FIRST: a hook asking for THIS request only still gets no previous rows', async () => {
    const held = renderHook(
      ({ fl }: { fl: string }) => useTelemetryOverview({ functionalLocationId: fl }, { keepPreviousData: false }),
      { wrapper: appWrapper, initialProps: { fl: 'fl-a' } },
    );
    await tick(0);
    expect(held.result.current.rows).toEqual(ROWS.data);
    // The next scope's request is in flight: nothing of the previous scope is handed back.
    policyFetcher.mockImplementationOnce(() => new Promise(() => {}));
    held.rerender({ fl: 'fl-b' });
    expect(held.result.current.rows).toEqual([]);
    expect(held.result.current.isLoading).toBe(true);
  });

  it('the floor plans are retried past two retries (at the retry interval) and never polled', async () => {
    fail = 3;
    failWith = down();
    const { result } = renderHook(() => useFloorplans(), { wrapper: appWrapper });
    await tick(0);
    expect(calls).toHaveLength(1);
    expect(result.current.error).toBeDefined();
    await tick(15_000);
    expect(calls).toHaveLength(4);
    expect(result.current.error).toBeUndefined();
    expect(result.current.plans).toEqual([]);
    // No periodic refresh once it has loaded.
    await tick(120_000);
    expect(calls).toHaveLength(4);
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
