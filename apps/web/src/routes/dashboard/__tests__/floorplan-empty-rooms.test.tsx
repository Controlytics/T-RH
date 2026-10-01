import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { TILE_CODE_FONT, TILE_LOCATION_FONT } from '../room-geometry';

/**
 * Operator, 2026-10-01: "which ever dont have instrument ids those rooms should
 * be unclickable and increase location name font size and instrument id font
 * size". Mounted for real: a room with an instrument is a button that opens its
 * detail; a room with none is not a button at all.
 */
const room = (id: string, code: string, label: string | null, x: number) => ({
  id, code, label, grade: null, x, y: 0.1, w: 0.4, h: 0.6,
  tempMin: null, tempMax: null, rhMin: null, rhMax: null, doors: null, meta: null, points: null,
});
const PLAN = {
  id: 'p', name: 'Plan', imagePath: null, imageWidth: 1000, imageHeight: 600, isActive: true, sortOrder: 0,
  annotations: null, links: [],
  rooms: [room('lab', 'R-LAB', 'LAB', 0.05), room('office', 'R-OFF', 'OFFICE', 0.55)],
};
const ROWS = [{
  instrumentId: 'i1', code: 'CWH/RDU/001-00', name: 'CWH/RDU/001-00', isActive: true,
  room: { id: 'lab', code: 'R-LAB', label: 'LAB', floorplanId: 'p' },
  locationAttribute: 'Wet lab (QC)', limits: null, status: 'OK', reporting: true,
  temperature: { key: 't', value: 21.5 }, humidity: { key: 'h', value: 45 },
  decimals: { temperature: 1, humidity: 0 }, sensorError: null, rangeError: null,
}];
vi.mock('swr', () => ({ default: () => ({ data: undefined, error: undefined, isLoading: false, mutate: vi.fn() }) }));
vi.mock('../use-telemetry', async (orig) => ({
  ...(await orig<typeof import('../use-telemetry')>()),
  useFloorplans: () => ({ plans: [PLAN], isLoading: false, error: undefined }),
  useTelemetryOverview: () => ({ rows: ROWS, isLoading: false, error: undefined }),
}));

const { FloorplanView } = await import('../floorplan-view');
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}</p>; }
const mount = () => render(
  <MemoryRouter initialEntries={['/']}>
    <Routes><Route path="/" element={<FloorplanView />} /><Route path="*" element={<Where />} /></Routes>
  </MemoryRouter>,
);

describe('rooms without an instrument are not clickable (2026-10-01)', () => {
  it('the instrument room is a button; the empty room is not, and has no tab stop', () => {
    mount();
    const buttons = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '');
    expect(buttons.some((l) => l.startsWith('R-LAB'))).toBe(true);
    expect(buttons.some((l) => l.startsWith('R-OFF'))).toBe(false);
    const office = document.querySelector('g[aria-label^="R-OFF"]')!;
    expect(office.getAttribute('tabindex')).toBeNull();
    expect((office as HTMLElement).style.cursor).toBe('');
    // No hover darkening either: that effect says "clickable".
    expect(office.querySelector('polygon')!.getAttribute('class')).toBeNull();
    expect(document.querySelector('g[aria-label^="R-LAB"] polygon')!.getAttribute('class')).toBe('fp-room-fill');
  });

  it('clicking the empty room goes nowhere', () => {
    mount();
    fireEvent.click(document.querySelector('g[aria-label^="R-OFF"]')!);
    expect(screen.queryByTestId('where')).toBeNull();
  });

  it("clicking a room opens its instrument's TREND page (operator: \"redirect to that instrument trends page\")", () => {
    mount();
    fireEvent.click(document.querySelector('g[aria-label^="R-LAB"]')!);
    expect(screen.getByTestId('where')).toHaveTextContent('/instruments/i1/trend');
  });

  it('clicking the reading tile opens the same trend page', () => {
    mount();
    fireEvent.click(document.querySelector('g[aria-label^="CWH/RDU/001-00"]')!);
    expect(screen.getByTestId('where')).toHaveTextContent('/instruments/i1/trend');
  });

  it('prints the instrument ID and its Location larger than before (14 and 12)', () => {
    expect(TILE_CODE_FONT).toBe(14);
    expect(TILE_LOCATION_FONT).toBe(12);
    mount();
    const code = screen.getByText('CWH/RDU/001-00');
    const loc = screen.getByText('Wet lab (QC)');
    expect(Number(code.getAttribute('font-size'))).toBeGreaterThan(10);
    expect(Number(loc.getAttribute('font-size'))).toBeGreaterThan(8.5);
  });
});
