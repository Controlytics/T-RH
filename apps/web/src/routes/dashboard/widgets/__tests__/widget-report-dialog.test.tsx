import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';
import {
  WIDGET_REPORT_FIELDS, builtinReportTemplate,
  type CustomWidget, type LatestKeyValue, type ReportTemplateDocument,
} from '@digilog/shared';
import type { ReportDoc, SnapshotSection } from '@/lib/pdf-report';

/**
 * The widget's Download report dialog (2026-11-02): the SERVER's resolution of
 * the template is shown and used, a profile with several templates offers a
 * picker, and the confirmed report goes through the ONE delivery path with the
 * widget's kind. The PDF builder is the real one (Task 3), so the headings
 * asserted are read from the snapshot that would be signed.
 */

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), postWithReauth: vi.fn() },
}));
const deliver = vi.fn();
vi.mock('@/lib/report-delivery', () => ({
  deliverReport: (...a: unknown[]) => deliver(...a),
  deliveryToast: () => ({ tone: 'success', title: 'Report downloaded', message: 'Recorded.' }),
}));
// Module-level constants: a fresh object per render re-runs effects forever.
const POLICY = {
  policy: { 'widget:gauge': { mode: 'DIRECT', remarksRequired: false, passwordRequired: false } },
  error: undefined,
};
vi.mock('@/hooks/use-report-downloads', () => ({ useReportDownloads: () => POLICY }));
const OVERVIEW = { rows: [{ instrumentId: 'i1' }], isLoading: false, error: undefined };
const SETTINGS = { overviewRefreshMs: 0, chartRefreshMs: 0 };
vi.mock('../../use-telemetry', async (importActual) => ({
  ...(await importActual<typeof import('../../use-telemetry')>()),
  useTelemetryOverview: () => OVERVIEW,
  useTelemetrySettings: () => SETTINGS,
}));
const AUTH: { user: { role: string; fullName: string; username: string } } = { user: { role: 'OPERATOR', fullName: 'Asha Rao', username: 'asha' } };
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => AUTH }));
const toastSuccess = vi.fn();
const TOAST = { toast: { success: (...a: unknown[]) => toastSuccess(...a), warning: vi.fn(), error: vi.fn() } };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => TOAST }));

import { WidgetReportDialog } from '../widget-report-dialog';

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Uint8Array.from(atob(PNG_1x1.split(',')[1]), (c) => c.charCodeAt(0));

const GAUGE: CustomWidget = {
  id: 'w-gauge', type: 'gauge', title: 'Freezer gauges',
  source: { mode: 'selection' }, keys: [{ source: 'telemetry', key: 'temp', label: 'Temperature' }], options: {},
} as CustomWidget;

const renamed = (heads: Record<string, string>): ReportTemplateDocument => {
  const d = builtinReportTemplate('gauge');
  d.columns = d.columns.map((c) => ({ ...c, heading: heads[c.id] ?? c.heading }));
  return d;
};
const row = (id: string, name: string, document: ReportTemplateDocument, isDefault: boolean) => ({
  id, profileId: 'p1', widgetType: 'gauge', name, isDefault, document,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'admin',
});
const PLANT_A = row('t-a', 'Plant A', renamed({ 'instrument.code': 'Tag', 'reading.value': 'Reading' }), true);
const PLANT_B = row('t-b', 'Plant B', renamed({ 'instrument.code': 'Asset', 'reading.value': 'Measured' }), false);

const TEMP: LatestKeyValue = {
  source: 'telemetry', key: 'temp', value: 21.456, ts: '2026-11-02T10:00:00.000Z', unit: '°C', decimals: 1, display: null,
  judged: { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false },
};

let templates = [PLANT_A];

