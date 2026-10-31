import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import type { CustomWidget, InstrumentStatus } from '@digilog/shared';
import type { OverviewRow } from '../../use-telemetry';

// Stable module-level objects only: a fresh object per call re-runs effects forever.
const state: { overview: { rows: OverviewRow[]; loading: boolean; error: unknown } } = {
  overview: { rows: [], loading: false, error: undefined },
};
const overviewCalls: unknown[][] = [];
vi.mock('../use-widget-data', async (orig) => ({
  ...(await orig<typeof import('../use-widget-data')>()),
  useWidgetOverview: (...a: unknown[]) => { overviewCalls.push(a); return state.overview; },
}));
const FORMAT = { formatDateTime: (v: string) => `DT:${v}`, formatDate: (v: string) => `D:${v}`, formatTime: (v: string) => `T:${v}` };
/** What the Last seen cell prints: the administered date, a space, the administered time (= `formatDateTime`). */
const seen = (iso: string) => `D:${iso} T:${iso}`;
vi.mock('@/hooks/use-datetime-format', () => ({ useDatetimeFormat: () => FORMAT }));
const PAGING = { options: [10, 25, 50], defaultLimit: 25 };
vi.mock('@/hooks/use-pagination-config', () => ({ usePaginationDefaults: () => PAGING }));

import { WidgetBody } from '../widget-panel';
import { statusClasses } from '../../status';
import { UNJUDGED_CLASSES } from '../key-value';

const SEL = { functionalLocationId: 'fl-1', directOnly: false };
const TRAIL = [{ label: 'Dashboard', to: '/' }, { label: 'QC Block', to: '/?fl=fl-1' }];
const W: CustomWidget = {
  id: '77777777-7777-4777-8777-777777777777', type: 'instrument_list', title: 'Instruments',
  source: { mode: 'selection' }, keys: [], options: {},
};

const row = (n: number, over: Partial<OverviewRow> = {}): OverviewRow => ({
  instrumentId: `id-${n}`, code: `CWH/RDU/${String(n).padStart(3, '0')}-00`, name: `n${n}`, isActive: true, room: null,
  functionalLocationName: `Area ${n}`, locationAttribute: `Room ${n}`,
  limits: null, limitSource: null, temperature: null, humidity: null,
  decimals: { temperature: 1, humidity: 1 }, reporting: true, judged: true,
  lastSeenAt: `2026-10-30T0${n % 10}:00:00.000Z`, status: 'OK' as InstrumentStatus, ...over,
});
const setRows = (rows: OverviewRow[]) => { state.overview = { rows, loading: false, error: undefined }; };

function TrendProbe() {
  const { id } = useParams();
  const location = useLocation();
  return <pre data-testid="trend-probe" data-id={id}>{JSON.stringify(location.state)}</pre>;
}
const tree = (widget: CustomWidget, trail?: typeof TRAIL) => (
  <MemoryRouter initialEntries={['/']}>
    <Routes>
      <Route path="/" element={<WidgetBody widget={widget} selection={SEL} trail={trail} />} />
      <Route path="/instruments/:id/trend" element={<TrendProbe />} />
    </Routes>
  </MemoryRouter>
);
const view = (widget: CustomWidget = W, trail?: typeof TRAIL) => render(tree(widget, trail));
const bodyRows = () => screen.getAllByTestId('instrument-list-row');
const cells = (tr: HTMLElement) => within(tr).getAllByRole('cell').map((c) => c.textContent);
const tokens = (el: Element) => el.className.split(/\s+/);

beforeEach(() => {
  setRows([]);
  overviewCalls.length = 0;
});

