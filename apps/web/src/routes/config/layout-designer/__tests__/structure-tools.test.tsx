import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The 2D structure tools (Layout Designer 2D, 2026-10-05): Column and
 * Equipment are dragged boxes, Window and Wall stub are two clicks (a window
 * along a wall lands ON it), Label is one click. Every edit is ONE PUT of the
 * plan's whole `annotations`; an element is selectable, editable in place and
 * deletable — and the Delete key takes the element, never a room selected
 * beside it.
 */
const PLAN = { id: 'p1', name: 'Blank', imagePath: null, imageWidth: 1600, imageHeight: 1200, isActive: true, sortOrder: 0, rooms: [] as unknown[], links: [] as unknown[], annotations: null as unknown };
const PLANS = { current: { data: [PLAN] } as { data: typeof PLAN[] } };
const DETAIL = { current: { ...PLAN } };
const mutate = vi.fn();
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/floorplans') return { data: PLANS.current, mutate };
    if (key && key.startsWith('/api/floorplans/')) return { data: DETAIL.current, mutate };
    if (key && key.startsWith('/api/instruments')) return { data: { data: [] }, mutate };
    return { data: undefined, mutate };
  },
}));
const post = vi.fn();
const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    post: (...a: unknown[]) => post(...a), put: (...a: unknown[]) => put(...a), delete: vi.fn(),
    postWithReauth: (...a: unknown[]) => post(...a), putWithReauth: (...a: unknown[]) => put(...a), deleteWithReauth: vi.fn(),
    get: vi.fn(), postFormData: vi.fn(),
  },
}));
vi.mock('@/lib/api-base', () => ({ getApiBase: () => '' }));
const toast = { success: vi.fn(), error: vi.fn(), successToast: vi.fn(), errorToast: vi.fn(), warning: vi.fn(), info: vi.fn() };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_a: string, cb: (pw?: string) => Promise<void>, opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }) => {
      try { await cb(undefined); opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    needsReauth: () => false, executeWithResult: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), setPassword: vi.fn(),
    isOpen: false, password: '', error: '', isVerifying: false,
  }),
}));
vi.mock('@/components/reauth-dialog', () => ({ ReauthDialog: () => null }));

// jsdom has no PointerEvent, so fireEvent.pointerDown would dispatch a bare
// Event with no button and no coordinates and every handler would ignore it.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: (MouseEventInit & { pointerId?: number }) | undefined) {
      super(type, init);
      this.pointerId = init?.pointerId ?? 1;
    }
  }
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}

const { LayoutDesignerPage } = await import('../index');
const renderPage = () => render(<MemoryRouter><LayoutDesignerPage /></MemoryRouter>);

/** The canvas is a 1000×750 viewBox; stub its box so pointer pixels map to plan units. */
const stubCanvas = () => {
  const svg = screen.getByTestId('designer-canvas');
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 750, right: 1000, bottom: 750, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  return svg;
};
const clickAt = (el: Element, x: number, y: number) => fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, pointerId: 1 });

const rect = (id: string, code: string, x: number, y: number, w: number, h: number) => ({
  id, code, label: null, grade: null, x, y, w, h, tempMin: null, tempMax: null, rhMin: null, rhMax: null, doors: null, points: null,
});
const twoD = (annotations: Record<string, unknown> = {}) => ({
  ...PLAN, annotations: { style: 'architectural', ...annotations }, rooms: [rect('A', 'A', 0.2, 0.2, 0.4, 0.3)],
});
const lastPut = () => put.mock.calls[put.mock.calls.length - 1] as [string, { annotations: Record<string, unknown[]> }];

beforeEach(() => {
  PLANS.current = { data: [twoD()] };
  DETAIL.current = { ...twoD() };
  post.mockReset().mockResolvedValue({ id: 'new' });
  put.mockReset().mockResolvedValue({});
  mutate.mockReset();
});

