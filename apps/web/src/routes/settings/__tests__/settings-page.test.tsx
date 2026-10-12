import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Settings page (2026-09-08). Operator, second pass: *"in a square widget i
 * need Instrument ID and value, Area and Value, Building, and all the attribute
 * keys and attributes values, these common settings on top user will select
 * instrument then that instrument values should display in widget, what ever
 * instruments assigned to that user, only that instruments should come in
 * selection"* — and, asked how editing should work, "One Edit button that opens
 * the existing Attributes panel".
 *
 * Every assertion is a WIRING one: the picker offers exactly the instruments
 * the (server-scoped) list returned, the widget prints the chosen instrument's
 * rows, and the Edit button is gated on `settings.edit` and opens the panel for
 * THAT instrument. The Attributes panel itself is stubbed — its own rule
 * (Attribute Access, remarks, re-auth) is tested where it lives.
 *
 * NOT VERIFIED HERE: what it looks like. Read out of the DOM, not seen.
 */

const inst = (over: Record<string, unknown>) => ({
  id: 'i-1', code: 'CWH/RDU/001-00', name: 'CWH/RDU/001-00', isActive: true, isGateway: false, gatewayId: 'g-1',
  profileId: 'p-1', profileName: 'RS485 T/RH', instrumentType: 'T/RH', manufacturer: 'Acme', model: 'X1',
  serialNumber: 'SN1', description: null, expectedIntervalSec: 60, lastSeenAt: new Date().toISOString(),
  functionalLocationId: 'a-1', createdAt: '2026-08-24T00:00:00.000Z',
  ...over,
});
// Only what the server returned — its instrument scope is the selection.
const rows = [
  inst({}),
  inst({ id: 'i-2', code: 'CWH/RDU/002-00', name: 'CWH/RDU/002-00', isActive: false, lastSeenAt: null, functionalLocationId: null }),
];
// Building and Area are ATTRIBUTES on this installation (100 of 100 instruments
// carry both) — the widget prints them once, from here, never from the
// functional location as well ("why area and building coming 2 times").
const attributes: Record<string, { key: string; value: string; display?: string | null }[]> = {
  'i-1': [
    { key: 'Building', value: 'CWH Block' },
    { key: 'Area', value: 'Stability' },
    { key: 'Location', value: 'HPLC ROOM' },
    { key: 'High Temperature Limit', value: '25', display: '25.0' },
    { key: 'Enable_Humid_NMT', value: '0' },
  ],
  'i-2': [{ key: 'Location', value: 'STORE' }],
};

let grants = new Set<string>(['settings.view']);
/** The caller's attribute rule, as `GET /attribute-access/me` returns it. `mode: null` = unconfigured. */
const access = { current: { mode: null as string | null, keys: [] as string[], requireReauth: false } };
const mutateList = vi.fn();
const mutateAttrs = vi.fn();
/** Configuration → Attribute Display Names, as the narrow-slice route returns it. */
const labels = { current: {} as Record<string, string> };
/** Which fields the Settings page hides (2026-09-21), from the same route. */
const hidden = { current: { instrumentId: false, keys: [] as string[] } };

/**
 * Block → Area → instrument (2026-10-03). The tree is what `GET
 * /api/functional-locations` returns; the list mock plays the SERVER's part
 * for `functionalLocationId=` — a Block expands to its Areas, an Area is
 * itself — so the page is tested on what the server returned, never on a
 * tree walk of its own.
 */
const tree = [
  { id: 'b-1', name: 'CWH Block', type: 'BLOCK', parentId: null, children: [
    { id: 'a-1', name: 'Stability', type: 'AREA', parentId: 'b-1', children: [] },
    { id: 'a-2', name: 'QC', type: 'AREA', parentId: 'b-1', children: [] },
  ] },
  { id: 'b-2', name: 'Annex', type: 'BLOCK', parentId: null, children: [] },
];
const LOCATION_IDS: Record<string, string[]> = { 'b-1': ['a-1', 'a-2'], 'b-2': [], 'a-1': ['a-1'], 'a-2': ['a-2'] };
/** Every list URL the page asked for, in order. */
let listRequests: string[] = [];

