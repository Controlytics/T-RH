import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReportSnapshot } from '@/lib/pdf-report';

/**
 * The Audit Trail PDF and Excel export as they printed BEFORE report templates
 * (2026-11-03, page reports on templates — spec §12, "built-in equals today").
 * Captured by driving the REAL page — its inline PDF builder had no function of
 * its own — with only the delivery and the Excel writer stubbed to keep what
 * they were handed. The report labels are the real defaults.
 */

const FIXTURE = join(__dirname, 'fixtures', 'audit-report-builtin.json');

/** Three records: a login, an attribute change whose summary runs past 80 characters, a redacted one with no IP or role. */
const RECORDS = [
  {
    id: 'r1', timestamp: '2026-09-21T10:00:00.000Z', action: 'LOGIN', userId: 'superadmin', userName: 'superadmin', userRole: 'SUPER_ADMIN',
    targetType: 'user', targetId: 'superadmin', targetName: 'superadmin', ipAddress: '10.0.0.5', beforeValue: null, afterValue: null,
    reason: null, signatureMeaning: null, chainPosition: 1, redactedAt: null,
  },
  {
    id: 'r2', timestamp: '2026-09-21T10:05:00.000Z', action: 'INSTRUMENT_ATTRIBUTE_UPDATED', userId: 'qa.lead', userName: 'qa.lead', userRole: 'QA',
    targetType: 'instrument', targetId: '6f1c2b8e-3d4a-4b5c-8d9e-0f1a2b3c4d5e', targetName: 'CWH/RDU/046-00', ipAddress: '10.0.0.7',
    beforeValue: { key: 'Location', value: 'Room 1' },
    afterValue: { key: 'Location', value: 'LCMS Room-II beside the dissolution laboratory on the north corridor' },
    reason: 'Relabelled after the layout change', signatureMeaning: null, chainPosition: 2, redactedAt: null,
  },
  {
    id: 'r3', timestamp: '2026-09-21T10:10:00.000Z', action: 'USER_UPDATED', userId: 'admin', userName: 'admin', userRole: null,
    targetType: 'user', targetId: 'operator1', targetName: 'operator1', ipAddress: null, beforeValue: null, afterValue: null,
    reason: null, signatureMeaning: null, chainPosition: 3,
    redactedAt: '2026-09-22T08:00:00.000Z', redactedByName: 'superadmin', redactionReason: 'Personal data removed on request',
  },
];

const AUDIT_PAGE = { data: RECORDS, total: 3, page: 1, totalPages: 1, hardDeleteEnabled: false };
const DIRECT = { mode: 'DIRECT', remarksRequired: true, passwordRequired: false } as const;
const DOWNLOADS = { alarms: DIRECT, 'audit-trail': DIRECT };
const mutate = vi.fn();

vi.mock('swr', () => ({
  default: (key: unknown) => {
    if (typeof key === 'string' && key.startsWith('/api/audit?')) return { data: AUDIT_PAGE, isLoading: false, mutate };
    if (key === '/api/config/report-downloads/current') return { data: DOWNLOADS, mutate };
    return { data: undefined, isLoading: false, mutate };
  },
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'me', username: 'superadmin', fullName: 'Super Admin', role: 'SUPER_ADMIN', permissions: [] } }),
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({
    formatDateTime: (d: string) => d.slice(0, 16).replace('T', ' '), formatDate: (d: string) => d.slice(0, 10), formatTime: (d: string) => d.slice(11, 16),
    config: undefined,
  }),
}));
vi.mock('@/hooks/use-pagination-config', () => ({
  usePaginationConfig: () => [25, 50, 100],
  usePaginationDefaults: () => ({ defaultLimit: 25, options: [25, 50, 100], pageSizeOptions: [25, 50, 100] }),
}));
vi.mock('@/hooks/use-role-colors', () => ({ useRoleColors: () => ({ roleColors: {}, rolesData: [] }) }));
vi.mock('@/hooks/use-export-limit', () => ({ useExportLimit: () => ({ maxRecords: 5000, tooLargeMessage: () => 'Too large' }) }));
vi.mock('@/hooks/use-reauth', async (importOriginal) => ({
  reauthActionLabel: (await importOriginal<typeof import('@/hooks/use-reauth')>()).reauthActionLabel,
  useReauth: () => ({
    execute: async (_a: string, cb: (p?: string) => Promise<void>) => { await cb(); },
    executeWithResult: async (_a: string, cb: (p?: string) => Promise<unknown>) => cb(undefined),
    isOpen: false, password: '', error: '', isVerifying: false, action: null,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: vi.fn(async (url: string) => (String(url).startsWith('/api/audit?') ? { data: RECORDS, total: RECORDS.length } : {})),
    post: vi.fn(), put: vi.fn(), delete: vi.fn(), postWithReauth: vi.fn(), putWithReauth: vi.fn(), deleteWithReauth: vi.fn(),
  },
}));

/** What the page handed the delivery and the Excel writer. */
const delivered: { report: { getSnapshot: () => ReportSnapshot }; title: string; subtitle?: string }[] = [];
const excel: { head: string[]; rows: string[][] }[] = [];
vi.mock('@/lib/report-delivery', () => ({
  deliverReport: async (input: (typeof delivered)[number]) => { delivered.push(input); return 'DOWNLOADED'; },
  deliveryToast: () => ({ tone: 'success', title: 'Downloaded', message: '' }),
}));
vi.mock('@/lib/report-export-log', () => ({ logReportExport: vi.fn(async () => undefined) }));
vi.mock('@/lib/excel-export', () => ({
  exportToExcel: (o: { head: string[]; rows: string[][] }) => { excel.push({ head: o.head, rows: o.rows }); },
}));

const { AuditTrailPage } = await import('../index');

/** What is frozen: the snapshot as JSON (an absent field is absent). */
const frozen = (s: ReportSnapshot) => JSON.parse(JSON.stringify({
  version: s.version, reportType: s.reportType, title: s.title, subtitle: s.subtitle, orientation: s.orientation,
  config: s.config, chrome: s.chrome, sections: s.sections,
}));

beforeEach(() => {
  delivered.length = 0;
  excel.length = 0;
  // Branding with no logo of its own; the default logo request fails (no logo drawn).
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (String(url).endsWith('/api/config/branding')) return { ok: true, json: async () => ({ companyName: 'Branding Co', appName: 'Branding App' }) };
    return { ok: false };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Export → the format → remarks → Download. */
async function exportAs(format: 'PDF' | 'Excel') {
  render(<MemoryRouter><AuditTrailPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /export/i }));
  fireEvent.click(screen.getByRole('button', { name: format === 'PDF' ? /export as pdf/i : /export as excel/i }));
  fireEvent.change(await screen.findByRole('textbox', { name: /remark|reason/i }), { target: { value: 'Quarterly audit review.' } });
  fireEvent.click(screen.getByRole('button', { name: /^download$/i }));
}

describe('the Audit Trail export as it printed before templates (captured)', () => {
  it('captures or matches the PDF and the Excel export', async () => {
    await exportAs('PDF');
    await waitFor(() => expect(delivered).toHaveLength(1));
    const pdf = frozen(delivered[0].report.getSnapshot());
    cleanup();
    await exportAs('Excel');
    await waitFor(() => expect(excel).toHaveLength(1));
    const captured = { pdf, excel: excel[0] };
    if (process.env.CAPTURE === '1') {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(captured, null, 2)}\n`, 'utf8');
    }
    expect(captured).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  });
});