describe('structure tools on a 2D plan', () => {
  it('Column: a drag stores a snapped box through one PUT of the whole layer', async () => {
    renderPage();
    const svg = stubCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Column' }));
    clickAt(svg, 100, 100);                                             // 0.10, 0.133 → grid 0.10, 0.14
    fireEvent.pointerMove(svg, { clientX: 140, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 140, clientY: 130, pointerId: 1 });
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [url, body] = lastPut();
    expect(url).toBe('/api/floorplans/p1');
    expect(body.annotations.columns).toHaveLength(1);
    const c = body.annotations.columns[0] as { x: number; y: number; w: number; h: number };
    expect(c.x).toBeCloseTo(0.1, 2); expect(c.w).toBeCloseTo(0.04, 2); expect(c.h).toBeCloseTo(0.04, 2);
  });

  it('Equipment: the same gesture stores into the equipment layer', async () => {
    renderPage();
    const svg = stubCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Equipment' }));
    clickAt(svg, 300, 300);
    fireEvent.pointerMove(svg, { clientX: 360, clientY: 330, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 360, clientY: 330, pointerId: 1 });
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(lastPut()[1].annotations.equipment).toHaveLength(1);
    expect(lastPut()[1].annotations.columns).toEqual([]);
  });

  it("Window: two clicks along the room's top wall store a thin box ON the wall", async () => {
    renderPage();
    const svg = stubCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Window' }));
    clickAt(svg, 300, 152);   // y 0.2027, beside the top wall at y 0.2
    clickAt(svg, 400, 148);   // y 0.1973
    await waitFor(() => expect(put).toHaveBeenCalled());
    const w = lastPut()[1].annotations.windows[0] as { x: number; y: number; w: number; h: number };
    expect(w.x).toBeCloseTo(0.3, 3);
    expect(w.w).toBeCloseTo(0.1, 3);
    expect(w.y).toBeCloseTo(0.2 - 0.004, 3);
    expect(w.h).toBeCloseTo(0.008, 3);
  });

  it('Wall stub: two clicks across a room store a free segment', async () => {
    renderPage();
    const svg = stubCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Wall stub' }));
    clickAt(svg, 300, 250);
    clickAt(svg, 300, 330);
    await waitFor(() => expect(put).toHaveBeenCalled());
    const s = lastPut()[1].annotations.walls[0] as { x1: number; y1: number; x2: number; y2: number };
    expect(s.x1).toBeCloseTo(0.3, 2); expect(s.x2).toBeCloseTo(0.3, 2);
    expect(s.y2 - s.y1).toBeCloseTo(80 / 750, 2);
  });

  it('Label: one click stores a label and the panel edits its text', async () => {
    renderPage();
    const svg = stubCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Label' }));
    clickAt(svg, 500, 400);
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect((lastPut()[1].annotations.labels[0] as { text: string }).text).toBe('Label');
  });

  it('selecting a structure element shows its numbers; Delete removes just it, the room stays', async () => {
    PLANS.current = { data: [twoD({ columns: [{ x: 0.1, y: 0.1, w: 0.02, h: 0.02 }] })] };
    renderPage();
    stubCanvas();
    // Select the room first, then the column: the Delete key must take the column.
    clickAt(screen.getByTestId('room-A'), 300, 250);
    fireEvent.pointerUp(screen.getByTestId('designer-canvas'));
    clickAt(screen.getByTestId('structure-columns-0'), 110, 90);
    fireEvent.pointerUp(screen.getByTestId('designer-canvas'));
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('0.1');
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(lastPut()[1].annotations.columns).toEqual([]);
    expect(put.mock.calls.every(([u]) => u === '/api/floorplans/p1')).toBe(true); // never the room endpoint
  });

  it('editing a number in the panel saves the element in place', async () => {
    PLANS.current = { data: [twoD({ labels: [{ x: 0.5, y: 0.5, text: 'HPLC' }] })] };
    renderPage();
    stubCanvas();
    clickAt(screen.getByTestId('structure-labels-0'), 500, 375);
    fireEvent.pointerUp(screen.getByTestId('designer-canvas'));
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'GC ROOM' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save element' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(lastPut()[1].annotations.labels).toEqual([{ x: 0.5, y: 0.5, text: 'GC ROOM' }]);
  });

  it('a 2D plan draws the structure layer in the designer', () => {
    PLANS.current = { data: [twoD({ columns: [{ x: 0.1, y: 0.1, w: 0.02, h: 0.02 }], windows: [{ x: 0.3, y: 0.196, w: 0.1, h: 0.008 }], walls: [{ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.6 }], equipment: [{ x: 0.3, y: 0.3, w: 0.05, h: 0.03 }], labels: [{ x: 0.5, y: 0.5, text: 'HPLC' }] })] };
    renderPage();
    const layer = screen.getByTestId('ld-structure');
    expect(layer.querySelectorAll('[data-structure="column"]')).toHaveLength(1);
    expect(layer.querySelectorAll('[data-structure="window"]')).toHaveLength(1);
    expect(layer.querySelectorAll('[data-structure="wall"]')).toHaveLength(1);
    expect(layer.querySelectorAll('[data-structure="equipment"]')).toHaveLength(1);
    expect(screen.getByText('HPLC')).toBeInTheDocument();
  });
});
