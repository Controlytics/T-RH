import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Performance audit 2026-11-17, P-08 / S2-H5: the instrument detail page polled
 * EVERY reading the instrument had ever sent (`?limit=<ALL_RECORDS>`) every 15 s —
 * 9.2 MB and a 1.3 s event-loop stall for an 87k-reading instrument, per open page —
 * and showed only `latest`. It now asks for one history row.
 */
const instrument = {
  id: 'i-1', name: 'Sensor', code: 'T-1', isActive: true,
  instrumentType: null, manufacturer: null, model: null, serialNumber: null,
  description: null, expectedIntervalSec: 60, reporting: true, effectiveExpectedIntervalSec: 60,
  tokenPrefix: null, lastSeenAt: new Date().toISOString(), tokenRevealable: false,
  createdAt: '2026-08-06T00:00:00.000Z', createdBy: null,
  block: null, area: null, location: null, isGateway: false, gatewayId: null, lastSeenVia: 'direct',
};
const TELEMETRY = { latest: [{ key: 'temperature', value: 22.5, valueType: 'float', ts: '2026-11-17T10:00:00.000Z' }] };
const keys: string[] = [];

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key) keys.push(key);
    if (key === '/api/instruments/i-1') return { data: instrument, mutate: vi.fn() };
    if (key?.startsWith('/api/instruments/i-1/telemetry')) return { data: TELEMETRY, mutate: vi.fn() };
    if (key === '/api/instruments/i-1/attributes') return { data: { data: [] }, mutate: vi.fn() };
    if (key === '/api/instruments/i-1/children') return { data: { data: [] }, mutate: vi.fn() };
    return { data: undefined, mutate: vi.fn() };
  },
  mutate: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({
  apiClient: { delete: vi.fn(), get: vi.fn(), post: vi.fn(), put: vi.fn(), getWithReauth: vi.fn(), postWithReauth: vi.fn(), putWithReauth: vi.fn() },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({ useDatetimeFormat: () => ({ formatDate: (v: string) => v, formatTime: () => '' }) }));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: vi.fn(), isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { InstrumentDetailPage } = await import('../detail');

describe('InstrumentDetailPage — the telemetry poll asks only for what it shows', () => {
  it('requests ONE history row, never every reading, and still shows the latest values', () => {
    render(
      <MemoryRouter initialEntries={['/instruments/i-1']}>
        <Routes><Route path="/instruments/:id" element={<InstrumentDetailPage />} /></Routes>
      </MemoryRouter>,
    );
    const telemetryKeys = [...new Set(keys.filter((k) => k.startsWith('/api/instruments/i-1/telemetry')))];
    expect(telemetryKeys).toEqual(['/api/instruments/i-1/telemetry?limit=1']);
    expect(screen.getByText('temperature')).toBeInTheDocument();
  });
});