vi.mock('swr', () => ({
  default: (key: any) => {
    const k = typeof key === 'function' ? key() : key;
    if (k === '/api/functional-locations') return { data: { data: tree }, isLoading: false, mutate: vi.fn() };
    if (typeof k === 'string' && k.startsWith('/api/instruments?')) {
      listRequests.push(k);
      const scope = new URLSearchParams(k.slice(k.indexOf('?'))).get('functionalLocationId');
      const data = scope ? rows.filter((r) => LOCATION_IDS[scope]?.includes(r.functionalLocationId as string)) : rows;
      return { data: { data, total: data.length }, isLoading: false, mutate: mutateList };
    }
    if (typeof k === 'string' && /\/api\/instruments\/(i-\d)\/attributes$/.test(k)) {
      const id = k.match(/\/api\/instruments\/(i-\d)\/attributes$/)![1];
      return { data: { data: attributes[id] }, isLoading: false, mutate: mutateAttrs };
    }
    if (k === '/api/instruments/attribute-access/me') return { data: access.current, mutate: vi.fn() };
    if (typeof k === 'string' && k.includes('/instrument-activity/')) return { data: { activeWindowMinutes: 3 }, mutate: vi.fn() };
    if (k === '/api/config/attribute-labels/current') return { data: { labels: labels.current, settingsHidden: hidden.current }, mutate: vi.fn() };
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => (node: string) => grants.has(node) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDateTime: (d: string) => d.slice(0, 16).replace('T', ' '), formatDate: (d: string) => d.slice(0, 10), formatTime: (d: string) => d.slice(11, 16) }),
}));
const put = vi.fn();
const putWithReauth = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: vi.fn(), post: vi.fn(),
    put: (...a: unknown[]) => put(...a),
    putWithReauth: (...a: unknown[]) => putWithReauth(...a),
  },
}));
/**
 * Pass-through, as the Attributes panel test does: the real hook prompts on the
 * backend's 401, which this mock cannot produce, so the callback runs with no
 * password — the production path for a role that needs no re-authentication.
 */
