import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Two review findings of 2026-10-12 on the Layout Designer page.
 *
 * 3 — doors and openings follow their WALL when a corner is inserted or
 *     deleted: the room PUT carries the doors on their new edge numbers and
 *     the room's own openings as `linkEdges` (they were re-sent unchanged and
 *     landed on the wrong wall).
 * 4 — the 2D layer is saved with the plan's version (`expectedUpdatedAt`); a
 *     cancelled or refused save is ROLLED BACK so the next edit does not
 *     re-send it; one layer save at a time.
 */
const rect = (id: string, code: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) => ({
  id, code, label: null, grade: null, x, y, w, h, tempMin: null, tempMax: null, rhMin: null, rhMax: null, doors: null, points: null, ...extra,
});
const BASE = { id: 'p1', name: 'Blank', imagePath: null, imageWidth: 1600, imageHeight: 1200, isActive: true, sortOrder: 0, updatedAt: '2026-10-12T10:00:00.000Z' };
type Plan = typeof BASE & { rooms: unknown[]; links: unknown[]; annotations: unknown };
const PLANS: { current: { data: Plan[] } } = { current: { data: [] } };
const DETAIL: { current: Plan | null } = { current: null };
const mutate = vi.fn();
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/floorplans') return { data: PLANS.current, mutate };
    if (key && key.startsWith('/api/floorplans/')) return { data: DETAIL.current, mutate };
    if (key && key.startsWith('/api/instruments')) return { data: { data: [] }, mutate };
    return { data: undefined, mutate };
  },
}));
const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    post: vi.fn(), put: (...a: unknown[]) => put(...a), delete: vi.fn(),
    postWithReauth: vi.fn(), putWithReauth: (...a: unknown[]) => put(...a), deleteWithReauth: vi.fn(),
    get: vi.fn(), postFormData: vi.fn(),
  },
}));
vi.mock('@/lib/api-base', () => ({ getApiBase: () => '' }));
const toast = { success: vi.fn(), error: vi.fn(), successToast: vi.fn(), errorToast: vi.fn(), warning: vi.fn(), info: vi.fn() };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
let REAUTH: 'ok' | 'cancel' = 'ok';
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_a: string, cb: (pw?: string) => Promise<void>, opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void }) => {
      if (REAUTH === 'cancel') { opts?.onCancel?.(); return; }
      try { await cb(undefined); await opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    needsReauth: () => false, executeWithResult: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), setPassword: vi.fn(),
    isOpen: false, password: '', error: '', isVerifying: false,
  }),
}));
vi.mock('@/components/reauth-dialog', () => ({ ReauthDialog: () => null }));

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
const stubCanvas = () => {
  const svg = screen.getByTestId('designer-canvas');
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 750, right: 1000, bottom: 750, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  return svg;
};
const drawColumn = (svg: Element, x: number) => {
  fireEvent.click(screen.getByRole('button', { name: 'Column' }));
  fireEvent.pointerDown(svg, { clientX: x, clientY: 100, button: 0, pointerId: 1 });
  fireEvent.pointerMove(svg, { clientX: x + 40, clientY: 130, pointerId: 1 });
  fireEvent.pointerUp(svg, { clientX: x + 40, clientY: 130, pointerId: 1 });
};
const putBody = (i: number) => put.mock.calls[i][1] as { annotations: { columns: unknown[] }; expectedUpdatedAt?: string };

function setPlan(plan: Plan) { PLANS.current = { data: [plan] }; DETAIL.current = { ...plan }; }

beforeEach(() => {
  REAUTH = 'ok';
  put.mockReset().mockResolvedValue({ updatedAt: '2026-10-12T10:05:00.000Z' });
  mutate.mockReset();
  toast.error.mockReset();
  setPlan({ ...BASE, annotations: { style: 'architectural' }, rooms: [rect('A', 'A', 0.2, 0.2, 0.4, 0.3)], links: [] });
});

