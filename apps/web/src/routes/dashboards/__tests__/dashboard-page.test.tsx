import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SWRConfig } from 'swr';
import type { CustomWidget, DashboardDetail, LatestValuesRow } from '@digilog/shared';

/**
 * One built dashboard's page (2026-10-29, dashboard builder phase 1).
 *
 * REAL SWR over a mocked `apiClient`: every request the page and its widgets
 * make is a call this file can see, and a refusal is a real rejected request
 * (the 404 that makes `notFound`, the 403 one widget gets). Mocked only where
 * the subject is not: the widget DIALOG (its own tests drive it), the chart
 * drawing, the container measurement jsdom cannot do, the toast and the
 * re-auth prompt (a pass-through that records the action).
 * NOT VERIFIED HERE: how it looks (concept-c-dashboard.png).
 */

vi.mock('react-grid-layout', async (importActual) => ({
  ...(await importActual<typeof import('react-grid-layout')>()),
  // jsdom measures nothing; the grid renders nothing at width 0.
  useContainerWidth: () => ({ width: 1240, mounted: true, containerRef: { current: null } }),
}));
class StubResizeObserver { observe() {} disconnect() {} unobserve() {} }

const AUTH: { user: { role: string } } = { user: { role: 'SUPER_ADMIN' } };
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => AUTH }));
const TOAST = { toast: { success: vi.fn(), error: vi.fn() } };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => TOAST }));
const reauthActions: string[] = [];
const REAUTH = {
  execute: async (
    action: string,
    cb: (p?: string) => Promise<void>,
    opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void },
  ) => {
    reauthActions.push(action);
    try { await cb(); opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
  },
  isOpen: false, password: '', error: '', isVerifying: false,
  setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
};
vi.mock('@/hooks/use-reauth', () => ({ useReauth: () => REAUTH }));

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    putWithReauth: vi.fn(), postWithReauth: vi.fn(), delete: vi.fn(), deleteWithReauth: vi.fn(),
  },
}));

// The widget dialog has its own tests; here it is a button that submits one
// fixed value-cards widget, and records the wording it was given.
const NEW_ID = '22222222-2222-4222-8222-000000000009';
const NEW_WIDGET: CustomWidget = {
  id: NEW_ID, type: 'value_cards', title: 'Freshly added', source: { mode: 'selection' },
  keys: [{ source: 'telemetry', key: 't' }], options: {},
};
vi.mock('@/routes/dashboard/widgets/widget-dialog', () => ({
  WidgetDialog: (p: { followLabel?: string; onSubmit: (w: CustomWidget) => void; onCancel: () => void }) => (
    <div data-testid="widget-dialog" data-follow={p.followLabel}>
      <button type="button" onClick={() => p.onSubmit(NEW_WIDGET)}>Submit widget</button>
    </div>
  ),
}));
vi.mock('@/routes/dashboard/time-series-chart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/routes/dashboard/time-series-chart')>()),
  TimeSeriesChart: () => <div data-testid="chart" />,
}));
// One widget title draws a renderer that THROWS, to prove the page survives it.
vi.mock('@/routes/dashboard/widgets/value-cards-widget', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/routes/dashboard/widgets/value-cards-widget')>();
  return {
    ValueCardsWidget: (p: { widget: CustomWidget }) => {
      if (p.widget.title === 'Explodes') throw new Error('renderer fault');
      return <actual.ValueCardsWidget {...(p as Parameters<typeof actual.ValueCardsWidget>[0])} />;
    },
  };
});

const { DashboardPage } = await import('../dashboard-page');

// ── Fixtures: module-level constants (a fresh object per call re-runs effects). ──
const ID = '33333333-3333-4333-8333-000000000001';
const PROFILE = '44444444-4444-4444-8444-000000000001';
const INST = '55555555-5555-4555-8555-000000000001';
const W_CARDS = '11111111-1111-4111-8111-000000000001';
const W_TREND = '11111111-1111-4111-8111-000000000002';
const W_DENIED = '11111111-1111-4111-8111-000000000003';
const W_BOOM = '11111111-1111-4111-8111-000000000004';

