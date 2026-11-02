import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * The detail band prints the SERVER's `reporting` and
 * `effectiveExpectedIntervalSec`. Here lastSeenAt is "now" and
 * expectedIntervalSec is null: computed in the browser that reads Active with
 * "Inactive after N min"; the server says a TCP/IP instrument read every 60 s
 * is NOT reporting.
 */
const instrument = {
  id: 'i-1', name: 'Sensor', code: 'T-1', isActive: true,
  instrumentType: null, manufacturer: null, model: null, serialNumber: null,
  description: null, expectedIntervalSec: null,
  reporting: false, effectiveExpectedIntervalSec: 60,
  tokenPrefix: null, lastSeenAt: new Date().toISOString(), tokenRevealable: false,
  createdAt: '2026-08-06T00:00:00.000Z', createdBy: null,
  block: null, area: null, location: null,
  isGateway: false, gatewayId: null, lastSeenVia: 'polled',
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
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    delete: vi.fn(), get: vi.fn(), post: vi.fn(), put: vi.fn(),
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
    execute: vi.fn(),
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { InstrumentDetailPage } = await import('../detail');

describe("InstrumentDetailPage - reporting is the server's", () => {
  it('shows Inactive and the effective read interval the server sent', () => {
    render(
      <MemoryRouter initialEntries={['/instruments/i-1']}>
        <Routes><Route path="/instruments/:id" element={<InstrumentDetailPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(screen.queryByText('Active')).toBeNull();
    expect(screen.getByText('Expected every 60s')).toBeInTheDocument();
  });
});
