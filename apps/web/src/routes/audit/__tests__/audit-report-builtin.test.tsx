import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinReportTemplate, REPORT_TEMPLATE_FIELDS, type ReportTemplateRow } from '@digilog/shared';
import type { ReportSnapshot } from '@/lib/pdf-report';
import type { PlanSection } from '@/lib/report-template-plan';
import { BRANDING_LOGO_PNG, stubBrandingFetch } from '@/test-support/branding-stub';
import { AUDIT_RECORDS } from './fixtures/audit-records';

/**
 * The Audit Trail PDF and Excel export (2026-11-03, page reports on templates
 * — spec §12, "built-in equals today"). The fixture was captured (commit
 * f60a2474) from the page's old inline PDF builder by driving the REAL page,
 * with only the delivery and the Excel writer stubbed to keep what they were
 * handed; that builder is gone and the fixture is the frozen record of it. The
 * report labels are the real defaults. The PDF now prints through the report
 * template the server resolves (here, the plan); with none it is the built-in
 * and must print what the old builder printed — except the subtitle, which
 * says "Search: —" when there is no search (ruling P-2, the ONE accepted
 * difference). The Excel export is not templated and is unchanged.
 */

const FIXTURE = join(__dirname, 'fixtures', 'audit-report-builtin.json');

const AUDIT_PAGE = { data: AUDIT_RECORDS, total: 3, page: 1, totalPages: 1, hardDeleteEnabled: false };
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
    get: vi.fn(async (url: string) => (String(url).startsWith('/api/audit?') ? { data: AUDIT_RECORDS, total: AUDIT_RECORDS.length } : {})),
    post: vi.fn(), put: vi.fn(), delete: vi.fn(), postWithReauth: vi.fn(), putWithReauth: vi.fn(), deleteWithReauth: vi.fn(),
  },
}));

/**
 * The template plan — the server's answer — as module-level constants (a
 * fresh object per render re-runs effects forever). `plan` picks one; every
 * call is recorded, so WHEN the page asks is observable.
 */
const APPLICATION = (resolved: ReportTemplateRow | null): PlanSection => ({
  profileId: null, profileName: null, instrumentIds: [], resolved, templates: resolved ? [resolved] : [],
  availableIds: REPORT_TEMPLATE_FIELDS('page:audit-trail').map((f) => f.id),
});
const SAVED: ReportTemplateRow = (() => {
  const document = builtinReportTemplate('page:audit-trail');
  document.header.title = 'Activity Log';
  document.columns = [
    { id: 'audit.user', heading: 'Who', show: true },
    { id: 'audit.action', heading: 'What', show: true },
    { id: 'audit.ip', heading: 'Where', show: false },
  ];
  return { id: 't1', name: 'Inspector copy', kind: 'page:audit-trail', profileId: null, isDefault: true, document } as unknown as ReportTemplateRow;
})();
const PLANS = {
  builtin: { sections: [APPLICATION(null)], loading: false, error: undefined },
  saved: { sections: [APPLICATION(SAVED)], loading: false, error: undefined },
  failed: { sections: [], loading: false, error: new Error('503') },
  loading: { sections: [], loading: true, error: undefined },
};
let plan: (typeof PLANS)[keyof typeof PLANS] = PLANS.builtin;
const planCalls: { kind: string; ids: readonly string[]; enabled: boolean | undefined }[] = [];
vi.mock('@/lib/report-template-plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/report-template-plan')>()),
  useReportTemplatePlan: (kind: string, ids: readonly string[], opts?: { enabled?: boolean }) => {
    planCalls.push({ kind, ids, enabled: opts?.enabled });
    return plan;
  },
}));

