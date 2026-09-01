import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * The on-screen per-chart summary strip, the extra-key sampling disclosure, and
 * the three states a chart may be in — all mounted through the real page, because
 * every one of them is a WIRING defect: each individual component would pass a
 * test of its own while the page fed it the wrong number or did not render it.
 *
 * WHAT EACH GUARDS
 *
 * 1. Strip figures come from the SERVER's whole-range `summaries[key]`, never
 *    from the plotted points. The plotted series here tops out at 22.6 °C while
 *    the range's true maximum is 31.9 °C — an excursion the sampler did not
 *    draw. A strip reading "Maximum 22.6 °C" on a period that breached 25.0 is
 *    the same §11 misstatement the printed report was fixed for on 2026-08-27.
 * 2. "Current" is the latest STORED reading in the range, not a bucket mean:
 *    the page is mounted at `interval=5m` so the last plotted point is an
 *    average, and the strip must still show the stored 22.5.
 * 3. An extra-key chart discloses sampling. The server samples EVERY key on the
 *    chart path, not just the two administered slots, and until 2026-08-27 the
 *    extra-key charts were the one place in this feature that dropped readings
 *    with nothing on screen saying so.
 * 4. A chart says "No data available" ONLY about a resolved, empty range —
 *    never while loading and never while the fetch is failing. Those are
 *    "we do not know", and stating them as a fact about the record is the
 *    defect this page exists to avoid.
 *
 * NOT VERIFIED HERE: what any of it looks like. Nothing in this repo can
 * authenticate a browser against the local certificate, so the rendering has
 * been read out of the DOM, not seen.
 */

// Two readings in one 5-minute bucket, TWO in the next. The second bucket means
// to 22.7 while its LAST STORED reading is 22.9 — that gap is what makes
// "Current is a stored reading, not the last plotted point" a real assertion.
// With a single reading in the final bucket the mean would equal the reading
// and the test would pass against either implementation.
const history = [
  { key: 'temperature', value: 22.4, ts: '2026-08-24T00:10:00.000Z', slot: 'temperature', decimals: 1 },
  { key: 'temperature', value: 22.6, ts: '2026-08-24T00:11:00.000Z', slot: 'temperature', decimals: 1 },
  { key: 'temperature', value: 22.5, ts: '2026-08-24T00:20:00.000Z', slot: 'temperature', decimals: 1 },
  { key: 'temperature', value: 22.9, ts: '2026-08-24T00:21:00.000Z', slot: 'temperature', decimals: 1 },
  { key: 'humidity', value: 45.3, ts: '2026-08-24T00:20:00.000Z', slot: 'humidity', decimals: 1 },
  { key: 'co2', value: 410, ts: '2026-08-24T00:20:00.000Z', slot: null, decimals: null },
];

/** The server's aggregates over the WHOLE range — the population the sample
 *  above is drawn from. `temperature.max` is the excursion LTTB dropped. */
const summaries: Record<string, any> = {
  temperature: { count: 2500, min: 17.2, max: 31.9, avg: 22.8, first: history[0].ts, last: history[3].ts },
  humidity: { count: 2500, min: 40.0, max: 55.5, avg: 46.2, first: history[4].ts, last: history[4].ts },
  co2: { count: 2500, min: 400, max: 900, avg: 512, first: history[5].ts, last: history[5].ts },
};

const overviewRow = {
  instrumentId: 'i-1', code: 'DEMO-TH-142', name: 'Demo', isActive: true, room: null,
  limits: { tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 },
  limitSource: 'INSTRUMENT',
  temperature: { key: 'temperature', value: 22.5, ts: '2026-08-24T00:20:00.000Z' },
  humidity: { key: 'humidity', value: 45.3, ts: '2026-08-24T00:20:00.000Z' },
  decimals: { temperature: 1, humidity: 1 }, reporting: true, status: 'OK',
};

/**
 * Flipped per test to drive the chart request's own loading/error branches.
 *
 * `keepData` models SWR's real behaviour on a FAILED REVALIDATION: `data` is
 * retained from the last success while `error` is set. That combination is
 * reachable on every focus refetch and every Retry, and it is the one the error
 * card must NOT claim "could not be loaded" for.
 */
const chartState: { isLoading: boolean; error: unknown; keepData: boolean } =
  { isLoading: false, error: undefined, keepData: false };

function dataFor(key: string | null): any {
  if (!key) return undefined;
  if (key.includes('/telemetry-overview')) return { data: [overviewRow] };
  if (key.includes('/telemetry-keys')) return { data: [{ key: 'co2', slot: null, lastSeen: history[4].ts }] };
  if (key.includes('/telemetry?')) return { latest: [], history, historyTotal: history.length, summaries };
  if (key.includes('/api/alarms')) return { data: [] };
  if (key.includes('action-reauth/my-actions')) return { actions: [] };
  if (key.startsWith('/api/instruments/')) return { id: 'i-1', code: 'DEMO-TH-142', name: 'Demo' };
  return {};
}

// The trend page renders the alarms widget, which since 2026-09-01 carries the
// Acknowledge flow — so it reaches `useCan` (permission gate) and `useToast`.
// Neither has a provider in this harness; both are stubbed so these tests keep
// failing on their own subject rather than on a context they do not set up.
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));

