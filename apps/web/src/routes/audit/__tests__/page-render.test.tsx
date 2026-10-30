import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Audit Trail page had no render test before UI v3 (2026-09-21). This
 * pins its shape on the shared band: the administered title inside it, the
 * record total as the band's one figure, and the export as its action.
 */
const mutate = vi.fn();
const AUDIT = {
  data: [{
    id: 'a-1', timestamp: '2026-09-21T10:00:00.000Z', action: 'LOGIN', userId: 'u-1', userName: 'superadmin', userRole: 'SUPER_ADMIN',
    targetType: 'user', targetId: 'u-1', targetName: 'superadmin', ipAddress: '127.0.0.1', beforeValue: null, afterValue: null,
    reason: null, signatureMeaning: null, chainPosition: 1, redactedAt: null,
  }],
  total: 5764, page: 1, totalPages: 231,
  hardDeleteEnabled: false,
};
// The same page with the installation's hard-delete switch ON (2026-10-12).
const AUDIT_HARD_DELETE_ON = { ...AUDIT, hardDeleteEnabled: true };
let auditResponse: typeof AUDIT = AUDIT;
const RESPONSES: Record<string, unknown> = {
  '/api/config/audit-templates/current': {},
  '/api/roles/active': [],
};
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (typeof key === 'string' && key.startsWith('/api/audit?')) return { data: auditResponse, isLoading: false, mutate };
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
  useDatetimeFormat: () => ({ formatDateTime: (d: string) => d, formatDate: (d: string) => d, formatTime: (d: string) => d }),
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

describe('AuditTrailPage — UI v3 shape', () => {
  it('opens with the hero band carrying the administered title, the record total and the export', () => {
    render(<MemoryRouter><AuditTrailPage /></MemoryRouter>);
    const hero = screen.getByTestId('page-hero');
    expect(hero.contains(screen.getByRole('heading', { level: 1, name: 'Audit Trail' }))).toBe(true);
    expect(hero).toHaveTextContent('5,764');
    expect(hero.contains(screen.getByRole('button', { name: /export/i }))).toBe(true);
  });
});

describe('AuditTrailPage — a bordered grid, 15px, bold (2026-09-25)', () => {
  // Operator: "make audit trail page in to table format … font sizes
  // increased and bold, and table lines shoud be visibl". The shared Table's
  // `grid` puts `.tbl-grid` (a line around every cell, a zebra) on the
  // table; the audit cells set 15px bold type.
  it('renders the records as a .tbl-grid table with bold 15px identity cells', () => {
    render(<MemoryRouter><AuditTrailPage /></MemoryRouter>);
    const table = screen.getByRole('table');
    expect(table.className).toMatch(/(^|\s)tbl-grid(\s|$)/);
    expect(table).toHaveAttribute('data-grid', 'true');
    const by = screen.getByText('u-1');
    expect(by.className).toMatch(/(^|\s)font-bold(\s|$)/);
    expect(by.className).toMatch(/text-\[0\.9375rem\]/);
  });
});

/**
 * 2026-10-12: permanent deletion is a Configuration switch, default OFF, and
 * the page offers its controls only when the SERVER says it is on (the
 * `hardDeleteEnabled` flag on GET /api/audit). Here the viewer holds every
 * permission, so the switch is the only thing that can hide them.
 */
describe('AuditTrailPage — hard-delete controls follow the server\'s switch', () => {
  it('offers no "Delete permanently" while the switch is off', () => {
    auditResponse = AUDIT;
    render(<MemoryRouter><AuditTrailPage /></MemoryRouter>);
    expect(screen.queryByTitle(/delete permanently/i)).toBeNull();
    // Redact (chain-preserving) is still offered.
    expect(screen.getByTitle(/redact record/i)).toBeInTheDocument();
  });

  it('offers it once the server says the switch is on', () => {
    auditResponse = AUDIT_HARD_DELETE_ON;
    try {
      render(<MemoryRouter><AuditTrailPage /></MemoryRouter>);
      expect(screen.getByTitle(/delete permanently/i)).toBeInTheDocument();
    } finally {
      auditResponse = AUDIT;
    }
  });
});
