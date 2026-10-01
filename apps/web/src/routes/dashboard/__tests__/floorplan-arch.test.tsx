import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { placeCard, avoidObstacles } from '../room-geometry';

/**
 * The 2D ARCHITECTURAL style (2026-10-01, operator: "2d layout was good replace
 * with that QC layout"). A plan opts in through `annotations.style`; every
 * other plan draws exactly as before. Mounted for real.
 */
const room = (id: string, code: string, label: string | null, x: number, extra: Record<string, unknown> = {}) => ({
  id, code, label, grade: null, x, y: 0.1, w: 0.4, h: 0.6,
  tempMin: null, tempMax: null, rhMin: null, rhMax: null, doors: null, meta: null, points: null, ...extra,
});
const ANN = { equipment: [], hvac: [], water: [], airflow: [], labels: [], columns: [{ x: 0.4, y: 0.6, w: 0.04, h: 0.06 }], windows: [], walls: [] };
const planOf = (style?: string) => ({
  id: 'p', name: 'Plan', imagePath: null, imageWidth: 1000, imageHeight: 600, isActive: true, sortOrder: 0,
  annotations: style ? { ...ANN, style } : ANN, links: [],
  rooms: [room('lab', 'R-LAB', 'LAB', 0.05), room('off', 'R-OFF', 'OFFICE', 0.55)],
});
const row = (over: Record<string, unknown>) => ({
  instrumentId: 'i1', code: 'CWH/RDU/001-00', name: 'CWH/RDU/001-00', isActive: true,
  room: { id: 'lab', code: 'R-LAB', label: 'LAB', floorplanId: 'p' },
  locationAttribute: 'Wet lab (QC)', limits: { tempMin: 15, tempMax: 25, rhMin: 30, rhMax: 60 }, status: 'OK', reporting: true,
  temperature: { key: 't', value: 21.5 }, humidity: { key: 'h', value: 45 },
  decimals: { temperature: 1, humidity: 0 }, sensorError: null, rangeError: null, ...over,
});

let PLAN: ReturnType<typeof planOf> = planOf('architectural');
let ROWS: ReturnType<typeof row>[] = [row({})];
vi.mock('swr', () => ({ default: () => ({ data: undefined, error: undefined, isLoading: false, mutate: vi.fn() }) }));
vi.mock('../use-telemetry', async (orig) => ({
  ...(await orig<typeof import('../use-telemetry')>()),
  useFloorplans: () => ({ plans: [PLAN], isLoading: false, error: undefined }),
  useTelemetryOverview: () => ({ rows: ROWS, isLoading: false, error: undefined }),
}));

const { FloorplanView, cardTone, roomTone, archSummary } = await import('../floorplan-view');
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}</p>; }
const mount = () => render(
  <MemoryRouter initialEntries={['/']}>
    <Routes><Route path="/" element={<FloorplanView />} /><Route path="*" element={<Where />} /></Routes>
  </MemoryRouter>,
);
const WORDS = { failure: 'Error', outOfRange: 'OL' };

describe('the style switch', () => {
  it('a plan WITHOUT the style draws as before: no 2D layer, no side panel, the legend bar', () => {
    PLAN = planOf(); ROWS = [row({})];
    mount();
    expect(screen.queryByTestId('fp-arch')).toBeNull();
    expect(screen.queryByTestId('fp-arch-panel')).toBeNull();
    expect(screen.getByText('Reading colour:')).toBeInTheDocument();
  });

  it('a plan WITH it draws walls, a card per instrument, the side panel, and no legend bar', () => {
    PLAN = planOf('architectural'); ROWS = [row({})];
    mount();
    expect(screen.getByTestId('fp-arch')).toBeInTheDocument();
    const card = screen.getByTestId('fp-card');
    expect(card).toHaveAttribute('data-tone', 'OK');
    expect(card).toHaveTextContent('CWH/RDU/001-00');
    expect(card).toHaveTextContent('Wet lab (QC)');
    expect(card).toHaveTextContent('21.5 °C');
    expect(card).toHaveTextContent('45 %RH');
    // The ID and the Location are large and BOLD (2026-10-01, operator).
    const id = [...card.querySelectorAll('text')].find((t) => t.textContent === 'CWH/RDU/001-00')!;
    const loc = [...card.querySelectorAll('text')].find((t) => t.textContent === 'Wet lab (QC)')!;
    expect(id.getAttribute('font-weight')).toBe('800');
    expect(Number(id.getAttribute('font-size'))).toBeCloseTo(15.5);
    expect(loc.getAttribute('font-weight')).toBe('700');
    expect(Number(loc.getAttribute('font-size'))).toBeCloseTo(14);
    expect(screen.getByTestId('fp-arch-panel')).toHaveTextContent('Plan north');
    expect(screen.queryByText('Reading colour:')).toBeNull();
  });

  it('the room floor is washed by its status, and an empty room prints its name and number', () => {
    PLAN = planOf('architectural'); ROWS = [row({ humidity: { key: 'h', value: 72 }, status: 'OUT_OF_SPEC' })];
    mount();
    expect(document.querySelector('g[aria-label^="R-LAB"] polygon')).toHaveAttribute('data-tone', 'OUT_OF_SPEC');
    expect(screen.getByTestId('fp-card')).toHaveAttribute('data-tone', 'OUT_OF_SPEC');
    expect(screen.getByText('OFFICE')).toBeInTheDocument();
    expect(screen.getByText('R-OFF')).toBeInTheDocument();
  });

  it('a card opens its instrument’s trend page', () => {
    PLAN = planOf('architectural'); ROWS = [row({})];
    mount();
    fireEvent.click(screen.getByTestId('fp-card'));
    expect(screen.getByTestId('where')).toHaveTextContent('/instruments/i1/trend');
  });

  it('the summary counts one bucket per instrument, so they sum', () => {
    PLAN = planOf('architectural');
    ROWS = [
      row({}),
      row({ instrumentId: 'i2', code: 'B', humidity: { key: 'h', value: 72 }, status: 'OUT_OF_SPEC' }),
      row({ instrumentId: 'i3', code: 'C', temperature: null, sensorError: { temperature: true, humidity: false } }),
      row({ instrumentId: 'i4', code: 'D', status: 'STALE', reporting: false }),
    ];
    mount();
    const panel = screen.getByTestId('fp-arch-panel');
    const value = (label: string) => panel.querySelector(`dt:not(:empty)`) && [...panel.querySelectorAll('dl > div')]
      .find((d) => d.querySelector('dt')?.textContent === label)?.querySelector('dd')?.textContent;
    expect(value('Instruments')).toBe('4');
    expect(value('In limit')).toBe('1');
    expect(value('Out of limit')).toBe('1');
    expect(value('Sensor error')).toBe('1');
    expect(value('Offline / no data')).toBe('1');
  });
});