vi.mock('swr', () => ({
  default: (key: any) => {
    const k = typeof key === 'function' ? key() : key;
    // Only the CHART request (`points=`) carries the loading/error state under
    // test — the table request must stay resolved, or a test proving the chart
    // skeleton would also be proving the table blank and could not tell them apart.
    const isChart = typeof k === 'string' && k.includes('points=');
    if (isChart && chartState.error) {
      return {
        data: chartState.keepData ? dataFor(k) : undefined,
        isLoading: false,
        error: chartState.error,
        mutate: vi.fn(),
      };
    }
    if (isChart && chartState.isLoading) return { data: undefined, isLoading: true, error: undefined, mutate: vi.fn() };
    return { data: dataFor(k), isLoading: false, error: undefined, mutate: vi.fn() };
  },
}));

vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async (url: string) => dataFor(url)), post: vi.fn(async () => ({})), postWithReauth: vi.fn(async () => ({})) },
}));

const { InstrumentTrend } = await import('../trend');

function renderPage() {
  // A 5-minute bucket, so every plotted point is a DERIVED mean and the strip
  // cannot accidentally agree with the series.
  return render(
    <MemoryRouter initialEntries={['/instruments/i-1/trend?from=2026-08-24T00:00:00.000Z&to=2026-08-24T01:00:00.000Z&label=Custom&interval=5m']}>
      <Routes><Route path="/instruments/:id/trend" element={<InstrumentTrend />} /></Routes>
    </MemoryRouter>,
  );
}

/** The strip cell following a given label, within the whole page. */
function strips(label: string): string[] {
  return screen.getAllByText(label)
    .map((el) => el.parentElement?.querySelector('dd')?.textContent ?? '')
    .filter((t) => t !== '');
}

// REMOVED 2026-09-01 with the per-chart summary strip itself (operator: drop
// Current / Minimum / Maximum / Average from the trend widgets). Three tests
// went with it, all asserting figures the page no longer prints:
//   - the server's whole-range Min/Max/Average rather than the plotted points
//   - the latest STORED reading as Current, never the last averaged point
//   - the instrument's own decimals, and humidity in its own unit
// The RULE they protected is not gone and is still enforced server-side:
// `summaries` is computed in SQL over every reading in the range, pinned by
// `apps/api/src/e2e/instrument-telemetry-range.test.ts`. What was lost here is
// only the assertion that the browser PRINTS those figures, which it no
// longer does. If a summary ever returns to this page, restore these three.

// REMOVED 2026-09-01 with the additional-keys section. Both tests were about
// a chart that no longer exists: one asserted an extra-key chart discloses its
// own sampling, the other was its discriminating control. The disclosure rule
// itself still holds for the two administered charts and is asserted by
// `SampledNote` usage in `trend-charts` coverage.

describe('trend page — chart loading and error states', () => {
  it('does not claim "No data available" while the chart request is in flight', () => {
    chartState.isLoading = true; chartState.error = undefined; chartState.keepData = false;
    renderPage();
    expect(screen.queryByText('No data available')).toBeNull();
    expect(screen.getAllByText('Loading…').length).toBeGreaterThanOrEqual(2);
  });

  it('does not claim "No data available" when the chart request failed — it offers Retry', () => {
    chartState.isLoading = false; chartState.error = new Error('network'); chartState.keepData = false;
    renderPage();
    expect(screen.queryByText('No data available')).toBeNull();
    const panels = screen.getAllByText(/These readings could not be loaded/);
    expect(panels.length).toBeGreaterThanOrEqual(2);
    expect(within(panels[0].closest('div')!.parentElement!).getByText('Retry')).toBeInTheDocument();
    chartState.error = undefined;
  });

  it('KEEPS a loaded chart when a later refresh fails, and says the refresh failed', () => {
    // SWR keeps `data` on a failed revalidation of the same key. Blanking a
    // correctly rendered chart to say "could not be loaded" would be a false
    // statement about readings that are in hand — the mirror of the "No data
    // available"-while-loading defect this page was fixed for.
    chartState.isLoading = false; chartState.error = new Error('network'); chartState.keepData = true;
    renderPage();
    expect(screen.queryByText(/These readings could not be loaded/)).toBeNull();
    expect(screen.getAllByText(/could not be refreshed/).length).toBeGreaterThanOrEqual(2);
    // The readings really are still on screen.
    //
    // Third probe for this one assertion, and the last one that should be
    // needed. It read the summary strip's Maximum until that was removed, then
    // the sampling note until that was removed too — both on 2026-09-01. Each
    // time the PROPERTY held and only the surface it was read through went
    // away, which is why the test was re-probed rather than deleted with them.
    //
    // It now reads the CHART ITSELF: `TimeSeriesChart` renders its SVG with
    // `role="img"` only when it has points to plot, so this is as close to "the
    // readings are still rendered" as the DOM gets, and there is nothing left
    // above it to remove.
    expect(screen.getAllByRole('img').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('No data available')).toBeNull();
    chartState.error = undefined; chartState.keepData = false;
  });
});
