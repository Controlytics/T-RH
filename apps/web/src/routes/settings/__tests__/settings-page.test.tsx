import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('swr', () => ({
  default: (key: any) => {
    const k = typeof key === 'function' ? key() : key;
    if (typeof k === 'string' && k.startsWith('/api/instruments?')) return { data: { data: rows, total: rows.length }, isLoading: false, mutate: mutateList };
    if (typeof k === 'string' && /\/api\/instruments\/(i-\d)\/attributes$/.test(k)) {
      const id = k.match(/\/api\/instruments\/(i-\d)\/attributes$/)![1];
      return { data: { data: attributes[id] }, isLoading: false, mutate: mutateAttrs };
    }
    if (k === '/api/instruments/attribute-access/me') return { data: access.current, mutate: vi.fn() };
    if (typeof k === 'string' && k.includes('/instrument-activity/')) return { data: { activeWindowMinutes: 3 }, mutate: vi.fn() };
    if (k === '/api/config/attribute-labels/current') return { data: { labels: labels.current }, mutate: vi.fn() };
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
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (
      _action: string,
      cb: (p?: string) => Promise<void>,
      opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void },
    ) => {
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
// The picker's trigger is the one button with a listbox popup.
const openPicker = () => fireEvent.click(screen.getByRole('button', { expanded: false }));

describe('SettingsPage', () => {
  beforeEach(() => {
    grants = new Set(['settings.view']);
    labels.current = {};
    access.current = { mode: null, keys: [], requireReauth: false };
    put.mockReset().mockResolvedValue({});
    putWithReauth.mockReset().mockResolvedValue({});
    mutateList.mockReset(); mutateAttrs.mockReset();
    try { localStorage.clear(); } catch { /* jsdom */ }
  });

  it('names the screen once; the picker offers exactly the instruments the server returned, and the first is shown', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    openPicker();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
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

    it('refuses a wildcard Instrument ID before any request, with the server rule\'s reason', () => {
      startEdit();
      fireEvent.change(field('Instrument ID'), { target: { value: 'CWH/+/001' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(put).not.toHaveBeenCalled();
      expect(screen.getByText(/cannot contain \+ or #/)).toBeInTheDocument();
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
