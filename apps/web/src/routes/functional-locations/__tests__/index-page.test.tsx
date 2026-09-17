import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
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
const mutate = vi.fn();
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/functional-locations') return { data: { data: tree }, isLoading: false, mutate };
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => (node: string) => grants.has(node) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), putWithReauth: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_a: string, cb: (p?: string) => Promise<void>) => { await cb(); },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { default: FunctionalLocationsPage } = await import('../index');

const renderPage = () => render(<MemoryRouter><FunctionalLocationsPage /></MemoryRouter>);
const hero = () => screen.getByTestId('fl-hero');
const card = (name: string) => screen.getByTestId(`fl-block-${name}`);

beforeEach(() => { grants = new Set(); });

describe('Functional Locations page', () => {
  it('the hero states the plant: blocks, areas and instruments assigned', () => {
    renderPage();
    const h = within(hero());
    expect(h.getByRole('heading', { name: 'Functional Locations' })).toBeInTheDocument();
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
    grants = new Set(['functional_locations.create', 'functional_locations.update']);
    renderPage();
    expect(screen.getByRole('button', { name: 'Create functional location' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arrange order' })).toBeInTheDocument();
    expect(within(card('CWH Block')).getByRole('button', { name: /Arrange areas/ })).toBeInTheDocument();
    expect(within(card('Warehouse')).queryByRole('button', { name: /Arrange areas/ })).not.toBeInTheDocument();
  });
});
