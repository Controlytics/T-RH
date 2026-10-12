import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Audit 2026-10-12, finding 11 (follow-up). The Debug traces From / To boxes
 * were converted with `new Date(text)` — the BROWSER's zone — while the trace
 * times beside them print in the configured one. New York is configured
 * because this host is IST, the default.
 */
const traceKeys: string[] = [];
const mutate = vi.fn();
const PAGE = { data: [], total: 0, page: 1, totalPages: 1 };
const STATS = {
  total: 0, success: 0, failed: 0, successRate: 100, successRate1h: 100, successRate24h: 100, avgDurationMs: 0,
  topErrors: [], byTransport: {}, byStatus: {},
};
const OP_TRACE = { enabled: true };
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (typeof key === 'string' && key.startsWith('/api/debug/traces?')) {
      traceKeys.push(key);
      return { data: PAGE, isLoading: false, mutate };
    }
    if (key === '/api/debug/traces/stats') return { data: STATS, mutate };
    if (key === '/api/debug/traces/operation-trace') return { data: OP_TRACE, mutate };
    return { data: undefined, isLoading: false, mutate };
  },
  mutate: vi.fn(),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({
    formatDateTime: (d: string) => d, formatDate: (d: string) => d, formatTime: (d: string) => d,
    config: { dateFormat: 'DD/MM/YYYY', timeFormat: '24-hour', timezone: 'America/New_York' },
  }),
}));
vi.mock('@/hooks/use-pagination-config', () => ({
  usePaginationConfig: () => [25, 50, 100],
  usePaginationDefaults: () => ({ defaultLimit: 25, options: [25, 50, 100], pageSizeOptions: [25, 50, 100] }),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn(), put: vi.fn() } }));

const { DebugTracesPage } = await import('../index');

describe('Debug traces — the period filter is read in the configured timezone', () => {
  it('sends typed bounds as New York time', async () => {
    render(<MemoryRouter><DebugTracesPage /></MemoryRouter>);
    const [from, to] = Array.from(document.querySelectorAll('input[type="datetime-local"]')) as HTMLInputElement[];
    fireEvent.change(from, { target: { value: '2026-08-27T00:00' } });
    fireEvent.change(to, { target: { value: '2026-08-27T12:00' } });
    await waitFor(() => {
      const q = new URLSearchParams(traceKeys.at(-1)!.split('?')[1]);
      expect(q.get('from')).toBe('2026-08-27T04:00:00.000Z');
      expect(q.get('to')).toBe('2026-08-27T16:00:00.000Z');
    });
  });
});
