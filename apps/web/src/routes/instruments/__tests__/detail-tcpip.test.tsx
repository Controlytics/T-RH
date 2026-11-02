import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * The instrument page of a TCP/IP (Modbus) instrument: a connection card that
 * prints whether the application is reaching the device, and a register map
 * card, in place of Access token / Device certificate / Connection. Everything
 * on the cards is the SERVER's answer (`/modbus-status`); the page decides
 * nothing.
 */
const MAP = [
  { key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Humidity', register: '40003', dataType: 'UINT16', scale: 0.1 },
];
const base = {
  id: 'i-1', name: 'MB-1', code: 'MB-1', isActive: true,
  instrumentType: null, manufacturer: null, model: null, serialNumber: null,
  description: null, expectedIntervalSec: null,
  reporting: true, effectiveExpectedIntervalSec: 60,
  tokenPrefix: null, lastSeenAt: null, tokenRevealable: false,
  createdAt: '2026-08-06T00:00:00.000Z', createdBy: null,
  block: null, area: null, location: null,
  isGateway: false, gatewayId: null, lastSeenVia: 'polled',
  profileId: 'p-1', profileName: 'Modbus meter',
};
const tcpInstrument = { ...base, connection: 'MODBUS_TCP', modbusHost: '10.1.1.5', modbusPort: 502, modbusRegisters: MAP };
const pushInstrument = { ...base, id: 'i-2', connection: 'PUSH', modbusHost: null, modbusPort: null, modbusRegisters: [], tokenPrefix: 'ABCD1234', tokenRevealable: true };

const READING = {
  state: 'reading', readBy: 'server', intervalSec: 60,
  lastSuccessAt: '2026-10-31T09:00:00.000Z', failingSince: null,
  stored24h: 1380, expected24h: 1440, inactivityAlarmsOff: false,
};
let status: Record<string, unknown> = READING;
/** Set to make `/modbus-status` FAIL, as useSWR reports it: no data, an error. */
let statusError: Error | undefined;
const statusMutate = vi.fn();
let role = 'SUPER_ADMIN';
const requested: string[] = [];

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key) requested.push(key);
    if (key === '/api/instruments/i-1') return { data: tcpInstrument, mutate: vi.fn() };
    if (key === '/api/instruments/i-2') return { data: pushInstrument, mutate: vi.fn() };
    if (key === '/api/instruments/i-1/modbus-status') {
      return statusError ? { data: undefined, error: statusError, mutate: statusMutate } : { data: status, mutate: vi.fn() };
    }
    if (key?.endsWith('/attributes')) return { data: { data: [] }, mutate: vi.fn() };
    if (key?.endsWith('/children')) return { data: { data: [] }, mutate: vi.fn() };
    return { data: undefined, mutate: vi.fn() };
  },
  mutate: vi.fn(),
}));

const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    put: (...a: unknown[]) => put(...a),
    get: vi.fn(), post: vi.fn(), delete: vi.fn(),
    getWithReauth: vi.fn(), postWithReauth: vi.fn(), putWithReauth: vi.fn(),
  },
}));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { role } }) }));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDate: (v: string) => `D(${v})`, formatTime: () => 'T', formatDateTime: (v: string) => v }),
}));
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
const panelProps: Array<Record<string, unknown>> = [];
vi.mock('../test-connection-panel', () => ({
  TestConnectionPanel: (p: Record<string, unknown>) => { panelProps.push(p); return <div data-testid="test-panel">Test connection</div>; },
}));

const { InstrumentDetailPage } = await import('../detail');

const renderPage = (id = 'i-1') => render(
  <MemoryRouter initialEntries={[`/instruments/${id}`]}>
    <Routes><Route path="/instruments/:id" element={<InstrumentDetailPage />} /></Routes>
  </MemoryRouter>,
);
const REASON = 'Moved the meter to the new panel';
const sign = async (button = 'Save change') => {
  fireEvent.change(await screen.findByPlaceholderText('Why is this changing?'), { target: { value: REASON } });
  fireEvent.click(screen.getByRole('button', { name: button }));
};

