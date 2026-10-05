import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Doors in 2D (Layout Designer, 2026-10-05): the room panel's door row edits
 * Hinge (start / end / none = a leafless opening), Swing (in / out) and Width,
 * and "Double leaf" replaces a door by two half-width doors with mirrored
 * hinges (`splitDoor`, the traces' vPair / hPair rule) — nothing new in the
 * door data, the room PUT carries them as before.
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
const clickAt = (el: Element, x: number, y: number) => fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, pointerId: 1 });
const rect = (id: string, code: string, x: number, y: number, w: number, h: number) => ({
  id, code, label: null, grade: null, x, y, w, h, tempMin: null, tempMax: null, rhMin: null, rhMax: null, doors: null, points: null,
});

const withDoor = { ...PLAN, annotations: { style: 'architectural' }, rooms: [{ ...rect('A', 'A', 0.2, 0.2, 0.4, 0.3), doors: [{ edge: 0, offset: 0.4, width: 0.2, kind: 'ENTRY' }] }] };
const roomBody = () => (put.mock.calls.find(([u]) => u === '/api/floorplans/p1/rooms/A') as [string, { doors: Record<string, unknown>[] }])[1];

beforeEach(() => {
  PLANS.current = { data: [withDoor] };
  DETAIL.current = { ...withDoor };
  post.mockReset().mockResolvedValue({ id: 'new' });
  put.mockReset().mockResolvedValue({});
  mutate.mockReset();
});

const selectRoom = () => {
  stubCanvas();
  clickAt(screen.getByTestId('room-A'), 300, 250);
  fireEvent.pointerUp(screen.getByTestId('designer-canvas'));
};

describe('door controls', () => {
  it('Hinge, Swing and Width are saved on the door', async () => {
    renderPage(); selectRoom();
    fireEvent.change(screen.getByLabelText('Door 1 hinge'), { target: { value: 'end' } });
    fireEvent.change(screen.getByLabelText('Door 1 swing'), { target: { value: 'out' } });
    fireEvent.change(screen.getByLabelText('Door 1 width'), { target: { value: '0.1' } });
    fireEvent.blur(screen.getByLabelText('Door 1 width')); // the width commits when the field is left
    fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(roomBody().doors[0]).toMatchObject({ edge: 0, offset: 0.4, width: 0.1, kind: 'ENTRY', hinge: 'end', swing: 'out' });
  });

  it('"None" hinge is a leafless opening', async () => {
    renderPage(); selectRoom();
    fireEvent.change(screen.getByLabelText('Door 1 hinge'), { target: { value: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(roomBody().doors[0].hinge).toBe('none');
  });

  it('Double leaf replaces the door by two half-width doors with mirrored hinges', async () => {
    renderPage(); selectRoom();
    fireEvent.click(screen.getByRole('button', { name: 'Door 1 double leaf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(roomBody().doors).toEqual([
      { edge: 0, offset: 0.4, width: 0.1, kind: 'ENTRY', hinge: 'start' },
      { edge: 0, offset: 0.5, width: 0.1, kind: 'ENTRY', hinge: 'end' },
    ]);
  });

  it('Width is typeable: a partial value is not clamped mid-keystroke, blur clamps it', async () => {
    renderPage(); selectRoom();
    const input = screen.getByLabelText('Door 1 width') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });
    expect(input.value).toBe('0');            // what the operator typed, not 0.02
    fireEvent.blur(input);
    expect(input.value).toBe('0.02');         // clamped only when they leave the field
    fireEvent.change(input, { target: { value: '0.3' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(roomBody().doors[0].width).toBe(0.3);
  });

  it('Double leaf is refused when the room already carries six doors', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ edge: 0, offset: i * 0.15, width: 0.1, kind: 'ENTRY' }));
    PLANS.current = { data: [{ ...withDoor, rooms: [{ ...withDoor.rooms[0], doors: six }] }] };
    renderPage(); selectRoom();
    expect(screen.getByRole('button', { name: 'Door 1 double leaf' })).toBeDisabled();
  });
});
