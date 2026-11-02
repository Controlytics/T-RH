import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  builtinReportTemplate, WIDGET_REPORT_FIELDS, type ReportField, type ReportTemplateDocument,
} from '@digilog/shared';

/**
 * Configuration → Report Templates (2026-11-02, spec §9): per instrument
 * PROFILE, per widget TYPE, any number of named templates, one default, edited
 * beside a live preview. Every write is a SUPER_ADMIN act signed under
 * UPDATE_REPORT_TEMPLATE.
 *
 * What is pinned here: the list is the server's for the selected profile and
 * tab; "+ New template" starts from the shared built-in; the four writes go to
 * the routes Task 2 serves, through the re-auth hook, with all three of its
 * outcomes handled; an edit lands in the PUT body (Show, heading, order); a
 * column the profile no longer has is KEPT and named (review focus 1); a
 * catalogue field nobody touched is not written; the logo is refused in the
 * browser by the SHARED rule; the preview rebuilds after an edit.
 */
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const PROFILES = {
  data: [
    { id: P1, name: 'T&RH Profile', instrumentCount: 12 },
    { id: P2, name: 'Pressure Profile', instrumentCount: 3 },
  ],
};

const BUILTIN_VC = builtinReportTemplate('value_cards');
const DOC_A: ReportTemplateDocument = {
  ...BUILTIN_VC,
  header: { ...BUILTIN_VC.header, title: 'Daily values' },
  columns: [...BUILTIN_VC.columns, { id: 'key:Gone', heading: 'Gone key', show: true }],
};
const stamp = { createdAt: '2026-11-01T08:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', updatedBy: 'superadmin' };
const ROW_A = { id: 't1', profileId: P1, widgetType: 'value_cards', name: 'Daily values', isDefault: true, document: DOC_A, ...stamp };
const ROW_B = { id: 't2', profileId: P1, widgetType: 'value_cards', name: 'Shift report', isDefault: false, document: BUILTIN_VC, ...stamp };
const ROW_G = { id: 't3', profileId: P1, widgetType: 'gauge', name: 'Gauge sheet', isDefault: false, document: builtinReportTemplate('gauge'), ...stamp };
const LIST_VC = { data: [ROW_A, ROW_B] };
const LIST_G = { data: [ROW_G] };
const LIST_EMPTY = { data: [] };

const TEMPERATURE: ReportField = { id: 'key:Temperature', label: 'Temperature', group: 'key', kind: 'number', unit: '°C', measured: true };
const LOCATION_ATTR: ReportField = { id: 'attr:Location', label: 'Location', group: 'attribute', kind: 'text' };
const CATALOGUE_VC = { fields: [...WIDGET_REPORT_FIELDS.value_cards, TEMPERATURE, LOCATION_ATTR] };
const CATALOGUE_G = { fields: [...WIDGET_REPORT_FIELDS.gauge] };

const listKey = (p: string, t: string) => `/api/report-templates?profileId=${p}&widgetType=${t}`;
const catalogueKey = (p: string, t: string) => `/api/report-templates/catalogue?profileId=${p}&widgetType=${t}`;
const RESPONSES: Record<string, unknown> = {
  '/api/instrument-profiles': PROFILES,
  [listKey(P1, 'value_cards')]: LIST_VC,
  [listKey(P1, 'gauge')]: LIST_G,
  [catalogueKey(P1, 'value_cards')]: CATALOGUE_VC,
  [catalogueKey(P1, 'gauge')]: CATALOGUE_G,
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
const reauthMode = { current: 'none' as 'none' | 'pw' | 'cancel' };
vi.mock('@/hooks/use-reauth', () => ({
  reauthActionLabel: (a: string | null) => a ?? undefined,
  useReauth: () => ({
    execute: async (
      action: string,
      cb: (p?: string) => Promise<void>,
      opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void },
    ) => {
      executed.push(action);
      if (reauthMode.current === 'cancel') { opts?.onCancel?.(); return; }
      try { await cb(reauthMode.current === 'pw' ? 'pw' : undefined); opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    isOpen: false, password: '', error: '', isVerifying: false, action: null,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const post = vi.fn(async (..._a: unknown[]) => ({}));
const postWithReauth = vi.fn(async (..._a: unknown[]) => ({}));
const put = vi.fn(async (..._a: unknown[]) => ({}));
const putWithReauth = vi.fn(async (..._a: unknown[]) => ({}));
const del = vi.fn(async (..._a: unknown[]) => ({}));
const delWithReauth = vi.fn(async (..._a: unknown[]) => ({}));
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: vi.fn(),
    post: (...a: unknown[]) => post(...a),
    postWithReauth: (...a: unknown[]) => postWithReauth(...a),
    put: (...a: unknown[]) => put(...a),
    putWithReauth: (...a: unknown[]) => putWithReauth(...a),
    delete: (...a: unknown[]) => del(...a),
    deleteWithReauth: (...a: unknown[]) => delWithReauth(...a),
  },
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'u', username: 'superadmin', fullName: 'Super Admin', role: 'SUPER_ADMIN', permissions: [] } }) }));