describe('cardTone / roomTone / archSummary', () => {
  it('a breach beats a failed probe beats the server status', () => {
    expect(cardTone(row({}) as never, WORDS)).toBe('OK');
    expect(cardTone(row({ humidity: { key: 'h', value: 72 } }) as never, WORDS)).toBe('OUT_OF_SPEC');
    expect(cardTone(row({ temperature: null, sensorError: { temperature: true, humidity: false } }) as never, WORDS)).toBe('ERROR');
    expect(cardTone(row({ status: 'STALE' }) as never, WORDS)).toBe('STALE');
    // The server's verdict is honoured even when no slot reads as breached here.
    expect(cardTone(row({ status: 'OUT_OF_SPEC' }) as never, WORDS)).toBe('OUT_OF_SPEC');
  });
  it('a room takes its worst instrument; no instruments = no tone', () => {
    expect(roomTone([], WORDS)).toBeNull();
    expect(roomTone([row({}), row({ status: 'STALE' })] as never, WORDS)).toBe('STALE');
    expect(roomTone([row({ status: 'STALE' }), row({ humidity: { key: 'h', value: 72 } })] as never, WORDS)).toBe('OUT_OF_SPEC');
  });
  it('the counts sum to the total', () => {
    const s = archSummary([row({}), row({ status: 'PARTIAL' }), row({ status: 'NO_DATA' })] as never, WORDS);
    expect(s).toEqual({ total: 3, ok: 1, outOfLimit: 0, fault: 0, other: 2 });
  });
});

describe('placeCard', () => {
  const box = { x: 0, y: 0, w: 300, h: 400 };
  it('a clear room gets a full-size card in its middle', () => {
    const c = placeCard(box, [], 196, 104)!;
    expect(c.k).toBe(1);
    expect(c.x + c.w / 2).toBeCloseTo(150, -1);
    expect(c.y + c.h / 2).toBeCloseTo(200, -1);
  });
  it('steps aside from an obstacle at full size rather than shrinking', () => {
    const swing = { x: 0, y: 150, w: 300, h: 60 }; // a band across the middle
    const c = placeCard(box, [swing], 196, 104)!;
    expect(c.k).toBe(1);
    expect(c.y + c.h <= swing.y || c.y >= swing.y + swing.h).toBe(true);
  });
  it('shrinks only when no full-size position is clear, and never past its last step', () => {
    const small = { x: 0, y: 0, w: 220, h: 120 };
    const c = placeCard(small, [{ x: 0, y: 70, w: 60, h: 50 }], 196, 104)!;
    expect(c.k).toBeLessThan(1);
    expect(placeCard({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 0, y: 0, w: 100, h: 100 }], 196, 104)).toBeNull();
  });
});

describe('avoidObstacles', () => {
  it('gives up the side a column stands on, and leaves a clear box alone', () => {
    const box = { x: 0, y: 0, w: 260, h: 140 };
    expect(avoidObstacles(box, [{ x: 225, y: 90, w: 60, h: 60 }])).toEqual({ x: 0, y: 0, w: 225, h: 140 });
    expect(avoidObstacles(box, [{ x: 400, y: 0, w: 10, h: 10 }])).toEqual(box);
  });
});
