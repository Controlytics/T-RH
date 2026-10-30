import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { useTelemetryOverview } from '../use-telemetry';

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