/** The PDF builder (Task 3) — mocked: what is pinned is WHEN and WITH WHAT the page calls it. */
const build = vi.fn(async (_input: any) => ({
  report: { toBlobUrl: () => `blob:preview-${build.mock.calls.length}` },
  title: 't',
  recordCount: 3,
}));
vi.mock('../report-templates/load-builder', () => ({ loadBuildWidgetReport: async () => build }));

const { ReportTemplatesConfigPage } = await import('../report-templates');
const { sampleRowsFor } = await import('../report-templates/sample-rows');

const renderPage = (url = '/config/report-templates') =>
  render(<MemoryRouter initialEntries={[url]}><ReportTemplatesConfigPage /></MemoryRouter>);

beforeAll(() => {
  // jsdom has no object URLs; the preview revokes the one it replaces.
  (URL as any).revokeObjectURL = vi.fn();
});
beforeEach(() => {
  for (const f of [post, postWithReauth, put, putWithReauth, del, delWithReauth, build, mutateList, toast.success, toast.error]) f.mockClear();
  post.mockImplementation(async () => ({}));
  executed.length = 0;
  swrKeys.length = 0;
  reauthMode.current = 'none';
});

const lastBody = (fn: typeof post) => fn.mock.calls.at(-1)![1] as any;

describe('sampleRowsFor', () => {
  it('three rows, one value per field, typed by kind; datetimes through the given formatter', () => {
    const fields: ReportField[] = [
      { id: 'instrument.code', label: 'Instrument ID', group: 'builtin', kind: 'text' },
      { id: 'reading.value', label: 'Value', group: 'builtin', kind: 'number' },
      { id: 'reading.ts', label: 'Reading time', group: 'builtin', kind: 'datetime' },
      { id: 'reading.status', label: 'Status', group: 'builtin', kind: 'status' },
    ];
    const rows = sampleRowsFor(fields, (iso) => `F(${iso.slice(11, 16)})`);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ 'instrument.code': 'Instrument ID 1', 'reading.value': 21.5, 'reading.ts': 'F(09:00)', 'reading.status': 'Normal' });
    expect(typeof rows[2]!['reading.value']).toBe('number');
    // A second number column gets its own figures.
    const two = sampleRowsFor([...fields, { id: 'key:Humidity', label: 'Humidity', group: 'key', kind: 'number' }]);
    expect(two[0]!['key:Humidity']).toBe(31.5);
    expect(rows[2]!['instrument.code']).toBe('Instrument ID 3');
  });
});

