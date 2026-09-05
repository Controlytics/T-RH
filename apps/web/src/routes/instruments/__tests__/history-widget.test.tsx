import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Instruments page's history widget (2026-09-05).
 *
 * Two instruments in one Area with DIFFERENT limits, so "judged with its own
 * instrument's bounds" is a discriminating assertion: the same reading is a
 * breach on one row and in-limit on the next. The download is asserted the way
 * `trend-downloads.test.tsx` asserts the trend page's: the audit row is written
 * BEFORE the file is saved, once, naming the report.
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

function dataFor(key: string | null): any {
  if (!key) return undefined;
  requested.push(key);
  if (key.includes('/telemetry-overview')) return { data: overview };
  if (key.includes('/telemetry-history?')) {
    const ids = new URLSearchParams(key.split('?')[1]).get('instrumentIds')!.split(',');
    const rows = historyRows.filter((r) => ids.includes(r.instrumentId));
    return { data: rows, total: rows.length };
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
const events: string[] = [];
const logged: any[] = [];
vi.mock('@/lib/report-export-log', () => ({
  logReportExport: vi.fn(async (input: any) => { logged.push(input); events.push(`log:${input.reportType}`); }),
}));

const { InstrumentHistoryWidget } = await import('../history-widget');
const jspdf: any = await import('jspdf');
const saved: string[] = [];
let lastPdf = '';
jspdf.default.API.save = function (this: any, name: string) {
  saved.push(name);
  events.push(`save:${name}`);
  const raw: string = (this.internal.pages as string[][]).filter(Boolean).flat().join('\n');
  lastPdf = [...raw.matchAll(/\((.*?)\)\s*Tj/gs)].map((m) => m[1].replace(/\\([()\\])/g, '$1')).join(' ');
  return this;
};

const FIXED = '?from=2026-08-24T00%3A00%3A00.000Z&to=2026-08-24T01%3A00%3A00.000Z&label=Custom';

function renderWidget(query = FIXED, embedded = false) {
  return render(
    <MemoryRouter initialEntries={[`/dashboard${query}`]}>
      <InstrumentHistoryWidget embedded={embedded} />
    </MemoryRouter>,
  );
}

function pickArea() {
  fireEvent.change(screen.getByLabelText('Block'), { target: { value: 'b1' } });
  fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'a1' } });
}

describe('InstrumentHistoryWidget', () => {
  beforeEach(() => { requested.length = 0; events.length = 0; logged.length = 0; saved.length = 0; lastPdf = ''; });

  it('offers the Blocks, then the chosen Block\'s Areas, and asks the list route for the scope', () => {
    renderWidget();
    expect(within(screen.getByLabelText('Block')).getByText('CWH Block')).toBeInTheDocument();
    expect(screen.getByLabelText('Area')).toBeDisabled();
    pickArea();
    expect(within(screen.getByLabelText('Area')).getByText('Stability')).toBeInTheDocument();
    expect(requested.some((u) => u.startsWith('/api/instruments?') && u.includes('functionalLocationId=a1'))).toBe(true);
  });

  it('embedded in a dashboard panel, leaves the title to the card and keeps its controls', () => {
    // The PanelCard owns the heading; the widget must not print a second one.
    // Rendered bare (no toolbar slot), the controls fall back to an inline row.
    renderWidget(FIXED, true);
    expect(screen.queryByRole('heading', { name: 'Instrument History' })).toBeNull();
    expect(screen.getByLabelText('Block')).toBeInTheDocument();
    expect(screen.getByLabelText('History interval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export as PDF' })).toBeInTheDocument();
    // Standalone, the heading IS printed.
    renderWidget(FIXED, false);
    expect(screen.getByRole('heading', { name: 'Instrument History' })).toBeInTheDocument();
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

  it('says so when the scope holds no instruments', () => {
    renderWidget();
    fireEvent.change(screen.getByLabelText('Block'), { target: { value: 'b1' } });
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'a2' } });
    expect(screen.getByText('No instruments in this scope.')).toBeInTheDocument();
    expect(screen.getByText('Select at least one instrument.')).toBeInTheDocument();
  });

  it('downloads ONE report for the selection, reading each instrument, writing the audit row before the file', async () => {
    renderWidget();
    pickArea();
    fireEvent.click(screen.getByRole('button', { name: 'Export as PDF' }));
    // The dialog offers the interval for this report (its own control, apart
    // from the widget's "Interval" selector above it), seeded from the page.
    const dialogInterval = document.getElementById('report-download-interval') as HTMLSelectElement | null;
    expect(dialogInterval).not.toBeNull();
    expect(dialogInterval!.value).toBe('');
    fireEvent.change(screen.getByLabelText(/Remarks/), { target: { value: 'area review' } });
    fireEvent.click(screen.getByText('Download'));
    await waitFor(() => expect(saved.length).toBe(1), { timeout: 5000 });

    expect(saved[0]).toMatch(/^instrument-history-/);
    expect(events).toEqual(['log:Instrument History', `save:${saved[0]}`]);
    expect(logged[0]).toMatchObject({ reportType: 'Instrument History', format: 'PDF', remarks: 'area review' });
    expect(logged[0].search).toContain(A.code);
    expect(logged[0].search).toContain(B.code);
    // Both instruments were read: a sampled call and a whole-period call each.
    const perInstrument = (id: string) => requested.filter((u) => u.includes(`/api/instruments/${id}/telemetry?`));
    expect(perInstrument(A.id).some((u) => u.includes('points='))).toBe(true);
    expect(perInstrument(A.id).some((u) => u.includes('limit='))).toBe(true);
    expect(perInstrument(B.id).some((u) => u.includes('points='))).toBe(true);
    // And the document names the cover and both instruments.
    expect(lastPdf).toContain('Instruments :');
    expect(lastPdf).toContain('CWH Block');
    expect(lastPdf).toContain('QC 3');
    expect(lastPdf).toContain(A.code);
    expect(lastPdf).toContain(B.code);
  });

  it('downloads only the ticked instruments', async () => {
    renderWidget();
    pickArea();
    fireEvent.click(screen.getByLabelText(B.code));
    fireEvent.click(screen.getByRole('button', { name: 'Export as PDF' }));
    fireEvent.change(screen.getByLabelText(/Remarks/), { target: { value: 'one probe' } });
    fireEvent.click(screen.getByText('Download'));
    await waitFor(() => expect(saved.length).toBe(1), { timeout: 5000 });
    expect(requested.some((u) => u.includes(`/api/instruments/${B.id}/telemetry?`))).toBe(false);
    expect(lastPdf).toContain(A.code);
    expect(lastPdf).not.toContain(B.code);
  });
});
