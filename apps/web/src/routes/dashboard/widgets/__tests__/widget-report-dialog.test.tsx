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
const OVERVIEW: { rows: { instrumentId: string }[]; isLoading: boolean; error: unknown } = { rows: [{ instrumentId: 'i1' }], isLoading: false, error: undefined };
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
import { WidgetReportViewProvider, useWidgetReportViewRegistry } from '../widget-report-view';

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
  id, profileId: 'p1', kind: 'gauge', name, isDefault, document,
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
  OVERVIEW.rows = [{ instrumentId: 'i1' }];
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
    expect(link.getAttribute('href')).toBe('/config/report-templates?kind=gauge&profileId=p1');
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

  describe('fix wave 1 — a text card is scoped by its SELECTION, like any other request', () => {
    const TEXT: CustomWidget = { id: 'w-text', type: 'text_card', title: 'Shift note', source: { mode: 'selection' }, keys: [], options: { text: 'Hello' } } as CustomWidget;
    beforeEach(() => {
      POLICY.policy['widget:text_card' as 'widget:gauge'] = POLICY.policy['widget:gauge'];
      get.mockImplementation(async (url: string) => {
        if (url.startsWith('/api/report-templates/resolve')) {
          // The server's answer is the VISIBLE ids: an out-of-view one is dropped.
          return { sections: [{ profileId: 'p1', profileName: 'T&RH', instrumentIds: ['i1'], template: null }] };
        }
        if (url.startsWith('/api/report-templates')) return { data: [], fields: [] };
        return {};
      });
    });
    const download = async () => {
      render(wrap(<WidgetReportDialog open widget={TEXT} selection={{ directOnly: false }} dashboardTitle="Dashboard" selectionLabel="QC 3" onClose={vi.fn()} />));
      expect(await screen.findByText(OVERVIEW.rows.length ? 'Template: Built-in (T&RH)' : 'Template: Built-in')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Download' }));
      await waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      return deliver.mock.calls[0][0];
    };

    it("sends the selection's instruments the server resolved as visible", async () => {
      OVERVIEW.rows = [{ instrumentId: 'i1' }, { instrumentId: 'i-out-of-view' }];
      const call = await download();
      expect(call.instrumentIds).toEqual(['i1']);
      expect(call.kind).toBe('widget:text_card');
    });

    it('sends [] only when the selection truly has no instrument', async () => {
      OVERVIEW.rows = [];
      const call = await download();
      expect(call.instrumentIds).toEqual([]);
      expect(get.mock.calls.some((c) => String(c[0]).startsWith('/api/report-templates/resolve'))).toBe(false);
    });
  });

  describe('fix wave 2', () => {
    const answer = (sections: unknown[], extra: (url: string) => unknown = () => ({})) => get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/report-templates/resolve')) return { sections };
      if (url.startsWith('/api/report-templates/catalogue')) return { fields: [] };
      if (url.startsWith('/api/report-templates?')) return { data: [] };
      return extra(url);
    });
    const textDoc = (): ReportTemplateDocument => {
      const d = builtinReportTemplate('text_card');
      d.header.title = 'Shift memo — {widget}';
      d.header.subtitle = 'by {user} · {period}';
      return d;
    };
    const TEXT: CustomWidget = { id: 'w-text', type: 'text_card', title: 'Shift note', source: { mode: 'selection' }, keys: [], options: { text: 'Hello' } } as CustomWidget;
    const open2 = (widget: CustomWidget, selectionLabel = 'QC 3') => render(wrap(
      <WidgetReportDialog open widget={widget} selection={{ directOnly: false }} dashboardTitle="Dashboard" selectionLabel={selectionLabel} onClose={vi.fn()} />,
    ));
    const confirm = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }));
      await waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      return deliver.mock.calls[0][0];
    };
    beforeEach(() => {
      for (const k of ['text_card', 'floorplan', 'alarm_table']) POLICY.policy[`widget:${k}` as 'widget:gauge'] = POLICY.policy['widget:gauge'];
    });

    it("I2 — a text card prints its FIRST profile's resolved template; m5 — {user} is the USERNAME", async () => {
      const tpl = { ...row('t-text', 'Shift memo', textDoc(), true), kind: 'text_card' };
      answer([{ profileId: 'p1', profileName: 'T&RH', instrumentIds: ['i1'], template: tpl }]);
      open2(TEXT);
      expect(await screen.findByText('Template: Shift memo (T&RH)')).toBeInTheDocument();
      const call = await confirm();
      expect(call.title).toBe('Shift memo — Shift note');
      expect(call.subtitle).toBe('by asha · Latest');
    });

    it('m2 — a floor plan with NO visible instrument still prints its picture, in ONE section', async () => {
      OVERVIEW.rows = [];
      answer([]);
      const FLOOR: CustomWidget = { id: 'w-fp', type: 'floorplan', title: 'QC floor', source: { mode: 'selection' }, keys: [], options: { planId: 'pl' } } as CustomWidget;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 100 50');
      const Publish = () => {
        const reg = useWidgetReportViewRegistry();
        reg?.publish(FLOOR.id, { floorplanSvg: () => svg });
        return null;
      };
      const ui = (open: boolean) => wrap(
        <WidgetReportViewProvider>
          <Publish />
          <WidgetReportDialog open={open} widget={FLOOR} selection={{ directOnly: false }} dashboardTitle="Dashboard" selectionLabel="QC" onClose={vi.fn()} />
        </WidgetReportViewProvider>,
      );
      const { rerender } = render(ui(false));
      rerender(ui(true));
      expect(await screen.findByText('Template: Built-in')).toBeInTheDocument();
      const call = await confirm();
      const sections = (call.report as ReportDoc).getSnapshot().sections;
      expect(sections.filter((s) => s.kind === 'image')).toHaveLength(1);
      expect(JSON.stringify(sections)).not.toContain('No instruments in this selection.');
      expect(call.instrumentIds).toEqual([]);
    });

    it('m8 — an alarm table\'s {period} says "As filtered"', async () => {
      const doc = builtinReportTemplate('alarm_table');
      doc.header.subtitle = '{period}';
      answer([{ profileId: 'p1', profileName: 'T&RH', instrumentIds: ['i1'], template: { ...row('t-al', 'Alarms', doc, true), kind: 'alarm_table' } }],
        (url) => (url.startsWith('/api/alarms') ? { data: [], total: 0 } : {}));
      open2({ id: 'w-al', type: 'alarm_table', title: 'Alarms', source: { mode: 'selection' }, keys: [], options: {} } as CustomWidget);
      await screen.findByText('Template: Alarms (T&RH)');
      expect((await confirm()).subtitle).toBe('As filtered');
    });

    it('m11 — the title and subtitle sent with the request are clamped to 500 / 1000 characters', async () => {
      const doc = textDoc();
      doc.header.title = '{selection}';
      doc.header.subtitle = '{selection} {selection}';
      answer([{ profileId: 'p1', profileName: 'T&RH', instrumentIds: ['i1'], template: { ...row('t-long', 'Long', doc, true), kind: 'text_card' } }]);
      open2(TEXT, 'x'.repeat(600));
      await screen.findByText('Template: Long (T&RH)');
      const call = await confirm();
      expect(call.title).toHaveLength(500);
      expect(call.title.endsWith('…')).toBe(true);
      expect(call.subtitle).toHaveLength(1000);
      expect(call.subtitle.endsWith('…')).toBe(true);
    });
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
