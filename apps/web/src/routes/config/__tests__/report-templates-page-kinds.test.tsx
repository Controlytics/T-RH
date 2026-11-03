import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import {
  REPORT_TEMPLATE_FIELDS, TEMPLATE_KIND_SPECS, WIDGET_TYPES, PAGE_TEMPLATE_KINDS, builtinReportTemplate,
  type ReportField, type TemplateKind,
} from '@digilog/shared';

/**
 * Configuration → Report Templates — the PAGE REPORT kinds (2026-11-03, page
 * reports on templates, spec §10). The 14 widget tabs are followed by the five
 * page reports in ONE tab list; `?kind=` selects (a legacy `?widgetType=` still
 * does); the Alarm Report and the Audit Trail are APPLICATION-WIDE — no profile
 * picker, and no request names a profile; the editor offers each kind's own
 * placeholders; a kind with no fields has no Columns section (ruling T3-C); the
 * trend preview carries one chart picture.
 */
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const PROFILES = {
  data: [
    { id: P1, name: 'T&RH Profile', instrumentCount: 12 },
    { id: P2, name: 'Pressure Profile', instrumentCount: 3 },
  ],
};
const stamp = { createdAt: '2026-11-01T08:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', updatedBy: 'superadmin' };
const ROW_ALARMS = {
  id: 'a1', profileId: null, kind: 'page:alarms', name: 'Plant alarm sheet', isDefault: true,
  document: builtinReportTemplate('page:alarms'), ...stamp,
};
const LIST_ALARMS = { data: [ROW_ALARMS] };
const LIST_EMPTY = { data: [] };
/** An install with no instrument profile yet (swapped in for one test, then put back). */
const NO_PROFILES = { data: [] };

const BUILDING: ReportField = { id: 'attr:Building', label: 'Building', group: 'attribute', kind: 'text' };
const LOCATION_ATTR: ReportField = { id: 'attr:Location', label: 'Location', group: 'attribute', kind: 'text' };
const builtins = (k: TemplateKind) => [...REPORT_TEMPLATE_FIELDS(k)];

// Written out as the URLSearchParams spells them: `kind` first, `:` as %3A.
const LIST_ALARMS_URL = '/api/report-templates?kind=page%3Aalarms';
const RESPONSES: Record<string, unknown> = {
  '/api/instrument-profiles': PROFILES,
  [LIST_ALARMS_URL]: LIST_ALARMS,
  '/api/report-templates/catalogue?kind=page%3Aalarms': { fields: builtins('page:alarms') },
  '/api/report-templates/catalogue?kind=page%3Aaudit-trail': { fields: builtins('page:audit-trail') },
  [`/api/report-templates/catalogue?kind=page%3Adata-report&profileId=${P1}`]: { fields: [...builtins('page:data-report'), BUILDING] },
  [`/api/report-templates/catalogue?kind=page%3Atrend&profileId=${P1}`]: { fields: [BUILDING, LOCATION_ATTR] },
  [`/api/report-templates/catalogue?kind=gauge&profileId=${P1}`]: { fields: [...builtins('gauge'), BUILDING] },
};
const swrKeys: string[] = [];
const mutateList = vi.fn(async () => undefined);
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key) swrKeys.push(key);
    const data = key === null ? undefined : (key in RESPONSES ? RESPONSES[key] : (key.startsWith('/api/report-templates?') ? LIST_EMPTY : undefined));
    return { data, mutate: mutateList, isLoading: false, error: undefined };
  },
  mutate: vi.fn(),
}));

const executed: string[] = [];
vi.mock('@/hooks/use-reauth', () => ({
  reauthActionLabel: (a: string | null) => a ?? undefined,
  useReauth: () => ({
    execute: async (
      action: string,
      cb: (p?: string) => Promise<void>,
      opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void },
    ) => {
      executed.push(action);
      try { await cb(undefined); opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    isOpen: false, password: '', error: '', isVerifying: false, action: null,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const post = vi.fn(async (..._a: unknown[]) => ({}));
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: vi.fn(),
    post: (...a: unknown[]) => post(...a),
    postWithReauth: vi.fn(),
    put: vi.fn(),
    putWithReauth: vi.fn(),
    delete: vi.fn(),
    deleteWithReauth: vi.fn(),
  },
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'u', username: 'superadmin', fullName: 'Super Admin', role: 'SUPER_ADMIN', permissions: [] } }) }));

