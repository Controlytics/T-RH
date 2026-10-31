import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { DEFAULT_DASHBOARD_LAYOUT, type CustomWidget } from '@digilog/shared';
import type { FloorplanShape, OverviewRow } from '../../use-telemetry';

/**
 * The floor plan widget (dashboard builder phase 2, Task 8): the dashboard's
 * own `FloorplanView` on ONE fixed plan, drawing the instruments the dashboard
 * selects. Mounted for real over mocked plan and overview hooks.
 */
const room = (id: string, code: string, x: number) => ({
  id, code, label: code, grade: null, x, y: 0.1, w: 0.4, h: 0.6,
  tempMin: null, tempMax: null, rhMin: null, rhMax: null, doors: null, meta: null, points: null,
});
const ANN = { style: 'architectural' as const, equipment: [], hvac: [], water: [], airflow: [], labels: [], columns: [], windows: [], walls: [] };
const plan = (id: string, name: string, rooms: ReturnType<typeof room>[], ann: Record<string, unknown> = {}): FloorplanShape => ({
  id, name, imagePath: null, imageWidth: 1000, imageHeight: 600, isActive: true, sortOrder: 0, links: [], rooms,
  annotations: { ...ANN, ...ann } as FloorplanShape['annotations'],
});
const QC = plan('11111111-aaaa-4aaa-8aaa-111111111111', 'CWH — QC', [room('q1', 'CWH-I/216', 0.05), room('q2', 'CWH-I/217', 0.55)]);
const GROUND = plan('22222222-aaaa-4aaa-8aaa-222222222222', 'CWH — Module-F — Ground Floor', [room('g1', 'CWH-I/036', 0.05)],
  { floor: { group: 'CWH — Module-F', label: 'Ground Floor', order: 0 } });
const FIRST = plan('33333333-aaaa-4aaa-8aaa-333333333333', 'CWH — Module-F — First Floor', [room('f1', 'CWH-I/041', 0.05)],
  { floor: { group: 'CWH — Module-F', label: 'First Floor', order: 1 } });
const GONE = '44444444-aaaa-4aaa-8aaa-444444444444';

const row = (id: string, roomId: string | null, planId: string): OverviewRow => ({
  instrumentId: id, code: `CWH/RDU/${id}`, name: id, isActive: true,
  room: roomId ? { id: roomId, code: roomId, label: roomId, floorplanId: planId } : null,
  locationAttribute: 'Wet lab', limits: { tempMin: 15, tempMax: 25, rhMin: 30, rhMax: 60 }, limitSource: 'INSTRUMENT',
  temperature: { key: 't', value: 21.5, ts: '2026-10-30T10:00:00.000Z' }, humidity: { key: 'h', value: 45, ts: '2026-10-30T10:00:00.000Z' },
  decimals: { temperature: 1, humidity: 0 }, reporting: true, judged: true, status: 'OK',
});

// Stable module-level objects only.
const state: {
  plans: { plans: FloorplanShape[]; isLoading: boolean; error: unknown };
  overview: { rows: OverviewRow[]; isLoading: boolean; error: unknown };
} = {
  plans: { plans: [QC, GROUND, FIRST], isLoading: false, error: undefined },
  overview: { rows: [], isLoading: false, error: undefined },
};
const overviewCalls: unknown[][] = [];
const SWR = { data: undefined, error: undefined, isLoading: false, mutate: () => undefined };
vi.mock('swr', () => ({ default: () => SWR }));
vi.mock('../../use-telemetry', async (orig) => ({
  ...(await orig<typeof import('../../use-telemetry')>()),
  useFloorplans: () => state.plans,
  useTelemetryOverview: (...a: unknown[]) => { overviewCalls.push(a); return state.overview; },
}));

const { WidgetBody, WidgetPanel } = await import('../widget-panel');
const { FloorplanView, FLOORPLAN_NOT_AVAILABLE, fixedPlanState } = await import('../../floorplan-view');
const { WIDGET_START_HEIGHT } = await import('@/hooks/use-dashboard-layout');
const tokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

const SEL = { functionalLocationId: 'fl-1', directOnly: false };
const TRAIL = [{ label: 'Dashboard', to: '/' }, { label: 'QC Block', to: '/?fl=fl-1' }];
const widget = (planId: string, source: CustomWidget['source'] = { mode: 'selection' }): CustomWidget => ({
  id: '99999999-9999-4999-8999-999999999999', type: 'floorplan', title: 'QC floor', source, keys: [], options: { planId },
});

