import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The bulk-upload template (2026-09-16, operator: "in bulk upload template
 * only attributes display names should come"). The file is headed by `code`
 * and then the chosen profile's attributes — each under its administered
 * DISPLAY NAME, the key itself where none is set — headed as the template
 * prints it: `Instrument ID`, then the attributes. No `name` column: the create
 * form has set name = code since the trim, and the importer now does the same.
 */
const PROFILES = { data: [{ id: 'p-1', name: 'T&RH Sensors' }, { id: 'p-2', name: 'Empty' }] };
const PROFILE_KEYS: Record<string, string> = { 'p-1': 'Building\nEnable_Temp_NMT\nRoom', 'p-2': '' };
const LABELS = { current: {} as Record<string, string> };
/** `GET /api/functional-locations` — undefined = not loaded, as every older case runs. */
const TREE = { current: undefined as unknown };

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/instrument-profiles') return { data: PROFILES };
    if (typeof key === 'string' && key.startsWith('/api/instrument-profiles/')) {
      const id = key.slice('/api/instrument-profiles/'.length);
      return { data: { id, attributeKeys: PROFILE_KEYS[id] ?? '' } };
    }
    if (key === '/api/config/attribute-labels/current') return { data: { labels: LABELS.current } };
    if (key === '/api/functional-locations') return { data: TREE.current };
    return { data: undefined };
  },
}));
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    post: (...a: unknown[]) => post(...a),
    postWithReauth: (url: string, body: unknown) => post(url, body),
    get: vi.fn(), put: vi.fn(), delete: vi.fn(),
  },
}));

/** A preview with nothing to update — every older case's file only creates. */
const NOTHING_TO_UPDATE = { create: [], update: [], unchanged: [], errors: [], warnings: [], remarkRequired: false };
/** Answer the preview with `preview` and the upload with `result`. */
function respond(result: unknown, preview: unknown = NOTHING_TO_UPDATE) {
  post.mockImplementation(async (url: string) => (url === '/api/instruments/bulk/preview' ? preview : result));
}
const uploads = () => post.mock.calls.filter(([url]) => url === '/api/instruments/bulk');
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
/** Every action the upload signed under (SEC-7). Pass-through otherwise: the
 *  callback runs with no password, the path for a role whose policy is off. */
const reauthActions: string[] = [];
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (
      action: string,
      cb: (p?: string) => Promise<void>,
      opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void },
    ) => {
      reauthActions.push(action);
      try { await cb(); await opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));
vi.mock('@/components/reauth-dialog', () => ({ ReauthDialog: () => null }));

const { InstrumentBulkCreatePage } = await import('../bulk-create');

/** Captures what `download()` would have saved, by reading the Blob it made. */
const saved: { name: string; text: Promise<string> }[] = [];
beforeEach(() => {
  saved.length = 0;
  LABELS.current = {};
  TREE.current = undefined;
  post.mockReset();
  reauthActions.length = 0;
  vi.stubGlobal('URL', {
    ...URL,
    // jsdom's Blob has no `.text()`; FileReader is what it does implement.
    createObjectURL: (blob: Blob) => {
      const text = new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result ?? ''));
        r.onerror = () => reject(r.error);
        r.readAsText(blob);
      });
      saved.push({ name: '', text });
      return 'blob:x';
    },
    revokeObjectURL: () => undefined,
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    if (saved.length) saved[saved.length - 1].name = this.download;
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const renderPage = (search = '') => render(
  <MemoryRouter initialEntries={[`/instruments/bulk${search}`]}><InstrumentBulkCreatePage /></MemoryRouter>,
);
const choose = (id: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: /profile/i }), { target: { value: id } });
const downloadTemplate = () => fireEvent.click(screen.getByRole('button', { name: /download template/i }));

