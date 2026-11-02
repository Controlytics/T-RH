import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';
import type { CustomWidget } from '@digilog/shared';

/**
 * The report prints THE WINDOW THE WIDGET IS SHOWING (ruling T4-1, the lead's
 * check): a period picked on the widget, a zoom, the alarm table's filters —
 * each widget's body publishes what it shows, the dialog opens on it, and the
 * report's request asks exactly what the widget's last request asked. Real
 * widget bodies inside the real WidgetPanel; only the transport is mocked.
 */

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), postWithReauth: vi.fn() },
}));
vi.mock('@/hooks/use-export-options', () => ({ useExportOptions: () => ({ pdf: true, excel: true }) }));
const DIRECT = { mode: 'DIRECT', remarksRequired: false, passwordRequired: false };
const POLICY = {
  policy: { 'widget:trend_chart': DIRECT, 'widget:timeseries_table': DIRECT, 'widget:bar_chart': DIRECT, 'widget:alarm_table': DIRECT },
  error: undefined,
};
vi.mock('@/hooks/use-report-downloads', () => ({ useReportDownloads: () => POLICY }));
const OVERVIEW = { rows: [{ instrumentId: 'i1' }], isLoading: false, error: undefined };
const SETTINGS = { overviewRefreshMs: 0, chartRefreshMs: 0 };
vi.mock('../../use-telemetry', async (ia) => ({
  ...(await ia<typeof import('../../use-telemetry')>()),
  useTelemetryOverview: () => OVERVIEW,
  useTelemetrySettings: () => SETTINGS,
}));
const AUTH = { user: { role: 'OPERATOR', fullName: 'Op', username: 'op' } };
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => AUTH }));
const TOAST = { toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => TOAST }));
// What is asked is the subject, not the PDF: the builder and the delivery are stand-ins.
const delivered = vi.fn();
vi.mock('@/lib/widget-report', () => ({
  buildWidgetReport: async () => ({ report: { addNote: () => {} }, title: 't', recordCount: 0 }),
}));
vi.mock('@/lib/report-delivery', () => ({
  deliverReport: async (input: unknown) => { delivered(input); return 'DOWNLOADED'; },
  deliveryToast: () => ({ tone: 'success', title: 'ok', message: 'ok' }),
}));
vi.mock('@/routes/instruments/chart-image', () => ({ renderChartToPng: async () => null }));
// No chart drawing in jsdom; the trend chart's stand-in offers the drag-zoom the real one has.
const ZOOM = { from: '2026-10-30T06:00:00.000Z', to: '2026-10-30T09:30:00.000Z' };
vi.mock('../../time-series-chart', async (ia) => ({
  ...(await ia<typeof import('../../time-series-chart')>()),
  TimeSeriesChart: ({ onZoom }: { onZoom?: (from: Date, to: Date) => void }) => (
    <button type="button" onClick={() => onZoom?.(new Date(ZOOM.from), new Date(ZOOM.to))}>zoom</button>
  ),
}));
vi.mock('../charts/lazy-echart', () => ({
  LazyEChart: () => <div data-testid="echart" />,
  renderChartSvg: async () => '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
}));

import { WidgetPanel } from '../widget-panel';

const TEMP = { source: 'telemetry' as const, key: 'temp', label: 'Temperature' };

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  delivered.mockReset();
  post.mockImplementation(async (url: string) => {
    if (url !== '/api/instruments/latest-values') throw new Error(`unexpected POST ${url}`);
    return {
      data: [{
        instrumentId: 'i1', code: 'CWH/RDU/101-01', name: 'x', functionalLocationName: 'QC 3', locationAttribute: 'Room 4',
        reporting: true, lastSeenAt: '2026-11-02T10:00:00.000Z',
        values: [{ source: 'telemetry', key: 'temp', value: 21, ts: '2026-11-02T10:00:00.000Z', unit: '°C', decimals: 1, display: null, judged: null }],
      }],
    };
  });
  get.mockImplementation(async (url: string) => {
    const u = new URL(url, 'https://x');
    if (u.pathname === '/api/report-templates/resolve') return { sections: [{ profileId: 'p1', profileName: 'T&RH', instrumentIds: ['i1'], template: null }] };
    if (u.pathname === '/api/report-templates/catalogue') return { fields: [] };
    if (u.pathname === '/api/report-templates') return { data: [] };
    if (/^\/api\/instruments\/i1\/telemetry$/.test(u.pathname)) return { history: [], summaries: {}, historySampled: false, historyTotal: 0 };
    if (u.pathname === '/api/instruments/telemetry-history') return { data: [], total: 0 };
    if (u.pathname === '/api/instruments/telemetry-buckets') {
      return { from: u.searchParams.get('from'), to: u.searchParams.get('to'), bucket: 'hour', agg: 'avg', timezone: 'UTC', bucketSeconds: 3600, series: [] };
    }
    if (u.pathname === '/api/alarms') return { data: [], total: 0 };
    return {};
  });
});

