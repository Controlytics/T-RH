import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Plan panel (Layout Designer 2D, 2026-10-05): style, floor and north,
 * saved as ONE PUT of the plan's whole `annotations`; a new plan is created
 * in the 2D style; the structure tools show only for a 2D plan; the
 * script-drawn plans say so.
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

const { LayoutDesignerPage } = await import('../index');
const renderPage = () => render(<MemoryRouter><LayoutDesignerPage /></MemoryRouter>);

beforeEach(() => {
  PLANS.current = { data: [{ ...PLAN, annotations: null }] };
  DETAIL.current = { ...PLAN, annotations: null };
  post.mockReset().mockResolvedValue({ id: 'new' });
  put.mockReset().mockResolvedValue({});
  mutate.mockReset();
});

describe('Plan panel', () => {
  it('a standard plan shows Style = Standard and NO structure tools', () => {
    renderPage();
    expect((screen.getByLabelText('Style') as HTMLSelectElement).value).toBe('standard');
    expect(screen.queryByRole('button', { name: 'Column' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Window' })).toBeNull();
  });

  it('switching to 2D PUTs the whole annotations object with the new style and reveals the tools', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Style'), { target: { value: 'architectural' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/floorplans/p1', { annotations: expect.objectContaining({ style: 'architectural', columns: [], windows: [], walls: [], equipment: [], labels: [], floor: null, north: null }) }));
    PLANS.current = { data: [{ ...PLAN, annotations: { style: 'architectural' } }] };
    renderPage();
    expect(screen.getAllByRole('button', { name: 'Column' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Label' }).length).toBeGreaterThan(0);
  });

  it('floor and north save with the style; switching BACK to Standard keeps the structure', async () => {
    PLANS.current = { data: [{ ...PLAN, annotations: { style: 'architectural', columns: [{ x: 0.1, y: 0.1, w: 0.02, h: 0.02 }] } }] };
    renderPage();
    fireEvent.change(screen.getByLabelText('Floor group'), { target: { value: 'CWH — Module-X' } });
    fireEvent.change(screen.getByLabelText('Floor label'), { target: { value: 'First Floor' } });
    fireEvent.change(screen.getByLabelText('Floor order'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('North (degrees)'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Style'), { target: { value: 'standard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [, body] = put.mock.calls[0] as [string, { annotations: Record<string, unknown> }];
    expect(body.annotations.style).toBe('standard');
    expect(body.annotations.floor).toEqual({ group: 'CWH — Module-X', label: 'First Floor', order: 1 });
    expect(body.annotations.north).toBe(90);
    expect(body.annotations.columns).toEqual([{ x: 0.1, y: 0.1, w: 0.02, h: 0.02 }]);
  });

  it('a NEW plan is created in the 2D style', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'New plan' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fresh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create plan' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/floorplans', expect.objectContaining({ name: 'Fresh', annotations: { style: 'architectural' } })));
  });

  it('a script-drawn plan says a re-run overwrites designer edits', () => {
    PLANS.current = { data: [{ ...PLAN, name: 'CWH — QC', annotations: { style: 'architectural' } }] };
    renderPage();
    expect(screen.getByText(/drawn by a script/i)).toBeInTheDocument();
  });
});
