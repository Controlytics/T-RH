import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Deleting an instrument is the most destructive act on this page — the device
 * loses its credentials and stops being able to send anything. It confirmed
 * through `window.confirm` until 2026-08-06.
 *
 * The double-click case is not hypothetical: before the swap there was NO
 * in-flight guard at all, so a second click sent a second DELETE and the
 * operator got a 404 toast for a row that had just been removed.
 */
const instrument = {
  id: 'i-1', name: 'Sensor', code: 'T-1', isActive: true,
  instrumentType: null, manufacturer: null, model: null, serialNumber: null,
  description: null, expectedIntervalSec: null,
  tokenPrefix: 'ABCD1234', lastSeenAt: null, tokenRevealable: true,
  createdAt: '2026-08-06T00:00:00.000Z', createdBy: null,
  block: null, area: null, location: null,
  isGateway: false, gatewayId: null, lastSeenVia: null,
};

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/instruments/i-1') return { data: instrument, mutate: vi.fn() };
    if (key === '/api/instruments/i-1/attributes') return { data: { data: [] }, mutate: vi.fn() };
    if (key === '/api/instruments/i-1/children') return { data: { data: [] }, mutate: vi.fn() };
    return { data: undefined, mutate: vi.fn() };
  },
  mutate: vi.fn(),
}));

const del = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    delete: (...a: unknown[]) => del(...a),
    get: vi.fn(), post: vi.fn(), put: vi.fn(),
    getWithReauth: vi.fn(), postWithReauth: vi.fn(), putWithReauth: vi.fn(),
  },
}));

vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDate: (v: string) => v, formatTime: () => '' }),
}));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_a: string, cb: (p?: string) => Promise<void>) => { await cb(); },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { InstrumentDetailPage } = await import('../detail');

const renderPage = () => render(
  <MemoryRouter initialEntries={['/instruments/i-1']}>
    <Routes>
      <Route path="/instruments/:id" element={<InstrumentDetailPage />} />
      <Route path="/instruments" element={<div>Instrument list</div>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => { del.mockReset().mockResolvedValue({}); });

describe('instrument detail — delete confirmation', () => {
  it('opens the dialog, naming the instrument, without deleting', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByText(/stops being able to send data/i)).toBeInTheDocument();
  });

  it('deletes and returns to the list once confirmed', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^delete instrument$/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/instruments/i-1'));
    await waitFor(() => expect(screen.getByText('Instrument list')).toBeInTheDocument());
  });

  it('deletes nothing when cancelled', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByText(/stops being able to send data/i)).not.toBeInTheDocument());
    expect(del).not.toHaveBeenCalled();
  });

  it('sends one DELETE however many times the confirm button is clicked', async () => {
    let release: (v: unknown) => void = () => {};
    del.mockImplementationOnce(() => new Promise((res) => { release = res; }));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    const confirmBtn = screen.getByRole('button', { name: /^delete instrument$/i });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(screen.getByRole('button', { name: /deleting…/i })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /deleting…/i }));

    release({});
    await waitFor(() => expect(screen.getByText('Instrument list')).toBeInTheDocument());
    expect(del).toHaveBeenCalledTimes(1);
  });
});
