import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';

const get = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));
const SETTINGS = { overviewRefreshMs: 0, chartRefreshMs: 0 };
vi.mock('../../use-telemetry', async (orig) => ({
  ...(await orig<typeof import('../../use-telemetry')>()),
  useTelemetrySettings: () => SETTINGS,
}));

import { useWidgetInstrumentIds, useKeyCatalogue, useWidgetOverview } from '../use-widget-data';
import { useTelemetryOverview } from '../../use-telemetry';

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, fetcher: (u: string) => get(u) }}>{children}</SWRConfig>
);
const P = '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b';
const SOURCE = { mode: 'selection' } as const;

beforeEach(() => { get.mockReset(); get.mockResolvedValue({ data: [] }); });
// The overview hook also reads its refresh settings; only the overview itself is under test.
const overviewCalls = () => get.mock.calls.map((c) => c[0] as string).filter((u) => u.includes('telemetry-overview'));

describe('widget data over a dashboard source', () => {
  it('an empty instrument list makes no overview request', async () => {
    const { result } = renderHook(() => useWidgetInstrumentIds(SOURCE, { directOnly: false, instrumentIds: [] }), { wrapper });
    await new Promise((r) => setTimeout(r, 30));
    expect(overviewCalls()).toEqual([]);
    expect(result.current.ids).toEqual([]);
  });

  it('a profile source asks the overview by profileId', async () => {
    renderHook(() => useWidgetInstrumentIds(SOURCE, { directOnly: false, profileId: P }), { wrapper });
    await waitFor(() => expect(overviewCalls()).toHaveLength(1));
    expect(overviewCalls()[0]).toBe(`/api/instruments/telemetry-overview?profileId=${P}`);
  });

  it('a fixed list is sent comma-joined', async () => {
    renderHook(() => useWidgetInstrumentIds(SOURCE, { directOnly: false, instrumentIds: ['a', 'b'] }), { wrapper });
    await waitFor(() => expect(overviewCalls()).toHaveLength(1));
    expect(decodeURIComponent(overviewCalls()[0])).toBe('/api/instruments/telemetry-overview?instrumentIds=a,b');
  });

  it("the status widgets' overview, following the selection, is the readings table's own request", async () => {
    renderHook(() => {
      useTelemetryOverview({ functionalLocationId: 'fl-1', directOnly: true });
      return useWidgetOverview(SOURCE, { functionalLocationId: 'fl-1', directOnly: true });
    }, { wrapper });
    await waitFor(() => expect(overviewCalls().length).toBeGreaterThan(0));
    // ONE key: the table's query and the widget's are the same URL.
    expect(new Set(overviewCalls())).toEqual(new Set(['/api/instruments/telemetry-overview?functionalLocationId=fl-1&functionalLocationDirect=true']));
  });

  it("the status widgets' overview over picked instruments asks for exactly those, never the selection's", async () => {
    const { result } = renderHook(
      () => useWidgetOverview({ mode: 'instruments', ids: ['a', 'b'] }, { functionalLocationId: 'fl-1', directOnly: false, profileId: P }),
      { wrapper },
    );
    await waitFor(() => expect(overviewCalls()).toHaveLength(1));
    expect(decodeURIComponent(overviewCalls()[0])).toBe('/api/instruments/telemetry-overview?instrumentIds=a,b');
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toEqual([]);
  });

  it('a catalogue over a profile asks data-keys by profileId', async () => {
    renderHook(() => useKeyCatalogue({ profileId: P }), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get.mock.calls[0][0]).toBe(`/api/instruments/data-keys?profileId=${P}`);
  });
});