const cards = (id: string, title: string, key = 't'): CustomWidget => ({
  id, type: 'value_cards', title, source: { mode: 'selection' }, keys: [{ source: 'telemetry', key }], options: {},
});
const TREND: CustomWidget = {
  id: W_TREND, type: 'trend_chart', title: 'Room trend', source: { mode: 'selection' },
  keys: [{ source: 'telemetry', key: 't' }], options: {},
};

const detail = (
  over: Partial<Omit<DashboardDetail, 'document'>> & { document?: Partial<DashboardDetail['document']> } = {},
): DashboardDetail => {
  const { document, ...rest } = over;
  return {
    id: ID, title: 'QC Block — Room Conditions', description: 'Dissolution rooms',
    sourceSummary: { mode: 'profile', label: 'Pressure Sensors' }, widgetCount: 2,
    updatedAt: '2026-10-29T10:00:00.000Z',
    ...rest,
    document: {
      version: 1,
      source: { mode: 'profile', profileId: PROFILE },
      timeWindow: { mode: 'relative', period: '24h' },
      items: [{ i: `w:${W_CARDS}`, x: 0, y: 0, w: 6, h: 5 }, { i: `w:${W_TREND}`, x: 6, y: 0, w: 6, h: 9 }],
      widgets: [cards(W_CARDS, 'Room cards'), TREND],
      ...document,
    },
  };
};
const DETAIL = detail();
const DETAIL_V2 = detail({ updatedAt: '2026-10-29T11:30:00.000Z' });
const DETAIL_NULL_SOURCE = detail({
  sourceSummary: { mode: 'unreadable', label: 'Unreadable' },
  document: { source: null },
});
const DETAIL_EMPTY = detail({ widgetCount: 0, document: { items: [], widgets: [] } });
const DETAIL_DENIED = detail({
  document: {
    items: [{ i: `w:${W_CARDS}`, x: 0, y: 0, w: 6, h: 5 }, { i: `w:${W_DENIED}`, x: 6, y: 0, w: 6, h: 5 }],
    widgets: [cards(W_CARDS, 'Room cards'), cards(W_DENIED, 'Forbidden cards', 'denied')],
  },
});
const DETAIL_BOOM = detail({
  document: {
    items: [{ i: `w:${W_CARDS}`, x: 0, y: 0, w: 6, h: 5 }, { i: `w:${W_BOOM}`, x: 6, y: 0, w: 6, h: 5 }],
    widgets: [cards(W_CARDS, 'Room cards'), cards(W_BOOM, 'Explodes')],
  },
});

const OVERVIEW = { data: [{ instrumentId: INST }] };
const LATEST: { data: LatestValuesRow[] } = {
  data: [{
    instrumentId: INST, code: 'CWH/RDU/014-00', name: 'x', functionalLocationName: 'QC', locationAttribute: 'Dissolution Room-II',
    reporting: true, lastSeenAt: '2026-10-29T09:59:00.000Z',
    values: [{
      source: 'telemetry', key: 't', value: 21.46, ts: '2026-10-29T09:59:00.000Z', unit: '°C', decimals: 1, display: null,
      judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false },
    }],
  }],
};
const HISTORY = {
  history: [{ key: 't', value: 21.4, ts: '2026-10-29T09:00:00.000Z' }],
  summaries: { t: { count: 1, numericCount: 1, min: 21.4, max: 21.4, avg: 21.4 } },
  historySampled: false, historyTotal: 1,
};

// NOT this machine's zone (IST here), so a range read in the browser's zone
// instead of the configured one comes out different.
const DATETIME = { dateFormat: 'DD/MM/YYYY', timeFormat: '24-hour', timezone: 'America/New_York' };

const failure = (status: number, code?: string) => Object.assign(new Error(`HTTP ${status}`), { status, code });
const state: { detail: DashboardDetail | 'missing' } = { detail: DETAIL };

