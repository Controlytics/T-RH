import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { FloorplanShape } from '../use-telemetry';

/**
 * Which layouts the graphical view offers, and a building of several floors
 * (2026-10-01, operator: "for module F there are 2 layouts ground floor and
 * first floor, we need to show as 2 seperate layouts in Module F, we need to
 * give option in Module F like Ground Floor and First floor"; and "when ever
 * im going to cwh block and click on area and going to graphical view there
 * all areas layouts was displaying only that area layout should be displayed
 * other areas should not displayed"). Mounted for real, with several plans.
 */
const room = (id: string, code: string, x = 0.05) => ({
  id, code, label: code, grade: null, x, y: 0.1, w: 0.4, h: 0.6,
  tempMin: null, tempMax: null, rhMin: null, rhMax: null, doors: null, meta: null, points: null,
});
const ANN = { style: 'architectural' as const, equipment: [], hvac: [], water: [], airflow: [], labels: [], columns: [], windows: [], walls: [] };
const plan = (id: string, name: string, rooms: ReturnType<typeof room>[], ann: Record<string, unknown> = {}): FloorplanShape => ({
  id, name, imagePath: null, imageWidth: 1000, imageHeight: 600, isActive: true, sortOrder: 0, links: [], rooms, annotations: { ...ANN, ...ann } as FloorplanShape['annotations'],
});
const GROUND = plan('pg', 'CWH — Module-F — Ground Floor', [room('g1', 'CWH-I/036'), room('g2', 'CWH-I/037', 0.55)],
  { floor: { group: 'CWH — Module-F', label: 'Ground Floor', order: 0 }, north: 90 });
const FIRST = plan('pf', 'CWH — Module-F — First Floor', [room('f1', 'CWH-I/041'), room('f2', 'CWH-I/042', 0.55)],
  { floor: { group: 'CWH — Module-F', label: 'First Floor', order: 1 }, north: 90 });
const QC = plan('pq', 'CWH — QC', [room('q1', 'CWH-I/216')]);
const row = (id: string, roomId: string, planId: string) => ({
  instrumentId: id, code: id, name: id, isActive: true,
  room: { id: roomId, code: roomId, label: roomId, floorplanId: planId },
  locationAttribute: 'Somewhere', limits: { tempMin: 15, tempMax: 25, rhMin: 30, rhMax: 60 }, status: 'OK', reporting: true,
  temperature: { key: 't', value: 21.5 }, humidity: { key: 'h', value: 45 },
  decimals: { temperature: 1, humidity: 0 }, sensorError: null, rangeError: null,
});
const ALL_ROWS = [row('CWH/RDU/040-00', 'g1', 'pg'), row('CWH/RDU/042-00', 'g2', 'pg'), row('CWH/RDU/041-00', 'f1', 'pf'), row('CWH/RDU/001-00', 'q1', 'pq')];

// The server sends the first floor BEFORE the ground floor (plans are ordered
// by sortOrder then name, and "First" sorts before "Ground").
let PLANS: FloorplanShape[] = [FIRST, GROUND, QC];
let ROWS: ReturnType<typeof row>[] = ALL_ROWS;
let ROWS_LOADING = false;
vi.mock('swr', () => ({ default: () => ({ data: undefined, error: undefined, isLoading: false, mutate: vi.fn() }) }));
vi.mock('../use-telemetry', async (orig) => ({
  ...(await orig<typeof import('../use-telemetry')>()),
  useFloorplans: () => ({ plans: PLANS, isLoading: false, error: undefined }),
  useTelemetryOverview: () => ({ rows: ROWS, isLoading: ROWS_LOADING, error: undefined }),
}));

const { FloorplanView, plansForSelection, planEntries, northMark, chooseCard, chooseCardOverPlant, cardHeadingFont, splitLabel, codeFont, cardSpec, LEGIBLE_LOC_FONT } = await import('../floorplan-view');
const mount = (props: { functionalLocationId?: string } = {}) => render(<MemoryRouter><FloorplanView {...props} /></MemoryRouter>);
const titleBar = () => screen.getByTestId('floorplan-view').firstElementChild as HTMLElement;
const shown = () => document.querySelector('svg[role="img"]')!.getAttribute('aria-label')!;

