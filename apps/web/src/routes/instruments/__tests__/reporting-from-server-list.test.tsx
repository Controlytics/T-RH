import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The list shows the SERVER's per-row `reporting`; it never re-derives it from
 * `lastSeenAt` + `expectedIntervalSec` (root CLAUDE.md). The rows are built so
 * the two disagree: an instrument that reported a moment ago which the server
 * says is NOT reporting (a TCP/IP one whose reads stopped), and two never seen
 * that the server says ARE.
 */
const inst = (over: Record<string, unknown>) => ({
  id: 'i-1', code: 'CWH/RDU/001-00', name: 'CWH/RDU/001-00', isActive: true, isGateway: false, gatewayId: null,
  profileId: 'p-1', profileName: 'RS485 T/RH', expectedIntervalSec: 60, lastSeenAt: new Date().toISOString(),
  functionalLocationId: 'a-1', createdAt: '2026-08-24T00:00:00.000Z', reporting: false,
  ...over,
});
const rows = [
  inst({ id: 'i-1', reporting: false }),
  inst({ id: 'i-2', code: 'CWH/RDU/002-00', name: 'CWH/RDU/002-00', lastSeenAt: null, reporting: true }),
  inst({ id: 'i-3', code: 'CWH/RDU/003-00', name: 'CWH/RDU/003-00', lastSeenAt: null, reporting: true }),
];

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

describe("InstrumentListPage - reporting is the server's", () => {
  it("counts Active and Inactive from each row's `reporting`, not from lastSeenAt", () => {
    render(
      <MemoryRouter initialEntries={['/instruments']}>
        <Routes><Route path="/instruments" element={<InstrumentListPage />} /></Routes>
      </MemoryRouter>,
    );
    const tile = (label: string) => screen.getAllByText(label)
      .map((el) => el.closest('button')?.textContent ?? '')
      .find((t) => t !== '') ?? '';
    // 2 rows the server calls reporting (never seen), 1 it does not (seen just now).
    expect(tile('Active')).toContain('2');
    expect(tile('Inactive')).toContain('1');
  });
});