beforeEach(() => {
  put.mockReset().mockResolvedValue({});
  status = READING;
  statusError = undefined;
  statusMutate.mockReset();
  role = 'SUPER_ADMIN';
  requested.length = 0;
  reauthActions.length = 0;
  panelProps.length = 0;
});

describe('instrument detail - a TCP/IP instrument', () => {
  it('shows the TCP/IP connection and Register map cards, and no token, certificate or Connection card', () => {
    renderPage();
    expect(screen.getByText('TCP/IP connection')).toBeInTheDocument();
    expect(screen.getByText('Register map')).toBeInTheDocument();
    for (const gone of ['Access token', 'Device certificate', 'Connection']) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    // The rest of the page is unchanged.
    expect(screen.getByTestId('details-card')).toBeInTheDocument();
    expect(screen.getByText('Latest readings')).toBeInTheDocument();
  });

  it('the register map is full width, outside the two-column grid (seven columns do not fit half a page)', () => {
    renderPage();
    // Render check 2026-11-02: in the left column at a 1240 px window, Byte
    // order, Scale and Judged as were scrolled out of sight.
    const map = screen.getByTestId('register-map-card');
    const connection = screen.getByTestId('modbus-connection-card');
    const gridOf = (el: HTMLElement) => el.closest('.lg\\:grid-cols-2');
    expect(gridOf(connection)).not.toBeNull();
    expect(gridOf(map)).toBeNull();
  });

  it('prints the server\'s state line, address, interval, stored figures and times', () => {
    renderPage();
    const card = screen.getByTestId('modbus-connection-card');
    expect(within(card).getByText('Reading')).toBeInTheDocument();
    expect(within(card).getByText('10.1.1.5 : 502')).toBeInTheDocument();
    expect(within(card).getByText('This server, every 60 s')).toBeInTheDocument();
    expect(within(card).getByText('stored 1380 of 1440 in 24 h')).toBeInTheDocument();
    expect(within(card).getByText(/D\(2026-10-31T09:00:00\.000Z\) T/)).toBeInTheDocument();
    expect(within(card).queryByTestId('modbus-last-error')).toBeNull();
    expect(within(card).queryByTestId('inactivity-off')).toBeNull();
  });

  it('a failing device prints Not answering, since when, and the last failure as the server worded it', () => {
    status = {
      ...READING, state: 'failing', failingSince: '2026-10-31T08:00:00.000Z',
      lastError: { code: 'NO_ANSWER', message: '10.1.1.5 : 502 did not answer within 3 s — check the IP, the cable, and that the device is on.', at: '2026-10-31T09:01:00.000Z' },
    };
    renderPage();
    const card = screen.getByTestId('modbus-connection-card');
    expect(within(card).getByText('Not answering')).toBeInTheDocument();
    expect(within(card).getByText(/Not answering since/)).toBeInTheDocument();
    expect(within(card).getByTestId('modbus-last-error')).toHaveTextContent('did not answer within 3 s');
  });

  it('a storage-only error is shown as the error it is, not as "Not answering"', () => {
    status = { ...READING, state: 'reading', lastError: { code: 'STORAGE_FAILED', message: 'The reading could not be saved.', at: '2026-10-31T09:01:00.000Z' } };
    renderPage();
    const card = screen.getByTestId('modbus-connection-card');
    expect(within(card).queryByText('Not answering')).toBeNull();
    expect(within(card).getByText('Reading')).toBeInTheDocument();
    expect(within(card).getByTestId('modbus-last-error')).toHaveTextContent('could not be saved');
  });

  it('a not-read instrument says why, in the server\'s words', () => {
    status = { ...READING, state: 'not-read', notReadReason: 'SERVER_READING_OFF', notReadDetail: 'Reading devices from this server is off.' };
    renderPage();
    const card = screen.getByTestId('modbus-connection-card');
    expect(within(card).getByText('Not read')).toBeInTheDocument();
    expect(within(card).getByText('Reading devices from this server is off.')).toBeInTheDocument();
  });

  it('a device the server stopped asking says why it is not read - never "Not answering", even with a stale failingSince (final review F-2)', () => {
    status = {
      ...READING, state: 'not-read', notReadReason: 'INSTRUMENT_DISABLED', notReadDetail: 'The instrument is disabled.',
      failingSince: '2026-10-31T08:00:00.000Z',
      lastError: { code: 'NO_ANSWER', message: '10.1.1.5 : 502 did not answer within 3 s — check the IP, the cable, and that the device is on.', at: '2026-10-31T08:40:00.000Z' },
    };
    renderPage();
    const card = screen.getByTestId('modbus-connection-card');
    expect(within(card).getByText('Not read')).toBeInTheDocument();
    expect(within(card).getByText('The instrument is disabled.')).toBeInTheDocument();
    expect(within(card).queryByText(/Not answering/)).toBeNull();
    // The last failure is still shown, as the record of what happened.
    expect(within(card).getByTestId('modbus-last-error')).toHaveTextContent('did not answer within 3 s');
  });

  it('a failed status request says so with the server\'s message and a retry - never "Checking the connection…" forever (final review F-8)', () => {
    statusError = new Error('Instrument not found.');
    renderPage();
    const card = screen.getByTestId('modbus-connection-card');
    expect(within(card).queryByText('Checking the connection…')).toBeNull();
    expect(within(card).getByText('Could not load the connection status.')).toBeInTheDocument();
    expect(within(card).getByText('Instrument not found.')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(statusMutate).toHaveBeenCalledTimes(1);
  });

  it('...and with no message from the server, the fixed sentence alone', () => {
    statusError = new Error('');
    renderPage();
    const card = screen.getByTestId('modbus-connection-card');
    expect(within(card).getByText('Could not load the connection status.')).toBeInTheDocument();
    expect(within(card).queryByText('Checking the connection…')).toBeNull();
  });

  it('prints the Inactivity Alarms sentence only when the server says they are off', () => {
    status = { ...READING, inactivityAlarmsOff: true };
    renderPage();
    expect(screen.getByTestId('inactivity-off')).toHaveTextContent(
      'No alarm is raised when this device stops answering — Inactivity Alarms are off (Configuration → Inactivity Alarms).',
    );
  });

  it('Test connection gets the stored address and map, and the instrument id', () => {
    renderPage();
    expect(screen.getByTestId('test-panel')).toBeInTheDocument();
    expect(panelProps[0]).toMatchObject({ profileId: 'p-1', host: '10.1.1.5', port: 502, map: MAP, instrumentId: 'i-1' });
  });

  it('Edit address asks for a reason and PUTs host, port and reason under UPDATE_INSTRUMENT', async () => {
    renderPage();
    const card = screen.getByTestId('modbus-connection-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(card).getByLabelText('IP address'), { target: { value: '10.1.1.9' } });
    fireEvent.change(within(card).getByLabelText('Port'), { target: { value: '1502' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await sign();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith('/api/instruments/i-1', { modbusHost: '10.1.1.9', modbusPort: 1502, reason: REASON });
    expect(reauthActions).toEqual(['UPDATE_INSTRUMENT']);
  });

  it('the register map is read-only; Edit is shown to a SUPER_ADMIN only', () => {
    role = 'ADMIN';
    renderPage();
    const card = screen.getByTestId('register-map-card');
    expect(within(card).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(card).getByText('Temperature')).toBeInTheDocument();
  });

  it('a SUPER_ADMIN edits the map: reason dialog, then PUT modbusRegisters + reason', async () => {
    renderPage();
    const card = screen.getByTestId('register-map-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await sign();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith('/api/instruments/i-1', { modbusRegisters: MAP, reason: REASON });
  });
});

describe('instrument detail - a PUSH instrument is unchanged', () => {
  it('keeps Access token and Device certificate, and never asks for modbus-status', () => {
    renderPage('i-2');
    expect(screen.getByText('Access token')).toBeInTheDocument();
    expect(screen.getByText('Device certificate')).toBeInTheDocument();
    expect(screen.getByText('Connection')).toBeInTheDocument();
    expect(screen.queryByText('TCP/IP connection')).toBeNull();
    expect(screen.queryByText('Register map')).toBeNull();
    expect(requested.some((k) => k.includes('modbus-status'))).toBe(false);
  });
});
