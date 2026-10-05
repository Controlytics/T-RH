import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * audit 2026-10-03, WEB-6 — the MUTATION CHECK. A failed fetch must render the
 * failure line, never the empty state: "No instruments registered yet" is a
 * sentence asserting that nothing exists, shown to someone who merely could
 * not read the list (a 500, or a visibility-scope 403). Drop the `!error`
 * guard on the empty state, or stop destructuring `error`, and this fails.
 */

const failure = Object.assign(new Error('Instrument visibility could not be resolved'), { status: 500 });

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (typeof key === 'string' && key.startsWith('/api/instruments?')) return { data: undefined, error: failure, isLoading: false, mutate: vi.fn() };
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

describe('InstrumentListPage — a failed fetch', () => {
  it('renders the failure line with the server\'s message, not "No instruments registered yet"', () => {
    render(
      <MemoryRouter initialEntries={['/instruments']}>
        <Routes><Route path="/instruments" element={<InstrumentListPage />} /></Routes>
      </MemoryRouter>,
    );
    const line = screen.getByRole('alert');
    expect(line).toHaveTextContent('Could not load instruments. Instrument visibility could not be resolved');
    expect(screen.queryByText(/No instruments registered yet/)).toBeNull();
    expect(screen.queryByText(/Register the first instrument/)).toBeNull();
  });
});