describe('plansForSelection', () => {
  it('unscoped offers every plan; scoped, only the plans holding one of the selection’s rooms, in order', () => {
    const placed = new Set(['f1']);
    expect(plansForSelection([FIRST, GROUND, QC], placed, false)).toEqual([FIRST, GROUND, QC]);
    expect(plansForSelection([FIRST, GROUND, QC], placed, true)).toEqual([FIRST]);
    expect(plansForSelection([FIRST, GROUND, QC], new Set(['g2', 'q1']), true)).toEqual([GROUND, QC]);
    expect(plansForSelection([FIRST, GROUND, QC], new Set(), true)).toEqual([]);
  });
});

describe('planEntries', () => {
  it('lists a building of several floors ONCE, where its first plan was, floors lowest order first; every other plan alone', () => {
    const entries = planEntries([FIRST, QC, GROUND]);
    expect(entries.map((e) => e.name)).toEqual(['CWH — Module-F', 'CWH — QC']);
    expect(entries[0].floors.map((p) => p.name)).toEqual(['CWH — Module-F — Ground Floor', 'CWH — Module-F — First Floor']);
    expect(entries[1].floors).toEqual([QC]);
    expect(entries[0].key).not.toBe(entries[1].key);
  });

  it('a plan with no floor, or a blank group, is its own entry', () => {
    const blank = plan('pb', 'Blank group', [], { floor: { group: '  ', label: 'X', order: 0 } });
    expect(planEntries([QC, blank]).map((e) => [e.name, e.floors.length])).toEqual([['CWH — QC', 1], ['Blank group', 1]]);
  });
});

