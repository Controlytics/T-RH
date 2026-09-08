import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
const tree = [{ id: 'b1', name: 'CWH', type: 'BLOCK', children: [{ id: 'a-1', name: 'QC 3', type: 'AREA', children: [] }] }];
const attributes: Record<string, { key: string; value: string; display?: string | null }[]> = {
  'i-1': [
    { key: 'Location', value: 'HPLC ROOM' },
    { key: 'High Temperature Limit', value: '25', display: '25.0' },
    { key: 'Enable_Humid_NMT', value: '0' },
  ],
  'i-2': [{ key: 'Location', value: 'STORE' }],
};

let grants = new Set<string>(['settings.view']);

vi.mock('swr', () => ({
  default: (key: any) => {
    const k = typeof key === 'function' ? key() : key;
    if (typeof k === 'string' && k.startsWith('/api/instruments?')) return { data: { data: rows, total: rows.length }, isLoading: false, mutate: vi.fn() };
    if (typeof k === 'string' && k === '/api/functional-locations') return { data: { data: tree }, mutate: vi.fn() };
    if (typeof k === 'string' && /\/api\/instruments\/(i-\d)\/attributes$/.test(k)) {
      const id = k.match(/\/api\/instruments\/(i-\d)\/attributes$/)![1];
      return { data: { data: attributes[id] }, isLoading: false, mutate: vi.fn() };
    }
    if (typeof k === 'string' && k.includes('/instrument-activity/')) return { data: { activeWindowMinutes: 3 }, mutate: vi.fn() };
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => (node: string) => grants.has(node) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDateTime: (d: string) => d.slice(0, 16).replace('T', ' '), formatDate: (d: string) => d.slice(0, 10), formatTime: (d: string) => d.slice(11, 16) }),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock('@/routes/instruments/attributes-panel', () => ({
  AttributesPanel: ({ instrumentId, canEdit }: { instrumentId: string; canEdit: boolean }) => (
    <div data-testid="attributes-panel" data-instrument={instrumentId} data-can-edit={String(canEdit)} />
  ),
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
  beforeEach(() => { grants = new Set(['settings.view']); try { localStorage.clear(); } catch { /* jsdom */ } });

  it('names the screen once; the picker offers exactly the instruments the server returned, and the first is shown', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    openPicker();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['CWH/RDU/001-00', 'CWH/RDU/002-00']);
    expect(rowValue('Instrument ID')).toBe('CWH/RDU/001-00');
  });

  it('the widget prints Instrument ID, Building, Area, then every attribute key with its value — display form when the server gives one', () => {
    mount();
    expect(rowValue('Building')).toBe('CWH');
    expect(rowValue('Area')).toBe('QC 3');
    expect(rowValue('Location')).toBe('HPLC ROOM');
    expect(rowValue('High Temperature Limit')).toBe('25.0');
    expect(rowValue('Enable_Humid_NMT')).toBe('0');
  });

  it('choosing another instrument swaps the widget to its rows; no functional location reads Unassigned', () => {
    mount();
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: 'CWH/RDU/002-00' }));
    expect(rowValue('Instrument ID')).toBe('CWH/RDU/002-00');
    expect(rowValue('Building')).toBe('Unassigned');
    expect(rowValue('Area')).toBe('Unassigned');
    expect(rowValue('Location')).toBe('STORE');
    expect(within(widget()).queryByText('High Temperature Limit')).toBeNull();
  });

  it('View alone: no Edit button; with Edit, it opens the Attributes panel for THAT instrument with the edit flag', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByTestId('attributes-panel')).toBeNull();
    grants = new Set(['settings.view', 'settings.edit']);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const panel = screen.getByTestId('attributes-panel');
    expect(panel).toHaveAttribute('data-instrument', 'i-1');
    expect(panel).toHaveAttribute('data-can-edit', 'true');
    // The dialog also states where the instrument is (operator: "in edit
    // dialog also show building and area").
    const placement = screen.getByTestId('dialog-placement');
    expect(within(placement).getByText('Building').closest('[data-row]')!.querySelector('dd')!.textContent).toBe('CWH');
    expect(within(placement).getByText('Area').closest('[data-row]')!.querySelector('dd')!.textContent).toBe('QC 3');
  });
});