describe('the 2D layer is saved safely (finding 4)', () => {
  it('sends the version the plan was loaded at', async () => {
    renderPage();
    drawColumn(stubCanvas(), 100);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(putBody(0).expectedUpdatedAt).toBe('2026-10-12T10:00:00.000Z');
  });

  it('a REFUSED save (409 STALE) is rolled back: the next edit does not re-send it, and the user is told', async () => {
    put.mockRejectedValueOnce({ error: 'STALE', message: 'changed' });
    renderPage();
    const svg = stubCanvas();
    drawColumn(svg, 100);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Plan changed elsewhere', expect.any(String)));
    drawColumn(svg, 500);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(putBody(1).annotations.columns).toHaveLength(1);
  });

  it('a CANCELLED save is rolled back too', async () => {
    REAUTH = 'cancel';
    renderPage();
    const svg = stubCanvas();
    drawColumn(svg, 100);
    REAUTH = 'ok';
    drawColumn(svg, 500);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(putBody(0).annotations.columns).toHaveLength(1);
  });

  it('a second layer edit while one is in flight WAITS, then goes with the first one\'s version', async () => {
    let answer: (v: unknown) => void = () => undefined;
    put.mockReset()
      .mockReturnValueOnce(new Promise((r) => { answer = r; }))
      .mockResolvedValue({ updatedAt: '2026-10-12T10:09:00.000Z' });
    renderPage();
    const svg = stubCanvas();
    drawColumn(svg, 100);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    drawColumn(svg, 500);
    await new Promise((r) => setTimeout(r, 50));
    expect(put).toHaveBeenCalledTimes(1);          // not sent on top of an unanswered save
    answer({ updatedAt: '2026-10-12T10:05:00.000Z' });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(putBody(1).annotations.columns).toHaveLength(2);
    expect(putBody(1).expectedUpdatedAt).toBe('2026-10-12T10:05:00.000Z');
  });

  it('edits queued behind a REFUSED save are dropped and the user told', async () => {
    let refuse: (e: unknown) => void = () => undefined;
    put.mockReset().mockReturnValueOnce(new Promise((_r, j) => { refuse = j; }));
    renderPage();
    const svg = stubCanvas();
    drawColumn(svg, 100);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    drawColumn(svg, 500);
    refuse({ error: 'STALE', message: 'changed' });
    expect(await screen.findByText(/later change\(s\) to the plan were not saved/)).toBeTruthy();
    expect(put).toHaveBeenCalledTimes(1);
  });
});

describe('doors and openings follow their wall (finding 3)', () => {
  const withDoorAndOpening = () => setPlan({
    ...BASE, annotations: null,
    rooms: [
      rect('A', 'A', 0.2, 0.2, 0.4, 0.3, { doors: [{ wall: 'right', offset: 0.3, width: 0.3, kind: 'ENTRY' }] }),
      rect('B', 'B', 0.6, 0.2, 0.2, 0.3),
    ],
    links: [{ id: 'L1', fromRoomId: 'A', toRoomId: 'B', kind: 'OPENING', fromEdge: 1, offset: 0.1, width: 0.2, door: null, label: null }],
  });

  it('inserting a corner on the top wall moves the right-wall door and opening to edge 2, in one PUT', async () => {
    withDoorAndOpening();
    renderPage();
    stubCanvas();
    const roomA = screen.getByTestId('room-A');
    fireEvent.pointerDown(roomA, { clientX: 300, clientY: 250, button: 0, pointerId: 1 });
    fireEvent.pointerUp(screen.getByTestId('designer-canvas'), { clientX: 300, clientY: 250, pointerId: 1 });
    fireEvent.doubleClick(await screen.findByTestId('edge-A-0'), { clientX: 400, clientY: 150 });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [url, body] = put.mock.calls[0] as [string, { points: unknown[]; doors: unknown[]; linkEdges: unknown[] }];
    expect(url).toBe('/api/floorplans/p1/rooms/A');
    expect(body.points).toHaveLength(5);
    expect(body.doors).toEqual([{ edge: 2, offset: 0.3, width: 0.3, kind: 'ENTRY' }]);
    expect(body.linkEdges).toEqual([{ id: 'L1', fromEdge: 2, offset: 0.1, width: 0.2 }]);
  });
});