beforeEach(() => {
  templates = [PLANT_A];
  get.mockReset();
  post.mockReset();
  deliver.mockReset();
  toastSuccess.mockReset();
  AUTH.user.role = 'OPERATOR';
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/report-templates/resolve')) {
      return { sections: [{ profileId: 'p1', profileName: 'T&RH', instrumentIds: ['i1'], template: PLANT_A }] };
    }
    if (url.startsWith('/api/report-templates/catalogue')) return { fields: WIDGET_REPORT_FIELDS.gauge };
    if (url.startsWith('/api/report-templates?')) return { data: templates };
    if (url.includes('report-page-titles')) return {};
    throw new Error(`unexpected GET ${url}`);
  });
  post.mockImplementation(async (url: string) => {
    if (url === '/api/instruments/latest-values') {
      return { data: [{ instrumentId: 'i1', code: 'CWH/RDU/001-01', name: 'x', functionalLocationName: 'QC 3', locationAttribute: 'Room 4', reporting: true, lastSeenAt: null, values: [TEMP] }] };
    }
    throw new Error(`unexpected POST ${url}`);
  });
  deliver.mockResolvedValue('DOWNLOADED');
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.endsWith('/api/config/branding')) return { ok: true, json: async () => ({ companyName: 'Co', appName: 'App', logoUrl: '/logo.png' }) };
    if (u === '/logo.png') return { ok: true, blob: async () => new Blob([PNG_BYTES], { type: 'image/png' }) };
    throw new Error(`unexpected fetch ${u}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: ReactNode) => (
  <MemoryRouter>
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>
  </MemoryRouter>
);
const open = (onClose = vi.fn()) => render(wrap(
  <WidgetReportDialog open widget={GAUGE} selection={{ directOnly: false }} dashboardTitle="Dashboard" selectionLabel="All Instruments" onClose={onClose} />,
));

const tableHeads = (report: ReportDoc) => report.getSnapshot().sections
  .filter((s): s is Extract<SnapshotSection, { kind: 'table' }> => s.kind === 'table')
  .map((t) => t.head);

describe('WidgetReportDialog', () => {
  it("names the template the SERVER resolved for each profile, and offers no picker for a profile with one", async () => {
    open();
    expect(await screen.findByText('Template: Plant A (T&RH)')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Template for T&RH/ })).toBeNull();
    // Not a SUPER_ADMIN: no way to the editor.
    expect(screen.queryByRole('link', { name: /Edit report templates/ })).toBeNull();
  });

  it("delivers the widget's kind through deliverReport, printed with the resolved template's headings", async () => {
    const onClose = vi.fn();
    open(onClose);
    await screen.findByText('Template: Plant A (T&RH)');
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const call = deliver.mock.calls[0][0];
    expect(call.kind).toBe('widget:gauge');
    expect(call.reportType).toBe('Widget: Gauge');
    expect(call.instrumentIds).toEqual(['i1']);
    expect(call.title).toBe('Freezer gauges');
    // A present-state widget sends NO period: "—" is a PDF placeholder, never a wire value.
    expect(call.requestMeta.period).toBeUndefined();
    expect(call.requestMeta.recordCount).toBe(1);
    const [head] = tableHeads(call.report);
    expect(head).toContain('Tag');
    expect(head).toContain('Reading');
    expect(head).not.toContain('Instrument ID');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalledWith('Report downloaded', 'Recorded.');
  });

  it('offers a picker when a profile has two templates, and prints the one picked', async () => {
    templates = [PLANT_A, PLANT_B];
    open();
    const picker = await screen.findByRole('combobox', { name: 'Template for T&RH' });
    fireEvent.change(picker, { target: { value: 't-b' } });
    expect(screen.getByText('Template: Plant B (T&RH)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const [head] = tableHeads(deliver.mock.calls[0][0].report);
    expect(head).toContain('Asset');
    expect(head).toContain('Measured');
  });

  it('a SUPER_ADMIN is offered the way to edit the profile\'s templates', async () => {
    AUTH.user.role = 'SUPER_ADMIN';
    open();
    const link = await screen.findByRole('link', { name: /Edit report templates/ });
    expect(link.getAttribute('href')).toBe('/config/report-templates?profileId=p1&widgetType=gauge');
  });

  it('a widget whose rows name no instrument (alarm counts) prints ONE table for all its profiles — never "No records." under the rest', async () => {
    const COUNTS: CustomWidget = { id: 'w-counts', type: 'alarm_counts', title: 'Alarms', source: { mode: 'selection' }, keys: [], options: {} } as CustomWidget;
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/report-templates/resolve')) {
        return { sections: [
          { profileId: 'p1', profileName: 'T&RH', instrumentIds: ['i1'], template: null },
          { profileId: 'p2', profileName: 'Pressure', instrumentIds: ['i2'], template: null },
        ] };
      }
      if (url.startsWith('/api/report-templates/catalogue')) return { fields: WIDGET_REPORT_FIELDS.alarm_counts };
      if (url.startsWith('/api/report-templates?')) return { data: [] };
      if (url.startsWith('/api/alarms/counts')) return { quadrants: { activeUnack: 1, activeAck: 0, clearedUnack: 0, clearedAck: 0 }, byType: [] };
      return {};
    });
    POLICY.policy['widget:alarm_counts' as 'widget:gauge'] = POLICY.policy['widget:gauge'];
    render(wrap(<WidgetReportDialog open widget={COUNTS} selection={{ directOnly: false }} dashboardTitle="Dashboard" selectionLabel="All" onClose={vi.fn()} />));
    expect(await screen.findByText('Template: Built-in (T&RH, Pressure)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const call = deliver.mock.calls[0][0];
    const sections = (call.report as ReportDoc).getSnapshot().sections;
    expect(sections.filter((s) => s.kind === 'title')).toEqual([]);
    expect(tableHeads(call.report)).toHaveLength(1);
    expect(JSON.stringify(sections)).not.toContain('No records.');
    expect(call.instrumentIds).toEqual(['i1', 'i2']);
  });

  it('says "Built-in" for a profile with no default template', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/report-templates/resolve')) return { sections: [{ profileId: 'p1', profileName: 'T&RH', instrumentIds: ['i1'], template: null }] };
      if (url.startsWith('/api/report-templates/catalogue')) return { fields: WIDGET_REPORT_FIELDS.gauge };
      if (url.startsWith('/api/report-templates?')) return { data: [] };
      return {};
    });
    open();
    expect(await screen.findByText('Template: Built-in (T&RH)')).toBeInTheDocument();
  });
});
