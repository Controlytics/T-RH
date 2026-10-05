import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Layout Designer page (2026-09-22): a room drawn corner by corner is
 * posted as points with the derived box; a bad outline is refused in place;
 * the Link tool posts an OPENING on a shared wall and a CONNECTOR otherwise.
 * `swr`, the API client, toasts and re-auth are mocked module-wide, the
 * convention of the other config page tests.
 */
const PLAN = {
  id: 'p1', name: 'Blank', imagePath: null, imageWidth: 1600, imageHeight: 1200, isActive: true, sortOrder: 0,
  rooms: [] as unknown[], links: [] as unknown[],
};
const rect = (id: string, code: string, x: number, y: number, w: number, h: number) => ({
  id, code, label: null, grade: null, x, y, w, h, tempMin: null, tempMax: null, rhMin: null, rhMax: null, doors: null, points: null,
});
const PLANS = { current: { data: [PLAN] } as { data: typeof PLAN[] } };
const DETAIL = { current: { ...PLAN, rooms: [] as unknown[] } };
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
const del = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    post: (...a: unknown[]) => post(...a), put: (...a: unknown[]) => put(...a), delete: (...a: unknown[]) => del(...a),
    postWithReauth: (...a: unknown[]) => post(...a), putWithReauth: (...a: unknown[]) => put(...a), deleteWithReauth: (...a: unknown[]) => del(...a),
    get: vi.fn(), postFormData: vi.fn(),
  },
}));
vi.mock('@/lib/api-base', () => ({ getApiBase: () => '' }));
const toast = { success: vi.fn(), error: vi.fn(), successToast: vi.fn(), errorToast: vi.fn(), warning: vi.fn(), info: vi.fn() };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_action: string, cb: (pw?: string) => Promise<void>, opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }) => {
      try { await cb(undefined); opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    needsReauth: () => false, executeWithResult: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), setPassword: vi.fn(),
    isOpen: false, password: '', error: '', isVerifying: false,
  }),
}));
vi.mock('@/components/reauth-dialog', () => ({ ReauthDialog: () => null }));

// jsdom has no PointerEvent, so fireEvent.pointerDown would dispatch a bare
// Event with no button and no coordinates and every handler would ignore it.
// A MouseEvent-backed stand-in carries both, which is all the canvas reads.
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

beforeEach(() => {
  PLANS.current = { data: [PLAN] };
  DETAIL.current = { ...PLAN, rooms: [] };
  post.mockReset().mockResolvedValue({ id: 'new' });
  put.mockReset().mockResolvedValue({});
  del.mockReset().mockResolvedValue({});
  mutate.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});

