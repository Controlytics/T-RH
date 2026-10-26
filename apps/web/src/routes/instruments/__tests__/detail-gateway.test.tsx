import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * A child instrument names its gateway from its OWN record (2026-10-26).
 *
 * The page used to look the gateway up by id. On AWS a viewer scoped to the
 * child but not the gateway (IOTGW01 sits in no functional location) got a
 * 404 for that lookup on every child they opened: a "Load Error — Instrument
 * not found" toast, "Gateway: No" in the Details card, and the WRONG attribute
 * topic in the connection instructions. The server now sends `gatewayCode` and
 * `gatewayVisible`; the page must use them and fetch nothing about the gateway.
 */
const base = {
  id: 'c-1', name: 'Child', code: 'CWH/RDU/001-00', isActive: true,
  instrumentType: null, manufacturer: null, model: null, serialNumber: null,
  description: null, expectedIntervalSec: null,
  tokenPrefix: 'ABCD1234', lastSeenAt: null, tokenRevealable: true,
  createdAt: '2026-08-06T00:00:00.000Z', createdBy: null,
  block: null, area: null, location: null,
  isGateway: false, gatewayId: 'gw-1', lastSeenVia: null,
  profileId: 'p-1', profileName: null,
  gatewayCode: 'IOTGW01',
};
const INSTRUMENT = { current: { ...base, gatewayVisible: false } as Record<string, unknown> };
/** Every key the page asked SWR for. */
const keys: string[] = [];

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key) keys.push(key);
    if (key === '/api/instruments/c-1') return { data: INSTRUMENT.current, mutate: vi.fn() };
    if (key === '/api/instruments/c-1/children') return { data: { data: [] }, mutate: vi.fn() };
    if (key === '/api/instruments/c-1/attributes') return { data: { data: [] }, mutate: vi.fn() };
    return { data: undefined, mutate: vi.fn() };
  },
  mutate: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getWithReauth: vi.fn(), postWithReauth: vi.fn(), putWithReauth: vi.fn() },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDate: (v: string) => v, formatTime: () => '' }),
}));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: vi.fn(), isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { InstrumentDetailPage } = await import('../detail');

const renderPage = () => render(
  <MemoryRouter initialEntries={['/instruments/c-1']}>
    <Routes>
      <Route path="/instruments/:id" element={<InstrumentDetailPage />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => { keys.length = 0; });

describe('InstrumentDetailPage — the gateway a child reports through', () => {
  it('names a gateway the viewer cannot open, without linking to it or fetching it', () => {
    INSTRUMENT.current = { ...base, gatewayVisible: false };
    renderPage();
    expect(screen.getAllByText('Child of IOTGW01').length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /child of iotgw01/i })).not.toBeInTheDocument();
    // The lookup that 404'd on AWS must not happen at all.
    expect(keys).not.toContain('/api/instruments/gw-1');
  });

  it('links to a gateway the viewer can open — still without fetching it', () => {
    INSTRUMENT.current = { ...base, gatewayVisible: true };
    renderPage();
    expect(screen.getByRole('link', { name: /child of iotgw01/i })).toHaveAttribute('href', '/instruments/gw-1');
    expect(keys).not.toContain('/api/instruments/gw-1');
  });

  it('says "No" for an instrument that reports directly', () => {
    INSTRUMENT.current = { ...base, gatewayId: null, gatewayCode: null, gatewayVisible: false };
    renderPage();
    expect(screen.queryByText(/child of/i)).not.toBeInTheDocument();
  });
});