const renderPanel = (widget: CustomWidget) => render(
  <MemoryRouter>
    {/* The alarm panel's query has no fetcher of its own (the app's global one
        answers it); here the transport answers only that one. */}
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, fetcher: (u: string) => (u.startsWith('/api/alarms?') ? get(u) : undefined) }}>
      <WidgetPanel
        widget={widget} item={{ i: widget.id, x: 0, y: 0, w: 12, h: 8 }} selection={{ directOnly: false }}
        reportHost={{ dashboard: 'Dashboard', selection: 'QC 3' }}
        editing={false} onEdit={() => {}} onRemove={() => {}} onStyleChange={() => {}} onSizeChange={() => {}}
        autoHeight={false} onNaturalHeight={() => {}}
      />
    </SWRConfig>
  </MemoryRouter>,
);

const urls = (path: string) => get.mock.calls.map((c) => String(c[0])).filter((u) => new URL(u, 'https://x').pathname === path);
const params = (url: string, names: string[]) => {
  const q = new URL(url, 'https://x').searchParams;
  return Object.fromEntries(names.map((n) => [n, q.get(n)]));
};

/** Open the widget's Download report and confirm it; resolves once the report has been delivered. */
async function downloadReport() {
  fireEvent.click(screen.getByRole('button', { name: 'Download report' }));
  await screen.findByText(/^Template:/);
  fireEvent.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
}

/** The widget asks, the viewer changes what it shows, and the report asks the same window. */
async function samePeriod(widget: CustomWidget, path: string) {
  renderPanel(widget);
  fireEvent.change(await screen.findByRole('combobox', { name: 'Period' }), { target: { value: '7d' } });
  await waitFor(() => expect(urls(path).some((u) => params(u, ['from', 'to']).from !== null)).toBe(true));
  // The widget's LAST request is the window on screen (7 days now).
  await waitFor(() => {
    const last = params(urls(path).at(-1)!, ['from', 'to']);
    expect(Date.parse(last.to!) - Date.parse(last.from!)).toBe(7 * 86_400_000);
  });
  const shown = params(urls(path).at(-1)!, ['from', 'to']);
  const before = urls(path).length;
  await downloadReport();
  const asked = urls(path).slice(before);
  expect(asked.length).toBeGreaterThan(0);
  for (const u of asked) expect(params(u, ['from', 'to'])).toEqual(shown);
  // …and the period recorded with the download is that window too.
  expect(delivered.mock.calls[0][0].requestMeta.period).toMatchObject(shown);
}

describe('the report prints the window the widget is SHOWING', () => {
  it('trend chart: a period picked on the widget', async () => {
    await samePeriod({ id: 'w-tr', type: 'trend_chart', title: 'Trend', source: { mode: 'selection' }, keys: [TEMP], options: { period: '24h' } } as CustomWidget, '/api/instruments/i1/telemetry');
  });

  it('time series table: a period picked on the widget', async () => {
    await samePeriod({ id: 'w-ts', type: 'timeseries_table', title: 'TS', source: { mode: 'selection' }, keys: [TEMP], options: { period: '24h' } } as CustomWidget, '/api/instruments/telemetry-history');
  });

  it('bar chart: a period picked on the widget', async () => {
    await samePeriod({ id: 'w-bar', type: 'bar_chart', title: 'Bars', source: { mode: 'selection' }, keys: [TEMP], options: { period: '24h' } } as CustomWidget, '/api/instruments/telemetry-buckets');
  });

  it('trend chart: a ZOOM on the widget is the report\'s window', async () => {
    renderPanel({ id: 'w-z', type: 'trend_chart', title: 'Trend', source: { mode: 'selection' }, keys: [TEMP], options: { period: '24h' } } as CustomWidget);
    fireEvent.click(await screen.findByRole('button', { name: 'zoom' }));
    await waitFor(() => expect(params(urls('/api/instruments/i1/telemetry').at(-1)!, ['from', 'to'])).toEqual(ZOOM));
    const before = urls('/api/instruments/i1/telemetry').length;
    await downloadReport();
    const asked = urls('/api/instruments/i1/telemetry').slice(before);
    expect(asked).toHaveLength(1);
    expect(params(asked[0], ['from', 'to'])).toEqual(ZOOM);
  });

  it("alarm table: the search, type and status the viewer set on the panel are the report's", async () => {
    renderPanel({ id: 'w-al', type: 'alarm_table', title: 'Alarms', source: { mode: 'selection' }, keys: [], options: {} } as CustomWidget);
    const panel = await screen.findByLabelText('Search the alarms in this selection');
    fireEvent.change(panel, { target: { value: 'QC' } });
    const typeSelect = screen.getByRole('combobox', { name: 'Filter by alarm type' }) as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: typeSelect.options[1].value } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'active-unack' } });
    const filters = ['search', 'type', 'status', 'functionalLocationId', 'instrumentIds', 'profileId'];
    await waitFor(() => expect(params(urls('/api/alarms').at(-1)!, filters)).toMatchObject({ search: 'QC', status: 'active-unack' }));
    const shown = params(urls('/api/alarms').at(-1)!, filters);
    const before = urls('/api/alarms').length;
    await downloadReport();
    const asked = urls('/api/alarms').slice(before);
    expect(asked.length).toBeGreaterThan(0);
    for (const u of asked) expect(params(u, filters)).toEqual(shown);
    expect(within(document.body).queryByRole('dialog')).toBeNull();
  });
});