/** What the page handed the delivery and the Excel writer. */
const delivered: { report: { getSnapshot: () => ReportSnapshot }; title: string; subtitle?: string; requestMeta: { recordCount: number } }[] = [];
const excel: { head: string[]; rows: string[][] }[] = [];
vi.mock('@/lib/report-delivery', async (importOriginal) => ({
  // The REAL `deliveredTitles` — the one clamp every page sends its titles through.
  ...(await importOriginal<typeof import('@/lib/report-delivery')>()),
  deliverReport: async (input: (typeof delivered)[number]) => { delivered.push(input); return 'DOWNLOADED'; },
  deliveryToast: () => ({ tone: 'success', title: 'Downloaded', message: '' }),
}));
vi.mock('@/lib/report-export-log', () => ({ logReportExport: vi.fn(async () => undefined) }));
vi.mock('@/lib/excel-export', () => ({
  exportToExcel: (o: { head: string[]; rows: string[][] }) => { excel.push({ head: o.head, rows: o.rows }); },
}));

const { AuditTrailPage } = await import('../index');

/**
 * The chrome less the logo's BYTES. The fixture was captured with the logo
 * request failing (`logoDataUrl: null`); since ruling F-1 was extended
 * (2026-11-03) a report made now REFUSES when Branding's logo cannot be read,
 * so it always carries the logo — pinned on its own below — and the rest of
 * the chrome is compared as captured.
 */
const withoutLogo = <T extends { chrome?: unknown }>(r: T): T => {
  const { logoDataUrl: _logo, ...chrome } = (r.chrome ?? {}) as Record<string, unknown>;
  return { ...r, chrome };
};

/** What is frozen: the snapshot as JSON (an absent field is absent), less the logo's bytes. */
const frozen = (s: ReportSnapshot) => withoutLogo(JSON.parse(JSON.stringify({
  version: s.version, reportType: s.reportType, title: s.title, subtitle: s.subtitle, orientation: s.orientation,
  config: s.config, chrome: s.chrome, sections: s.sections,
})));