describe('instrument list widget', () => {
  it('the columns, each read from the server row as it is: ID, Area, Location, Status, Last seen', () => {
    setRows([row(1), row(2, { functionalLocationName: null, locationAttribute: null })]);
    view(W, TRAIL);
    const table = screen.getByTestId('instrument-list');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent))
      .toEqual(['Instrument ID', 'Area', 'Location', 'Status', 'Last seen']);
    expect(cells(bodyRows()[0])).toEqual(['CWH/RDU/001-00', 'Area 1', 'Room 1', 'In limit', seen('2026-10-30T01:00:00.000Z')]);
    // Area and Location keep their whole text on hover when a narrow card clamps them.
    expect(within(bodyRows()[0]).getByText('Area 1').getAttribute('title')).toBe('Area 1');
    expect(within(bodyRows()[0]).getByText('Room 1').getAttribute('title')).toBe('Room 1');
    // No Area, no Location: a dash, never a re-derived value.
    expect(cells(bodyRows()[1]).slice(1, 3)).toEqual(['—', '—']);
    // Asked with the widget's source and the dashboard's selection: the readings table's own key.
    expect(overviewCalls.at(-1)).toEqual([W.source, SEL]);
  });

  it('Last seen through the administered formatter; a dash when the instrument never reported', () => {
    setRows([row(1), row(2, { lastSeenAt: null }), row(3, { lastSeenAt: undefined })]);
    view(W, TRAIL);
    expect(bodyRows().map((r) => cells(r)[4])).toEqual([seen('2026-10-30T01:00:00.000Z'), '—', '—']);
  });

  it('Review Focus 1: a reporting instrument nothing judges reads "Not judged", neutral; silent, "Offline"', () => {
    setRows([row(1, { status: 'NO_DATA', judged: false, reporting: true }), row(2, { status: 'NO_DATA', judged: false, reporting: false })]);
    view(W, TRAIL);
    const [notJudged, offline] = screen.getAllByTestId('instrument-list-status');
    expect(notJudged.textContent).toBe('Not judged');
    expect(notJudged.getAttribute('data-look')).toBe('NOT_JUDGED');
    expect(tokens(notJudged)).toEqual(expect.arrayContaining([UNJUDGED_CLASSES.bg, UNJUDGED_CLASSES.text, UNJUDGED_CLASSES.border]));
    expect(bodyRows()[0].textContent).not.toContain(statusClasses('NO_DATA').label);
    const ok = statusClasses('OK');
    for (const cls of [ok.bg, ok.text, ok.border, ok.dot]) expect(notJudged.outerHTML).not.toContain(cls);
    expect(notJudged.outerHTML).not.toMatch(/emerald|green/);
    expect(offline.textContent).toBe('Offline');
    expect(offline.getAttribute('data-look')).toBe('STALE');
  });

  it('rows in the server\'s order, ten to a page by default, paged with the shared pager', () => {
    // Deliberately not in code order: the server's order is the order shown.
    const rows = Array.from({ length: 23 }, (_, n) => row(23 - n));
    setRows(rows);
    view(W, TRAIL);
    expect(bodyRows().map((r) => cells(r)[0])).toEqual(rows.slice(0, 10).map((r) => r.code));
    expect(screen.getByText(/^Showing/).textContent).toBe('Showing 1–10 of 23');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(bodyRows().map((r) => cells(r)[0])).toEqual(rows.slice(10, 20).map((r) => r.code));
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    expect(bodyRows().map((r) => cells(r)[0])).toEqual(rows.slice(20).map((r) => r.code));
  });

  it('the stored page size is the page size', () => {
    setRows(Array.from({ length: 23 }, (_, n) => row(n)));
    view({ ...W, options: { pageSize: 25 } }, TRAIL);
    expect(bodyRows()).toHaveLength(23);
  });

  it('a page past the end after the rows shrink shows the last page, never an empty table', () => {
    setRows(Array.from({ length: 23 }, (_, n) => row(n)));
    const { rerender } = view(W, TRAIL);
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    expect(bodyRows()).toHaveLength(3);
    setRows(Array.from({ length: 5 }, (_, n) => row(n)));
    rerender(tree(W, TRAIL));
    expect(bodyRows()).toHaveLength(5);
    expect(screen.getByText(/^Showing/).textContent).toBe('Showing 1–5 of 5');
  });

  it('a row click opens that instrument\'s trend page with the dashboard\'s origin AND trail; the ID is the link', () => {
    setRows([row(1, { instrumentId: 'inst-7' })]);
    view(W, TRAIL);
    const link = within(bodyRows()[0]).getByRole('link', { name: 'Open trend page for CWH/RDU/001-00' });
    expect(link.getAttribute('href')).toBe('/instruments/inst-7/trend');
    // A click anywhere on the row — here, its Location cell.
    fireEvent.click(within(bodyRows()[0]).getByText('Room 1'));
    const probe = screen.getByTestId('trend-probe');
    expect(probe.getAttribute('data-id')).toBe('inst-7');
    expect(JSON.parse(probe.textContent!)).toEqual({ from: 'dashboard', trail: TRAIL });
  });

  it('M-9: a Ctrl / ⌘ / Shift / Alt or middle click, or a click that ends a text selection, leaves the tab where it is', () => {
    setRows([row(1, { instrumentId: 'inst-7' })]);
    view(W, TRAIL);
    const cell = within(bodyRows()[0]).getByText('Room 1');
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      fireEvent.click(cell, init);
      expect(screen.queryByTestId('trend-probe')).toBeNull();
    }
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'Room 1' } as unknown as Selection);
    try {
      fireEvent.click(cell);
      expect(screen.queryByTestId('trend-probe')).toBeNull();
    } finally {
      selection.mockRestore();
    }
    // A plain click still opens it.
    fireEvent.click(cell);
    expect(screen.getByTestId('trend-probe').getAttribute('data-id')).toBe('inst-7');
  });

  it('M-1: compact cells and no minimum widths, so a half-width card has room for every column', () => {
    setRows([row(1)]);
    view(W, TRAIL);
    const table = screen.getByTestId('instrument-list');
    for (const el of [...within(table).getAllByRole('columnheader'), ...within(table).getAllByRole('cell')]) {
      expect(tokens(el)).toContain('px-2.5');
      expect(tokens(el)).not.toContain('px-4');
    }
    expect(table.innerHTML).not.toMatch(/min-w-\[/);
  });

  it('M-1: a narrow column wraps between words, never at a hyphen; the text is exactly the server text', () => {
    setRows([row(1, { functionalLocationName: 'Module-F', locationAttribute: 'Module-E staging area' })]);
    view(W, TRAIL);
    const [, area, location] = within(bodyRows()[0]).getAllByRole('cell');
    expect(area.textContent).toBe('Module-F');
    expect(location.textContent).toBe('Module-E staging area');
    expect(tokens(within(area).getByText('Module-F'))).toContain('whitespace-nowrap');
    expect(tokens(within(location).getByText('Module-E'))).toContain('whitespace-nowrap');
    // Between words it may still wrap.
    expect(location.innerHTML).toContain('</span> staging area');
  });

  it('the ID link itself carries the same state', () => {
    setRows([row(1, { instrumentId: 'inst-7' })]);
    view(W, TRAIL);
    fireEvent.click(screen.getByRole('link', { name: 'Open trend page for CWH/RDU/001-00' }));
    expect(JSON.parse(screen.getByTestId('trend-probe').textContent!)).toEqual({ from: 'dashboard', trail: TRAIL });
  });

  it('with no host trail (the Add widget preview, a dashboard being edited) a row is not a link and a click stays put', () => {
    setRows([row(1)]);
    view(W);
    expect(screen.queryAllByRole('link')).toEqual([]);
    fireEvent.click(within(bodyRows()[0]).getByText('Room 1'));
    expect(screen.queryByTestId('trend-probe')).toBeNull();
    expect(bodyRows()).toHaveLength(1);
  });

  it('loading, a failed load, nothing in view, and a failed refresh are each said', () => {
    state.overview = { rows: [], loading: true, error: undefined };
    const a = view(W, TRAIL);
    expect(screen.getByText('Loading…')).toBeTruthy();
    a.unmount();
    state.overview = { rows: [], loading: false, error: Object.assign(new Error('500'), { status: 500 }) };
    const b = view(W, TRAIL);
    expect(screen.getByRole('alert').textContent).toBe('Could not load this widget.');
    b.unmount();
    setRows([]);
    const c = view(W, TRAIL);
    expect(screen.getByText('No instruments in your view')).toBeTruthy();
    expect(screen.queryByTestId('instrument-list')).toBeNull();
    c.unmount();
    state.overview = { rows: [row(1)], loading: false, error: Object.assign(new Error('502'), { status: 502 }) };
    view(W, TRAIL);
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByTestId('widget-refresh-failed')).toBeTruthy();
  });
});
