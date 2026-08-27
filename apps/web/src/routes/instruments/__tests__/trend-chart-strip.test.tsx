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

// Two readings inside one 5-minute bucket, one in the next, per key. At `5m`
// the temperature series plots two AVERAGED points (22.5 and 22.5), so nothing
// the strip prints can have come from the plotted series.
const history = [
  { key: 'temperature', value: 22.4, ts: '2026-08-24T00:10:00.000Z', slot: 'temperature', decimals: 1 },
  { key: 'temperature', value: 22.6, ts: '2026-08-24T00:11:00.000Z', slot: 'temperature', decimals: 1 },
  { key: 'temperature', value: 22.5, ts: '2026-08-24T00:20:00.000Z', slot: 'temperature', decimals: 1 },
  { key: 'humidity', value: 45.3, ts: '2026-08-24T00:20:00.000Z', slot: 'humidity', decimals: 1 },
  { key: 'co2', value: 410, ts: '2026-08-24T00:20:00.000Z', slot: null, decimals: null },
];

/** The server's aggregates over the WHOLE range — the population the sample
 *  above is drawn from. `temperature.max` is the excursion LTTB dropped. */
const summaries: Record<string, any> = {
  temperature: { count: 2500, min: 17.2, max: 31.9, avg: 22.8, first: history[0].ts, last: history[2].ts },
  humidity: { count: 2500, min: 40.0, max: 55.5, avg: 46.2, first: history[3].ts, last: history[3].ts },
  co2: { count: 2500, min: 400, max: 900, avg: 512, first: history[4].ts, last: history[4].ts },
};

const overviewRow = {
  instrumentId: 'i-1', code: 'DEMO-TH-142', name: 'Demo', isActive: true, room: null,
  limits: { tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 },
  limitSource: 'INSTRUMENT',
  temperature: { key: 'temperature', value: 22.5, ts: '2026-08-24T00:20:00.000Z' },
  humidity: { key: 'humidity', value: 45.3, ts: '2026-08-24T00:20:00.000Z' },
  decimals: { temperature: 1, humidity: 1 }, reporting: true, status: 'OK',
};

/** Flipped per test to drive the chart request's own loading/error branches. */
const chartState: { isLoading: boolean; error: unknown } = { isLoading: false, error: undefined };

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

vi.mock('swr', () => ({
  default: (key: any) => {
    const k = typeof key === 'function' ? key() : key;
    // Only the CHART request (`points=`) carries the loading/error state under
    // test — the table request must stay resolved, or a test proving the chart
    // skeleton would also be proving the table blank and could not tell them apart.
    const isChart = typeof k === 'string' && k.includes('points=');
    if (isChart && chartState.error) return { data: undefined, isLoading: false, error: chartState.error, mutate: vi.fn() };
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

describe('trend page — per-chart summary strip', () => {
  it('prints the server\'s whole-range Minimum/Maximum/Average, not the plotted points', () => {
    chartState.isLoading = false; chartState.error = undefined;
    renderPage();
    // Temperature strip first, humidity second (chart order on the page).
    expect(strips('Maximum')[0]).toBe('31.9 °C');
    expect(strips('Minimum')[0]).toBe('17.2 °C');
    expect(strips('Average')[0]).toBe('22.8 °C');
    // The whole point: the drawn series never reaches this, so a strip fed
    // from the chart would have printed 22.6 and hidden a real excursion.
    expect(strips('Maximum')[0]).not.toBe('22.6 °C');
  });

  it('shows the latest STORED reading as Current, not the last averaged point', () => {
    chartState.isLoading = false; chartState.error = undefined;
    renderPage();
    expect(strips('Current')[0]).toBe('22.5 °C');
  });

  it('renders at the instrument\'s own decimals, and humidity in its own unit', () => {
    chartState.isLoading = false; chartState.error = undefined;
    renderPage();
    expect(strips('Maximum')[1]).toBe('55.5 %RH');
  });
});

describe('trend page — extra-key charts disclose sampling', () => {
  it('says how many of the range\'s readings an extra-key chart is showing', () => {
    localStorage.setItem('digilog.trendKeys.i-1', JSON.stringify(['co2']));
    chartState.isLoading = false; chartState.error = undefined;
    renderPage();
    // Humidity and co2 each returned ONE of the range's 2,500 readings, so this
    // wording matches exactly twice. Before the fix it matched once: the
    // extra-key chart plotted its single sampled point and said nothing.
    // (Temperature returned three, and carries its own "Showing 3 of 2,500".)
    expect(screen.getAllByText(/Showing 1 of 2,500 readings/)).toHaveLength(2);
    expect(screen.getAllByText(/Showing 3 of 2,500 readings/)).toHaveLength(1);
    localStorage.clear();
  });

  it('and without the extra key that same wording appears only once', () => {
    // The discriminating half: proves the count above moved BECAUSE of the
    // extra-key chart, not because the two administered charts render twice.
    localStorage.clear();
    chartState.isLoading = false; chartState.error = undefined;
    renderPage();
    expect(screen.getAllByText(/Showing 1 of 2,500 readings/)).toHaveLength(1);
  });
});

describe('trend page — chart loading and error states', () => {
  it('does not claim "No data available" while the chart request is in flight', () => {
    chartState.isLoading = true; chartState.error = undefined;
    renderPage();
    expect(screen.queryByText('No data available')).toBeNull();
    expect(screen.getAllByText('Loading…').length).toBeGreaterThanOrEqual(2);
  });

  it('does not claim "No data available" when the chart request failed — it offers Retry', () => {
    chartState.isLoading = false; chartState.error = new Error('network');
    renderPage();
    expect(screen.queryByText('No data available')).toBeNull();
    const panels = screen.getAllByText(/These readings could not be loaded/);
    expect(panels.length).toBeGreaterThanOrEqual(2);
    expect(within(panels[0].closest('div')!.parentElement!).getByText('Retry')).toBeInTheDocument();
    chartState.error = undefined;
  });
});