/** Every action the page signed under (audit 2026-10-03, SEC-7). */
const reauthActions: string[] = [];
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (
      action: string,
      cb: (p?: string) => Promise<void>,
      opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void },
    ) => {
      reauthActions.push(action);
      try { await cb(); opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { SettingsPage } = await import('../index');

function mount() {
  return render(<MemoryRouter initialEntries={['/settings']}><SettingsPage /></MemoryRouter>);
}
const widget = () => screen.getByTestId('settings-widget');
const rowValue = (label: string) => within(widget()).getByText(label).closest('[data-row]')!.querySelector('dd')!.textContent;
// The picker's trigger is the one button with a listbox popup. Its entries are read from the
// LISTBOX, since the Block / Area selects' native <option>s share the role (2026-10-03).
const openPicker = () => fireEvent.click(screen.getByRole('button', { expanded: false }));

describe('SettingsPage', () => {
  beforeEach(() => {
    grants = new Set(['settings.view']);
    labels.current = {};
    access.current = { mode: null, keys: [], requireReauth: false };
    put.mockReset().mockResolvedValue({});
    putWithReauth.mockReset().mockResolvedValue({});
    mutateList.mockReset(); mutateAttrs.mockReset();
    listRequests = [];
    try { localStorage.clear(); } catch { /* jsdom */ }
  });

  it('names the screen once; the picker offers exactly the instruments the server returned, and the first is shown', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    // UI v3 (2026-09-21): the picker rides INSIDE the band, not in a bar under it.
    expect(screen.getByTestId('page-hero').contains(screen.getByRole('button', { expanded: false }))).toBe(true);
    openPicker();
    const options = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['CWH/RDU/001-00', 'CWH/RDU/002-00']);
    expect(rowValue('Instrument ID')).toBe('CWH/RDU/001-00');
  });

  it('the widget prints Instrument ID, then every attribute key ONCE with its value — display form when the server gives one', () => {
    mount();
    expect(within(widget()).getAllByText('Building')).toHaveLength(1);
    expect(within(widget()).getAllByText('Area')).toHaveLength(1);
    expect(rowValue('Building')).toBe('CWH Block');
    expect(rowValue('Area')).toBe('Stability');
    expect(rowValue('Location')).toBe('HPLC ROOM');
    expect(rowValue('High Temperature Limit')).toBe('25.0');
    expect(rowValue('Enable_Humid_NMT')).toBe('0');
  });

  // 2026-09-16: a tile is headed by the key's administered display name, and
  // by the key itself when none is configured. The value is untouched.
  it('heads a tile with the display name where one is configured, else the key', () => {
    labels.current = { Enable_Humid_NMT: 'High humidity alarm enabled' };
    mount();
    expect(rowValue('High humidity alarm enabled')).toBe('0');
    expect(within(widget()).queryByText('Enable_Humid_NMT')).toBeNull();
    expect(rowValue('Building')).toBe('CWH Block');
  });

  it('choosing another instrument swaps the widget to its rows — only the attributes it carries', () => {
    mount();
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: 'CWH/RDU/002-00' }));
    expect(rowValue('Instrument ID')).toBe('CWH/RDU/002-00');
    expect(within(widget()).queryByText('Building')).toBeNull();
    expect(rowValue('Location')).toBe('STORE');
    expect(within(widget()).queryByText('High Temperature Limit')).toBeNull();
  });

  it('View alone: no Edit button and nothing editable', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  /**
   * Inline editing (2026-09-16, operator: "when user clicks on edit values
   * should be editable but another edit popup was showing and also in settings
   * Instrument id should be changable"). Edit turns the tiles into inputs IN
   * PLACE — no dialog, no second screen. The §11 flow is the Attributes
   * panel's, unchanged: only keys the role may edit become inputs, a changed
   * attribute needs ONE remark for the batch, every request still carries the
   * KEY and the reason, and re-authentication is the hook's business.
   */
  describe('inline edit', () => {
    const startEdit = () => {
      grants = new Set(['settings.view', 'settings.edit']);
      mount();
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    };
    const field = (name: string) => within(widget()).getByRole('textbox', { name });
    const remark = (text = 'Corrected against the calibration certificate') => {
      fireEvent.change(screen.getByRole('textbox', { name: /remarks/i }), { target: { value: text } });
      fireEvent.click(screen.getByRole('button', { name: /^save change/i }));
    };

    it('Edit turns the tiles into inputs in place — no dialog — with Save and Cancel', () => {
      startEdit();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(field('Instrument ID')).toHaveValue('CWH/RDU/001-00');
      expect(field('Location')).toHaveValue('HPLC ROOM');
      // The STORED value is edited, never the display form.
      expect(field('High Temperature Limit')).toHaveValue('25');
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    });

    it('Cancel discards the draft and returns to the read-only tiles', () => {
      startEdit();
      fireEvent.change(field('Location'), { target: { value: 'CHANGED' } });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(within(widget()).queryByRole('textbox')).toBeNull();
      expect(rowValue('Location')).toBe('HPLC ROOM');
      expect(put).not.toHaveBeenCalled();
    });

    it('Save with changed attributes asks ONE remark for the batch, then PUTs each changed KEY with the reason', async () => {
      labels.current = { Location: 'Room name' };
      startEdit();
      fireEvent.change(field('Room name'), { target: { value: 'QC LAB' } });
      fireEvent.change(field('Building'), { target: { value: 'CWH Annex' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      // The remark dialog names what is about to change, by display name.
      const dlg = screen.getByRole('dialog');
      expect(within(dlg).getByText('Room name')).toBeInTheDocument();
      expect(within(dlg).getByText('Building')).toBeInTheDocument();
      remark('Room renamed after the relayout');
      await waitFor(() => expect(put).toHaveBeenCalledWith(
        '/api/instruments/i-1/attributes/Location', { value: 'QC LAB', reason: 'Room renamed after the relayout' },
      ));
      expect(put).toHaveBeenCalledWith(
        '/api/instruments/i-1/attributes/Building', { value: 'CWH Annex', reason: 'Room renamed after the relayout' },
      );
      // Unchanged attributes are not re-written.
      expect(put.mock.calls.some(([url]) => String(url).endsWith('/attributes/Area'))).toBe(false);
      await waitFor(() => expect(mutateAttrs).toHaveBeenCalled());
      // Back to read-only tiles once saved.
      expect(within(widget()).queryByRole('textbox')).toBeNull();
    });

    // Audit 2026-10-12, finding 7. Keys are written one by one, so a failure on
    // the second leaves the first SAVED. The page did not refresh on failure, so
    // a re-Save compared against the stale values and PUT the saved key again —
    // a before == after §11 row. It now re-reads the server's values on any
    // failure, and a re-Save writes only what still differs from them.
    it('after a partial failure it re-reads the server, and a re-Save writes only what is still different', async () => {
      const original = attributes['i-1'];
      try {
        put.mockImplementation((url: string) => (String(url).endsWith('/attributes/Location')
          ? Promise.reject(new Error('Location refused')) : Promise.resolve({})));
        // The server's answer after the failure: Building WAS saved.
        mutateAttrs.mockImplementation(async () => {
          attributes['i-1'] = original.map((a) => (a.key === 'Building' ? { ...a, value: 'CWH Annex' } : a));
        });
        startEdit();
        fireEvent.change(field('Location'), { target: { value: 'QC LAB' } });
        fireEvent.change(field('Building'), { target: { value: 'CWH Annex' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        remark('Room renamed after the relayout');
        await waitFor(() => expect(mutateAttrs).toHaveBeenCalled());
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());

        put.mockReset().mockResolvedValue({});
        if (!screen.queryByRole('textbox', { name: /remarks/i })) {
          fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        }
        remark('Second attempt after the refusal');
        await waitFor(() => expect(put).toHaveBeenCalledWith(
          '/api/instruments/i-1/attributes/Location', { value: 'QC LAB', reason: 'Second attempt after the refusal' },
        ));
        expect(put.mock.calls.some(([url]) => String(url).endsWith('/attributes/Building'))).toBe(false);
      } finally {
        attributes['i-1'] = original;
      }
    });

    it('Save with nothing changed writes nothing and just leaves edit mode', () => {
      startEdit();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(put).not.toHaveBeenCalled();
      expect(within(widget()).queryByRole('textbox')).toBeNull();
    });

    it('a changed Instrument ID is PUT on the instrument, without a remark, and the picker list refreshes', async () => {
      startEdit();
      fireEvent.change(field('Instrument ID'), { target: { value: 'CWH/RDU/001-01' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      await waitFor(() => expect(put).toHaveBeenCalledWith('/api/instruments/i-1', { code: 'CWH/RDU/001-01' }));
      await waitFor(() => expect(mutateList).toHaveBeenCalled());
    });

    it('a rename alone signs under UPDATE_INSTRUMENT, not the attribute action (audit 2026-10-03, SEC-7)', async () => {
      reauthActions.length = 0;
      startEdit();
      fireEvent.change(field('Instrument ID'), { target: { value: 'CWH/RDU/001-01' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(put).toHaveBeenCalledWith('/api/instruments/i-1', { code: 'CWH/RDU/001-01' }));
      expect(reauthActions).toEqual(['UPDATE_INSTRUMENT']);
    });

    it('sends an Instrument ID containing an MQTT wildcard as typed — the guard was removed (operator, 2026-09-16)', async () => {
      startEdit();
      fireEvent.change(field('Instrument ID'), { target: { value: 'CWH/+/001' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(put).toHaveBeenCalledWith('/api/instruments/i-1', { code: 'CWH/+/001' }));
    });

    it('only the keys the role may edit become inputs; the rest stay read-only tiles', () => {
      access.current = { mode: 'SELECTED', keys: ['Location'], requireReauth: false };
      startEdit();
      expect(field('Location')).toBeInTheDocument();
      expect(within(widget()).queryByRole('textbox', { name: 'Building' })).toBeNull();
      expect(rowValue('Building')).toBe('CWH Block');
    });

    it('ALL_VIEW leaves every attribute read-only but the Instrument ID still editable', () => {
      access.current = { mode: 'ALL_VIEW', keys: [], requireReauth: false };
      startEdit();
      expect(within(widget()).queryByRole('textbox', { name: 'Location' })).toBeNull();
      expect(field('Instrument ID')).toBeInTheDocument();
    });
  });
});

/**
 * Settings-page visibility (2026-09-21, operator: "in that configuration page
 * any attribute or any field hide, then that field should not show in the
 * settings page"). The hidden set comes from Configuration → Instrument
 * Attributes through the same route as the display names. A hidden field is
 * not drawn and, in Edit, has no input — so nothing can be written to it from
 * here. Presentation over this page only: the API still serves the attribute.
 */
describe('SettingsPage — fields hidden by configuration', () => {
  beforeEach(() => {
    grants = new Set(['settings.view']);
    labels.current = {};
    hidden.current = { instrumentId: false, keys: [] };
    access.current = { mode: null, keys: [], requireReauth: false };
    put.mockReset().mockResolvedValue({});
    putWithReauth.mockReset().mockResolvedValue({});
    mutateList.mockReset(); mutateAttrs.mockReset();
    try { localStorage.clear(); } catch { /* jsdom */ }
  });
  afterEach(() => { hidden.current = { instrumentId: false, keys: [] }; });

  it('does not draw a tile for a hidden attribute key — matched ignoring case — and keeps the rest', () => {
    hidden.current = { instrumentId: false, keys: ['enable_humid_nmt', 'High Temperature Limit'] };
    mount();
    expect(within(widget()).queryByText('Enable_Humid_NMT')).toBeNull();
    expect(within(widget()).queryByText('High Temperature Limit')).toBeNull();
    expect(rowValue('Building')).toBe('CWH Block');
    expect(rowValue('Location')).toBe('HPLC ROOM');
    expect(rowValue('Instrument ID')).toBe('CWH/RDU/001-00');
  });

  it('does not draw the Instrument ID tile when it is hidden, and still draws the attributes', () => {
    hidden.current = { instrumentId: true, keys: [] };
    mount();
    expect(within(widget()).queryByText('Instrument ID')).toBeNull();
    expect(rowValue('Building')).toBe('CWH Block');
  });

  it('in Edit, a hidden attribute and a hidden Instrument ID have no input, and a save writes neither', async () => {
    hidden.current = { instrumentId: true, keys: ['Building'] };
    grants = new Set(['settings.view', 'settings.edit']);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(within(widget()).queryByRole('textbox', { name: 'Building' })).toBeNull();
    expect(within(widget()).queryByRole('textbox', { name: 'Instrument ID' })).toBeNull();
    fireEvent.change(within(widget()).getByRole('textbox', { name: 'Location' }), { target: { value: 'QC LAB' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.change(screen.getByRole('textbox', { name: /remarks/i }), { target: { value: 'Relayout' } });
    fireEvent.click(screen.getByRole('button', { name: /^save change/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes/Location', { value: 'QC LAB', reason: 'Relayout' },
    ));
    expect(put.mock.calls.some(([url]) => String(url).endsWith('/attributes/Building'))).toBe(false);
    expect(put.mock.calls.some(([url]) => url === '/api/instruments/i-1')).toBe(false);
  });
});

/**
 * Block → Area → instrument (2026-10-03, operator: "in settings page give
 * block/area/instrument wise selection"). The two selects are the Data Report
 * page's cascade; the scope is the Area, else the Block, else everything, and
 * it goes to the LIST route as `functionalLocationId` — the server expands a
 * Block to its Areas and applies the caller's instrument scope. Every
 * assertion here is on what was REQUESTED and what the server's answer made
 * the picker offer; the page walks no tree of its own.
 */
describe('SettingsPage — Block / Area / instrument selection', () => {
  beforeEach(() => {
    grants = new Set(['settings.view']);
    labels.current = {};
    hidden.current = { instrumentId: false, keys: [] };
    access.current = { mode: null, keys: [], requireReauth: false };
    mutateList.mockReset(); mutateAttrs.mockReset();
    listRequests = [];
    try { localStorage.clear(); } catch { /* jsdom */ }
  });
  const block = () => screen.getByRole('combobox', { name: 'Block' }) as HTMLSelectElement;
  const area = () => screen.getByRole('combobox', { name: 'Area' }) as HTMLSelectElement;
  const optionsOf = (sel: HTMLSelectElement) => Array.from(sel.options).map((o) => o.textContent);
  const lastScope = () => new URLSearchParams(listRequests.at(-1)!.split('?')[1]).get('functionalLocationId');

  it('offers every Block from the tree with "All blocks" first; the Area select waits for a Block, and no scope is sent', () => {
    mount();
    expect(optionsOf(block())).toEqual(['All blocks', 'CWH Block', 'Annex']);
    expect(area()).toBeDisabled();
    expect(optionsOf(area())).toEqual(['Choose a block first']);
    expect(lastScope()).toBeNull();
    // The whole scoped list, so the unassigned instrument is reachable.
    openPicker();
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['CWH/RDU/001-00', 'CWH/RDU/002-00']);
  });

  it('choosing a Block sends ITS id as the scope, offers its Areas, and the picker narrows to what the server returned', () => {
    mount();
    fireEvent.change(block(), { target: { value: 'b-1' } });
    expect(lastScope()).toBe('b-1');
    expect(area()).toBeEnabled();
    expect(optionsOf(area())).toEqual(['All areas', 'Stability', 'QC']);
    openPicker();
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['CWH/RDU/001-00']);
    expect(rowValue('Instrument ID')).toBe('CWH/RDU/001-00');
  });

  it('choosing an Area sends the AREA id, not the Block\'s; choosing another Block clears the Area', () => {
    mount();
    fireEvent.change(block(), { target: { value: 'b-1' } });
    fireEvent.change(area(), { target: { value: 'a-1' } });
    expect(lastScope()).toBe('a-1');
    expect(rowValue('Instrument ID')).toBe('CWH/RDU/001-00');
    fireEvent.change(block(), { target: { value: 'b-2' } });
    expect(area().value).toBe('');
    expect(lastScope()).toBe('b-2');
  });

  it('a scope with nothing in it says so and draws no widget — not "assigned to you", which is a different fact', () => {
    mount();
    fireEvent.change(block(), { target: { value: 'b-1' } });
    fireEvent.change(area(), { target: { value: 'a-2' } });
    expect(screen.getByText('No instruments in this selection.')).toBeInTheDocument();
    expect(screen.queryByText('No instruments are assigned to you.')).toBeNull();
    expect(screen.queryByTestId('settings-widget')).toBeNull();
  });

  it('when the remembered instrument is not in the new scope, the first in scope is shown', () => {
    mount();
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: 'CWH/RDU/002-00' }));
    expect(rowValue('Instrument ID')).toBe('CWH/RDU/002-00');
    fireEvent.change(block(), { target: { value: 'b-1' } });
    expect(rowValue('Instrument ID')).toBe('CWH/RDU/001-00');
  });

  it('the Block and Area are remembered per browser and the first request carries them', () => {
    localStorage.setItem('settings.scope', JSON.stringify({ blockId: 'b-1', areaId: 'a-1' }));
    mount();
    expect(block().value).toBe('b-1');
    expect(area().value).toBe('a-1');
    expect(lastScope()).toBe('a-1');
  });

  it('a malformed remembered scope falls back to "All blocks" rather than breaking the page', () => {
    localStorage.setItem('settings.scope', '{not json');
    mount();
    expect(block().value).toBe('');
    expect(lastScope()).toBeNull();
  });
});
