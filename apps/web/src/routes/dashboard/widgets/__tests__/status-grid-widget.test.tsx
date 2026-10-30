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
vi.mock('../use-widget-data', () => ({
  useWidgetOverview: (...a: unknown[]) => { overviewCalls.push(a); return state.overview; },
}));

import { WidgetBody } from '../widget-panel';
import { STATUS_GRID_MAX } from '../status-grid-widget';
import { statusClasses } from '../../status';
import { UNJUDGED_CLASSES } from '../key-value';

const SEL = { functionalLocationId: 'fl-1', directOnly: false };
const TRAIL = [{ label: 'Dashboard', to: '/' }, { label: 'QC Block', to: '/?fl=fl-1' }];
const W: CustomWidget = {
  id: '66666666-6666-4666-8666-666666666666', type: 'status_grid', title: 'Plant health',
  source: { mode: 'selection' }, keys: [], options: {},
};

const row = (id: string, status: InstrumentStatus, over: Partial<OverviewRow> = {}): OverviewRow => ({
  instrumentId: id, code: `CWH/RDU/${id}`, name: id, isActive: true, room: null,
  limits: null, limitSource: null, temperature: null, humidity: null,
  decimals: { temperature: 1, humidity: 1 }, reporting: true, judged: true, status, ...over,
});
const setRows = (rows: OverviewRow[]) => { state.overview = { rows, loading: false, error: undefined }; };

/** Where a tile lands: the trend route, printing the router state it was given. */
function TrendProbe() {
  const { id } = useParams();
  const location = useLocation();
  return <pre data-testid="trend-probe" data-id={id}>{JSON.stringify(location.state)}</pre>;
}
const view = (trail?: typeof TRAIL) => render(
  <MemoryRouter initialEntries={['/']}>
    <Routes>
      <Route path="/" element={<WidgetBody widget={W} selection={SEL} trail={trail} />} />
      <Route path="/instruments/:id/trend" element={<TrendProbe />} />
    </Routes>
  </MemoryRouter>,
);
const tiles = () => screen.getAllByTestId('status-tile');
const tokens = (el: Element) => el.className.split(/\s+/);

beforeEach(() => {
  setRows([]);
  overviewCalls.length = 0;
});

