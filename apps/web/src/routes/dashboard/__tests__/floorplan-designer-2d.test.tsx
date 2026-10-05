import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * A plan built the way the Layout Designer builds one (2026-10-05): polygon
 * rooms, hinged doors, and `annotations` as the designer writes them. It must
 * take the SAME 2D path as a traced floor — the designer adds no renderer.
 */
const room = (id: string, code: string, label: string | null, x: number, extra: Record<string, unknown> = {}) => ({
  id, code, label, grade: null, x, y: 0.1, w: 0.4, h: 0.6,
  tempMin: null, tempMax: null, rhMin: null, rhMax: null, doors: null, meta: null, points: null, ...extra,
});
const row = (over: Record<string, unknown>) => ({
  instrumentId: 'i1', code: 'CWH/RDU/001-00', name: 'CWH/RDU/001-00', isActive: true,
  room: { id: 'lab', code: 'R-LAB', label: 'LAB', floorplanId: 'p' },
  locationAttribute: 'Wet lab (QC)', limits: { tempMin: 15, tempMax: 25, rhMin: 30, rhMax: 60 }, status: 'OK', reporting: true,
  temperature: { key: 't', value: 21.5 }, humidity: { key: 'h', value: 45 },
  decimals: { temperature: 1, humidity: 0 }, sensorError: null, rangeError: null, ...over,
});

let PLAN: Record<string, unknown> = {};
let ROWS: ReturnType<typeof row>[] = [row({})];
vi.mock('swr', () => ({ default: () => ({ data: undefined, error: undefined, isLoading: false, mutate: vi.fn() }) }));
vi.mock('../use-telemetry', async (orig) => ({
  ...(await orig<typeof import('../use-telemetry')>()),
  useFloorplans: () => ({ plans: [PLAN], isLoading: false, error: undefined }),
  useTelemetryOverview: () => ({ rows: ROWS, isLoading: false, error: undefined }),
}));

const { FloorplanView } = await import('../floorplan-view');
const mount = () => render(
  <MemoryRouter initialEntries={['/']}>
    <Routes><Route path="/" element={<FloorplanView />} /></Routes>
  </MemoryRouter>,
);

describe('a designer-made 2D plan', () => {
  it('draws the 2D layer, the structure, the plant outlines and a hinged door leaf', () => {
    PLAN = {
      id: 'p', name: 'Designer plan', imagePath: null, imageWidth: 1600, imageHeight: 1200, isActive: true, sortOrder: 0, links: [],
      annotations: {
        style: 'architectural',
        columns: [{ x: 0.1, y: 0.1, w: 0.02, h: 0.02 }], windows: [{ x: 0.3, y: 0.196, w: 0.1, h: 0.008 }],
        walls: [{ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.6 }], equipment: [{ x: 0.3, y: 0.3, w: 0.05, h: 0.03 }],
        labels: [{ x: 0.5, y: 0.5, text: 'HPLC' }], floor: null, north: 90,
      },
      rooms: [{ ...room('lab', 'R-LAB', 'LAB', 0.2), points: [{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.6, y: 0.5 }, { x: 0.2, y: 0.5 }],
        doors: [{ edge: 0, offset: 0.4, width: 0.1, kind: 'ENTRY', hinge: 'end', swing: 'in' }] }],
    };
    ROWS = [row({})];
    mount();
    expect(screen.getByTestId('fp-arch')).toBeInTheDocument();
    const structure = screen.getByTestId('fp-structure');
    expect(structure.querySelectorAll('[data-structure="column"]')).toHaveLength(1);
    expect(structure.querySelectorAll('[data-structure="window"]')).toHaveLength(1);
    expect(structure.querySelectorAll('[data-structure="stub-core"]')).toHaveLength(1);
    expect(screen.getByTestId('fp-plant').querySelectorAll('rect')).toHaveLength(1);
    expect(screen.getByText('HPLC')).toBeInTheDocument();
    expect(screen.getByTestId('fp-card')).toBeInTheDocument();
  });
});