/** The templated report builder (Task 3) — mocked: what is pinned is WITH WHAT the preview calls it. */
const build = vi.fn(async (_input: any) => ({
  report: { toBlobUrl: () => `blob:preview-${build.mock.calls.length}` },
  title: 't',
  recordCount: 3,
}));
vi.mock('../report-templates/load-builder', () => ({ loadBuildTemplatedReport: async () => build }));

// jsdom draws nothing on a canvas (getContext is null without the native
// package): a stand-in 2D context records what the chart placeholder draws.
const canvases: HTMLCanvasElement[] = [];
const ctx = { fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '', lineWidth: 0, fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn() };
const getContext = vi.fn(function (this: HTMLCanvasElement) { canvases.push(this); return ctx; });
const toDataURL = vi.fn(() => 'data:image/png;base64,iVBORw0KGgoCHART');

const { ReportTemplatesConfigPage } = await import('../report-templates');
const { samplePlaceholderValues, sampleChartPng, sampleRowsFor } = await import('../report-templates/sample-rows');

function SearchProbe() {
  return <output data-testid="search">{useLocation().search}</output>;
}
const renderPage = (url: string) =>
  render(<MemoryRouter initialEntries={[url]}><ReportTemplatesConfigPage /><SearchProbe /></MemoryRouter>);
const search = () => new URLSearchParams(screen.getByTestId('search').textContent ?? '');
const templateKeys = () => swrKeys.filter((k) => k.startsWith('/api/report-templates'));
const newTemplate = () => fireEvent.click(screen.getByRole('button', { name: /new template/i }));
const pickerValues = (label: string) => Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((o) => o.value).filter(Boolean);

beforeAll(() => {
  (URL as any).revokeObjectURL = vi.fn();
  HTMLCanvasElement.prototype.getContext = getContext as any;
  HTMLCanvasElement.prototype.toDataURL = toDataURL as any;
});
beforeEach(() => {
  for (const f of [post, build, mutateList, toast.success, toast.error]) f.mockClear();
  executed.length = 0;
  swrKeys.length = 0;
});

describe('the tabs: 14 widget types, then the 5 page reports, in one list', () => {
  it('19 tabs, the widget labels first in their order, then the page reports’ labels', () => {
    renderPage(`/config/report-templates?profileId=${P1}`);
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      ...WIDGET_TYPES.map((t) => TEMPLATE_KIND_SPECS[t].label),
      'Data Report', 'Instrument Trend', 'Instrument Alarms', 'Alarm Report', 'Audit Trail',
    ]);
    expect(tabs.map((t) => t.id)).toEqual([...WIDGET_TYPES, ...PAGE_TEMPLATE_KINDS].map((k) => `report-templates-tab-${k}`));
  });

  it('a tab writes ?kind= and drops a legacy widgetType, keeping the profile for the next profile tab', () => {
    renderPage(`/config/report-templates?widgetType=gauge&profileId=${P2}`);
    fireEvent.click(screen.getByRole('tab', { name: 'Alarm Report' }));
    expect(search().get('kind')).toBe('page:alarms');
    expect(search().has('widgetType')).toBe(false);
    expect(search().get('profileId')).toBe(P2);
    fireEvent.click(screen.getByRole('tab', { name: 'Gauge' }));
    expect(search().get('kind')).toBe('gauge');
    expect(templateKeys()).toContain(`/api/report-templates?kind=gauge&profileId=${P2}`);
    expect(screen.getByRole('button', { name: 'Instrument profile' })).toHaveTextContent('Pressure Profile');
  });
});

