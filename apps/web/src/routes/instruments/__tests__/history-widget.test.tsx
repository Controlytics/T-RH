import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Instrument History widget (2026-09-05) — the body of the Data Report page
 * since 2026-09-07, after a day on the Instruments page and two on the
 * dashboard.
 *
 * Two instruments in one Area with DIFFERENT limits, so "judged with its own
 * instrument's bounds" is a discriminating assertion: the same reading is a
 * breach on one row and in-limit on the next. The download is NOT here any
 * more: it is the Generate Data Report card's (2026-09-07), asserted in
 * `data-report/__tests__/generate-report-card.test.tsx`.
 */

const tree = [{ id: 'b1', name: 'CWH Block', children: [{ id: 'a1', name: 'QC 3' }, { id: 'a2', name: 'Stability' }] }];
const instruments = [
  { id: '11111111-1111-4111-8111-111111111111', code: 'CWH/RDU/001-00', name: 'CWH/RDU/001-00', functionalLocationId: 'a1' },
  { id: '22222222-2222-4222-8222-222222222222', code: 'CWH/RDU/002-00', name: 'CWH/RDU/002-00', functionalLocationId: 'a1' },
];
const [A, B] = instruments;
const overview = [
  {
    instrumentId: A.id, code: A.code, name: A.code, isActive: true, room: null,
    functionalLocationName: 'QC 3', locationAttribute: 'LCMS Room-I',
    limits: { tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 }, limitSource: 'INSTRUMENT',
    temperature: { key: 'temperature', value: 26, ts: '2026-08-24T00:20:00.000Z' },
    humidity: { key: 'humidity', value: 45, ts: '2026-08-24T00:20:00.000Z' },
    decimals: { temperature: 1, humidity: 0 }, reporting: true, status: 'OUT_OF_SPEC',
    rangeBounds: { temperatureLow: -10, temperatureHigh: 50, humidityLow: 0, humidityHigh: 100 },
  },
  {
    instrumentId: B.id, code: B.code, name: B.code, isActive: true, room: null,
    functionalLocationName: 'QC 3', locationAttribute: 'LCMS Room-II',
    limits: { tempMin: 18, tempMax: 30, rhMin: 30, rhMax: 60 }, limitSource: 'INSTRUMENT',
    temperature: { key: 'temperature', value: 26, ts: '2026-08-24T00:20:00.000Z' },
    humidity: { key: 'humidity', value: 45, ts: '2026-08-24T00:20:00.000Z' },
    decimals: { temperature: 1, humidity: 0 }, reporting: true, status: 'OK',
    rangeBounds: { temperatureLow: -10, temperatureHigh: 50, humidityLow: 0, humidityHigh: 100 },
  },
];
// The merged history the endpoint returns, newest first.
const historyRows = [
  { instrumentId: A.id, ts: '2026-08-24T00:20:00.000Z', values: { temperature: 26, humidity: 45 } },
  { instrumentId: B.id, ts: '2026-08-24T00:20:00.000Z', values: { temperature: 26, humidity: 45 } },
  { instrumentId: A.id, ts: '2026-08-24T00:10:00.000Z', values: { temperature: 'NA', humidity: 120 } },
];
// One instrument's readings for the report path.
const longHistory = [
  { key: 'temperature', value: 26, ts: '2026-08-24T00:20:00.000Z' },
  { key: 'humidity', value: 45, ts: '2026-08-24T00:20:00.000Z' },
];

/** Every URL asked for, in order. */
const requested: string[] = [];
/** When set, the history endpoint reports this whole-period total instead of the page's row count. */
let historyTotalOverride: number | null = null;
/** The administered date/time settings; `{}` = the browser's zone (no timezone set). */
let datetimeConfig: Record<string, string> = {};

function dataFor(key: string | null): any {
  if (!key) return undefined;
  requested.push(key);
  if (key.includes('/telemetry-overview')) return { data: overview };
  if (key.includes('/telemetry-history?')) {
    const ids = new URLSearchParams(key.split('?')[1]).get('instrumentIds')!.split(',');
    const rows = historyRows.filter((r) => ids.includes(r.instrumentId));
    return { data: rows, total: historyTotalOverride ?? rows.length };
  }
  if (key.includes('/telemetry?')) {
    return { latest: [], history: longHistory, historyTotal: longHistory.length, summaries: { temperature: { min: 26, max: 26 }, humidity: { min: 45, max: 45 } } };
  }
  if (key.includes('/api/functional-locations')) return { data: tree };
  if (key.startsWith('/api/instruments?')) {
    const scope = new URLSearchParams(key.split('?')[1]).get('functionalLocationId');
    return { data: scope === 'a2' ? [] : instruments, total: scope === 'a2' ? 0 : 2 };
  }
  if (key.includes('action-reauth/my-actions')) return { actions: [] };
  if (key === '/api/config/datetime/current') return datetimeConfig;
  return {};
}