function TrendProbe() {
  const { id } = useParams();
  const location = useLocation();
  return <pre data-testid="trend-probe" data-id={id}>{JSON.stringify(location.state)}</pre>;
}
const view = (w: CustomWidget, opts: { trail?: typeof TRAIL; selection?: Parameters<typeof WidgetBody>[0]['selection'] } = {}) => render(
  <MemoryRouter initialEntries={['/']}>
    <Routes>
      <Route path="/" element={<div data-testid="host"><WidgetBody widget={w} selection={opts.selection ?? SEL} trail={opts.trail} /></div>} />
      <Route path="/instruments/:id/trend" element={<TrendProbe />} />
    </Routes>
  </MemoryRouter>,
);
/** The overview calls `FloorplanView` made: one argument, the hold option its own default. */
const viewCalls = () => overviewCalls.filter((c) => c.length === 1);
const titleBar = () => screen.getByTestId('floorplan-view').firstElementChild as HTMLElement;

beforeEach(() => {
  overviewCalls.length = 0;
  state.plans = { plans: [QC, GROUND, FIRST], isLoading: false, error: undefined };
  state.overview = { rows: [row('216-00', 'q1', QC.id)], isLoading: false, error: undefined };
});

describe('FloorplanView without the new props', () => {
  it('makes exactly the overview request it made before: the same one argument', () => {
    render(<MemoryRouter><FloorplanView functionalLocationId="fl-1" directOnly={false} trail={TRAIL} /></MemoryRouter>);
    expect(overviewCalls.length).toBeGreaterThan(0);
    for (const c of overviewCalls) expect(c).toStrictEqual([{ functionalLocationId: 'fl-1', directOnly: false }]);
    overviewCalls.length = 0;
    render(<MemoryRouter><FloorplanView /></MemoryRouter>);
    for (const c of overviewCalls) expect(c).toStrictEqual([{ functionalLocationId: undefined, directOnly: undefined }]);
  });

  it('still offers the other plans, the floor switch and Full screen', () => {
    render(<MemoryRouter><FloorplanView /></MemoryRouter>);
    expect(within(titleBar()).getByRole('heading').textContent).toBe('CWH — QC');
    fireEvent.click(within(titleBar()).getByRole('button', { name: 'CWH — Module-F' }));
    expect(screen.getByTestId('fp-floor-switch')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Full screen — floor plan' })).toBeTruthy();
  });
});

describe('fixedPlanState — the ONE decision about a fixed plan (M-4)', () => {
  it('found is ok; a refused list or a plan not in it is gone; a server failure is an error; nothing yet is loading', () => {
    expect(fixedPlanState([QC, FIRST], false, undefined, QC.id)).toBe('ok');
    expect(fixedPlanState([QC, FIRST], false, undefined, GONE)).toBe('gone');
    expect(fixedPlanState([], true, undefined, QC.id)).toBe('loading');
    expect(fixedPlanState([], false, Object.assign(new Error('no'), { status: 403 }), QC.id)).toBe('gone');
    expect(fixedPlanState([], false, Object.assign(new Error('no'), { status: 404 }), QC.id)).toBe('gone');
    expect(fixedPlanState([QC], false, Object.assign(new Error('down'), { status: 502 }), QC.id)).toBe('error');
    expect(fixedPlanState([], false, new Error('network'), QC.id)).toBe('error');
  });
});

describe('floor plan widget', () => {
  it('draws ITS plan, named, with no plan picker and no floor switch', () => {
    view(widget(FIRST.id), { trail: TRAIL });
    expect(within(titleBar()).getByRole('heading').textContent).toBe('CWH — Module-F — First Floor');
    expect(document.querySelector('svg[role="img"]')!.getAttribute('aria-label')).toMatch(/^CWH — Module-F — First Floor:/);
    expect(within(titleBar()).queryByRole('button', { name: 'CWH — QC' })).toBeNull();
    expect(within(titleBar()).queryByRole('button', { name: 'CWH — Module-F' })).toBeNull();
    expect(screen.queryByTestId('fp-floor-switch')).toBeNull();
  });

  it('a plan that no longer exists says so — not the picker, not another plan', () => {
    view(widget(GONE), { trail: TRAIL });
    expect(screen.getByText(FLOORPLAN_NOT_AVAILABLE)).toBeTruthy();
    expect(FLOORPLAN_NOT_AVAILABLE).toBe('This floor plan is not available.');
    expect(document.querySelector('svg[role="img"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'CWH — QC' })).toBeNull();
  });

  it('a plan list the viewer is refused says the same; a server failure says the layouts could not be loaded', () => {
    state.plans = { plans: [], isLoading: false, error: Object.assign(new Error('Permission denied'), { status: 403 }) };
    const a = view(widget(QC.id), { trail: TRAIL });
    expect(screen.getByText(FLOORPLAN_NOT_AVAILABLE)).toBeTruthy();
    a.unmount();
    state.plans = { plans: [], isLoading: false, error: Object.assign(new Error('Bad gateway'), { status: 502 }) };
    view(widget(QC.id), { trail: TRAIL });
    expect(screen.getByRole('alert').textContent).toMatch(/The floor layouts could not be loaded\./);
    expect(screen.queryByText(FLOORPLAN_NOT_AVAILABLE)).toBeNull();
    // No Tabular view on a built dashboard to point at.
    expect(screen.getByRole('alert').textContent).not.toMatch(/Tabular/);
  });

  it('nothing is said about the plan while the plan list is still loading: it is loading', () => {
    state.plans = { plans: [], isLoading: true, error: undefined };
    view(widget(GONE), { trail: TRAIL });
    expect(screen.queryByText(FLOORPLAN_NOT_AVAILABLE)).toBeNull();
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('M-4: the plan is decided FIRST — a gone plan says so with an empty selection, failed rows or rows on their way', () => {
    for (const overview of [
      { rows: [], isLoading: false, error: undefined },
      { rows: [], isLoading: false, error: Object.assign(new Error('500'), { status: 500 }) },
      { rows: [], isLoading: true, error: undefined },
    ]) {
      state.overview = overview;
      const v = view(widget(GONE), { trail: TRAIL });
      expect(screen.getByText(FLOORPLAN_NOT_AVAILABLE)).toBeTruthy();
      expect(screen.queryByText('No instruments in your view')).toBeNull();
      expect(screen.queryByText('Could not load this widget.')).toBeNull();
      expect(screen.queryByText('Loading…')).toBeNull();
      v.unmount();
    }
  });

  it('M-4: an empty selection draws the fixed plan with no readings — never "No instruments in your view"', () => {
    state.overview = { rows: [], isLoading: false, error: undefined };
    view(widget(QC.id), { trail: TRAIL });
    expect(document.querySelector('g[aria-label^="CWH-I/216"]')).not.toBeNull();
    expect(document.querySelector('g[aria-label^="CWH-I/217"]')).not.toBeNull();
    expect(screen.queryAllByTestId('fp-card')).toHaveLength(0);
    expect(screen.queryByText('No instruments in your view')).toBeNull();
  });

  it('M-5: "not available" is centred in the card, not pinned to its top', () => {
    view(widget(GONE), { trail: TRAIL });
    const box = screen.getByTestId('fp-not-available');
    expect(tokens(box)).toEqual(expect.arrayContaining(['absolute', 'top-1/2', '-translate-y-1/2', 'inset-x-4']));
  });

  it('follows the dashboard\'s selection: the view asks for the selection\'s instruments, the same query as every widget', () => {
    const sel = { directOnly: false, profileId: 'prof-1' };
    view(widget(QC.id), { trail: TRAIL, selection: sel });
    expect(viewCalls().length).toBeGreaterThan(0);
    for (const c of viewCalls()) expect(c).toStrictEqual([{ functionalLocationId: undefined, directOnly: false, profileId: 'prof-1' }]);
    // The widget's own reading of the same rows asks the same question (one SWR key), only for this request's answer.
    const own = overviewCalls.filter((c) => c.length === 2);
    expect(own.length).toBeGreaterThan(0);
    for (const c of own) {
      expect(c[0]).toEqual(viewCalls()[0][0]);
      expect(c[1]).toEqual({ keepPreviousData: false });
    }
  });

  it('a location selection draws the whole fixed plan, its readings the selection\'s', () => {
    view(widget(QC.id), { trail: TRAIL });
    expect(viewCalls().length).toBeGreaterThan(0);
    for (const c of viewCalls()) expect(c).toStrictEqual([{ functionalLocationId: 'fl-1', directOnly: false }]);
    // Both rooms of the plan are drawn, the empty one included.
    expect(document.querySelector('g[aria-label^="CWH-I/216"]')).not.toBeNull();
    expect(document.querySelector('g[aria-label^="CWH-I/217"]')).not.toBeNull();
    expect(screen.getAllByTestId('fp-card')).toHaveLength(1);
  });

  it('a fixed plan holding none of the selection\'s instruments is still drawn whole, with no readings on it', () => {
    state.overview = { rows: [row('036-00', 'g1', GROUND.id)], isLoading: false, error: undefined };
    view(widget(QC.id), { trail: TRAIL });
    expect(document.querySelector('g[aria-label^="CWH-I/216"]')).not.toBeNull();
    expect(document.querySelector('g[aria-label^="CWH-I/217"]')).not.toBeNull();
    expect(screen.queryAllByTestId('fp-card')).toHaveLength(0);
    expect(screen.queryByTestId('fp-no-layout')).toBeNull();
  });

  it('over picked instruments, it asks for exactly those', () => {
    const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'];
    view(widget(QC.id, { mode: 'instruments', ids }), { trail: TRAIL });
    expect(viewCalls().length).toBeGreaterThan(0);
    for (const c of viewCalls()) expect(c).toStrictEqual([{ functionalLocationId: undefined, directOnly: undefined, instrumentIds: ids }]);
  });

  it('a card opens its instrument\'s trend page with the dashboard\'s origin and trail', () => {
    view(widget(QC.id), { trail: TRAIL });
    fireEvent.click(screen.getByTestId('fp-card'));
    const probe = screen.getByTestId('trend-probe');
    expect(probe.getAttribute('data-id')).toBe('216-00');
    expect(JSON.parse(probe.textContent!)).toEqual({ from: 'dashboard', trail: TRAIL });
  });

  it('with no host trail (the Add widget preview, a dashboard being edited) nothing leads off the page', () => {
    view(widget(QC.id));
    const card = screen.getByTestId('fp-card');
    expect(card.getAttribute('role')).toBeNull();
    expect(card.getAttribute('tabindex')).toBeNull();
    fireEvent.click(card);
    fireEvent.click(document.querySelector('g[aria-label^="CWH-I/216"]')!);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(screen.queryByTestId('trend-probe')).toBeNull();
    expect(document.querySelector('g[aria-label^="CWH-I/216"]')!.getAttribute('role')).toBe('group');
    // Full screen is gone too: its Escape would also close the Add widget dialog.
    expect(screen.queryByRole('button', { name: 'Full screen — floor plan' })).toBeNull();
  });

  it('Full screen still works from inside a widget card: the overlay is a portal on the page, outside the card', () => {
    view(widget(QC.id), { trail: TRAIL });
    fireEvent.click(screen.getByRole('button', { name: 'Full screen — floor plan' }));
    const overlay = document.querySelector('[data-fullscreen="true"]')!;
    expect(overlay).not.toBeNull();
    expect(overlay.parentElement).toBe(document.body);
    expect(screen.getByTestId('host').contains(overlay)).toBe(false);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('[data-fullscreen="true"]')).toBeNull();
  });

  it('I-1: ONE floor-plan behaviour — in its card the widget is drawn as the home panel is: fitted to the width, the body scrolling', () => {
    const noop = () => {};
    render(
      <MemoryRouter>
        <WidgetPanel
          widget={widget(QC.id)} item={{ i: `w:${QC.id}`, x: 0, y: 0, w: 12, h: 16 }} selection={SEL} trail={TRAIL}
          editing={false} onEdit={noop} onRemove={noop} onStyleChange={noop} onSizeChange={noop}
          autoHeight={false} onNaturalHeight={noop}
        />
      </MemoryRouter>,
    );
    // view root → the widget's root → the card's content wrapper: none of them is
    // handed the card's height, so the view's own `h-full` is auto — as on home.
    const widgetRoot = screen.getByTestId('floorplan-view').parentElement!;
    const contentWrapper = widgetRoot.parentElement!;
    for (const el of [widgetRoot, contentWrapper]) {
      expect(tokens(el)).not.toContain('h-full');
      expect(tokens(el)).not.toContain('flex-1');
    }
    // And the card's body is the scroll region, as on home.
    expect(tokens(contentWrapper.parentElement!)).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-auto']));
  });

  it('I-1: a new floor plan starts at the home floor panel\'s size', () => {
    const home = DEFAULT_DASHBOARD_LAYOUT.items.find((it) => it.i === 'telemetry_floorplan')!;
    expect(home).toMatchObject({ w: 12, h: 16 });
    expect(WIDGET_START_HEIGHT.floorplan).toBe(home.h);
  });

  it('loading, a failed load and a failed refresh are each said', () => {
    state.overview = { rows: [], isLoading: true, error: undefined };
    const a = view(widget(QC.id), { trail: TRAIL });
    expect(screen.getByText('Loading…')).toBeTruthy();
    a.unmount();
    state.overview = { rows: [], isLoading: false, error: Object.assign(new Error('500'), { status: 500 }) };
    const b = view(widget(QC.id), { trail: TRAIL });
    expect(screen.getByRole('alert').textContent).toBe('Could not load this widget.');
    b.unmount();
    state.overview = { rows: [row('216-00', 'q1', QC.id)], isLoading: false, error: Object.assign(new Error('502'), { status: 502 }) };
    view(widget(QC.id), { trail: TRAIL });
    expect(screen.getByTestId('fp-card')).toBeTruthy();
    expect(screen.getByTestId('widget-refresh-failed')).toBeTruthy();
  });
});
