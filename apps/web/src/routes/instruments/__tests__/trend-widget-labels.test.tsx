import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { TREND_WIDGET_LABEL_DEFAULT, resolveTrendWidgetTexts } from '@digilog/shared';

/**
 * The administered wording, mounted through the REAL page.
 *
 * Every per-widget suite proves a widget renders the words it is handed. None of
 * them can prove the PAGE hands each widget the right ones — and that is a
 * distinct defect with a distinct failure: the temperature card wearing the
 * humidity card's title. Both would still render, both would look deliberate,
 * and no component test would notice. The two cards and the two charts are each
 * ONE component rendered TWICE, which is exactly the shape that invites it.
 *
 * So every label here is given a DIFFERENT value, and each is asserted in its own
 * place. A wiring that crossed two of them fails.
 *
 * NOT VERIFIED HERE: what any of it looks like. Read out of the DOM, not seen.
 */

const overviewRow = {
  instrumentId: 'i-1', code: 'DEMO-TH-142', name: 'Demo', isActive: true, room: null,
  limits: { tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 },
  limitSource: 'INSTRUMENT',
  temperature: { key: 'temperature', value: 22.5, ts: '2026-08-24T00:20:00.000Z' },
  humidity: { key: 'humidity', value: 45.3, ts: '2026-08-24T00:20:00.000Z' },
  decimals: { temperature: 1, humidity: 1 }, reporting: true, status: 'OK',
};

const history = [
  { key: 'temperature', value: 22.5, ts: '2026-08-24T00:20:00.000Z', slot: 'temperature', decimals: 1 },
  { key: 'humidity', value: 45.3, ts: '2026-08-24T00:20:00.000Z', slot: 'humidity', decimals: 1 },
];

/** Six distinguishable renames — one per widget, plus the headings that would
 *  betray a crossed wire inside the two tables. */
const RENAMES = {
  tempCardTitle: 'Chamber Temp',
  humidCardTitle: 'Chamber RH',
  tempChartTitle: 'Temp Over Time',
  humidChartTitle: 'RH Over Time',
  timeseriesTitle: 'Raw Log',
  timeseriesSubtitle: 'Every stored reading',
  timeseriesTimestampHeading: 'Recorded at',
  alarmsTitle: 'Excursions',
  alarmsStatusHeading: 'State',
};

/** Flipped per test: nothing administered, or every rename above. */
let administered = false;

function dataFor(key: string | null): any {
  if (!key) return undefined;
  if (key.includes('/config/trend-widgets/current')) {
    return resolveTrendWidgetTexts(administered ? RENAMES : {});
  }
  if (key.includes('/telemetry-overview')) return { data: [overviewRow] };
  if (key.includes('/telemetry-keys')) return { data: [] };
  if (key.includes('/telemetry?')) return { latest: [], history, historyTotal: history.length, summaries: {} };
  if (key.includes('/api/alarms')) return { data: [] };
  if (key.includes('action-reauth/my-actions')) return { actions: [] };
  if (key.startsWith('/api/instruments/')) return { id: 'i-1', code: 'DEMO-TH-142', name: 'Demo' };
  return {};
}

vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));
// Not a SUPER_ADMIN: this suite is about the WORDING, and the pencil's own gate
// is proven in `widget-settings-button.test.tsx`. Rendering it here would put six
// "Edit … labels" buttons into every accessible-name query below.
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { role: 'OPERATOR' } }) }));

vi.mock('swr', () => ({
  default: (key: any) => ({
    data: dataFor(typeof key === 'function' ? key() : key),
    isLoading: false,
    error: undefined,
    mutate: vi.fn(),
  }),
}));

vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: vi.fn(async (url: string) => dataFor(url)),
    post: vi.fn(async () => ({})),
    postWithReauth: vi.fn(async () => ({})),
  },
}));

const { InstrumentTrend } = await import('../trend');

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/instruments/i-1/trend?from=2026-08-24T00:00:00.000Z&to=2026-08-24T01:00:00.000Z&label=Custom']}>
      <Routes><Route path="/instruments/:id/trend" element={<InstrumentTrend />} /></Routes>
    </MemoryRouter>,
  );
}

describe('trend page — administered widget wording', () => {
  it('shows the SHIPPED wording when nothing is administered', () => {
    administered = false;
    renderPage();
    for (const key of [
      'tempCardTitle', 'humidCardTitle', 'tempChartTitle', 'humidChartTitle',
      'timeseriesTitle', 'timeseriesSubtitle', 'alarmsTitle',
    ] as const) {
      expect(screen.getAllByText(TREND_WIDGET_LABEL_DEFAULT[key]).length, key).toBeGreaterThan(0);
    }
  });

  it('gives each widget its OWN administered wording', () => {
    administered = true;
    renderPage();
    // Each name appears where it belongs. Distinct values throughout, so a page
    // that fed the humidity card the temperature title fails on the missing one.
    for (const [key, text] of Object.entries(RENAMES)) {
      expect(screen.getAllByText(text).length, key).toBeGreaterThan(0);
    }
  });

  it('does NOT leave a shipped title behind after a rename', () => {
    // Presence alone would pass against a page rendering BOTH — the old title in
    // one widget and the new one in another.
    administered = true;
    renderPage();
    expect(screen.queryByText(TREND_WIDGET_LABEL_DEFAULT.tempChartTitle)).toBeNull();
    expect(screen.queryByText(TREND_WIDGET_LABEL_DEFAULT.humidChartTitle)).toBeNull();
    expect(screen.queryByText(TREND_WIDGET_LABEL_DEFAULT.timeseriesTitle)).toBeNull();
    expect(screen.queryByText(TREND_WIDGET_LABEL_DEFAULT.alarmsTitle)).toBeNull();
  });

  it('hides the edit pencil from a non-SUPER_ADMIN on the real page', () => {
    // The page-level half of the gate proven in `widget-settings-button.test.tsx`:
    // six pencils are wired in here, and none of them may reach an operator.
    administered = false;
    renderPage();
    expect(screen.queryAllByRole('button', { name: /Edit .* labels/ })).toHaveLength(0);
  });
});
