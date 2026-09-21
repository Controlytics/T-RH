import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * UI v3 Batch 4 (2026-09-21): the configuration and system screens open with
 * the shared band. Five representative pages are mounted under generic mocks
 * — the Configuration index (card grid), a react-hook-form config page
 * (Password Policy), a config page with a wrapper that used to hold the header
 * beside a sibling (Date/Time), System Health (needs a full data object to get
 * past its skeleton) and Debug traces (a raw table converted to the shared
 * one). Each must render `page-hero` containing its h1.
 */
const mutate = vi.fn();
const HEALTH = {
  os: { hostname: 'cc-box', platform: 'win32', arch: 'x64', release: '10', uptimeSeconds: 3600, loadAvg: { '1m': 0.1, '5m': 0.1, '15m': 0.1 } },
  memory: { totalBytes: 16e9, usedBytes: 8e9, freeBytes: 8e9, usagePercent: 50 },
  cpu: { cores: 8, model: 'CPU', usagePercent: 12 },
  disk: { totalBytes: 500e9, usedBytes: 200e9, freeBytes: 300e9, usagePercent: 40 },
  process: { nodeVersion: 'v24', pid: 1, uptimeSeconds: 600, memoryUsage: { rss: 1e8, heapTotal: 5e7, heapUsed: 3e7, external: 1e6 } },
  api: { totalRequests: 100, requestsPerMinute: 2 },
  database: { connected: true, databaseSize: '1 GB', activeConnections: 3, totalTables: 36 },
  timestamp: '2026-09-21T10:00:00.000Z',
};
const RESPONSES: Record<string, unknown> = {
  '/api/system-health': HEALTH,
  '/api/config/registry/manifest': [],
  '/api/config/password-policy': { minLength: 8, requireUppercase: true, requireLowercase: true, requireNumbers: true, requireSpecialChars: false, expiryDays: 90, historyCount: 5, maxAttempts: 5, lockoutMinutes: 30 },
  '/api/config/datetime': { dateFormat: 'DD/MM/YYYY', timeFormat: '24h', timezone: 'Asia/Kolkata' },
  '/api/debug/traces/stats': {
    total: 0, success: 0, failed: 0, successRate: 100, successRate1h: 100, successRate24h: 100, avgDurationMs: 0,
    topErrors: [], byTransport: {}, byStatus: {},
  },
  '/api/debug/traces/operation-trace': { enabled: true },
  '/api/config/pagination': { defaultLimit: 25, maxLimit: 500, optionCount: 4 },
  '/api/floorplans': { data: [] },
};
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (typeof key === 'string' && key.startsWith('/api/debug/traces?')) return { data: { data: [], total: 0, page: 1, totalPages: 1 }, isLoading: false, mutate };
    if (typeof key === 'string' && key in RESPONSES) return { data: RESPONSES[key], isLoading: false, mutate };
    return { data: undefined, isLoading: false, mutate };
  },
  mutate: vi.fn(),
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'me', username: 'superadmin', fullName: 'Super Admin', role: 'SUPER_ADMIN', permissions: [] } }),
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDateTime: (d: string) => d, formatDate: (d: string) => d, formatTime: (d: string) => d }),
}));
vi.mock('../../../hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDateTime: (d: string) => d, formatDate: (d: string) => d, formatTime: (d: string) => d }),
}));
vi.mock('@/hooks/use-pagination-config', () => ({
  usePaginationConfig: () => [25, 50, 100],
  usePaginationDefaults: () => ({ defaultLimit: 25, options: [25, 50, 100], pageSizeOptions: [25, 50, 100] }),
}));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_a: string, cb: (p?: string) => Promise<void>) => { await cb(); },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), postWithReauth: vi.fn(), putWithReauth: vi.fn(), deleteWithReauth: vi.fn() },
}));

const heroHas = (name: string | RegExp) => {
  const hero = screen.getByTestId('page-hero');
  expect(hero.contains(screen.getByRole('heading', { level: 1, name }))).toBe(true);
};

describe('configuration and system screens — UI v3 shape', () => {
  it('Configuration index', async () => {
    const { ConfigIndexPage } = await import('../index');
    render(<MemoryRouter><ConfigIndexPage /></MemoryRouter>);
    heroHas('System Configuration');
  });
  it('Password Policy', async () => {
    const { PasswordPolicyPage } = await import('../password-policy');
    render(<MemoryRouter><PasswordPolicyPage /></MemoryRouter>);
    heroHas('General & Password Settings');
  });
  it('Date/Time Format', async () => {
    const { DatetimeConfigPage } = await import('../datetime');
    render(<MemoryRouter><DatetimeConfigPage /></MemoryRouter>);
    heroHas(/date\/time/i);
  });
  it('System Health', async () => {
    const { SystemHealthPage } = await import('../../system-health/index');
    render(<MemoryRouter><SystemHealthPage /></MemoryRouter>);
    heroHas('System Health');
  });
  // The four card-based forms rebuilt on FormSection (operator: "do those
  // four forms also") — each form is a labelled region under the plate.
  it('Backup: both forms are FormSections', async () => {
    const { BackupRestorePage } = await import('../backup');
    render(<MemoryRouter><BackupRestorePage /></MemoryRouter>);
    heroHas(/backup/i);
    expect(screen.getByRole('region', { name: 'Create Backup' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Restore from Backup' })).toBeInTheDocument();
  });
  it('Pagination: the form is a FormSection', async () => {
    const { PaginationConfigPage } = await import('../pagination');
    render(<MemoryRouter><PaginationConfigPage /></MemoryRouter>);
    expect(screen.getByRole('region', { name: 'Page Size Configuration' })).toBeInTheDocument();
  });
  it('Floorplans: the plan editor is a FormSection with its controls in the plate', async () => {
    const { FloorplansConfigPage } = await import('../floorplans');
    render(<MemoryRouter><FloorplansConfigPage /></MemoryRouter>);
    heroHas(/floor/i);
    const plan = screen.getByRole('region', { name: 'Plan' });
    expect(plan.contains(screen.getByRole('button', { name: /upload plan/i }))).toBe(true);
  });
  it('Debug traces, with its table on the shared band', async () => {
    const { DebugTracesPage } = await import('../../debug/index');
    render(<MemoryRouter><DebugTracesPage /></MemoryRouter>);
    heroHas(/debug traces/i);
    expect(document.querySelector('thead')).toHaveAttribute('data-band', 'gradient');
  });
});