describe('Configuration → Report Templates — the list', () => {
  it('lists the selected profile\'s templates for the active tab, from the server, with the default marked', () => {
    renderPage();
    expect(swrKeys).toContain(listKey(P1, 'value_cards'));
    const table = screen.getByRole('table');
    expect(within(table).getByText('Daily values')).toBeInTheDocument();
    expect(within(table).getByText('Shift report')).toBeInTheDocument();
    const rowA = within(table).getByText('Daily values').closest('tr')!;
    expect(within(rowA).getByText(/default/i)).toBeInTheDocument();
    const rowB = within(table).getByText('Shift report').closest('tr')!;
    expect(within(rowB).queryByText(/^default$/i)).not.toBeInTheDocument();
  });

  it('offers all 14 widget types as tabs, and a tab shows ITS list', () => {
    renderPage();
    expect(screen.getAllByRole('tab')).toHaveLength(14);
    fireEvent.click(screen.getByRole('tab', { name: 'Gauge' }));
    expect(swrKeys).toContain(listKey(P1, 'gauge'));
    expect(screen.getByText('Gauge sheet')).toBeInTheDocument();
    expect(screen.queryByText('Daily values')).not.toBeInTheDocument();
  });

  it('says so when templates exist but none is the default (review focus 5)', () => {
    renderPage();
    expect(screen.queryByTestId('no-default')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Gauge' }));
    expect(screen.getByTestId('no-default')).toHaveTextContent(/built-in template/i);
  });

  it('an empty tab says the built-in is used', () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Pie chart' }));
    expect(screen.getByText(/no templates/i)).toBeInTheDocument();
    expect(screen.getAllByText(/built-in template/i).length).toBeGreaterThan(0);
  });

  it('?profileId=&widgetType= preselect the profile and the tab', () => {
    renderPage(`/config/report-templates?profileId=${P2}&widgetType=gauge`);
    expect(screen.getByRole('tab', { name: 'Gauge' })).toHaveAttribute('aria-selected', 'true');
    expect(swrKeys).toContain(listKey(P2, 'gauge'));
    expect(screen.getByRole('button', { name: 'Instrument profile' })).toHaveTextContent('Pressure Profile');
  });

  it('Set as default → PUT /:id/default, signed', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Set Shift report as default' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/report-templates/t2/default', {}));
    expect(executed).toEqual(['UPDATE_REPORT_TEMPLATE']);
  });

  it('Delete confirms; deleting the DEFAULT says the built-in will be used; DELETE /:id, signed', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Daily values' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/the built-in template will be used/i);
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /delete template/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/report-templates/t1'));
    expect(executed).toEqual(['UPDATE_REPORT_TEMPLATE']);
  });

  it('deleting a template that is NOT the default does not claim the built-in takes over', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Shift report' }));
    expect(screen.getByRole('dialog')).not.toHaveTextContent(/built-in template will be used/i);
  });
});