describe('LayoutDesignerPage', () => {
  it('draws a triangle corner by corner, names it, and posts points with the derived box', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /draw room/i }));
    const svg = stubCanvas();
    for (const [x, y] of [[100, 75], [500, 75], [100, 375]]) clickAt(svg, x, y);
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.change(screen.getByLabelText(/room code/i), { target: { value: 'TRI' } });
    fireEvent.click(screen.getByRole('button', { name: /create room/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const call = post.mock.calls.find((c) => String(c[0]).endsWith('/rooms'))!;
    expect(call[0]).toBe('/api/floorplans/p1/rooms');
    expect(call[1]).toMatchObject({
      code: 'TRI',
      points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.1, y: 0.5 }],
      x: 0.1, y: 0.1, w: 0.4, h: 0.4,
    });
  });

  it('a bow-tie is refused in place with the reason and nothing is posted', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /draw room/i }));
    const svg = stubCanvas();
    for (const [x, y] of [[100, 75], [500, 375], [500, 75], [100, 375]]) clickAt(svg, x, y);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByRole('status')).toHaveTextContent(/crosses itself/);
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/room code/i)).toBeNull();
  });

  it('a corridor is drawn the same way with the grade preset', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /draw corridor/i }));
    const svg = stubCanvas();
    for (const [x, y] of [[100, 75], [900, 75], [900, 150], [100, 150]]) clickAt(svg, x, y);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByLabelText(/grade/i)).toHaveValue('CIRCULATION');
    expect(screen.getByLabelText(/room code/i)).toHaveValue('CORRIDOR-01');
    fireEvent.click(screen.getByRole('button', { name: /create room/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ grade: 'CIRCULATION', code: 'CORRIDOR-01' });
  });

  it('linking two touching rooms posts an OPENING on the shared edge; two apart rooms a CONNECTOR', async () => {
    const rooms = [rect('A', 'A', 0.1, 0.1, 0.2, 0.2), rect('B', 'B', 0.3, 0.1, 0.2, 0.2), rect('C', 'C', 0.7, 0.7, 0.1, 0.1)];
    PLANS.current = { data: [{ ...PLAN, rooms }] };
    DETAIL.current = { ...PLAN, rooms };
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^link$/i }));
    stubCanvas();
    clickAt(screen.getByTestId('room-A'), 200, 150);
    clickAt(screen.getByTestId('room-B'), 400, 150);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe('/api/floorplans/p1/links');
    expect(post.mock.calls[0][1]).toMatchObject({ fromRoomId: 'A', toRoomId: 'B', kind: 'OPENING', fromEdge: 1 });
    clickAt(screen.getByTestId('room-A'), 200, 150);
    clickAt(screen.getByTestId('room-C'), 750, 560);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]).toMatchObject({ fromRoomId: 'A', toRoomId: 'C', kind: 'CONNECTOR' });
  });

  it('Remove: a door selected on the canvas is removed through the room endpoint', async () => {
    const rooms = [{ ...rect('A', 'A', 0.1, 0.1, 0.2, 0.2), doors: [{ wall: 'top', offset: 0.4, width: 0.2, kind: 'ENTRY' }] }];
    PLANS.current = { data: [{ ...PLAN, rooms }] };
    DETAIL.current = { ...PLAN, rooms };
    renderPage();
    stubCanvas();
    expect(screen.getByRole('button', { name: /^remove$/i })).toBeDisabled();
    clickAt(screen.getByTestId('door-A-0'), 200, 75);
    const remove = screen.getByRole('button', { name: /^remove: door 1 of A$/i });
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [url, body] = put.mock.calls[0];
    expect(url).toBe('/api/floorplans/p1/rooms/A');
    expect(body).toMatchObject({ doors: null });
  });

  it('Delete plan: confirms with the room and instrument counts, deletes through the audited endpoint, and moves to the next plan', async () => {
    const rooms = [rect('A', 'A', 0.1, 0.1, 0.2, 0.2), rect('B', 'B', 0.5, 0.1, 0.2, 0.2)];
    const other = { ...PLAN, id: 'p2', name: 'Other plan', rooms: [] };
    PLANS.current = { data: [{ ...PLAN, rooms }, other] };
    DETAIL.current = { ...PLAN, rooms: [{ ...rooms[0], instruments: [{ id: 'i1', code: 'CWH/RDU/001-00' }] }, rooms[1]] };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Delete plan Blank' }));
    expect(confirm.mock.calls[0][0]).toBe('Delete the plan "Blank" with its 2 rooms? 1 instrument become unplaced (not deleted). This cannot be undone.');
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/floorplans/p1'));
    expect(toast.success).toHaveBeenCalledWith('Plan deleted', '"Blank" and its rooms are gone; 1 instrument is unplaced.');
    // The list is re-read; with the deleted plan gone the next one is selected.
    PLANS.current = { data: [other] };
    expect(mutate).toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('Delete plan: declining the confirm deletes nothing', () => {
    PLANS.current = { data: [PLAN] };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^Delete plan/ }));
    expect(del).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('Save room: a LIMIT change asks for a reason first and sends it on the PUT (DATA-11)', async () => {
    const rooms = [{ ...rect('A', 'A', 0.1, 0.1, 0.2, 0.2), tempMax: 25 }];
    PLANS.current = { data: [{ ...PLAN, rooms }] };
    DETAIL.current = { ...PLAN, rooms };
    renderPage();
    stubCanvas();
    clickAt(screen.getByTestId('room-A'), 200, 150);
    fireEvent.pointerUp(screen.getByTestId('designer-canvas'));
    fireEvent.change(screen.getByLabelText('Max temperature (°C)'), { target: { value: '27' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
    // Nothing is sent until the reason is given; the dialog shows the line being signed for.
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText('Change a room limit — A')).toBeTruthy();
    expect(screen.getByText('27')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Why is this changing?'), { target: { value: 'NMT raised per SOP-114 rev 3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [url, body] = put.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/floorplans/p1/rooms/A');
    expect(body.tempMax).toBe(27);
    expect(body.reason).toBe('NMT raised per SOP-114 rev 3');
  });

  it('Save room: a label change with the limits untouched asks for no reason', async () => {
    const rooms = [{ ...rect('A', 'A', 0.1, 0.1, 0.2, 0.2), tempMax: 25 }];
    PLANS.current = { data: [{ ...PLAN, rooms }] };
    DETAIL.current = { ...PLAN, rooms };
    renderPage();
    stubCanvas();
    clickAt(screen.getByTestId('room-A'), 200, 150);
    fireEvent.pointerUp(screen.getByTestId('designer-canvas'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'HPLC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [, body] = put.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.label).toBe('HPLC');
    expect(body.tempMax).toBe(25);
    expect('reason' in body).toBe(false);
    expect(screen.queryByPlaceholderText('Why is this changing?')).toBeNull();
  });

  it('selecting a room and pressing Delete removes it through the audited endpoint', async () => {
    const rooms = [rect('A', 'A', 0.1, 0.1, 0.2, 0.2)];
    PLANS.current = { data: [{ ...PLAN, rooms }] };
    DETAIL.current = { ...PLAN, rooms };
    renderPage();
    stubCanvas();
    clickAt(screen.getByTestId('room-A'), 200, 150);
    fireEvent.pointerUp(screen.getByTestId('designer-canvas'));
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/floorplans/p1/rooms/A'));
  });
});