describe('the floor switch', () => {
  it('names the building, offers its floors with the GROUND floor shown first, and the other layouts beside', () => {
    PLANS = [FIRST, GROUND, QC]; ROWS = ALL_ROWS; ROWS_LOADING = false;
    mount();
    const bar = titleBar();
    expect(within(bar).getByRole('heading')).toHaveTextContent('CWH — Module-F');
    const sw = within(bar).getByTestId('fp-floor-switch');
    const ground = within(sw).getByRole('button', { name: 'Ground Floor' });
    const first = within(sw).getByRole('button', { name: 'First Floor' });
    expect(ground).toHaveAttribute('aria-pressed', 'true');
    expect(first).toHaveAttribute('aria-pressed', 'false');
    expect(shown()).toMatch(/^CWH — Module-F — Ground Floor:/);
    // The other layout is one button; the building's floors are NOT listed there again.
    expect(within(bar).getByRole('button', { name: 'CWH — QC' })).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: 'CWH — Module-F — First Floor' })).toBeNull();
  });

  it('choosing a floor shows THAT floor and presses its button; the other layouts stay', () => {
    PLANS = [FIRST, GROUND, QC]; ROWS = ALL_ROWS; ROWS_LOADING = false;
    mount();
    fireEvent.click(within(titleBar()).getByRole('button', { name: 'First Floor' }));
    expect(shown()).toMatch(/^CWH — Module-F — First Floor:/);
    expect(within(titleBar()).getByRole('button', { name: 'First Floor' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(titleBar()).getByRole('button', { name: 'Ground Floor' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(titleBar()).getByRole('button', { name: 'CWH — QC' })).toBeInTheDocument();
  });

  it('a plan that is no floor of anything has no switch; the building is offered beside it and opens on its ground floor', () => {
    PLANS = [QC, FIRST, GROUND]; ROWS = ALL_ROWS; ROWS_LOADING = false;
    mount();
    expect(shown()).toMatch(/^CWH — QC:/);
    expect(screen.queryByTestId('fp-floor-switch')).toBeNull();
    fireEvent.click(within(titleBar()).getByRole('button', { name: 'CWH — Module-F' }));
    expect(shown()).toMatch(/^CWH — Module-F — Ground Floor:/);
    expect(screen.getByTestId('fp-floor-switch')).toBeInTheDocument();
  });

  it('full screen shows the floor’s own name and no switch', () => {
    PLANS = [FIRST, GROUND, QC]; ROWS = ALL_ROWS; ROWS_LOADING = false;
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Full screen — floor plan' }));
    const full = screen.getByTestId('floorplan-view');
    expect(full).toHaveAttribute('data-fullscreen', 'true');
    expect(within(full).getByRole('heading')).toHaveTextContent('CWH — Module-F — Ground Floor');
    expect(within(full).queryByTestId('fp-floor-switch')).toBeNull();
  });
});

describe('only the selected location’s layouts', () => {
  it('with a location selected, the plans that hold none of its instruments are not offered', () => {
    // The selection's rows: Module-F's three (the server scoped them).
    PLANS = [FIRST, GROUND, QC]; ROWS = ALL_ROWS.slice(0, 3); ROWS_LOADING = false;
    mount({ functionalLocationId: 'loc-module-f' });
    const bar = titleBar();
    expect(within(bar).getByRole('heading')).toHaveTextContent('CWH — Module-F');
    expect(within(bar).queryByRole('button', { name: 'CWH — QC' })).toBeNull();
    expect(screen.getByTestId('fp-floor-switch')).toBeInTheDocument();
    expect(shown()).toMatch(/^CWH — Module-F — Ground Floor:/);
  });

  it('a floor holding none of the selection’s instruments is still offered as part of its building’s switch only when it holds one', () => {
    // Only the first floor's instrument in the selection: the switch has one floor — no switch — and the ground floor is not offered.
    PLANS = [FIRST, GROUND, QC]; ROWS = [ALL_ROWS[2]]; ROWS_LOADING = false;
    mount({ functionalLocationId: 'loc-first-only' });
    expect(shown()).toMatch(/^CWH — Module-F — First Floor:/);
    expect(screen.queryByTestId('fp-floor-switch')).toBeNull();
    expect(within(titleBar()).queryByRole('button', { name: 'CWH — QC' })).toBeNull();
  });

  it('a selection placed on no plan at all says so, and draws no other area’s layout', () => {
    PLANS = [FIRST, GROUND, QC]; ROWS = [row('CWH/RDU/099-00', 'nowhere', 'px')]; ROWS_LOADING = false;
    mount({ functionalLocationId: 'loc-unplaced' });
    expect(screen.getByTestId('fp-no-layout')).toHaveTextContent("No layout shows this location's instruments.");
    expect(document.querySelector('svg[role="img"]')).toBeNull();
  });

  it('while the selection’s rows are still loading it says nothing of the kind', () => {
    PLANS = [FIRST, GROUND, QC]; ROWS = []; ROWS_LOADING = true;
    mount({ functionalLocationId: 'loc-module-f' });
    expect(screen.queryByTestId('fp-no-layout')).toBeNull();
    ROWS_LOADING = false;
  });

  it('with nothing selected every layout is offered, whatever the rows', () => {
    PLANS = [FIRST, GROUND, QC]; ROWS = [ALL_ROWS[3]]; ROWS_LOADING = false;
    mount();
    expect(within(titleBar()).getByRole('button', { name: 'CWH — QC' })).toBeInTheDocument();
    expect(screen.getByTestId('fp-floor-switch')).toBeInTheDocument();
  });
});

describe('north', () => {
  it('northMark: a drawing that marks north turns the arrow there and drops the disclaimer; one that does not keeps "plan north"', () => {
    expect(northMark(undefined).marked).toBe(false);
    expect(northMark(null).caption).toBe('Plan north');
    expect(northMark(90)).toMatchObject({ marked: true, angle: 90, caption: 'North', label: 'North is to the right of the drawing' });
    expect(northMark(-90).angle).toBe(270);
    expect(northMark(45).label).toBe('North is to 45° clockwise from the top of the drawing');
  });

  it('on the plan: the Module-F floors say North, to the right; a plan without it says Plan north', () => {
    PLANS = [FIRST, GROUND, QC]; ROWS = ALL_ROWS; ROWS_LOADING = false;
    mount();
    let n = screen.getByTestId('fp-north');
    expect(n).toHaveAttribute('data-north', '90');
    expect(within(n).getByRole('img')).toHaveAttribute('aria-label', 'North is to the right of the drawing');
    expect(n.querySelector('path')).toHaveAttribute('transform', 'rotate(90)');
    expect(n).toHaveTextContent('North');
    expect(n).not.toHaveTextContent('Plan north');
    fireEvent.click(within(titleBar()).getByRole('button', { name: 'CWH — QC' }));
    n = screen.getByTestId('fp-north');
    expect(n).not.toHaveAttribute('data-north');
    expect(n.querySelector('path')).not.toHaveAttribute('transform');
    expect(n).toHaveTextContent('Plan north');
  });
});

describe('a card and the plant in its room', () => {
  const inner = { x: 0, y: 0, w: 90, h: 190 };
  // A hopper outlined in the middle of a room 90 x 190 (Module-F's BLENDER CHARGING AREA-01).
  const hopper = { x: 22, y: 55, w: 46, h: 110 };
  const code = 'CWH/RDU/041-00', location = 'Blender Charging Area-01';

  it('kept clear of the hopper the card is illegible; drawn over it, it is not — and that is the card chosen', () => {
    const clear = chooseCard(inner, [hopper], location, code)!;
    expect(cardHeadingFont(clear, location, code)).toBeLessThan(LEGIBLE_LOC_FONT - 2);
    const chosen = chooseCardOverPlant(inner, [], [hopper], location, code)!;
    expect(cardHeadingFont(chosen, location, code)).toBeGreaterThan(cardHeadingFont(clear, location, code) + 2);
    expect(chosen).toEqual(chooseCard(inner, [], location, code));
  });

  it('a room whose card is legible beside its plant keeps it there', () => {
    const big = { x: 0, y: 0, w: 400, h: 360 };
    const plant = { x: 150, y: 120, w: 100, h: 120 };
    const clear = chooseCard(big, [plant], location, code)!;
    expect(cardHeadingFont(clear, location, code)).toBeGreaterThanOrEqual(LEGIBLE_LOC_FONT);
    expect(chooseCardOverPlant(big, [], [plant], location, code)).toEqual(clear);
  });

  it('the plant is drawn UNDER the cards, after the walls', () => {
    PLANS = [plan('pp', 'Plant', [room('r1', 'ROOM')], { equipment: [{ x: 0.2, y: 0.3, w: 0.1, h: 0.2 }] })]; ROWS = [row('CWH/RDU/041-00', 'r1', 'pp')]; ROWS_LOADING = false;
    mount();
    const plantLayer = screen.getByTestId('fp-plant');
    const card = screen.getByTestId('fp-card');
    expect(plantLayer.querySelectorAll('[data-structure="equipment"]')).toHaveLength(1);
    // Drawn before = under.
    expect(plantLayer.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('fp-arch').contains(plantLayer)).toBe(true);
    expect(screen.queryByTestId('fp-structure')).toBeNull();
  });
});

describe('the narrow-room card wins a tie on the two-line ID', () => {
  it('a room where the Location binds on every shape takes mini for its larger ID', () => {
    // Ground-floor BINDER PREPARATION, as drawn: 92 x 136 units.
    const card = chooseCard({ x: 0, y: 0, w: 92, h: 136 }, [], 'Binder preparation Area', 'CWH/RDU/038-00')!;
    expect(card.shape).toBe('mini');
    expect(codeFont(cardSpec('mini', 'Binder preparation Area'), card.k, 'CWH/RDU/038-00')).toBeGreaterThan(12);
  });

  it('splitLabel: the mini card wraps to three lines as soon as a two-line half is over its wrap', () => {
    expect(splitLabel('Blender Charging Area-01', 12)).toEqual(['Blender Charging', 'Area-01']);
    expect(splitLabel('Blender Charging Area-01', 12, 1)).toEqual(['Blender', 'Charging', 'Area-01']);
    // A label with no space cannot take three lines, whatever the threshold.
    expect(splitLabel('LAF-1(Microbiology)', 12, 1)).toEqual(['LAF-1', '(Microbiology)']);
  });
});
