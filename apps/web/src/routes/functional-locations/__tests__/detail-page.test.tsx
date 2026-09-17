import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * One functional location after the 2026-09-17 redesign ("and inside screens
 * also"). WIRING assertions only: the hero carries the name, type and the
 * three figures; a Block lists its Areas as tiles with their own counts; the
 * direct-instrument list and the read-only "in this block's areas" list are
 * SEPARATE (the membership editor must never show an Area's instrument, or an
 * unlink would silently move it up to the Block); and the actions are gated on
 * their nodes. No live state per instrument ("remove live status").
 */

const tree = [
  {
    id: 'b1', name: 'CWH Block', type: 'BLOCK', parentId: null, ownCount: 1, totalCount: 3,
    children: [{ id: 'a1', name: 'Stability', type: 'AREA', parentId: 'b1', ownCount: 2, totalCount: 2 }],
  },
];
const block = {
  id: 'b1', name: 'CWH Block', type: 'BLOCK', parentId: null, ownCount: 1, totalCount: 3,
  children: [{ id: 'a1', name: 'Stability', type: 'AREA', parentId: 'b1', ownCount: 2, totalCount: 2 }],
  instruments: [
    { id: 'i1', code: 'CWH/RDU/001-00', name: 'CWH/RDU/001-00', functionalLocationId: 'b1' },
    { id: 'i2', code: 'CWH/RDU/002-00', name: 'CWH/RDU/002-00', functionalLocationId: 'a1' },
    { id: 'i3', code: 'CWH/RDU/003-00', name: 'Corridor probe', functionalLocationId: 'a1' },
  ],
};
const area = {
  id: 'a1', name: 'Stability', type: 'AREA', parentId: 'b1', ownCount: 2, totalCount: 2, children: [],
  instruments: [
    { id: 'i2', code: 'CWH/RDU/002-00', name: 'CWH/RDU/002-00', functionalLocationId: 'a1' },
    { id: 'i3', code: 'CWH/RDU/003-00', name: 'Corridor probe', functionalLocationId: 'a1' },
  ],
};
const linkable = [
  { id: 'i1', code: 'CWH/RDU/001-00', name: 'CWH/RDU/001-00', functionalLocationId: 'b1', functionalLocationPath: 'CWH Block' },
  { id: 'i2', code: 'CWH/RDU/002-00', name: 'CWH/RDU/002-00', functionalLocationId: 'a1', functionalLocationPath: 'CWH Block > Stability' },
  { id: 'i3', code: 'CWH/RDU/003-00', name: 'Corridor probe', functionalLocationId: 'a1', functionalLocationPath: 'CWH Block > Stability' },
  { id: 'i9', code: 'FREE-01', name: 'FREE-01', functionalLocationId: null, functionalLocationPath: null },
];
let grants = new Set<string>();
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/functional-locations') return { data: { data: tree }, isLoading: false, mutate: vi.fn() };
    if (key === '/api/functional-locations/b1') return { data: block, isLoading: false, mutate: vi.fn() };
    if (key === '/api/functional-locations/a1') return { data: area, isLoading: false, mutate: vi.fn() };
    if (key === '/api/functional-locations/linkable-instruments') return { data: { data: linkable }, mutate: vi.fn() };
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => (node: string) => grants.has(node) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), putWithReauth: vi.fn(), delete: vi.fn() },
}));

const { FunctionalLocationDetailPage } = await import('../detail');

const renderPage = (id: string) => render(
  <MemoryRouter initialEntries={[`/functional-locations/${id}`]}>
    <Routes><Route path="/functional-locations/:id" element={<FunctionalLocationDetailPage />} /></Routes>
  </MemoryRouter>,
);
const hero = () => screen.getByTestId('fl-detail-hero');

beforeEach(() => { grants = new Set(); });

describe('Functional location detail page', () => {
  it('a Block: the hero names it, its type and its three figures', () => {
    renderPage('b1');
    const h = within(hero());
    expect(h.getByRole('heading', { name: 'CWH Block' })).toBeInTheDocument();
    expect(h.getByText('Block')).toBeInTheDocument();
    expect(h.getByTestId('fl-stat-total')).toHaveTextContent('3');
    expect(h.getByTestId('fl-stat-areas')).toHaveTextContent('1');
    // No "Linked directly" tile ("remove that linked directly tile also");
    // the direct list's own count below is that number.
    expect(h.queryByTestId('fl-stat-direct')).not.toBeInTheDocument();
    expect(h.queryByText(/Linked directly/)).not.toBeInTheDocument();
    // No live state anywhere on the page ("remove live status").
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('a Block lists its Areas as tiles, each with its own count, linking to the Area', () => {
    renderPage('b1');
    const areas = within(screen.getByTestId('fl-areas'));
    const tile = areas.getByRole('link', { name: /Stability/ });
    expect(tile).toHaveAttribute('href', '/functional-locations/a1');
    // ONE count per tile, worded ("count is showing two times for areas").
    expect(tile).toHaveTextContent(/^Stability2 instruments$/);
  });

  it('direct instruments and the areas’ instruments are two separate lists', () => {
    renderPage('b1');
    const direct = within(screen.getByTestId('fl-instruments'));
    expect(direct.getByRole('link', { name: 'CWH/RDU/001-00' })).toHaveAttribute('href', '/instruments/i1');
    expect(direct.queryByRole('link', { name: 'CWH/RDU/002-00' })).not.toBeInTheDocument();

    const inAreas = within(screen.getByTestId('fl-in-areas'));
    expect(inAreas.getByRole('link', { name: 'CWH/RDU/002-00' })).toBeInTheDocument();
    expect(inAreas.getByRole('link', { name: 'CWH/RDU/003-00' })).toBeInTheDocument();
    // …and NOT the Block's own instrument: mutation-checked — dropping the
    // `functionalLocationId !== data.id` filter passed until this line existed.
    expect(inAreas.queryByRole('link', { name: 'CWH/RDU/001-00' })).not.toBeInTheDocument();
    // A name that differs from the code prints under it; each tile names its Area.
    expect(inAreas.getByText('Corridor probe')).toBeInTheDocument();
    expect(inAreas.getAllByText('Stability')).toHaveLength(2);
  });

  it('an Area: no Areas figure, no areas section, no in-areas list; the crumb trail climbs to its Block', () => {
    renderPage('a1');
    const h = within(hero());
    expect(h.getByRole('heading', { name: 'Stability' })).toBeInTheDocument();
    expect(h.getByText('Area')).toBeInTheDocument();
    expect(h.queryByTestId('fl-stat-areas')).not.toBeInTheDocument();
    expect(h.getByRole('link', { name: 'CWH Block' })).toHaveAttribute('href', '/functional-locations/b1');
    expect(screen.queryByTestId('fl-areas')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fl-in-areas')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('fl-instruments')).getAllByRole('link')).toHaveLength(2);
  });

  it('Add area, Edit, Delete and Add instruments are each gated on their node', () => {
    renderPage('b1');
    for (const name of ['Add area', 'Edit', 'Delete', 'Add instruments']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    cleanup();
    grants = new Set(['functional_locations.create', 'functional_locations.edit', 'functional_locations.delete']);
    renderPage('b1');
    for (const name of ['Add area', 'Edit', 'Delete', 'Add instruments']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('button', { name: /Unlink/ })).toHaveLength(1);
  });
});