/** Pick a CSV file and press Upload. jsdom's FileReader reads a File. */
async function uploadCsv(text: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([text], 'instruments.csv', { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
  const button = screen.getByRole('button', { name: /^upload$/i });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

/**
 * 2026-09-16, operator: "if upload failed then show a popup where it failed
 * and reason, in which line which cell like that". Any failure — a rejected
 * row or the whole request — opens ONE dialog that names the row, the cell
 * and the reason. Row numbers count the header, matching the spreadsheet.
 */
describe('InstrumentBulkCreatePage — upload problems', () => {
  it('opens a dialog listing each rejected row with its cell and reason', async () => {
    respond({
      created: [{ id: 'i-1', code: 'PA-1', name: 'PA-1', token: 'T' }],
      errors: [
        { row: 3, column: 'Instrument ID', message: 'Instrument ID is required' },
        { row: 5, message: 'Unterminated quoted field' },
      ],
      warnings: ['Column(s) "Colour" are not attributes of this profile and were ignored.'],
    });
    renderPage();
    choose('p-1');
    await uploadCsv('Instrument ID,Building\nPA-1,x\n,y\nPB-1,z\n"bad');
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/upload problems/i)).toBeInTheDocument();
    const rows = within(dlg).getAllByTestId('upload-problem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('3');
    expect(rows[0]).toHaveTextContent('Instrument ID');
    expect(rows[0]).toHaveTextContent('Instrument ID is required');
    expect(rows[1]).toHaveTextContent('5');
    expect(rows[1]).toHaveTextContent('Unterminated quoted field');
    // The whole-file note rides in the same dialog.
    expect(within(dlg).getByText(/Colour/)).toBeInTheDocument();
    // And the summary says what still landed.
    expect(within(dlg).getByText(/1 created, 2 rejected/i)).toBeInTheDocument();
  });

  it('signs the upload under the CREATE_INSTRUMENT re-auth action, once (SEC-7)', async () => {
    respond({ created: [{ id: 'i-1', code: 'PA-1', name: 'PA-1', token: 'T' }], errors: [], warnings: [] });
    renderPage();
    choose('p-1');
    await uploadCsv('Instrument ID\nPA-1');
    await waitFor(() => expect(uploads()).toHaveLength(1));
    // The preview writes nothing, so it is NOT signed; the upload is, once.
    expect(reauthActions).toEqual(['CREATE_INSTRUMENT']);
    expect(post).toHaveBeenNthCalledWith(1, '/api/instruments/bulk/preview', { csv: 'Instrument ID\nPA-1', profileId: 'p-1' });
    expect(post).toHaveBeenNthCalledWith(2, '/api/instruments/bulk', { csv: 'Instrument ID\nPA-1', profileId: 'p-1' });
  });

  it('opens the same dialog when the request itself fails, with the reason', async () => {
    post.mockRejectedValue(Object.assign(new Error('Profile not found.'), { error: 'PROFILE_NOT_FOUND' }));
    renderPage();
    choose('p-1');
    await uploadCsv('Instrument ID\nPA-1');
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/upload failed/i)).toBeInTheDocument();
    expect(within(dlg).getByText('Profile not found.')).toBeInTheDocument();
    expect(within(dlg).queryAllByTestId('upload-problem')).toHaveLength(0);
  });

  it('opens no dialog when every row was accepted', async () => {
    respond({ created: [{ id: 'i-1', code: 'PA-1', name: 'PA-1', token: 'T' }], errors: [], warnings: [] });
    renderPage();
    choose('p-1');
    await uploadCsv('Instrument ID\nPA-1');
    await waitFor(() => expect(uploads()).toHaveLength(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('InstrumentBulkCreatePage — the template', () => {
  it('is headed by Instrument ID and the profile attributes under their DISPLAY NAMES, no name column', async () => {
    LABELS.current = { Enable_Temp_NMT: 'High temperature alarm enabled', Room: 'Cleanroom number' };
    renderPage();
    choose('p-1');
    downloadTemplate();
    await waitFor(() => expect(saved).toHaveLength(1));
    const text = await saved[0].text;
    // The heading row ONLY (2026-10-28, operator: "every time when uploading its
    // showing instrument id error was coming, only heading"). The sample row
    // named CWH/RDU/001-00 — a REAL instrument — so an untouched template
    // failed every upload with "already exists", and since existing IDs are
    // updated it would now write to that instrument instead.
    expect(text).toBe('Instrument ID,Building,High temperature alarm enabled,Cleanroom number\n');
    expect(saved[0].name).toBe('instrument-template.csv');
  });

  it('falls back to the key as the heading when no display name is set', async () => {
    renderPage();
    choose('p-1');
    downloadTemplate();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect((await saved[0].text).split('\n')[0]).toBe('Instrument ID,Building,Enable_Temp_NMT,Room');
  });

  it('is just the Instrument ID column for a profile that asks for no attributes', async () => {
    renderPage();
    choose('p-2');
    downloadTemplate();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect((await saved[0].text).split('\n')[0]).toBe('Instrument ID');
  });

  // 2026-09-16, operator: "in bulk upload profile selected and next download
  // template" — the profile is step 1, above the download, not below it.
  it('asks for the profile FIRST, then offers the template', () => {
    renderPage();
    const profile = screen.getByRole('combobox', { name: /profile/i });
    const download = screen.getByRole('button', { name: /download template/i });
    expect(profile.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // "and location" since 2026-10-26: the functional location is chosen in the same step.
    expect(screen.getByText('1. Choose the profile and location')).toBeInTheDocument();
    expect(screen.getByText('2. Download the template')).toBeInTheDocument();
    expect(screen.getByText('3. Upload')).toBeInTheDocument();
  });

  it('cannot be downloaded before a profile is chosen — the columns depend on it', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /download template/i })).toBeDisabled();
  });

  it('uses the preset profile from the URL', async () => {
    LABELS.current = { Room: 'Cleanroom number' };
    renderPage('?profileId=p-1');
    downloadTemplate();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect((await saved[0].text).split('\n')[0]).toBe('Instrument ID,Building,Enable_Temp_NMT,Cleanroom number');
  });
});

/**
 * One functional location for the whole upload (2026-10-26) — required when the
 * server says the uploader's instrument view is limited, or every row would be
 * created out of their own sight (the AWS defect, for a single form).
 */
describe('InstrumentBulkCreatePage — the functional location every row is born in', () => {
  it('holds Create until a location is chosen, then sends it with the file', async () => {
    TREE.current = { placementRequired: true, data: [{ id: 'b-1', name: 'CWH', placeable: true, children: [] }] };
    respond({ created: [{ id: 'i-1', code: 'PA-1', name: 'PA-1', token: 'T' }], errors: [], warnings: [] });
    renderPage();
    choose('p-1');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['Instrument ID\nPA-1'], 'i.csv', { type: 'text/csv' })] } });
    const block = screen.getByRole('combobox', { name: 'Functional location block' });
    const button = screen.getByRole('button', { name: /^upload$/i });
    fireEvent.change(block, { target: { value: 'b-1' } });
    await waitFor(() => expect(button).toBeEnabled());
    // The file is loaded now, so only the location can be what disables it.
    fireEvent.change(block, { target: { value: '' } });
    expect(button).toBeDisabled();
    fireEvent.change(block, { target: { value: 'b-1' } });
    fireEvent.click(button);
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/instruments/bulk', { csv: 'Instrument ID\nPA-1', profileId: 'p-1', functionalLocationId: 'b-1' },
    ));
  });
});

