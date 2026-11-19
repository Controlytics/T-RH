import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Windows packaging plan A1 (2026-11-19): System Health names the running release —
 * the version (and the CI build when there is one), the commit and the build date —
 * from the server's `release` object. An API older than that sends no `release`, and
 * the page says so rather than printing a blank.
 */

const base = {
  os: {
    hostname: 'cwh-srv', platform: 'win32', arch: 'x64', release: '10.0', uptimeSeconds: 3600,
    loadAvg: { '1m': 0, '5m': 0, '15m': 0, available: false },
  },
  memory: { totalBytes: 8e9, usedBytes: 4e9, freeBytes: 4e9, usagePercent: 50 },
  cpu: { cores: 4, model: 'Test CPU', usagePercent: 12 },
  disk: { path: 'C:\\data', totalBytes: 100e9, usedBytes: 40e9, freeBytes: 60e9, usagePercent: 40, available: true, error: null },
  process: { nodeVersion: 'v24.0.0', pid: 1, uptimeSeconds: 60, memoryUsage: { rss: 1e8, heapTotal: 5e7, heapUsed: 2e7, external: 1e6 } },
  api: { totalRequests: 10, requestsPerMinute: 1 },
  database: { connected: true, databaseSize: '1 GB', activeConnections: 2, totalTables: 37 },
  timestamp: '2026-11-19T10:00:00.000Z',
};
type Release = { product: string; version: string; build: number | null; commit: string | null; date: string | null };
let health: typeof base & { release?: Release } = base;

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/system-health') return { data: health, isLoading: false, mutate: vi.fn() };
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
}));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDate: (v: string) => v, formatTime: (v: string) => v, formatDateTime: (v: string) => `formatted ${v}` }),
}));

const { SystemHealthPage, releaseLabel } = await import('../index');
const mount = () => render(<MemoryRouter><SystemHealthPage /></MemoryRouter>);

describe('SystemHealthPage — the running release', () => {
  it('an installed release: version with its build, the short commit and the build date', () => {
    health = {
      ...base,
      release: { product: 'T&RH Monitoring', version: '1.2.0', build: 57, commit: '0123456789abcdef0123', date: '2026-11-19T09:00:00Z' },
    };
    mount();
    expect(screen.getByTestId('system-version')).toHaveTextContent('Version: 1.2.0 (build 57)');
    expect(screen.getByText('0123456789ab')).toBeInTheDocument();
    expect(screen.getByText('formatted 2026-11-19T09:00:00Z')).toBeInTheDocument();
  });

  it('a checkout: the -dev version alone, and no commit or build date line', () => {
    health = { ...base, release: { product: 'T&RH Monitoring', version: '1.0.0-dev', build: null, commit: null, date: null } };
    mount();
    expect(screen.getByTestId('system-version')).toHaveTextContent('Version: 1.0.0-dev');
    expect(screen.queryByText('Commit:')).toBeNull();
    expect(screen.queryByText('Built:')).toBeNull();
  });

  it('an API that sends no release says "Not reported", never a blank', () => {
    health = base;
    mount();
    expect(screen.getByTestId('system-version')).toHaveTextContent('Version: Not reported');
  });

  it('releaseLabel', () => {
    expect(releaseLabel(undefined)).toBe('Not reported');
    expect(releaseLabel({ product: 'p', version: '1.0.0', build: 0, commit: null, date: null })).toBe('1.0.0 (build 0)');
  });
});
