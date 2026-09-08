import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Settings page (2026-09-08). Operator: *"in side bar add settings, in that
 * page show the instrument details and attributes, there selected user role
 * should edit details, view deytails"*.
 *
 * Every assertion is a WIRING one: which instruments are listed and with what,
 * that a row expands to its details and mounts the Attributes panel for THAT
 * instrument, and that the `settings.edit` gate is what turns the details form
 * on and hands the panel its edit flag. The Attributes panel itself is stubbed —
 * its own rule (Attribute Access, remarks, re-auth) is tested where it lives.
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
const rows = [
  inst({}),
  inst({ id: 'i-2', code: 'CWH/RDU/002-00', name: 'CWH/RDU/002-00', isActive: false, lastSeenAt: null, functionalLocationId: null, profileName: 'RS485 T/RH' }),
];
const overview = [
  { instrumentId: 'i-1', code: 'CWH/RDU/001-00', functionalLocationName: 'CWH › QC 3', locationAttribute: 'HPLC ROOM' },
  { instrumentId: 'i-2', code: 'CWH/RDU/002-00', functionalLocationName: null, locationAttribute: null },
];

let grants = new Set<string>(['settings.view']);
const put = vi.fn(async () => ({}));
const mutate = vi.fn();

vi.mock('swr', () => ({
  default: (key: any) => {
    const k = typeof key === 'function' ? key() : key;
    if (typeof k === 'string' && k.startsWith('/api/instruments?')) return { data: { data: rows, total: rows.length }, isLoading: false, mutate };
    if (typeof k === 'string' && k.startsWith('/api/instruments/telemetry-overview')) return { data: { data: overview }, mutate: vi.fn() };
    if (typeof k === 'string' && k.startsWith('/api/instrument-profiles')) return { data: { data: [{ id: 'p-1', name: 'RS485 T/RH' }, { id: 'p-2', name: 'Gateway' }] }, mutate: vi.fn() };
    if (typeof k === 'string' && k.includes('/instrument-activity/')) return { data: { activeWindowMinutes: 3 }, mutate: vi.fn() };
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => (node: string) => grants.has(node) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDateTime: (d: string) => d.slice(0, 16).replace('T', ' '), formatDate: (d: string) => d.slice(0, 10), formatTime: (d: string) => d.slice(11, 16) }),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn(), put: (...a: unknown[]) => put(...(a as [])) } }));
vi.mock('@/routes/instruments/attributes-panel', () => ({
  AttributesPanel: ({ instrumentId, canEdit }: { instrumentId: string; canEdit: boolean }) => (
    <div data-testid="attributes-panel" data-instrument={instrumentId} data-can-edit={String(canEdit)} />
  ),
}));

const { SettingsPage } = await import('../index');

function mount() {
  return render(<MemoryRouter initialEntries={['/settings']}><SettingsPage /></MemoryRouter>);
}
const rowOf = (code: string) => screen.getByText(code).closest('tr')!;

describe('SettingsPage', () => {
  beforeEach(() => { grants = new Set(['settings.view']); put.mockClear(); mutate.mockClear(); });

  it('names the screen once and lists every instrument with its profile, Block › Area, Location and status', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    const r1 = rowOf('CWH/RDU/001-00');
    expect(r1).toHaveTextContent('RS485 T/RH');
    expect(r1).toHaveTextContent('CWH › QC 3');
    expect(r1).toHaveTextContent('HPLC ROOM');
    expect(within(r1).getByText('Reporting')).toBeInTheDocument();
    const r2 = rowOf('CWH/RDU/002-00');
    // Empty states are worded APART, as on the dashboard.
    expect(r2).toHaveTextContent('Unassigned');
    expect(r2).toHaveTextContent('Not set');
    expect(within(r2).getByText('Disabled')).toBeInTheDocument();
  });

  it('expands a row to its details and mounts the Attributes panel for THAT instrument, read-only with View alone', () => {
    mount();
    expect(screen.queryByTestId('attributes-panel')).toBeNull();
    fireEvent.click(within(rowOf('CWH/RDU/001-00')).getByRole('button', { name: /Show details/ }));
    const panel = screen.getByTestId('attributes-panel');
    expect(panel).toHaveAttribute('data-instrument', 'i-1');
    expect(panel).toHaveAttribute('data-can-edit', 'false');
    // Details are read out, not editable.
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();
  });

  it('with Edit: the details form saves through the instrument update endpoint and the panel gets the edit flag', async () => {
    grants = new Set(['settings.view', 'settings.edit']);
    mount();
    fireEvent.click(within(rowOf('CWH/RDU/001-00')).getByRole('button', { name: /Show details/ }));
    expect(screen.getByTestId('attributes-panel')).toHaveAttribute('data-can-edit', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    const manufacturer = screen.getByLabelText('Manufacturer') as HTMLInputElement;
    fireEvent.change(manufacturer, { target: { value: 'Vaisala' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [url, body] = put.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe('/api/instruments/i-1');
    expect(body).toMatchObject({ name: 'CWH/RDU/001-00', manufacturer: 'Vaisala', profileId: 'p-1', isActive: true, expectedIntervalSec: 60 });
    // The superseded free-text placement columns are NOT written from here.
    expect(body).not.toHaveProperty('block');
    expect(body).not.toHaveProperty('location');
    await waitFor(() => expect(mutate).toHaveBeenCalled());
  });

  it('Edit alone (no View) still shows the table — the grant set carries read', () => {
    grants = new Set(['settings.edit']);
    mount();
    expect(rowOf('CWH/RDU/001-00')).toBeInTheDocument();
  });

  it('search narrows the table by Instrument ID or Location', () => {
    mount();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search instruments' }), { target: { value: 'hplc' } });
    expect(screen.getByText('CWH/RDU/001-00')).toBeInTheDocument();
    expect(screen.queryByText('CWH/RDU/002-00')).toBeNull();
  });
});