beforeEach(() => {
  delivered.length = 0;
  excel.length = 0;
  planCalls.length = 0;
  plan = PLANS.builtin;
  // Branding with no logo of its own: the bundled default logo, which answers.
  stubBrandingFetch({ companyName: 'Branding Co', appName: 'Branding App' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Export → the format; returns once the download dialog shows its remarks box. */
async function openExport(format: 'PDF' | 'Excel', search = '') {
  render(<MemoryRouter><AuditTrailPage /></MemoryRouter>);
  if (search) fireEvent.change(screen.getByPlaceholderText(/search by user/i), { target: { value: search } });
  fireEvent.click(screen.getByRole('button', { name: /export/i }));
  fireEvent.click(screen.getByRole('button', { name: format === 'PDF' ? /export as pdf/i : /export as excel/i }));
  return screen.findByRole('textbox', { name: /remark|reason/i });
}

/** …then remarks → Download. */
async function exportAs(format: 'PDF' | 'Excel', search = '') {
  fireEvent.change(await openExport(format, search), { target: { value: 'Quarterly audit review.' } });
  fireEvent.click(screen.getByRole('button', { name: /^download$/i }));
}

const FROZEN_FILE = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { pdf: ReturnType<typeof frozen>; excel: { head: string[]; rows: string[][] } };
const FROZEN = { ...FROZEN_FILE, pdf: withoutLogo(FROZEN_FILE.pdf) };
const withoutSubtitle = (r: ReturnType<typeof frozen>) => { const { subtitle: _s, ...rest } = r; return rest; };

describe('the built-in Audit Trail PDF on templates equals today\'s', () => {
  it('sections, title, page, legend and chrome as captured; the subtitle says "Search: —" (ruling P-2)', async () => {
    await exportAs('PDF');
    await waitFor(() => expect(delivered).toHaveLength(1));
    const pdf = frozen(delivered[0].report.getSnapshot());
    expect(pdf.sections).toEqual(FROZEN.pdf.sections);
    expect(withoutSubtitle(pdf)).toEqual(withoutSubtitle(FROZEN.pdf));
    expect(pdf.subtitle).toBe('Period: All Time  |  Search: —  |  Total: 3 record(s)  |  21 CFR Part 11 Compliant');
    // The request is titled as printed and counts the records printed.
    expect(delivered[0]).toMatchObject({ title: 'Audit Trail', subtitle: pdf.subtitle, requestMeta: { recordCount: 3 } });
    // Branding's logo is frozen as read (ruling F-1: the configured logo, or no report).
    expect(delivered[0].report.getSnapshot().chrome?.logoDataUrl).toBe(BRANDING_LOGO_PNG);
  });

  it('with a search the subtitle quotes it, as it always did', async () => {
    await exportAs('PDF', 'x');
    await waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0].report.getSnapshot().subtitle)
      .toBe('Period: All Time  |  Search: "x"  |  Total: 3 record(s)  |  21 CFR Part 11 Compliant');
  });

  it('the Excel export is untouched', async () => {
    await exportAs('Excel');
    await waitFor(() => expect(excel).toHaveLength(1));
    expect(excel[0]).toEqual(FROZEN.excel);
  });
});

describe('the PDF dialog names the template; the Excel dialog does not', () => {
  it('asks for the plan only while the PDF dialog is open, application-wide (no instruments)', async () => {
    render(<MemoryRouter><AuditTrailPage /></MemoryRouter>);
    expect(planCalls.length).toBeGreaterThan(0);
    expect(planCalls.every((c) => c.kind === 'page:audit-trail' && c.ids.length === 0 && c.enabled === false)).toBe(true);
    cleanup();
    planCalls.length = 0;
    await openExport('PDF');
    expect(planCalls.at(-1)).toMatchObject({ kind: 'page:audit-trail', enabled: true });
    expect(within(screen.getByRole('dialog')).getByTestId('report-template-line')).toHaveTextContent('Template: Built-in (application-wide)');
  });

  it('Excel: no template line, no plan asked', async () => {
    await openExport('Excel');
    expect(within(screen.getByRole('dialog')).queryByTestId('report-template-line')).toBeNull();
    expect(planCalls.length).toBeGreaterThan(0);
    expect(planCalls.every((c) => c.enabled === false)).toBe(true);
  });
});

describe('a SAVED application template draws the PDF', () => {
  it('its title and its shown columns, in its order, at jsPDF\'s widths', async () => {
    plan = PLANS.saved;
    await openExport('PDF');
    expect(within(screen.getByRole('dialog')).getByTestId('report-template-line')).toHaveTextContent('Template: Inspector copy (application-wide)');
    fireEvent.change(screen.getByRole('textbox', { name: /remark|reason/i }), { target: { value: 'Inspector request.' } });
    fireEvent.click(screen.getByRole('button', { name: /^download$/i }));
    await waitFor(() => expect(delivered).toHaveLength(1));
    const snap = delivered[0].report.getSnapshot();
    expect(snap.title).toBe('Activity Log');
    const table = snap.sections.find((s) => s.kind === 'table');
    expect(table).toMatchObject({ head: ['Who', 'What'], body: [['superadmin', 'LOGIN'], ['qa.lead', 'INSTRUMENT ATTRIBUTE UPDATED'], ['admin', 'USER UPDATED']] });
    expect(table && 'columnStyles' in table ? table.columnStyles : undefined).toBeUndefined();
  });

  it('a plan that failed to load refuses the PDF: nothing is delivered, the dialog says why', async () => {
    plan = PLANS.failed;
    await exportAs('PDF');
    expect(await screen.findByText('The report templates could not be loaded. Close this and try again.', { selector: 'p:not([role="alert"])' })).toBeInTheDocument();
    expect(delivered).toHaveLength(0);
  });

  it('a plan still LOADING refuses the PDF too (ruling R5-6): nothing is delivered, the dialog says it is loading', async () => {
    plan = PLANS.loading;
    await exportAs('PDF');
    expect(await screen.findByText('The report templates are still loading. Try again in a moment.', { selector: 'p:not([role="alert"])' })).toBeInTheDocument();
    expect(delivered).toHaveLength(0);
    // The lines say it is loading — not that the templates failed.
    expect(within(screen.getByRole('dialog')).getByText('Loading the report templates…')).toBeInTheDocument();
  });
});