describe('Configuration → Report Templates — the editor', () => {
  it('"+ New template" starts from the shared built-in and POSTs {profileId, widgetType, name, isDefault, document}', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new template/i }));
    expect(screen.getByLabelText('Title')).toHaveValue('{widget}');
    expect(screen.getByLabelText('Heading for Instrument ID')).toHaveValue('Instrument ID');
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Night shift' } });
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0]).toBe('/api/report-templates');
    // The catalogue's Temperature and Location were offered but never touched — not written.
    expect(lastBody(post)).toEqual({
      profileId: P1, widgetType: 'value_cards', name: 'Night shift', isDefault: false, document: BUILTIN_VC,
    });
    expect(executed).toEqual(['UPDATE_REPORT_TEMPLATE']);
  });

  it('re-auth outcome 1 — a password collected → postWithReauth; success closes the editor and refreshes the list', async () => {
    reauthMode.current = 'pw';
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new template/i }));
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Night shift' } });
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(postWithReauth).toHaveBeenCalledTimes(1));
    expect(postWithReauth.mock.calls[0]![2]).toBe('pw');
    expect(post).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(mutateList).toHaveBeenCalled();
    expect(screen.queryByLabelText('Template name')).not.toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Daily values')).toBeInTheDocument();
  });

  it('re-auth outcome 2 — a refusal is shown on the editor, which stays open; a name clash is on the name', async () => {
    post.mockImplementation(async () => { throw Object.assign(new Error('A template named "Night shift" already exists for this profile and widget'), { code: 'TEMPLATE_NAME_IN_USE' }); });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new template/i }));
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Night shift' } });
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeInTheDocument());
    expect(screen.getByLabelText('Template name')).toHaveAttribute('aria-invalid', 'true');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('re-auth outcome 3 — a cancel sends nothing, shows no error and leaves Save usable', async () => {
    reauthMode.current = 'cancel';
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new template/i }));
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Night shift' } });
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(executed).toEqual(['UPDATE_REPORT_TEMPLATE']));
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save template$/i })).toBeEnabled();
  });

  it('a nameless template is refused in the browser by the shared schema — nothing is sent', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new template/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('A template needs a name'));
    expect(post).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
  });

  it('a refused column or information row is NAMED in the message, and nothing is sent', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Daily values' }));
    fireEvent.change(screen.getByLabelText('Heading for Area'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('A column needs a heading — column “Area”'));
    fireEvent.change(screen.getByLabelText('Heading for Area'), { target: { value: 'Area' } });
    fireEvent.change(screen.getByLabelText('Label of information row 2'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('An information row needs a label — information row 2'));
    expect(put).not.toHaveBeenCalled();
  });

  it('Edit: a column\'s Show switch and heading land in the PUT body {name, document}', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Daily values' }));
    expect(screen.getByLabelText('Title')).toHaveValue('Daily values');
    fireEvent.change(screen.getByLabelText('Heading for Instrument ID'), { target: { value: 'Tag' } });
    fireEvent.click(screen.getByLabelText('Show Area'));
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![0]).toBe('/api/report-templates/t1');
    const body = lastBody(put);
    expect(Object.keys(body).sort()).toEqual(['document', 'name']);
    expect(body.name).toBe('Daily values');
    const cols = body.document.columns as { id: string; heading: string; show: boolean }[];
    expect(cols.find((c) => c.id === 'instrument.code')).toEqual({ id: 'instrument.code', heading: 'Tag', show: true });
    expect(cols.find((c) => c.id === 'instrument.area')).toEqual({ id: 'instrument.area', heading: 'Area', show: false });
  });

  it('a stored column the profile no longer has is named "not available" and KEPT (review focus 1)', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Daily values' }));
    expect(screen.getByTestId('column-row-key:Gone')).toHaveTextContent(/not available for this profile/i);
    expect(screen.getByTestId('column-row-instrument.code')).not.toHaveTextContent(/not available/i);
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(lastBody(put).document.columns.map((c: { id: string }) => c.id)).toContain('key:Gone');
  });

  it('a catalogue field is offered hidden; switched on, it is written at its place, labelled from the catalogue', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Daily values' }));
    expect(screen.getByLabelText('Show Temperature')).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('Show Temperature'));
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const cols = lastBody(put).document.columns as { id: string }[];
    expect(cols.at(-1)).toEqual({ id: 'key:Temperature', heading: 'Temperature', show: true });
    expect(cols.map((c) => c.id)).not.toContain('attr:Location');
  });

  it('a number column takes decimals and a unit; a text column offers neither', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Daily values' }));
    expect(screen.queryByLabelText('Decimals for Instrument ID')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Decimals for Value'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Unit for Value'), { target: { value: '°C' } });
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const value = (lastBody(put).document.columns as { id: string }[]).find((c) => c.id === 'reading.value');
    expect(value).toEqual({ id: 'reading.value', heading: 'Value', show: true, decimals: 2, unit: '°C' });
  });

  it('Move up reorders the columns in the PUT body', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Daily values' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Area up' }));
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const ids = (lastBody(put).document.columns as { id: string }[]).map((c) => c.id);
    expect(ids.slice(0, 3)).toEqual(['instrument.area', 'instrument.code', 'instrument.location']);
  });

  it('Duplicate opens a NEW template from that one\'s document and POSTs it', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Daily values' }));
    expect(screen.getByLabelText('Template name')).toHaveValue('Daily values (copy)');
    expect(screen.getByLabelText('Title')).toHaveValue('Daily values');
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(lastBody(post).document.columns.map((c: { id: string }) => c.id)).toContain('key:Gone');
    expect(lastBody(post).isDefault).toBe(false);
  });

  it('the placeholder picker inserts {name} at the caret', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new template/i }));
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Report  readings' } });
    title.setSelectionRange(7, 7);
    fireEvent.change(screen.getByLabelText('Insert into Title'), { target: { value: 'profile' } });
    expect(title).toHaveValue('Report {profile} readings');
  });
});