/**
 * An existing Instrument ID is UPDATED (2026-10-28, operator: "when user doing
 * bulk upload with already exiting instrument ids and like attributes values
 * changed and uploaded then already existed error was coming, there i need like
 * what values are changed those data should update"). The page previews the
 * file, and when it would change an instrument it shows every change — from its
 * current value to the new one — before anything is written. Whether a remark is
 * needed is the SERVER's answer (`remarkRequired`), never re-derived here.
 */
describe('InstrumentBulkCreatePage — updating instruments that already exist', () => {
  const PLAN = {
    create: [{ row: 3, code: 'NEW-1' }],
    update: [{
      id: 'i-9', code: 'CWH/RDU/001-00', row: 2,
      changes: [
        { key: 'Room', column: 'Cleanroom number', from: '101', to: '102' },
        { key: 'Building', column: 'Building', from: null, to: 'CWH' },
      ],
    }],
    unchanged: [{ row: 4, code: 'CWH/RDU/002-00' }],
    errors: [],
    warnings: [],
    remarkRequired: true,
  };
  const RESULT = {
    created: [{ id: 'i-1', code: 'NEW-1', name: 'NEW-1', token: 'T' }],
    updated: [PLAN.update[0]],
    unchanged: PLAN.unchanged,
    errors: [], warnings: [],
  };
  const CSV = 'Instrument ID,Cleanroom number,Building\nCWH/RDU/001-00,102,CWH\nNEW-1,,\nCWH/RDU/002-00,,';

  it('shows every change, from its current value to the new one, and writes nothing until confirmed', async () => {
    respond(RESULT, PLAN);
    renderPage();
    choose('p-1');
    await uploadCsv(CSV);
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/review the upload/i)).toBeInTheDocument();
    const rows = within(dlg).getAllByTestId('review-change');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('CWH/RDU/001-00');
    expect(rows[0]).toHaveTextContent('Cleanroom number');
    expect(rows[0]).toHaveTextContent('101');
    expect(rows[0]).toHaveTextContent('102');
    // A first fill says the instrument had no value, never a blank cell.
    expect(rows[1]).toHaveTextContent(/not set/i);
    expect(within(dlg).getByTestId('review-summary')).toHaveTextContent('1 new · 1 to update · 1 unchanged');
    expect(uploads()).toHaveLength(0);
  });

  it('sends the ONE remark with the upload, and refuses to send without it', async () => {
    respond(RESULT, PLAN);
    renderPage();
    choose('p-1');
    await uploadCsv(CSV);
    const dlg = await screen.findByRole('dialog');
    fireEvent.click(within(dlg).getByRole('button', { name: /^upload$/i }));
    expect(uploads()).toHaveLength(0);
    fireEvent.change(within(dlg).getByLabelText(/remarks/i), { target: { value: 'Rooms renumbered per drawing rev 4' } });
    fireEvent.click(within(dlg).getByRole('button', { name: /^upload$/i }));
    await waitFor(() => expect(uploads()).toHaveLength(1));
    expect(uploads()[0][1]).toEqual({ csv: CSV, profileId: 'p-1', reason: 'Rooms renumbered per drawing rev 4' });
    expect(reauthActions).toEqual(['CREATE_INSTRUMENT']);
  });

  it('asks no remark when the server says none is needed (every change a first fill)', async () => {
    respond(RESULT, { ...PLAN, remarkRequired: false });
    renderPage();
    choose('p-1');
    await uploadCsv(CSV);
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).queryByLabelText(/remarks/i)).toBeNull();
    fireEvent.click(within(dlg).getByRole('button', { name: /^upload$/i }));
    await waitFor(() => expect(uploads()).toHaveLength(1));
    expect(uploads()[0][1]).toEqual({ csv: CSV, profileId: 'p-1' });
  });

  it('Cancel writes nothing', async () => {
    respond(RESULT, PLAN);
    renderPage();
    choose('p-1');
    await uploadCsv(CSV);
    const dlg = await screen.findByRole('dialog');
    fireEvent.click(within(dlg).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(uploads()).toHaveLength(0);
  });

  it('lists what was updated after the upload, beside what was created', async () => {
    respond(RESULT, { ...PLAN, remarkRequired: false });
    renderPage();
    choose('p-1');
    await uploadCsv(CSV);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^upload$/i }));
    expect(await screen.findByText('Updated (1)')).toBeInTheDocument();
    const updated = screen.getAllByTestId('updated-change');
    expect(updated).toHaveLength(2);
    expect(updated[0]).toHaveTextContent('CWH/RDU/001-00');
    expect(updated[0]).toHaveTextContent('101');
    expect(updated[0]).toHaveTextContent('102');
    expect(screen.getByText('Created (1)')).toBeInTheDocument();
  });
});