describe('?kind= and the legacy ?widgetType=', () => {
  it('?widgetType=gauge still selects Gauge (review focus 5)', () => {
    renderPage(`/config/report-templates?widgetType=gauge&profileId=${P1}`);
    expect(screen.getByRole('tab', { name: 'Gauge' })).toHaveAttribute('aria-selected', 'true');
    expect(templateKeys()).toContain(`/api/report-templates?kind=gauge&profileId=${P1}`);
  });

  it('?kind= wins over a legacy ?widgetType=', () => {
    renderPage(`/config/report-templates?kind=page:trend&widgetType=gauge&profileId=${P1}`);
    expect(screen.getByRole('tab', { name: 'Instrument Trend' })).toHaveAttribute('aria-selected', 'true');
  });

  it('?kind=page:data-report&profileId= shows the profile picker and the list request carries both', () => {
    renderPage(`/config/report-templates?kind=page:data-report&profileId=${P2}`);
    expect(screen.getByRole('tab', { name: 'Data Report' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Instrument profile' })).toHaveTextContent('Pressure Profile');
    expect(screen.queryByTestId('report-templates-application-scope')).not.toBeInTheDocument();
    expect(templateKeys()).toContain(`/api/report-templates?kind=page%3Adata-report&profileId=${P2}`);
  });
});

describe('an application-wide kind: no profile anywhere', () => {
  it('?kind=page:alarms: the Alarm Report tab, the application-wide line, NO profile picker, the list asked with no profileId', () => {
    renderPage('/config/report-templates?kind=page:alarms');
    expect(screen.getByRole('tab', { name: 'Alarm Report' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('report-templates-application-scope')).toHaveTextContent('Application-wide — one set of templates for every profile.');
    expect(screen.queryByRole('button', { name: 'Instrument profile' })).not.toBeInTheDocument();
    expect(templateKeys()).toEqual([LIST_ALARMS_URL]);
    expect(within(screen.getByRole('table')).getByText('Plant alarm sheet')).toBeInTheDocument();
  });

  it('a profile left in the URL by a profile tab is never sent — list, catalogue or body', async () => {
    renderPage(`/config/report-templates?kind=page:audit-trail&profileId=${P1}`);
    expect(screen.queryByRole('button', { name: 'Instrument profile' })).not.toBeInTheDocument();
    newTemplate();
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Quarterly audit' } });
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(templateKeys()).toContain('/api/report-templates?kind=page%3Aaudit-trail');
    expect(templateKeys()).toContain('/api/report-templates/catalogue?kind=page%3Aaudit-trail');
    for (const k of templateKeys()) expect(k).not.toContain('profileId');
    const body = post.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('profileId');
    expect(body).toEqual({ kind: 'page:audit-trail', name: 'Quarterly audit', isDefault: true, document: builtinReportTemplate('page:audit-trail') });
    expect(executed).toEqual(['UPDATE_REPORT_TEMPLATE']);
  });

  it('with NO instrument profile, the tabs still show and the application-wide kinds still work; a profile kind says why it cannot', () => {
    RESPONSES['/api/instrument-profiles'] = NO_PROFILES;
    try {
      renderPage('/config/report-templates');
      expect(within(screen.getByRole('tablist')).getAllByRole('tab')).toHaveLength(19);
      expect(screen.getByText('No instrument profiles')).toBeInTheDocument();
      expect(templateKeys()).toEqual([]);
      fireEvent.click(screen.getByRole('tab', { name: 'Alarm Report' }));
      expect(screen.getByTestId('report-templates-application-scope')).toBeInTheDocument();
      expect(screen.queryByText('No instrument profiles')).not.toBeInTheDocument();
      expect(within(screen.getByRole('table')).getByText('Plant alarm sheet')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /new template/i })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: 'Gauge' }));
      expect(screen.getByText('No instrument profiles')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /new template/i })).not.toBeInTheDocument();
    } finally {
      RESPONSES['/api/instrument-profiles'] = PROFILES;
    }
  });

  it('the preview of an application kind has no profile, and only the kind’s own placeholder values', async () => {
    renderPage('/config/report-templates?kind=page:alarms');
    newTemplate();
    await waitFor(() => expect(build).toHaveBeenCalled());
    const input = build.mock.calls.at(-1)![0];
    expect(input.kind).toBe('page:alarms');
    expect(input.sections).toHaveLength(1);
    expect(input.sections[0]).toMatchObject({ profileId: null, profileName: null });
    expect(input.sections[0].availableIds).toEqual(builtins('page:alarms').map((f) => f.id));
    expect(input.values.level).toBe('All');
    expect(input.values).not.toHaveProperty('profile');
    expect(input.values).not.toHaveProperty('instrument');
    // No instrument, so no attribute values.
    expect(input.sections[0]).not.toHaveProperty('attributes');
  });
});

