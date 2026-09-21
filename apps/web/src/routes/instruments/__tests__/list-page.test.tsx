import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The Instruments list had no render test before UI v3 (2026-09-21). This
 * pins the page's SHAPE on the shared primitives: the hero band with the
 * screen's actions inside it, a named search box in the toolbar, the shared
 * table band, and the rows' links — the wiring that a restyle can break
 * while every unit test stays green.
 */
const inst = (over: Record<string, unknown>) => ({
  id: 'i-1', code: 'CWH/RDU/001-00', name: 'CWH/RDU/001-00', isActive: true, isGateway: false, gatewayId: null,
  profileId: 'p-1', profileName: 'RS485 T/RH', expectedIntervalSec: 60, lastSeenAt: new Date().toISOString(),
  functionalLocationId: 'a-1', createdAt: '2026-08-24T00:00:00.000Z',
  ...over,
});
const rows = [inst({}), inst({ id: 'i-2', code: 'CWH/RDU/002-00', name: 'CWH/RDU/002-00', isActive: false, lastSeenAt: null })];

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (typeof key === 'string' && key.startsWith('/api/instruments?')) return { data: { data: rows, total: rows.length }, isLoading: false, mutate: vi.fn() };
    if (typeof key === 'string' && key.includes('/instrument-activity/')) return { data: { activeWindowMinutes: 3 }, mutate: vi.fn() };
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-pagination-config', () => ({
  usePaginationConfig: () => [25, 50, 100],
  usePaginationDefaults: () => ({ defaultLimit: 25, pageSizeOptions: [25, 50, 100] }),
}));

const { InstrumentListPage } = await import('../list');

const mount = () => render(
  <MemoryRouter initialEntries={['/instruments']}>
    <Routes><Route path="/instruments" element={<InstrumentListPage />} /></Routes>
  </MemoryRouter>,
);

describe('InstrumentListPage — UI v3 shape', () => {
  it('opens with the hero band carrying New instrument, a named search toolbar and the shared table band', () => {
    mount();
    const hero = screen.getByTestId('page-hero');
    expect(hero.contains(screen.getByRole('link', { name: /new instrument/i }))).toBe(true);
    expect(screen.getByRole('textbox', { name: 'Search instruments' })).toHaveAttribute('name', 'instrument-search');
    expect(document.querySelector('thead')).toHaveAttribute('data-band', 'gradient');
    expect(screen.getByRole('link', { name: /CWH\/RDU\/001-00/ })).toBeInTheDocument();
  });
});
