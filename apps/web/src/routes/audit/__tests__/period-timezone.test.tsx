import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Audit 2026-10-12, finding 11 (follow-up). The From / To boxes were converted
 * with `new Date(text)` — the BROWSER's zone — while every time on the page and
 * in the export prints in the configured one. New York is configured because
 * this host is IST, the default. Mocks as in page-render.test.tsx.
 */
const auditKeys: string[] = [];
const mutate = vi.fn();
const AUDIT = {
  data: [{
    id: 'a-1', timestamp: '2026-09-21T10:00:00.000Z', action: 'LOGIN', userId: 'u-1', userName: 'superadmin', userRole: 'SUPER_ADMIN',
    targetType: 'user', targetId: 'u-1', targetName: 'superadmin', ipAddress: '127.0.0.1', beforeValue: null, afterValue: null,
    reason: null, signatureMeaning: null, chainPosition: 1, redactedAt: null,
  }],
  total: 5764, page: 1, totalPages: 231,
};
const RESPONSES: Record<string, unknown> = {
  '/api/config/audit-templates/current': {},
  '/api/roles/active': [],
};
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (typeof key === 'string' && key.startsWith('/api/audit?')) auditKeys.push(key);
    if (typeof key === 'string' && key.startsWith('/api/audit?')) return { data: AUDIT, isLoading: false, mutate };
    if (typeof key === 'string' && key in RESPONSES) return { data: RESPONSES[key], mutate };
    return { data: undefined, isLoading: false, mutate };
  },
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'me', username: 'superadmin', fullName: 'Super Admin', role: 'SUPER_ADMIN', permissions: [] } }),
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
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
vi.mock('@/hooks/use-role-colors', () => ({ useRoleColors: () => ({ roleColors: {}, rolesData: [] }) }));
vi.mock('@/hooks/use-export-limit', () => ({ useExportLimit: () => ({ maxRecords: 5000, tooLargeMessage: 'Too large' }) }));
vi.mock('@/hooks/use-report-page-titles', () => ({
  useReportPageTitles: () => ({ branding: {}, companyName: 'Controlytics', appName: 'T&RH-Monitoring' }),
}));
const COLUMNS = { timestamp: 'Timestamp', action: 'Action', user: 'User', role: 'Role', targetType: 'Target', description: 'Description', ipAddress: 'IP address' };
vi.mock('../../../hooks/use-report-labels', () => ({
  useReportLabels: () => ({ labelsFor: () => ({ title: 'Audit Trail', subtitle: '', columns: COLUMNS }) }),
}));
vi.mock('@/hooks/use-reauth', async (importOriginal) => ({
  // The real label lookup — the page names the action its one dialog signs.
  reauthActionLabel: (await importOriginal<typeof import('@/hooks/use-reauth')>()).reauthActionLabel,
  useReauth: () => ({
    execute: async (_a: string, cb: (p?: string) => Promise<void>) => { await cb(); },
    isOpen: false, password: '', error: '', isVerifying: false, action: null,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), postWithReauth: vi.fn(), putWithReauth: vi.fn(), deleteWithReauth: vi.fn() },
}));

const { AuditTrailPage } = await import('../index');

describe('Audit Trail — the period filter is read in the configured timezone', () => {
  it('sends typed bounds as New York time', async () => {
    render(<MemoryRouter><AuditTrailPage /></MemoryRouter>);
    const [from, to] = Array.from(document.querySelectorAll('input[type="datetime-local"]')) as HTMLInputElement[];
    fireEvent.change(from, { target: { value: '2026-08-27T00:00' } });
    fireEvent.change(to, { target: { value: '2026-08-27T12:00' } });
    await waitFor(() => {
      const q = new URLSearchParams(auditKeys.at(-1)!.split('?')[1]);
      expect(q.get('startDate')).toBe('2026-08-27T04:00:00.000Z');
      expect(q.get('endDate')).toBe('2026-08-27T16:00:00.000Z');
    });
  });
});