describe('status grid widget', () => {
  it('one tile per instrument, in the server\'s order: the code (its title the code) and the instrumentLook word', () => {
    setRows([row('101-01', 'OK'), row('001-00', 'OUT_OF_SPEC'), row('014-00', 'STALE', { reporting: false })]);
    view(TRAIL);
    expect(tiles().map((t) => within(t).getByTestId('status-tile-code').textContent))
      .toEqual(['CWH/RDU/101-01', 'CWH/RDU/001-00', 'CWH/RDU/014-00']);
    expect(within(tiles()[0]).getByTestId('status-tile-code').getAttribute('title')).toBe('CWH/RDU/101-01');
    expect(tiles().map((t) => within(t).getByTestId('status-tile-word').textContent)).toEqual(['In limit', 'Out of limit', 'Offline']);
    // The colour is the status's own classes.
    expect(tokens(tiles()[1])).toEqual(expect.arrayContaining([statusClasses('OUT_OF_SPEC').bg, statusClasses('OUT_OF_SPEC').border]));
    // Asked with the widget's source and the dashboard's selection.
    expect(overviewCalls.at(-1)).toEqual([W.source, SEL]);
  });

  it('Review Focus 1: a reporting instrument nothing judges is "Not judged", neutral — never "No data", never green', () => {
    setRows([row('201-00', 'NO_DATA', { judged: false, reporting: true })]);
    view(TRAIL);
    const [tile] = tiles();
    expect(tile.getAttribute('data-look')).toBe('NOT_JUDGED');
    expect(within(tile).getByTestId('status-tile-word').textContent).toBe('Not judged');
    expect(tile.textContent).not.toContain(statusClasses('NO_DATA').label);
    expect(tokens(tile)).toEqual(expect.arrayContaining([UNJUDGED_CLASSES.bg, UNJUDGED_CLASSES.border]));
    expect(tokens(within(tile).getByTestId('status-tile-dot'))).toContain(UNJUDGED_CLASSES.dot);
    // Independent anchors: not the "In limit" classes, and no green anywhere in it.
    const ok = statusClasses('OK');
    for (const cls of [ok.bg, ok.border, ok.dot, ok.text]) expect(tile.innerHTML + tile.className).not.toContain(cls);
    expect(tile.outerHTML).not.toMatch(/emerald|green/);
  });

  it('Review Focus 1: the same instrument not reporting is "Offline"', () => {
    setRows([row('201-00', 'NO_DATA', { judged: false, reporting: false })]);
    view(TRAIL);
    const [tile] = tiles();
    expect(tile.getAttribute('data-look')).toBe('STALE');
    expect(within(tile).getByTestId('status-tile-word').textContent).toBe('Offline');
    expect(tokens(within(tile).getByTestId('status-tile-dot'))).toContain(statusClasses('STALE').dot);
  });

  it('a tile click opens that instrument\'s trend page, carrying the dashboard\'s origin AND trail', () => {
    setRows([row('101-01', 'OK', { instrumentId: 'inst-7' })]);
    view(TRAIL);
    const link = screen.getByRole('link', { name: 'Open trend page for CWH/RDU/101-01 — In limit' });
    expect(link).toBe(tiles()[0]);
    expect(link.getAttribute('href')).toBe('/instruments/inst-7/trend');
    fireEvent.click(link);
    const probe = screen.getByTestId('trend-probe');
    expect(probe.getAttribute('data-id')).toBe('inst-7');
    expect(JSON.parse(probe.textContent!)).toEqual({ from: 'dashboard', trail: TRAIL });
  });

  it('with no host trail (the Add widget preview) a tile is not a link, so a click cannot leave the dialog', () => {
    setRows([row('101-01', 'OK')]);
    view();
    expect(tiles()).toHaveLength(1);
    expect(screen.queryAllByRole('link')).toEqual([]);
  });

  it(`more than ${STATUS_GRID_MAX} instruments: ${STATUS_GRID_MAX} tiles and "N more not shown"`, () => {
    expect(STATUS_GRID_MAX).toBe(120);
    setRows(Array.from({ length: STATUS_GRID_MAX + 37 }, (_, n) => row(`i${n}`, 'OK', { instrumentId: `id-${n}` })));
    view(TRAIL);
    expect(tiles()).toHaveLength(STATUS_GRID_MAX);
    expect(screen.getByTestId('widget-more-note').textContent).toBe('37 more not shown');
    // The notes sit above the tiles, as on every widget.
    const notes = screen.getByTestId('widget-notes');
    expect(notes.compareDocumentPosition(screen.getByTestId('status-grid')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('exactly the cap: no note', () => {
    setRows(Array.from({ length: STATUS_GRID_MAX }, (_, n) => row(`i${n}`, 'OK', { instrumentId: `id-${n}` })));
    view(TRAIL);
    expect(screen.queryByTestId('widget-notes')).toBeNull();
  });

  it('tiles reflow by the panel\'s width: an auto-filling grid, not a fixed column count', () => {
    setRows([row('101-01', 'OK')]);
    view(TRAIL);
    expect(screen.getByTestId('status-grid').className).toContain('[grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr))]');
  });

  it('loading, a failed load, nothing in view, and a failed refresh are each said', () => {
    state.overview = { rows: [], loading: true, error: undefined };
    const a = view(TRAIL);
    expect(screen.getByText('Loading…')).toBeTruthy();
    a.unmount();
    state.overview = { rows: [], loading: false, error: Object.assign(new Error('500'), { status: 500 }) };
    const b = view(TRAIL);
    expect(screen.getByRole('alert').textContent).toBe('Could not load this widget.');
    b.unmount();
    setRows([]);
    const c = view(TRAIL);
    expect(screen.getByText('No instruments in your view')).toBeTruthy();
    c.unmount();
    // Rows held through a failed refresh stay drawn, and the widget says so.
    state.overview = { rows: [row('101-01', 'OK')], loading: false, error: Object.assign(new Error('502'), { status: 502 }) };
    view(TRAIL);
    expect(tiles()).toHaveLength(1);
    expect(screen.getByTestId('widget-refresh-failed')).toBeTruthy();
  });
});
