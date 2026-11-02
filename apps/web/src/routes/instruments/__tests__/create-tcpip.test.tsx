import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';

/**
 * New Instrument for a TCP/IP (Modbus) profile (2026-10-31, spec §12). The
 * instrument carries its own IP address, port, Slave ID and Read every (CR-1,
 * 2026-11-02 — no longer the profile's) and register map; it is never a
 * gateway nor behind one; it gets NO token (this server reads the device, so
 * nothing ever logs in as it) — so no token dialog. Which key is judged is the
 * Test-connection RESPONSE's answer and nothing else. A Gateway profile's form
 * is the one `create.test.tsx` pins, unchanged.
 */

// A profile carries only its connection since CR-1: no interval, no unit id.
const PROFILES = {
  data: [
    { id: 'g-1', name: 'T&RH Sensors', connection: 'PUSH' },
    { id: 't-1', name: 'Modbus Room Sensors', connection: 'MODBUS_TCP' },
  ],
};
const DETAIL: Record<string, unknown> = {
  'g-1': { id: 'g-1', attributeKeys: '', connection: 'PUSH' },
  't-1': { id: 't-1', attributeKeys: '', connection: 'MODBUS_TCP' },
};
const LABELS = { labels: {} };
const GATEWAYS = { data: [{ id: 'gw-1', code: 'IOTGW01', name: 'IOTGW01', profileName: 'T&RH Sensors' }] };

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/instrument-profiles') return { data: PROFILES };
    if (key === '/api/config/attribute-labels/current') return { data: LABELS };
    if (typeof key === 'string' && key.startsWith('/api/instruments?isGateway=true')) return { data: GATEWAYS };
    if (typeof key === 'string' && key.startsWith('/api/instrument-profiles/')) {
      return { data: DETAIL[key.slice('/api/instrument-profiles/'.length)] };
    }
    return { data: undefined };
  },
}));

const post = vi.fn();
const postWithReauth = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    post: (...a: unknown[]) => post(...a),
    postWithReauth: (...a: unknown[]) => postWithReauth(...a),
    get: vi.fn(), put: vi.fn(), delete: vi.fn(),
  },
}));
const errorToast = vi.fn();
const successToast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: successToast, error: errorToast } }),
}));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (
      _action: string,
      cb: (p?: string) => Promise<void>,
      opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void },
    ) => {
      try { await cb(undefined); await opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { InstrumentCreatePage } = await import('../create');

function Detail() {
  const { id } = useParams();
  return <p>DETAIL {id}</p>;
}
const renderAt = (url: string) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/instruments/new" element={<InstrumentCreatePage />} />
      <Route path="/instruments/:id" element={<Detail />} />
    </Routes>
  </MemoryRouter>,
);

/** A TCP/IP instrument's 201: no `token` key at all (spec §9). */
const CREATED_TCPIP = { id: 'i-new', code: 'CWH/RDU/101-01', name: 'CWH/RDU/101-01', connection: 'MODBUS_TCP' };
const SIX_KEYS = {
  keys: [
    { key: 'Temperature', register: '40001', data_type: 'FLOAT32', byte_order: 'ABCD' },
    { key: 'Humidity', register: '40003', data_type: 'FLOAT32', byte_order: 'ABCD' },
    { key: 'Pressure', register: '40005', data_type: 'FLOAT32', byte_order: 'ABCD' },
    { key: 'Power', register: '40007', data_type: 'FLOAT32', byte_order: 'ABCD' },
    { key: 'Voltage', register: '40009', data_type: 'UINT16', byte_order: 'ABCD' },
    { key: 'Switch', register: '40010', data_type: 'INT16', byte_order: 'ABCD' },
  ],
};
const SIX_MAP = [
  { key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Humidity', register: '40003', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Pressure', register: '40005', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Power', register: '40007', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Voltage', register: '40009', dataType: 'UINT16', scale: 1 },
  { key: 'Switch', register: '40010', dataType: 'INT16', scale: 1 },
];

const typeInto = (name: string | RegExp, value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });
const slaveId = () => screen.getByRole('spinbutton', { name: /slave id/i }) as HTMLInputElement;
const readEvery = () => screen.getByRole('combobox', { name: /read every/i }) as HTMLSelectElement;
const importSix = async () => {
  fireEvent.change(screen.getByLabelText('Import keys file'), {
    target: { files: [new File([JSON.stringify(SIX_KEYS)], 'ModbusTCPReader_keys.json', { type: 'application/json' })] },
  });
  await waitFor(() => expect(screen.getAllByRole('textbox', { name: /^Key, row \d+$/ })).toHaveLength(6));
};
const create = () => fireEvent.click(screen.getByRole('button', { name: /create instrument/i }));
const createCalls = () => post.mock.calls.filter(([url]) => url === '/api/instruments');

