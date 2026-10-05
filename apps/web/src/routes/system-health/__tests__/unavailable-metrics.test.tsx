import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * audit 2026-10-03 follow-up: the API now says when a metric could NOT be
 * measured (`disk.available`, `loadAvg.available`). The page must say
 * "Unavailable", never print the zeros the server fills in — "0 B / 0 B" reads
 * as a full disk with nothing on it, and 0/0/0 load as an idle server.
 */

const base = {
  os: {
    hostname: 'cwh-srv', platform: 'win32', arch: 'x64', release: '10.0', uptimeSeconds: 3600,
    loadAvg: { '1m': 0, '5m': 0, '15m': 0, available: false },
  },
  memory: { totalBytes: 8e9, usedBytes: 4e9, freeBytes: 4e9, usagePercent: 50 },
  cpu: { cores: 4, model: 'Test CPU', usagePercent: 12 },
  disk: {
    path: 'C:\\app\\uploads', totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePercent: 0,
    available: false, error: 'Disk usage unavailable for C:\\app\\uploads — statfs: not supported' as string | null,
  },
  process: { nodeVersion: 'v24.0.0', pid: 1, uptimeSeconds: 60, memoryUsage: { rss: 1e8, heapTotal: 5e7, heapUsed: 2e7, external: 1e6 } },
  api: { totalRequests: 10, requestsPerMinute: 1 },
  database: { connected: true, databaseSize: '1 GB', activeConnections: 2, totalTables: 37 },
  timestamp: '2026-10-05T10:00:00.000Z',
};
let health: typeof base = base;

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/system-health') return { data: health, isLoading: false, mutate: vi.fn() };
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
}));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDate: (v: string) => v, formatTime: (v: string) => v, formatDateTime: (v: string) => v }),
}));

const { SystemHealthPage } = await import('../index');
const mount = () => render(<MemoryRouter><SystemHealthPage /></MemoryRouter>);

describe('SystemHealthPage — metrics the server could not measure', () => {
  it('prints "Unavailable" for the disk and the load average, with the reader\'s reason on hover, never zeros', () => {
    health = base;
    mount();
    const lines = screen.getAllByText('Unavailable');
    expect(lines).toHaveLength(2);
    // The disk block carries the error as its tooltip and prints the path it describes.
    expect(screen.getByText(/Disk usage unavailable for/)).toBeInTheDocument();
    expect(screen.getByText('C:\\app\\uploads')).toBeInTheDocument();
    expect(screen.queryByText(/0 B \/ 0 B/)).toBeNull();
    expect(screen.queryByText('1m:')).toBeNull();
  });

  it('prints the figures when both are available', () => {
    health = {
      ...base,
      os: { ...base.os, loadAvg: { '1m': 0.5, '5m': 0.4, '15m': 0.3, available: true } },
      disk: { ...base.disk, totalBytes: 100e9, usedBytes: 40e9, freeBytes: 60e9, usagePercent: 40, available: true, error: null },
    };
    mount();
    expect(screen.queryByText('Unavailable')).toBeNull();
    expect(screen.getByText('1m:')).toBeInTheDocument();
    expect(screen.getByText(/37\.3 GB \/ 93\.1 GB/)).toBeInTheDocument();
  });
});