vi.mock('swr', () => ({
  default: (key: any) => ({ data: dataFor(typeof key === 'function' ? key() : key), isLoading: false, error: undefined }),
}));
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: vi.fn(async (url: string) => dataFor(url)),
    post: vi.fn(async () => ({})),
    postWithReauth: vi.fn(async () => ({})),
  },
}));

const { InstrumentHistoryWidget } = await import('../history-widget');
const { useHistoryScope } = await import('@/routes/data-report/use-history-scope');
const FIXED = '?from=2026-08-24T00%3A00%3A00.000Z&to=2026-08-24T01%3A00%3A00.000Z&label=Custom';

/** The page owns the selection (`useHistoryScope`) and hands it to the widget
 *  and the Generate Data Report card alike; the widget is rendered here the way
 *  the page renders it. */
function Harness() {
  const scope = useHistoryScope();
  return <InstrumentHistoryWidget scope={scope} />;
}

function renderWidget(query = FIXED) {
  return render(
    <MemoryRouter initialEntries={[`/data-report${query}`]}>
      <Harness />
    </MemoryRouter>,
  );
}

function pickArea() {
  fireEvent.change(screen.getByLabelText('Block'), { target: { value: 'b1' } });
  fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'a1' } });
}

describe('InstrumentHistoryWidget', () => {
  beforeEach(() => { requested.length = 0; });

  it('offers the Blocks, then the chosen Block\'s Areas, and asks the list route for the scope', () => {
    renderWidget();
    expect(within(screen.getByLabelText('Block')).getByText('CWH Block')).toBeInTheDocument();
    expect(screen.getByLabelText('Area')).toBeDisabled();
    pickArea();
    expect(within(screen.getByLabelText('Area')).getByText('Stability')).toBeInTheDocument();
    expect(requested.some((u) => u.startsWith('/api/instruments?') && u.includes('functionalLocationId=a1'))).toBe(true);
  });

  it('prints no heading and no download of its own — the page header names the screen, the card downloads', () => {
    // On the dashboard the PanelCard owned the heading (an `embedded` flag
    // suppressed the widget's); on the Data Report page the PageHeader does.
    // The download moved to the Generate Data Report card on 2026-09-07 so the
    // page has ONE trigger; a second icon here would be the same report twice.
    renderWidget();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export as PDF' })).toBeNull();
    expect(screen.getByLabelText('Block')).toBeInTheDocument();
    expect(screen.getByLabelText('Area')).toBeInTheDocument();
    expect(screen.getByLabelText('History interval')).toBeInTheDocument();
  });

  it('selects NOTHING until a Block or Area is chosen — no plant-wide query on page load', () => {
    renderWidget();
    expect(screen.getByTestId('history-selection-count')).toHaveTextContent('0 of 2 selected');
    expect(requested.some((u) => u.includes('/telemetry-history?'))).toBe(false);
    expect(screen.getByText('Select at least one instrument.')).toBeInTheDocument();
    // Ticking one by hand still works without a scope.
    fireEvent.click(screen.getByLabelText(A.code));
    expect(screen.getByTestId('history-selection-count')).toHaveTextContent('1 of 2 selected');
    expect(requested.some((u) => u.includes('/telemetry-history?'))).toBe(true);
  });

  it('selects every instrument in scope until one is unticked, and narrows the history request to the ticked ones', async () => {
    renderWidget();
    pickArea();
    expect(screen.getByTestId('history-selection-count')).toHaveTextContent('2 of 2 selected');
    let hist = requested.filter((u) => u.includes('/telemetry-history?')).pop()!;
    expect(new URLSearchParams(hist.split('?')[1]).get('instrumentIds')).toBe(`${A.id},${B.id}`);

    fireEvent.click(screen.getByLabelText(B.code));
    expect(screen.getByTestId('history-selection-count')).toHaveTextContent('1 of 2 selected');
    hist = requested.filter((u) => u.includes('/telemetry-history?')).pop()!;
    expect(new URLSearchParams(hist.split('?')[1]).get('instrumentIds')).toBe(A.id);
  });

  it('judges each row with ITS OWN instrument\'s limits', () => {
    renderWidget();
    pickArea();
    const rows = screen.getAllByTestId('history-row');
    // Same 26.0 °C: a breach on A (NMT 25), in limit on B (NMT 30).
    const values = (row: HTMLElement) => within(row).getAllByTestId('history-value');
    expect(values(rows[0])[0]).toHaveAttribute('data-tone', 'out');
    expect(values(rows[0])[0]).toHaveTextContent('26.0');
    expect(values(rows[1])[0]).toHaveAttribute('data-tone', 'in');
    expect(rows[0]).toHaveAttribute('data-tone', 'out');
    expect(rows[1]).toHaveAttribute('data-tone', 'in');
  });

  it('prints the administered fault words — Error for a non-numeric reading, OL for one outside the span', () => {
    renderWidget();
    pickArea();
    const third = screen.getAllByTestId('history-row')[2];
    const [temp, rh] = within(third).getAllByTestId('history-value');
    expect(temp).toHaveTextContent('Error');
    expect(temp).toHaveAttribute('data-tone', 'fault');
    expect(rh).toHaveTextContent('OL');
    expect(third).toHaveAttribute('data-tone', 'fault');
  });

  /**
   * The chips (2026-09-16 restyle; the four summary tiles that shipped with
   * it went the same day — operator: "remove counts cards and all instruments
   * should be display directly, i dont need scroll option"). A chip is a real
   * checkbox, so the selection rules and the label-click tests above still
   * hold; and the chip list is NOT a scroll box — every instrument in scope is
   * on screen at once.
   */
  describe('chips (2026-09-16)', () => {
    it('shows no summary tiles', () => {
      renderWidget();
      pickArea();
      for (const id of ['history-tile-instruments', 'history-tile-period', 'history-tile-readings', 'history-tile-interval']) {
        expect(screen.queryByTestId(id)).toBeNull();
      }
    });

    it('lists every instrument in scope without a scroll box', () => {
      renderWidget();
      pickArea();
      const chips = screen.getAllByTestId('history-chip');
      expect(chips).toHaveLength(2);
      const list = chips[0].parentElement!;
      expect(list.className).not.toMatch(/max-h|overflow-y/);
    });

    it('a chip is filled while ticked and outlined once unticked', () => {
      renderWidget();
      pickArea();
      const chipOf = (code: string) => screen.getByLabelText(code).closest('[data-testid="history-chip"]')!;
      expect(chipOf(A.code)).toHaveAttribute('data-checked', 'true');
      fireEvent.click(screen.getByLabelText(A.code));
      expect(chipOf(A.code)).toHaveAttribute('data-checked', 'false');
      expect(chipOf(B.code)).toHaveAttribute('data-checked', 'true');
    });
  });

  /**
   * Full screen (2026-09-16, operator: "make data report widget into full
   * screen"): the trend chart card's pattern — a toggle in the toolbar, the
   * section becomes a fixed full-viewport overlay, Escape leaves it. A fixed
   * overlay with no keyboard way out is a trap for anyone not using a mouse.
   */
  describe('full screen', () => {
    it('toggles the widget into a full-viewport overlay and back, and Escape leaves it', () => {
      renderWidget();
      const widget = screen.getByTestId('history-widget');
      const btn = screen.getByRole('button', { name: 'Fullscreen — Data Report' });
      expect(btn).toHaveAttribute('aria-pressed', 'false');
      expect(widget.className).not.toMatch(/fixed/);
      fireEvent.click(btn);
      expect(widget.className).toMatch(/fixed inset-0/);
      expect(screen.getByRole('button', { name: 'Exit fullscreen — Data Report' })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(widget.className).not.toMatch(/fixed/);
      expect(screen.getByRole('button', { name: 'Fullscreen — Data Report' })).toBeInTheDocument();
    });
  });

  it('says so when the scope holds no instruments', () => {
    renderWidget();
    fireEvent.change(screen.getByLabelText('Block'), { target: { value: 'b1' } });
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'a2' } });
    expect(screen.getByText('No instruments in this scope.')).toBeInTheDocument();
    expect(screen.getByText('Select at least one instrument.')).toBeInTheDocument();
  });
});

/**
 * Audit 2026-10-12, finding 11. The From / To pickers read and showed the
 * BROWSER's zone; every time printed beside them is in the configured one.
 * New York, because this host is IST and the default would hide the defect.
 */
describe('InstrumentHistoryWidget — the period pickers use the configured timezone', () => {
  afterEach(() => { datetimeConfig = {}; });

  it('shows the period in New York time and reads what is typed as New York time', async () => {
    datetimeConfig = { dateFormat: 'DD/MM/YYYY', timeFormat: '24-hour', timezone: 'America/New_York' };
    renderWidget();
    pickArea();
    const from = screen.getByLabelText('History from');
    expect(from).toHaveValue('2026-08-23T20:00');
    expect(screen.getByLabelText('History to')).toHaveValue('2026-08-23T21:00');
    fireEvent.change(from, { target: { value: '2026-08-23T19:00' } });
    await waitFor(() => expect(screen.getByLabelText('History from')).toHaveValue('2026-08-23T19:00'));
    const hist = requested.filter((k) => k.includes('/telemetry-history?')).at(-1)!;
    expect(new URLSearchParams(hist.split('?')[1]).get('from')).toBe('2026-08-23T23:00:00.000Z');
  });
});