beforeEach(() => {
  post.mockReset().mockImplementation((url: string) =>
    url === '/api/instruments' ? Promise.resolve(CREATED_TCPIP) : Promise.resolve({}));
  postWithReauth.mockReset();
  errorToast.mockReset();
  successToast.mockReset();
});

describe('New Instrument — a TCP/IP profile', () => {
  it('hides Is Gateway and Reports through gateway; shows its own address (port 502) and register map', () => {
    renderAt('/instruments/new?profileId=t-1');
    expect(screen.queryByRole('checkbox', { name: /is gateway/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /reports through gateway/i })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'TCP/IP connection' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /ip address/i })).toHaveValue('');
    expect(screen.getByRole('spinbutton', { name: /^port/i })).toHaveValue(502);
    expect(screen.getByRole('region', { name: 'Register map' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeInTheDocument();
  });

  it('the TCP/IP connection asks, in order, for IP address, Port, Slave ID (1) and Read every (1 minute) — the profile says nothing about either', () => {
    renderAt('/instruments/new?profileId=t-1');
    const section = screen.getByRole('region', { name: 'TCP/IP connection' });
    const labels = Array.from(section.querySelectorAll('label > span:first-child')).map((s) => s.textContent);
    expect(labels).toEqual(['IP address *', 'Port *', 'Slave ID', 'Read every']);
    expect(slaveId()).toHaveValue(1);
    expect(readEvery()).toHaveValue('60');
    expect(readEvery().selectedOptions[0]?.textContent).toBe('1 minute');
    expect(screen.queryByText(/set once on the profile/)).not.toBeInTheDocument();
    expect(screen.queryByText(/unit ID/)).not.toBeInTheDocument();
  });

  it('a Gateway profile keeps the form it had: Is Gateway, the gateway picker, and none of the TCP/IP cards', () => {
    renderAt('/instruments/new?profileId=g-1');
    expect(screen.getByRole('checkbox', { name: /is gateway/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /reports through gateway/i })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'TCP/IP connection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Register map' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
  });
});

describe('New Instrument — Judged as is the Test-connection response', () => {
  it('reads "—" until a response arrives, then exactly what the response said', async () => {
    post.mockImplementation((url: string) => url === '/api/instruments/modbus/test'
      // A key NAMED Temperature that the server did not judge: the column
      // must say so — no browser lookup of measurement names.
      ? Promise.resolve({ ok: true, elapsedMs: 40, requests: 1, values: [{ key: 'Temperature', value: 22.4, judgedAs: null }], rejected: [] })
      : Promise.resolve(CREATED_TCPIP));
    renderAt('/instruments/new?profileId=t-1');
    fireEvent.click(screen.getByRole('button', { name: '+ Add key' }));
    typeInto('Key, row 1', 'Temperature');
    typeInto('Register, row 1', '40001');
    fireEvent.change(screen.getByRole('combobox', { name: 'Byte order, row 1' }), { target: { value: 'ABCD' } });
    typeInto(/ip address/i, '192.168.1.24');
    expect(screen.getByTestId('map-judged-0')).toHaveTextContent('—');
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByTestId('map-judged-0')).toHaveTextContent('Not judged'));
    expect(post).toHaveBeenCalledWith('/api/instruments/modbus/test', {
      profileId: 't-1', modbusHost: '192.168.1.24', modbusPort: 502, modbusUnitId: 1,
      modbusRegisters: [{ key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 }],
    });
  });

  it('Test connection and a per-key Test send the Slave ID as typed', async () => {
    post.mockImplementation((url: string) => url === '/api/instruments/modbus/test'
      ? Promise.resolve({ ok: true, elapsedMs: 40, requests: 1, values: [{ key: 'Humidity', value: 47.1, judgedAs: 'HUMIDITY' }], rejected: [] })
      : Promise.resolve(CREATED_TCPIP));
    renderAt('/instruments/new?profileId=t-1');
    await importSix();
    typeInto(/ip address/i, '192.168.1.24');
    fireEvent.change(slaveId(), { target: { value: '17' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/instruments/modbus/test', expect.objectContaining({ modbusUnitId: 17, modbusRegisters: SIX_MAP })));
    fireEvent.click(screen.getByRole('button', { name: 'Test key, row 2' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/instruments/modbus/test', {
      profileId: 't-1', modbusHost: '192.168.1.24', modbusPort: 502, modbusUnitId: 17, modbusRegisters: [SIX_MAP[1]],
    }));
    expect(await screen.findByTestId('map-test-1')).toHaveTextContent('Read now: 47.1 · judged as Humidity');
  });

  it('a per-key Test waits for the address and a Slave ID', async () => {
    renderAt('/instruments/new?profileId=t-1');
    await importSix();
    expect(screen.getByRole('button', { name: 'Test key, row 1' })).toHaveAttribute('title', 'Set the IP address to test.');
    typeInto(/ip address/i, '192.168.1.24');
    fireEvent.change(slaveId(), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Test key, row 1' })).toHaveAttribute('title', 'Set a Slave ID from 0 to 255 to test.');
    expect(screen.getByRole('button', { name: 'Test key, row 1' })).toBeDisabled();
  });

  it('a READING_OFF answer prints its sentence', async () => {
    const message = 'Reading devices from this server is off (Configuration → TCP/IP Reading).';
    post.mockImplementation((url: string) => url === '/api/instruments/modbus/test'
      ? Promise.resolve({ ok: false, code: 'READING_OFF', message })
      : Promise.resolve(CREATED_TCPIP));
    renderAt('/instruments/new?profileId=t-1');
    await importSix();
    typeInto(/ip address/i, '192.168.1.24');
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('an ADDRESS_IN_USE answer prints its sentence', async () => {
    const message = '192.168.1.24 : 502 is already used by instrument "CWH/RDU/101-01".';
    post.mockImplementation((url: string) => url === '/api/instruments/modbus/test'
      ? Promise.resolve({ ok: false, code: 'ADDRESS_IN_USE', message })
      : Promise.resolve(CREATED_TCPIP));
    renderAt('/instruments/new?profileId=t-1');
    await importSix();
    typeInto(/ip address/i, '192.168.1.24');
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });
});

describe('New Instrument — Create for a TCP/IP profile', () => {
  it('POSTs its address and register map, and opens NO token dialog — it goes to the instrument', async () => {
    renderAt('/instruments/new?profileId=t-1');
    typeInto(/instrument id/i, 'CWH/RDU/101-01');
    typeInto(/ip address/i, '192.168.1.24');
    await importSix();
    create();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(createCalls()[0]![1]).toEqual({
      name: 'CWH/RDU/101-01', code: 'CWH/RDU/101-01', profileId: 't-1',
      modbusHost: '192.168.1.24', modbusPort: 502, modbusUnitId: 1, modbusIntervalSec: 60, modbusRegisters: SIX_MAP,
    });
    expect(await screen.findByText('DETAIL i-new')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(errorToast).not.toHaveBeenCalled();
  });

  it('a port typed by the operator is sent as a number', async () => {
    renderAt('/instruments/new?profileId=t-1');
    typeInto(/instrument id/i, 'P-1');
    typeInto(/ip address/i, '10.1.2.3');
    fireEvent.change(screen.getByRole('spinbutton', { name: /^port/i }), { target: { value: '5020' } });
    create();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(createCalls()[0]![1]).toMatchObject({ modbusHost: '10.1.2.3', modbusPort: 5020, modbusRegisters: [] });
  });

  it('the Slave ID and Read every chosen are sent as numbers', async () => {
    renderAt('/instruments/new?profileId=t-1');
    typeInto(/instrument id/i, 'P-6');
    typeInto(/ip address/i, '10.1.2.3');
    fireEvent.change(slaveId(), { target: { value: '0' } });
    fireEvent.change(readEvery(), { target: { value: '300' } });
    create();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(createCalls()[0]![1]).toMatchObject({ modbusUnitId: 0, modbusIntervalSec: 300 });
  });

  it('a blank Slave ID is no Slave ID (never 0): named under its field in the shared schema\'s words, nothing posted', async () => {
    renderAt('/instruments/new?profileId=t-1');
    typeInto(/instrument id/i, 'P-7');
    typeInto(/ip address/i, '10.1.2.3');
    fireEvent.change(slaveId(), { target: { value: '' } });
    create();
    expect(await screen.findByText('Slave ID must be a whole number from 0 to 255.')).toBeInTheDocument();
    expect(slaveId()).toHaveAttribute('aria-invalid', 'true');
    expect(createCalls()).toHaveLength(0);
  });

  it('a Slave ID over 255 is stopped by the field\'s own 0..255 bounds (as Port\'s are) — nothing posted', async () => {
    renderAt('/instruments/new?profileId=t-1');
    typeInto(/instrument id/i, 'P-7');
    typeInto(/ip address/i, '10.1.2.3');
    fireEvent.change(slaveId(), { target: { value: '256' } });
    expect(slaveId().validity.rangeOverflow).toBe(true);
    create();
    await new Promise((r) => setTimeout(r, 0));
    expect(createCalls()).toHaveLength(0);
  });

  it('a refusal the form did not foresee is printed under its field, in the API\'s words', async () => {
    post.mockImplementation((url: string) => url === '/api/instruments'
      ? Promise.reject(Object.assign(new Error('VALIDATION_ERROR'), {
        status: 400, code: 'VALIDATION_ERROR',
        connectionInfo: { formErrors: [], fieldErrors: { modbusIntervalSec: ['Read every must be a whole number of seconds from 10 to 3600.'] } },
      }))
      : Promise.resolve({}));
    renderAt('/instruments/new?profileId=t-1');
    typeInto(/instrument id/i, 'P-8');
    typeInto(/ip address/i, '10.1.2.3');
    create();
    expect(await screen.findByText('Read every must be a whole number of seconds from 10 to 3600.')).toBeInTheDocument();
    expect(readEvery()).toHaveAttribute('aria-invalid', 'true');
    expect(errorToast).toHaveBeenCalled();
  });

  it('Is Gateway ticked under a Gateway profile is NOT sent after switching to a TCP/IP one', async () => {
    renderAt('/instruments/new');
    fireEvent.change(screen.getByRole('combobox', { name: /profile/i }), { target: { value: 'g-1' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /is gateway/i }));
    fireEvent.change(screen.getByRole('combobox', { name: /profile/i }), { target: { value: 't-1' } });
    typeInto(/instrument id/i, 'P-2');
    typeInto(/ip address/i, '192.168.1.30');
    create();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    const body = createCalls()[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('isGateway');
    expect(body).not.toHaveProperty('gatewayId');
    expect(body.modbusHost).toBe('192.168.1.30');
  });

  it('a Gateway profile sends no TCP/IP fields', async () => {
    post.mockResolvedValue({ id: 'g-new', code: 'P-3', token: 'TOK' });
    renderAt('/instruments/new?profileId=g-1');
    typeInto(/instrument id/i, 'P-3');
    create();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    const body = createCalls()[0]![1] as Record<string, unknown>;
    for (const k of ['modbusHost', 'modbusPort', 'modbusUnitId', 'modbusIntervalSec', 'modbusRegisters']) expect(body).not.toHaveProperty(k);
    expect(screen.queryByRole('spinbutton', { name: /slave id/i })).not.toBeInTheDocument();
    // …and its token is shown, as it always was.
    expect(await screen.findByText('TOK')).toBeInTheDocument();
  });

  it('a hostname is named beside the field and nothing is posted', async () => {
    renderAt('/instruments/new?profileId=t-1');
    typeInto(/instrument id/i, 'P-4');
    typeInto(/ip address/i, 'plc.local');
    create();
    expect(await screen.findByText('Enter an IPv4 address such as 192.168.1.24 (hostnames are not accepted)')).toBeInTheDocument();
    expect(createCalls()).toHaveLength(0);
  });

  it('a row whose Quantity was changed has no data type until one is chosen: not posted', async () => {
    renderAt('/instruments/new?profileId=t-1');
    typeInto(/instrument id/i, 'P-9');
    typeInto(/ip address/i, '192.168.1.24');
    await importSix();
    fireEvent.change(screen.getByRole('combobox', { name: 'Quantity, row 1' }), { target: { value: '1' } });
    expect(screen.getByTestId('map-errors-0')).toHaveTextContent('Data type must be one of');
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    create();
    expect(await screen.findByText(/The register map has errors/)).toBeInTheDocument();
    expect(createCalls()).toHaveLength(0);
  });

  it('a register map the shared schema refuses is not posted', async () => {
    renderAt('/instruments/new?profileId=t-1');
    typeInto(/instrument id/i, 'P-5');
    typeInto(/ip address/i, '192.168.1.24');
    fireEvent.click(screen.getByRole('button', { name: '+ Add key' }));
    create();
    expect(await screen.findByText(/The register map has errors/)).toBeInTheDocument();
    expect(createCalls()).toHaveLength(0);
  });
});