describe('Configuration → Report Templates — the logo', () => {
  const pngFile = (bytes: number) => {
    const b = new Uint8Array(bytes);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return new File([b], 'logo.png', { type: 'image/png' });
  };

  it('a 1.1 MB file is refused in the browser with the shared message, before it is even read, and nothing is set', async () => {
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL');
    try {
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: /new template/i }));
      fireEvent.click(screen.getByRole('radio', { name: 'Upload' }));
      fireEvent.change(screen.getByLabelText('Upload logo'), { target: { files: [pngFile(1_100_000)] } });
      await waitFor(() => expect(screen.getByTestId('logo-error')).toHaveTextContent('The logo must be 1 MB or smaller'));
      expect(read).not.toHaveBeenCalled();
      expect(screen.queryByRole('img', { name: /logo/i })).not.toBeInTheDocument();
    } finally {
      read.mockRestore();
    }
  });

  it('a file under the cap whose DATA URL is over it (base64 is 4/3 the bytes) is refused by the same shared rule', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new template/i }));
    fireEvent.click(screen.getByRole('radio', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Upload logo'), { target: { files: [pngFile(800_000)] } });
    await waitFor(() => expect(screen.getByTestId('logo-error')).toHaveTextContent('The logo must be 1 MB or smaller'));
    expect(screen.queryByRole('img', { name: /logo/i })).not.toBeInTheDocument();
  });

  it('a GIF is refused with the shared format message', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new template/i }));
    fireEvent.click(screen.getByRole('radio', { name: 'Upload' }));
    const gif = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0])], 'logo.gif', { type: 'image/gif' });
    fireEvent.change(screen.getByLabelText('Upload logo'), { target: { files: [gif] } });
    await waitFor(() => expect(screen.getByTestId('logo-error')).toHaveTextContent('The logo must be a PNG or JPEG image'));
  });

  it('a PNG is sent as a data:image/png;base64 URL of its own bytes', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new template/i }));
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'With logo' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Upload logo'), { target: { files: [pngFile(300)] } });
    await waitFor(() => expect(screen.getByRole('img', { name: /logo/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const logo = lastBody(post).document.header.logo;
    expect(logo.mode).toBe('custom');
    expect(logo.dataUrl).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
  });

  it('a logo uploaded and then switched to Branding is not written', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new template/i }));
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'No logo kept' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Upload logo'), { target: { files: [pngFile(300)] } });
    await waitFor(() => expect(screen.getByRole('img', { name: /logo/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('radio', { name: 'Branding' }));
    fireEvent.click(screen.getByRole('button', { name: /^save template$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(lastBody(post).document.header.logo).toEqual({ mode: 'branding' });
  });
});

describe('Configuration → Report Templates — the live preview', () => {
  it('builds from the draft over sample rows, with the catalogue ids as available, and rebuilds after an edit', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new template/i }));
    const frame = await screen.findByTitle('Report preview');
    await waitFor(() => expect(frame).toHaveAttribute('src', 'blob:preview-1#view=FitH'));
    const first = build.mock.calls[0]![0];
    expect(first.widgetType).toBe('value_cards');
    expect(first.sections).toHaveLength(1);
    expect(first.sections[0].availableIds).toEqual(CATALOGUE_VC.fields.map((f) => f.id));
    expect(first.sections[0].rows).toHaveLength(3);
    expect(first.sections[0].profileName).toBe('T&RH Profile');

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Changed title' } });
    await waitFor(() => expect(frame).toHaveAttribute('src', 'blob:preview-2#view=FitH'));
    // The replaced PDF's object URL is let go.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(build.mock.calls.at(-1)![0].sections[0].document.header.title).toBe('Changed title');
  });
});
