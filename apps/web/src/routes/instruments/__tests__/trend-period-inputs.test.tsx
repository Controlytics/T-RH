import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

/**
 * Audit 2026-10-12, findings 4 and 11. The trend page put `period.from.slice(0,16)`
 * — UTC text — into its `datetime-local` From / To inputs, and read a typed
 * value back with `new Date(text)` — the BROWSER's zone. So the boxes were off
 * by the UTC offset, and every edit moved the period by it. They now show and
 * read the CONFIGURED timezone, the one every printed time on the page uses.
 * New York is configured because this host is IST (the default zone): a test in
 * the default zone could not tell browser-local from configured.
 */
const overviewRow = {
  instrumentId: 'i-1', code: 'DEMO-TH-142', name: 'Demo', isActive: true, room: null,
  functionalLocationName: 'QC 3', locationAttribute: 'LCMS Room-II',
  limits: { tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 }, limitSource: 'INSTRUMENT',
  temperature: null, humidity: null, decimals: { temperature: 1, humidity: 1 }, reporting: true, status: 'OK',
};
const DATETIME = { dateFormat: 'DD/MM/YYYY', timeFormat: '24-hour', timezone: 'America/New_York' };
const OVERVIEW = { data: [overviewRow] };
const EMPTY_LIST = { data: [] };
const TELEMETRY = { latest: [], history: [], historyTotal: 0 };
const INSTRUMENT = { id: 'i-1', code: 'DEMO-TH-142', name: 'Demo', functionalLocationId: null };
const ACTIONS = { actions: [] };
const NOTHING = {};
function dataFor(key: string | null): unknown {
  if (!key) return undefined;
  if (key === '/api/config/datetime/current') return DATETIME;
  if (key.includes('/telemetry-overview')) return OVERVIEW;
  if (key.includes('/telemetry-keys')) return EMPTY_LIST;
  if (key.includes('/telemetry?')) return TELEMETRY;
  if (key.includes('/api/alarms')) return EMPTY_LIST;
  if (key.includes('action-reauth/my-actions')) return ACTIONS;
  if (key.startsWith('/api/instruments/')) return INSTRUMENT;
  return NOTHING;
}
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('swr', () => ({
  default: (key: unknown) => ({ data: dataFor(typeof key === 'function' ? key() : (key as string | null)), isLoading: false, error: undefined }),
}));
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async (url: string) => dataFor(url)), post: vi.fn(async () => ({})), postWithReauth: vi.fn(async () => ({})) },
}));

const { InstrumentTrend } = await import('../trend');

let search = '';
function LocationProbe() {
  search = useLocation().search;
  return null;
}

describe('trend page — From / To are in the configured timezone', () => {
  it('shows the URL period as New York wall-clock time, and writes a typed time back as New York time', async () => {
    render(
      <MemoryRouter initialEntries={['/instruments/i-1/trend?from=2026-08-24T00%3A00%3A00.000Z&to=2026-08-24T06%3A00%3A00.000Z&label=Custom']}>
        <Routes><Route path="/instruments/:id/trend" element={<><InstrumentTrend /><LocationProbe /></>} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByLabelText('From')).toHaveValue('2026-08-23T20:00');
    expect(screen.getByLabelText('To')).toHaveValue('2026-08-24T02:00');

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-23T18:30' } });
    await waitFor(() => expect(new URLSearchParams(search).get('from')).toBe('2026-08-23T22:30:00.000Z'));
    expect(screen.getByLabelText('From')).toHaveValue('2026-08-23T18:30');
    // The other bound is untouched.
    expect(new URLSearchParams(search).get('to')).toBe('2026-08-24T06:00:00.000Z');
  });
});