function route(url: string): Promise<unknown> {
  if (url === `/api/dashboards/${ID}`) {
    return state.detail === 'missing' ? Promise.reject(failure(404, 'NOT_FOUND')) : Promise.resolve(state.detail);
  }
  if (url.startsWith('/api/instruments/telemetry-overview')) return Promise.resolve(OVERVIEW);
  if (url.startsWith(`/api/instruments/${INST}/telemetry?`)) return Promise.resolve(HISTORY);
  return Promise.resolve(undefined);
}

function mount(search = '') {
  return render(
    <SWRConfig value={{
      provider: () => new Map(), fetcher: (u: string) => get(u),
      dedupingInterval: 0, shouldRetryOnError: false, revalidateOnFocus: false,
    }}>
      <MemoryRouter initialEntries={[`/dashboards/${ID}${search}`]}>
        <Routes>
          <Route path="/dashboards/:id" element={<DashboardPage />} />
          <Route path="/dashboards" element={<div>the list</div>} />
        </Routes>
      </MemoryRouter>
    </SWRConfig>,
  );
}

const urls = () => get.mock.calls.map((c) => c[0] as string);
const historyUrls = () => urls().filter((u) => u.startsWith(`/api/instruments/${INST}/telemetry?`));
const spanOf = (u: string) => {
  const q = new URL(u, 'https://x').searchParams;
  return Date.parse(q.get('to')!) - Date.parse(q.get('from')!);
};

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
  AUTH.user.role = 'SUPER_ADMIN';
  state.detail = DETAIL;
  reauthActions.length = 0;
  TOAST.toast.success.mockReset(); TOAST.toast.error.mockReset();
  get.mockReset().mockImplementation(route);
  post.mockReset().mockImplementation((url: string, body: { keys: { key: string }[] }) => {
    if (url !== '/api/instruments/latest-values') return Promise.resolve(undefined);
    if (body.keys.some((k) => k.key === 'denied')) return Promise.reject(failure(403, 'FORBIDDEN'));
    return Promise.resolve(LATEST);
  });
  put.mockReset().mockResolvedValue(DETAIL);
});
afterEach(() => {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

describe('DashboardPage', () => {
  it('draws the stored widgets under a header naming the dashboard and its instruments', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'QC Block — Room Conditions' })).toBeInTheDocument();
    expect(screen.getByText('Dissolution rooms')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('dashboard-source')).toHaveTextContent('Pressure Sensors · 1 in your view'));
    expect(screen.getByRole('heading', { name: 'Room cards' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Room trend' })).toBeInTheDocument();
    expect(await screen.findByText('21.5')).toBeInTheDocument();
    // The header's window starts at the document's.
    expect(within(screen.getByRole('group', { name: 'Time window' })).getByRole('button', { name: '24h' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  it('a profile source makes the overview ask for that profile', async () => {
    mount();
    await waitFor(() => expect(urls()).toContain(`/api/instruments/telemetry-overview?profileId=${PROFILE}`));
    expect(urls().filter((u) => u.startsWith('/api/instruments/telemetry-overview'))
      .every((u) => u.includes(`profileId=${PROFILE}`))).toBe(true);
  });

  it('a non-super-admin sees no Edit, even with ?edit=1', async () => {
    AUTH.user.role = 'OPERATOR';
    mount('?edit=1');
    expect(await screen.findByRole('heading', { name: 'Room cards' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add widget' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save layout' })).toBeNull();
  });

  it('?edit=1 opens a super admin straight into edit mode', async () => {
    mount('?edit=1');
    expect(await screen.findByRole('button', { name: 'Add widget' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save layout' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Edit widget' })).toHaveLength(2);
  });

  it('SA: Edit → Add widget → Save sends ONE PUT with the loaded updatedAt and the document with that widget', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Room cards' });
    // A session window is never saved into the document.
    fireEvent.click(within(screen.getByRole('group', { name: 'Time window' })).getByRole('button', { name: '7d' }));
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    expect(screen.getByTestId('widget-dialog')).toHaveAttribute('data-follow', 'Follow the dashboard');
    fireEvent.click(screen.getByRole('button', { name: 'Submit widget' }));
    expect(await screen.findByRole('heading', { name: 'Freshly added' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [url, body] = put.mock.calls[0] as [string, { document: DashboardDetail['document']; expectedUpdatedAt: string }];
    expect(url).toBe(`/api/dashboards/${ID}`);
    expect(body.expectedUpdatedAt).toBe(DETAIL.updatedAt);
    expect(body.document.widgets.map((w) => w.id)).toEqual([W_CARDS, W_TREND, NEW_ID]);
    expect(body.document.items.find((it) => it.i === `w:${NEW_ID}`)).toEqual({ i: `w:${NEW_ID}`, x: 0, y: 9, w: 12, h: 5 });
    expect(body.document.timeWindow).toEqual({ mode: 'relative', period: '24h' });
    expect(body.document.source).toEqual({ mode: 'profile', profileId: PROFILE });
    expect(reauthActions).toEqual(['UPDATE_DASHBOARD']);
    // Saved: edit mode ends and the dashboard is read again.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save layout' })).toBeNull());
    expect(urls().filter((u) => u === `/api/dashboards/${ID}`).length).toBeGreaterThanOrEqual(2);
    expect(TOAST.toast.success).toHaveBeenCalled();
  });

  it('Save sends the updatedAt loaded when editing BEGAN, not one fetched since', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Room cards' });
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    // Someone else saves; this page re-reads it (Refresh) while still editing.
    state.detail = DETAIL_V2;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(urls().filter((u) => u === `/api/dashboards/${ID}`).length).toBeGreaterThanOrEqual(2));
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit widget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect((put.mock.calls[0][1] as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe(DETAIL.updatedAt);
  });

  it('a 409 keeps the draft and offers Reload', async () => {
    put.mockReset().mockRejectedValue(failure(409, 'DASHBOARD_CHANGED'));
    mount();
    await screen.findByRole('heading', { name: 'Room cards' });
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit widget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));

    const dialog = await screen.findByRole('dialog');
    const banner = within(dialog).getByTestId('dialog-banner');
    expect(banner).toHaveAttribute('data-tone', 'danger');
    expect(banner).toHaveTextContent('This dashboard was changed by someone else.');
    // The draft is still on screen, still being edited.
    expect(screen.getByRole('heading', { name: 'Freshly added' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save layout' })).toBeInTheDocument();
    expect(TOAST.toast.error).not.toHaveBeenCalled();

    const before = urls().filter((u) => u === `/api/dashboards/${ID}`).length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Freshly added' })).toBeNull());
    expect(urls().filter((u) => u === `/api/dashboards/${ID}`).length).toBeGreaterThan(before);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save layout' })).toBeNull();
  });

  it("one widget's 403 leaves the rest drawn", async () => {
    state.detail = DETAIL_DENIED;
    mount();
    expect(await screen.findByText('Could not load this widget.')).toBeInTheDocument();
    expect(await screen.findByText('21.5')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Room cards' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Forbidden cards' })).toBeInTheDocument();
  });

  it('a widget that throws while drawing leaves the page and the other widgets drawn', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.detail = DETAIL_BOOM;
    mount();
    expect(await screen.findByText('21.5')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'QC Block — Room Conditions' })).toBeInTheDocument();
    expect(screen.getByText('Could not load this widget.')).toBeInTheDocument();

    // While editing, the broken card can still be removed — else it could never be cleared.
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    const broken = screen.getByTestId('widget-failed');
    expect(within(broken).getByRole('button', { name: 'Edit widget' })).toBeInTheDocument();
    fireEvent.click(within(broken).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByTestId('widget-failed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const body = put.mock.calls[0][1] as { document: DashboardDetail['document'] };
    expect(body.document.widgets.map((w) => w.id)).toEqual([W_CARDS]);
    expect(body.document.items.map((it) => it.i)).toEqual([`w:${W_CARDS}`]);
    quiet.mockRestore();
  });

  it("changing the window to 7d changes the trend widget's requested range", async () => {
    mount();
    await waitFor(() => expect(historyUrls().length).toBeGreaterThan(0));
    expect(spanOf(historyUrls().at(-1)!)).toBe(24 * 3_600_000);
    fireEvent.click(within(screen.getByRole('group', { name: 'Time window' })).getByRole('button', { name: '7d' }));
    await waitFor(() => expect(spanOf(historyUrls().at(-1)!)).toBe(7 * 86_400_000));
    expect(within(screen.getByRole('group', { name: 'Time window' })).getByRole('button', { name: '7d' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  it('a custom range is sent as instants in the configured zone; an end before its start is refused in place', async () => {
    // The administered zone: New York, on EDT (UTC-04:00) on this date.
    get.mockImplementation((u: string) => (u === '/api/config/datetime/current'
      ? Promise.resolve(DATETIME) : route(u)));
    mount();
    await waitFor(() => expect(historyUrls().length).toBeGreaterThan(0));
    const group = screen.getByRole('group', { name: 'Time window' });
    fireEvent.click(within(group).getByRole('button', { name: 'Custom' }));
    const from = screen.getByLabelText('From') as HTMLInputElement;
    const to = screen.getByLabelText('To') as HTMLInputElement;
    expect(from.name).not.toBe(to.name);

    fireEvent.change(from, { target: { value: '2026-10-29T10:00' } });
    fireEvent.change(to, { target: { value: '2026-10-29T09:00' } });
    const calls = historyUrls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The window must end after it starts');
    expect(screen.getByLabelText('From')).toBeInTheDocument(); // still open, in place
    expect(within(group).getByRole('button', { name: '24h' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.change(to, { target: { value: '2026-10-29T16:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(historyUrls().length).toBeGreaterThan(calls));
    const q = new URL(historyUrls().at(-1)!, 'https://x').searchParams;
    expect(q.get('from')).toBe('2026-10-29T14:00:00.000Z');
    expect(q.get('to')).toBe('2026-10-29T20:30:00.000Z');
    expect(screen.queryByLabelText('From')).toBeNull();
    expect(within(group).getByRole('button', { name: '24h' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('Refresh asks the server again', async () => {
    mount();
    await waitFor(() => expect(urls().some((u) => u.startsWith('/api/instruments/telemetry-overview'))).toBe(true));
    const before = urls().filter((u) => u.startsWith('/api/instruments/telemetry-overview')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(urls().filter((u) => u.startsWith('/api/instruments/telemetry-overview')).length).toBeGreaterThan(before));
  });

  it('a dashboard that is not visible (404) says so and links back to the list', async () => {
    state.detail = 'missing';
    mount();
    expect(await screen.findByText('This dashboard is not available to you.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dashboards/ })).toHaveAttribute('href', '/dashboards');
    expect(screen.queryByRole('group', { name: 'Time window' })).toBeNull();
  });

  it('an unreadable source shows the banner and NO instruments — never the whole estate', async () => {
    state.detail = DETAIL_NULL_SOURCE;
    mount();
    expect(await screen.findByText("This dashboard's instruments could not be read. A super admin can choose them again in Settings."))
      .toBeInTheDocument();
    expect((await screen.findAllByText('No instruments in your view')).length).toBeGreaterThan(0);
    expect(urls().some((u) => u.startsWith('/api/instruments/telemetry-overview'))).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('an empty dashboard: the SA is offered the first widget; anyone else is told it is empty', async () => {
    state.detail = DETAIL_EMPTY;
    const { unmount } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add the first widget' }));
    expect(screen.getByTestId('widget-dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save layout' })).toBeInTheDocument();
    unmount();

    AUTH.user.role = 'QA';
    mount();
    expect(await screen.findByText('Nothing on this dashboard yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add the first widget' })).toBeNull();
  });
});