describe('the editor on a page kind', () => {
  it('"+ New template" on the Audit Trail opens the built-in; the picker lists {recordCount}, not {instrument}', () => {
    renderPage('/config/report-templates?kind=page:audit-trail');
    newTemplate();
    const builtin = builtinReportTemplate('page:audit-trail');
    expect(screen.getByLabelText('Title')).toHaveValue(builtin.header.title);
    expect(screen.getByLabelText('Subtitle')).toHaveValue(builtin.header.subtitle);
    const offered = pickerValues('Insert into Title');
    expect(offered).toContain('recordCount');
    expect(offered).not.toContain('instrument');
    expect(offered).toEqual([...TEMPLATE_KIND_SPECS['page:audit-trail'].placeholders]);
  });

  it('the Data Report offers NO Decimals control on any of its four columns (all four print the page’s text)', () => {
    renderPage(`/config/report-templates?kind=page:data-report&profileId=${P1}`);
    newTemplate();
    for (const f of REPORT_TEMPLATE_FIELDS('page:data-report')) expect(screen.getByTestId(`column-row-${f.id}`)).toBeInTheDocument();
    expect(screen.queryAllByLabelText(/^Decimals for/)).toHaveLength(0);
    expect(screen.getByRole('region', { name: 'Columns' })).toBeInTheDocument();
  });

  it('the Data Report’s info rows read its own placeholders and the profile’s attributes; "Add row" starts on one of them', () => {
    renderPage(`/config/report-templates?kind=page:data-report&profileId=${P1}`);
    newTemplate();
    const sources = pickerValues('Value of information row 1');
    expect(sources).toEqual([...TEMPLATE_KIND_SPECS['page:data-report'].placeholders, 'attr:Building']);
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    const added = screen.getByLabelText('Value of information row 14') as HTMLSelectElement;
    expect(TEMPLATE_KIND_SPECS['page:data-report'].placeholders).toContain(added.value);
    expect(within(added).queryByText(/not available/i)).not.toBeInTheDocument();
  });

  // Ruling T3-C: a kind with no fields prints no table, so the editor offers no
  // columns there; its catalogue's attr: fields feed the information rows only.
  it('the Instrument Trend (no fields) has NO Columns section; its catalogue attributes are info-row sources; nothing is written as a column', async () => {
    renderPage(`/config/report-templates?kind=page:trend&profileId=${P1}`);
    newTemplate();
    expect(screen.queryByRole('region', { name: 'Columns' })).not.toBeInTheDocument();
    expect(screen.queryByTestId(/^column-row-/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Show Building')).not.toBeInTheDocument();
    expect(pickerValues('Value of information row 1')).toEqual(expect.arrayContaining(['attr:Building', 'attr:Location']));
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Trend sheet' } });
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const body = post.mock.calls[0]![1] as { profileId: string; kind: string; document: { columns: unknown[] } };
    expect(body.profileId).toBe(P1);
    expect(body.kind).toBe('page:trend');
    expect(body.document.columns).toEqual([]);
  });

  it('the Instrument Trend preview hands the builder ONE chart picture, the sample instrument and series', async () => {
    renderPage(`/config/report-templates?kind=page:trend&profileId=${P1}`);
    newTemplate();
    await waitFor(() => expect(build).toHaveBeenCalled());
    const input = build.mock.calls.at(-1)![0];
    expect(input.kind).toBe('page:trend');
    expect(input.sections[0].images).toHaveLength(1);
    expect(input.sections[0].images[0].dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(input.sections[0]).toMatchObject({ profileId: P1, profileName: 'T&RH Profile', rows: [] });
    expect(input.sections[0].availableIds).toEqual(['attr:Building', 'attr:Location']);
    expect(input.values).toMatchObject({ instrument: 'CWH/RDU/001-00', series: 'Temperature', profile: 'T&RH Profile' });
    // The download hands its ONE instrument's attribute values to the attr: info
    // rows (TemplatedSection.attributes); the preview hands sample ones, so an
    // attribute row previews as it will print, not as —.
    expect(input.sections[0].attributes).toEqual({ 'attr:Building': 'Building 1', 'attr:Location': 'Location 1' });
  });

  it('the preview hands the builder the kind\'s STRUCTURED legend, as its download does — the end block matches the PDF\'s', async () => {
    const legendOf = async (url: string) => {
      build.mockClear();
      const view = renderPage(url);
      newTemplate();
      await waitFor(() => expect(build).toHaveBeenCalled());
      const input = build.mock.calls.at(-1)![0];
      view.unmount();
      return input.legend;
    };
    // The Data Report's own rule over the sample's limits ("18.0 - 27.0": no NMT / NLT) and its MKT.
    expect(await legendOf(`/config/report-templates?kind=page:data-report&profileId=${P1}`)).toEqual([
      { abbr: 'Temp', meaning: 'Temperature' },
      { abbr: 'RH', meaning: 'Relative Humidity' },
      { abbr: 'MKT', meaning: 'Mean Kinetic Temperature' },
    ]);
    expect(await legendOf('/config/report-templates?kind=page:alarms')).toEqual([
      { abbr: 'PV Value', meaning: 'Present Value' },
      { abbr: 'UOM', meaning: 'Units of Measurement' },
    ]);
    // Every other kind's download passes none.
    expect(await legendOf('/config/report-templates?kind=page:audit-trail')).toBeUndefined();
    expect(await legendOf(`/config/report-templates?kind=page:trend&profileId=${P1}`)).toBeUndefined();
    expect(await legendOf(`/config/report-templates?kind=gauge&profileId=${P1}`)).toBeUndefined();
  });

  it('a WIDGET preview hands no attribute values — a widget section reads them from its rows, as its download does', async () => {
    renderPage(`/config/report-templates?kind=gauge&profileId=${P1}`);
    newTemplate();
    await waitFor(() => expect(build).toHaveBeenCalled());
    expect(build.mock.calls.at(-1)![0].sections[0].availableIds).toContain('attr:Building');
    expect(build.mock.calls.at(-1)![0].sections[0]).not.toHaveProperty('attributes');
  });

  it('a falls-back download is said to use the Built-in — never "Built-in layout" (ruling R-5)', () => {
    renderPage(`/config/report-templates?kind=page:data-report&profileId=${P1}`);
    expect(screen.getAllByText(/built-in template/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/built-in layout/i)).not.toBeInTheDocument();
  });
});

describe('samplePlaceholderValues', () => {
  const fmt = {
    formatDate: (iso: string | Date) => `D(${String(iso).slice(0, 10)})`,
    formatTime: (iso: string | Date) => `T(${String(iso).slice(11, 16)})`,
    formatDateTime: (iso: string | Date) => `DT(${String(iso).slice(0, 16)})`,
  };

  it('a widget type: exactly the ten values the widget preview always printed', () => {
    const v = samplePlaceholderValues('gauge', fmt, 'superadmin', 'T&RH Profile');
    expect(Object.keys(v).sort()).toEqual(['dashboard', 'date', 'instrumentCount', 'period', 'profile', 'selection', 'user', 'widget']);
    expect(v).toMatchObject({ dashboard: 'Sample dashboard', widget: 'Gauge', period: 'Latest', user: 'superadmin', instrumentCount: '3', selection: 'T&RH Profile' });
    const trend = samplePlaceholderValues('trend_chart', fmt, 'superadmin', 'T&RH Profile');
    expect(trend).toMatchObject({ period: 'Last 24 hours', from: 'DT(2026-11-01T09:30)', to: 'DT(2026-11-02T09:30)' });
  });

  it('the Data Report: the sample instrument, its placement, limits, interval, MKT and extremes; the period split into date and time', () => {
    const v = samplePlaceholderValues('page:data-report', fmt, 'superadmin', 'T&RH Profile');
    expect(v).toMatchObject({
      instrument: 'CWH/RDU/001-00', block: 'CWH', area: 'QC', location: 'Lab 1',
      tempLimit: '18.0 - 27.0', rhLimit: '40 - 60', interval: '15 min', mkt: '22.1', extremes: 'Max 24.1 · Min 20.3',
      fromDate: 'D(2026-11-01)', fromTime: 'T(09:30)', toDate: 'D(2026-11-02)', toTime: 'T(09:30)',
      profile: 'T&RH Profile', user: 'superadmin',
    });
  });

  it('every kind gets ONLY its own placeholders — what the real download supplies', () => {
    for (const k of [...WIDGET_TYPES, ...PAGE_TEMPLATE_KINDS]) {
      const v = samplePlaceholderValues(k, fmt, 'superadmin', TEMPLATE_KIND_SPECS[k].scope === 'profile' ? 'T&RH Profile' : null);
      for (const name of Object.keys(v)) expect(TEMPLATE_KIND_SPECS[k].placeholders).toContain(name);
    }
    expect(samplePlaceholderValues('page:alarms', fmt, 'superadmin', null)).toMatchObject({ recordCount: '3', search: '—', level: 'All' });
    expect(samplePlaceholderValues('page:trend', fmt, 'superadmin', 'T&RH Profile')).toMatchObject({ series: 'Temperature' });
  });
});

describe('sampleRowsFor on a page kind', () => {
  it('a DATE column prints the date and a TIME column the time — as the page prints them — when the parts are given', () => {
    const at = (iso: string) => `DT(${iso.slice(0, 16)})`;
    const parts = { formatDate: (iso: string) => `D(${iso.slice(0, 10)})`, formatTime: (iso: string) => `T(${iso.slice(11, 16)})` };
    const [first] = sampleRowsFor(REPORT_TEMPLATE_FIELDS('page:data-report'), at, parts);
    expect(first).toMatchObject({ 'record.date': 'D(2026-11-02)', 'record.time': 'T(09:00)' });
    const [alarm] = sampleRowsFor(REPORT_TEMPLATE_FIELDS('page:alarms'), at, parts);
    expect(alarm).toMatchObject({ 'alarm.date': 'D(2026-11-02)', 'alarm.time': 'T(09:00)' });
    // Any other datetime field — and every field without the parts — keeps the whole instant.
    const [audit] = sampleRowsFor(REPORT_TEMPLATE_FIELDS('page:audit-trail'), at, parts);
    expect(audit!['audit.timestamp']).toBe('DT(2026-11-02T09:00)');
    expect(sampleRowsFor(REPORT_TEMPLATE_FIELDS('page:data-report'), at)[0]!['record.time']).toBe('DT(2026-11-02T09:00)');
  });

  it('the Data Report preview prints its DATE and TIME columns apart', async () => {
    renderPage(`/config/report-templates?kind=page:data-report&profileId=${P1}`);
    newTemplate();
    await waitFor(() => expect(build).toHaveBeenCalled());
    const row = build.mock.calls.at(-1)![0].sections[0].rows[0];
    expect(row['record.date']).not.toBe(row['record.time']);
    expect(row['record.date']).not.toMatch(/:/);
    expect(row['record.time']).toMatch(/:/);
  });
});

describe('sampleChartPng', () => {
  it('a 1200 x 500 grey picture with "Chart" written on it — drawn once, then remembered', () => {
    const a = sampleChartPng();
    const b = sampleChartPng();
    expect(a).toBe('data:image/png;base64,iVBORw0KGgoCHART');
    expect(b).toBe(a);
    // Drawn once in this whole file, whichever test asked first.
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(canvases[0]!.width).toBe(1200);
    expect(canvases[0]!.height).toBe(500);
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1200, 500);
    expect(ctx.fillText.mock.calls.map((c) => c[0])).toContain('Chart');
    expect(toDataURL).toHaveBeenCalledWith('image/png');
  });
});
