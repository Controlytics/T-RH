import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Functional Locations browse page after the 2026-09-17 redesign
 * (operator: "functional location page is looking sample ui, i need best
 * professional and colorful screen"; then "remove live status"). Every
 * assertion is WIRING: the hero figures, one card per Block with its Areas
 * inside, search keeping a Block whose Area matches, and the action gates.
 * Nothing here reads the instrument list — the page shows the grouping and
 * its counts only. What it LOOKS like is read out of the DOM, not seen —
 * the operator holds the browser session.
 */

const tree = [
  {
    id: 'b1', name: 'CWH Block', type: 'BLOCK', parentId: null, ownCount: 1, totalCount: 4,
    children: [
      { id: 'a1', name: 'Stability', type: 'AREA', parentId: 'b1', ownCount: 2, totalCount: 2 },
      { id: 'a2', name: 'QC Floor', type: 'AREA', parentId: 'b1', ownCount: 1, totalCount: 1 },
    ],
  },
  { id: 'b2', name: 'Warehouse', type: 'BLOCK', parentId: null, ownCount: 0, totalCount: 0, children: [] },
];
let grants = new Set<string>();
let role = 'OPERATOR';
const mutate = vi.fn();
const toast = { success: vi.fn(), error: vi.fn() };
const del = vi.fn();
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/functional-locations') return { data: { data: tree }, isLoading: false, mutate };
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => (node: string) => grants.has(node) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'u1', role } }) }));
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: vi.fn(), post: vi.fn(), put: vi.fn(), putWithReauth: vi.fn(), postWithReauth: vi.fn(),
    delete: (...a: unknown[]) => del(...a), deleteWithReauth: (...a: unknown[]) => del(...a),
  },
}));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_a: string, cb: (p?: string) => Promise<void>, opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }) => {
      try { await cb(); await opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    executeWithResult: async (_a: string, cb: (p?: string) => Promise<unknown>) => cb(),
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { default: FunctionalLocationsPage } = await import('../index');

const renderPage = () => render(<MemoryRouter><FunctionalLocationsPage /></MemoryRouter>);
const hero = () => screen.getByTestId('fl-hero');
const card = (name: string) => screen.getByTestId(`fl-block-${name}`);

beforeEach(() => { grants = new Set(); role = 'OPERATOR'; del.mockReset().mockResolvedValue(undefined); mutate.mockReset(); toast.success.mockReset(); toast.error.mockReset(); });

describe('Functional Locations page', () => {
  it('the hero states the plant: blocks, areas and instruments assigned', () => {
    renderPage();
    const h = within(hero());
    expect(h.getByRole('heading', { name: 'Functional Locations' })).toBeInTheDocument();
    // UI v3 (2026-09-21): the hero IS the shared primitive, not a private copy.
    expect(hero()).toHaveAttribute('data-hero', 'v3');
    expect(h.getByTestId('fl-figure-blocks')).toHaveTextContent('2');
    expect(h.getByTestId('fl-figure-areas')).toHaveTextContent('2');
    expect(h.getByTestId('fl-figure-instruments')).toHaveTextContent('4');
    // No live state anywhere on the page ("remove live status").
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('one card per Block with its rolled-up count, its Areas inside it each with its own count', () => {
    renderPage();
    const c = within(card('CWH Block'));
    expect(c.getByRole('link', { name: /CWH Block/ })).toHaveAttribute('href', '/functional-locations/b1');
    expect(c.getByTestId('fl-block-total')).toHaveTextContent('4');
    // The plate carries the total only — no "linked directly" line under the
    // name (operator: "remove that linked directly line also").
    expect(c.queryByText(/linked directly/)).not.toBeInTheDocument();
    // Areas are rows in the card, each linking to its own page, with ITS count.
    const stability = c.getByRole('link', { name: /Stability/ });
    expect(stability).toHaveAttribute('href', '/functional-locations/a1');
    // ONE count per row, worded (operator: "count is showing two times for
    // areas" — it printed "2 instruments" under the name AND a "2" pill).
    expect(stability).toHaveTextContent(/^Stability2 instruments$/);
    expect(c.getByRole('link', { name: /QC Floor/ })).toHaveTextContent('1');
  });

  it('a Block with no areas says so', () => {
    renderPage();
    const c = within(card('Warehouse'));
    expect(c.getByText('No areas yet')).toBeInTheDocument();
    expect(c.getByTestId('fl-block-total')).toHaveTextContent('0');
  });

  it('search keeps a Block whose AREA matches — areas are only reachable through their card', () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText(/Search blocks and areas/), { target: { value: 'qc floor' } });
    expect(screen.getByTestId('fl-block-CWH Block')).toBeInTheDocument();
    expect(screen.queryByTestId('fl-block-Warehouse')).not.toBeInTheDocument();
  });

  it('Create and Arrange are gated on their nodes; Arrange areas needs two areas', () => {
    renderPage();
    expect(screen.queryByRole('button', { name: 'Create functional location' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Arrange order' })).not.toBeInTheDocument();

    cleanup();
    // `functional_locations.edit` is the tree's node; until 2026-10-03 the page
    // (and this test) named a `functional_locations.update` that does not exist.
    grants = new Set(['functional_locations.create', 'functional_locations.edit']);
    renderPage();
    expect(screen.getByRole('button', { name: 'Create functional location' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arrange order' })).toBeInTheDocument();
    expect(within(card('CWH Block')).getByRole('button', { name: /Arrange areas/ })).toBeInTheDocument();
    expect(within(card('Warehouse')).queryByRole('button', { name: /Arrange areas/ })).not.toBeInTheDocument();
  });

  describe('Delete (2026-10-03, operator: "add delete option for functional locations for super admin")', () => {
    it('Delete block / Delete area buttons appear only with the delete node', () => {
      renderPage();
      expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
      cleanup();
      grants = new Set(['functional_locations.delete']);
      renderPage();
      expect(within(card('CWH Block')).getByRole('button', { name: 'Delete block CWH Block' })).toBeInTheDocument();
      expect(within(card('CWH Block')).getByRole('button', { name: 'Delete area Stability' })).toBeInTheDocument();
      expect(within(card('Warehouse')).getByRole('button', { name: 'Delete block Warehouse' })).toBeInTheDocument();
    });

    it('an EMPTY block: confirm, then the plain audited DELETE, then the tree is re-read', async () => {
      grants = new Set(['functional_locations.delete']);
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Delete block Warehouse' }));
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Delete the block "Warehouse"? It holds nothing.');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(del).toHaveBeenCalledWith('/api/functional-locations/b2'));
      expect(mutate).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Location deleted', '"Warehouse" removed.');
    });

    it('a block that holds areas and instruments: a non-super-admin gets the refusal and nothing is sent', () => {
      grants = new Set(['functional_locations.delete']);
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Delete block CWH Block' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledWith('Cannot delete', '"CWH Block" still holds 4 instruments and 2 areas. Move or unlink them before deleting it.');
      expect(del).not.toHaveBeenCalled();
    });

    it('the same block, a SUPER_ADMIN: the confirm states the areas and the instruments that become unassigned, then DELETE ?cascade=true', async () => {
      role = 'SUPER_ADMIN';
      grants = new Set(['functional_locations.delete']);
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Delete block CWH Block' }));
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Delete the block "CWH Block" with its 2 areas?');
      expect(dialog).toHaveTextContent('4 instruments become unassigned');
      expect(dialog).toHaveTextContent('stay registered');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete with everything in it' }));
      await waitFor(() => expect(del).toHaveBeenCalledWith('/api/functional-locations/b1?cascade=true'));
      expect(toast.success).toHaveBeenCalledWith('Location deleted', '"CWH Block" is gone; 4 instruments unassigned.');
    });

    it('an AREA with instruments, a SUPER_ADMIN: its own count, cascade', async () => {
      role = 'SUPER_ADMIN';
      grants = new Set(['functional_locations.delete']);
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Delete area Stability' }));
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Delete the area "Stability"?');
      expect(dialog).toHaveTextContent('2 instruments become unassigned');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete with everything in it' }));
      await waitFor(() => expect(del).toHaveBeenCalledWith('/api/functional-locations/a1?cascade=true'));
    });

    it('Cancel sends nothing; a refusal from the API is shown as its own message', async () => {
      role = 'SUPER_ADMIN';
      grants = new Set(['functional_locations.delete']);
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Delete block Warehouse' }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      expect(del).not.toHaveBeenCalled();
      del.mockRejectedValueOnce({ error: 'NOT_EMPTY', message: '"Warehouse" still holds 1 instrument(s). Move or unlink them before deleting it.' });
      fireEvent.click(screen.getByRole('button', { name: 'Delete block Warehouse' }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not delete', '"Warehouse" still holds 1 instrument(s). Move or unlink them before deleting it.'));
      expect(mutate).not.toHaveBeenCalled();
    });
  });
});
