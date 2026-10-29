import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { resolveTrendWidgetTexts, PANEL_KEYS, type LatestKeyValue } from '@digilog/shared';

/**
 * The profile's EXTRA keys on the real trend page (widget data keys phase 3).
 * Harness after `trend-widget-labels.test.tsx`; every SWR answer is a stable
 * module-level object.
 */

const overviewRow = {
  instrumentId: 'i-1', code: 'DEMO-TH-142', name: 'Demo', isActive: true, room: null,
  limits: { tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 }, limitSource: 'INSTRUMENT',
  temperature: { key: 'temperature', value: 22.5, ts: '2026-08-24T00:20:00.000Z' },
  humidity: { key: 'humidity', value: 45.3, ts: '2026-08-24T00:20:00.000Z' },
  decimals: { temperature: 1, humidity: 1 }, reporting: true, status: 'OK',
};
const HISTORY = {
  latest: [],
  history: [
    { key: 'temperature', value: 22.5, ts: '2026-08-24T00:20:00.000Z' },
    { key: 'humidity', value: 45.3, ts: '2026-08-24T00:20:00.000Z' },
    { key: 'p', value: '101.3', ts: '2026-08-24T00:20:00.000Z' },
    { key: 'p', value: 'NA', ts: '2026-08-24T00:21:00.000Z' },
  ],
  historyTotal: 4,
  summaries: { p: { count: 2, numericCount: 1, min: 101.3, max: 101.3, avg: 101.3 } },
};
const P_LATEST: LatestKeyValue = { source: 'telemetry', key: 'p', value: '101.3', ts: '2026-08-24T00:20:00.000Z', unit: null, decimals: null, display: null, judged: null };
const DP_NEVER: LatestKeyValue = { source: 'telemetry', key: 'dp', value: null, ts: null, unit: null, decimals: null, display: null, judged: null };
const LATEST = [{
  instrumentId: 'i-1', code: 'DEMO-TH-142', name: 'Demo', functionalLocationName: null, locationAttribute: null,
  reporting: true, lastSeenAt: null, values: [P_LATEST, DP_NEVER],
}];
const INST = { id: 'i-1', code: 'DEMO-TH-142', name: 'Demo', profileId: 'prof-1' };
const WITH_KEYS = { id: 'prof-1', name: 'T&RH Sensors', instrumentCount: 105, displayKeys: [
  { source: 'telemetry', key: 'p', label: 'Pressure', unit: 'kPa' },
  { source: 'telemetry', key: 'dp', label: 'Diff pressure' },
] };
const NO_KEYS = { id: 'prof-1', name: 'T&RH Sensors', instrumentCount: 105, displayKeys: [] };
const TEXTS = resolveTrendWidgetTexts({});
const OVERVIEW = { data: [overviewRow] };
const EMPTY_LIST = { data: [] };
const NO_ACTIONS = { actions: [] };
const EMPTY = {};

let profile: object = WITH_KEYS;
let myConfig: object = EMPTY;
const swrKeys: string[] = [];

function dataFor(key: unknown): unknown {
  if (!key) return undefined;
  if (Array.isArray(key)) return key[0] === 'widget-latest-values' ? LATEST : undefined;
  const k = String(key);
  swrKeys.push(k);
  if (k.includes('/config/trend-widgets/current')) return TEXTS;
  if (k.includes('/telemetry-overview')) return OVERVIEW;
  if (k.includes('/telemetry?')) return HISTORY;
  if (k.includes('/api/alarms')) return EMPTY_LIST;
  if (k.includes('action-reauth/my-actions')) return NO_ACTIONS;
  if (k.startsWith('/api/instrument-profiles/')) return profile;
  if (k === '/api/config/my-config') return myConfig;
  if (k.startsWith('/api/instruments/')) return INST;
  return EMPTY;
}

vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
const AUTH = { user: { role: 'OPERATOR' } };
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => AUTH }));
vi.mock('../display-keys-dialog', () => ({ DisplayKeysDialog: () => <div data-testid="display-keys-dialog" /> }));
const results = new Map<string, unknown>();
vi.mock('swr', () => ({
  default: (key: unknown) => {
    const k = typeof key === 'function' ? (key as () => unknown)() : key;
    const id = JSON.stringify(k);
    if (!results.has(id)) results.set(id, { data: dataFor(k), isLoading: false, error: undefined, mutate: vi.fn() });
    return results.get(id);
  },
}));
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async (u: string) => dataFor(u)), post: vi.fn(async () => ({})), postWithReauth: vi.fn(async () => ({})) },
}));

const { InstrumentTrend } = await import('../trend');

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/instruments/i-1/trend?from=2026-08-24T00:00:00.000Z&to=2026-08-24T01:00:00.000Z&label=Custom']}>
      <Routes><Route path="/instruments/:id/trend" element={<InstrumentTrend />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  results.clear();
  swrKeys.length = 0;
  profile = WITH_KEYS;
  myConfig = EMPTY;
  AUTH.user.role = 'OPERATOR';
});

describe("the trend page draws its profile's extra keys", () => {
  it('as value cards, chart cards and Time Series columns', () => {
    renderPage();
    const cards = screen.getAllByTestId('extra-key-card');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText('Pressure')).toBeTruthy();
    expect(within(cards[0]).getByText('101.3')).toBeTruthy();
    expect(within(cards[0]).getByText('Not judged')).toBeTruthy();
    // One chart card per extra key, titled by its label.
    expect(screen.getAllByText('Pressure').length).toBeGreaterThan(1);
    expect(screen.getByTestId('extra-chart-p')).toBeTruthy();
    expect(screen.getByText('1 text readings not plotted')).toBeTruthy();
    // A column per extra key, headed with its unit.
    expect(screen.getByText('Pressure (kPa)')).toBeTruthy();
    expect(screen.getAllByTestId('ts-extra-p').map((c) => c.textContent)).toEqual(expect.arrayContaining(['101.3', 'NA']));
  });

  it('a key this instrument never sent reads NA', () => {
    renderPage();
    const dp = screen.getAllByTestId('extra-key-card')[1];
    expect(within(dp).getByText('NA')).toBeTruthy();
  });

  it('no displayKeys renders the page exactly as before', () => {
    profile = NO_KEYS;
    renderPage();
    expect(screen.queryAllByTestId('extra-key-card')).toHaveLength(0);
    expect(screen.queryByTestId('extra-chart-p')).toBeNull();
    expect(screen.queryByText('Pressure (kPa)')).toBeNull();
  });

  it('the panels still govern them', () => {
    myConfig = { panels: PANEL_KEYS.filter((k) => k !== 'trend_charts') };
    renderPage();
    expect(screen.queryByTestId('extra-chart-p')).toBeNull();
    expect(screen.getAllByTestId('extra-key-card')).toHaveLength(2);
  });

  it('the page no longer asks for telemetry-keys', () => {
    renderPage();
    expect(swrKeys.some((k) => k.includes('telemetry-keys'))).toBe(false);
    expect(swrKeys).toContain('/api/instrument-profiles/prof-1');
  });

  it('the Keys pencil is shown to a SUPER_ADMIN only', () => {
    renderPage();
    expect(screen.queryByRole('button', { name: 'Keys' })).toBeNull();
  });

  it('a SUPER_ADMIN opens the Keys dialog from the pencil', async () => {
    AUTH.user.role = 'SUPER_ADMIN';
    renderPage();
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('button', { name: 'Keys' }));
    expect(screen.getByTestId('display-keys-dialog')).toBeTruthy();
  });
});
