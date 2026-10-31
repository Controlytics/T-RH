import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ModbusRegisterMap } from '@digilog/shared';

/**
 * The register map of a TCP/IP (Modbus) instrument (2026-10-31): the keys this
 * server reads from the device, one row each. What the editor may say on its
 * own is only the SHAPE of what was typed — the shared schema's messages, and
 * the Area a Modicon reference names (a pure parse of the user's own input).
 * Whether a key is judged is the SERVER's answer, read from a Test-connection
 * response and passed in as `judged`; with none, the column says "—".
 */

/** The desktop Modbus tool's keys file, as the shared converter's tests have it. */
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

const INSTRUMENTS = {
  data: [
    { id: 'i-9', code: 'CWH/RDU/101-01', name: 'CWH/RDU/101-01', profileName: 'Modbus Room Sensors' },
    { id: 'i-8', code: 'CWH/RDU/102-01', name: 'CWH/RDU/102-01', profileName: 'Modbus Room Sensors' },
  ],
};
const COPIED_MAP: ModbusRegisterMap = [
  { key: 'Temperature', register: '30001', dataType: 'FLOAT32', byteOrder: 'CDAB', scale: 1 },
  { key: 'Pressure', register: '30003', dataType: 'INT16', scale: 0.1 },
];
/** Every swr key the editor asked for — the copy picker must ask for TCP/IP instruments only. */
const swrKeys: (string | null)[] = [];
vi.mock('swr', () => ({
  default: (key: string | null) => {
    swrKeys.push(key);
    if (typeof key === 'string' && key.startsWith('/api/instruments?connection=MODBUS_TCP')) return { data: INSTRUMENTS };
    return { data: undefined };
  },
}));

const get = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const { RegisterMapEditor } = await import('../register-map-editor');

type Judged = Record<string, 'TEMPERATURE' | 'HUMIDITY' | null>;
const changes: ModbusRegisterMap[] = [];

function Harness({ initial = [], judged, readOnly }: { initial?: ModbusRegisterMap; judged?: Judged; readOnly?: boolean }) {
  const [map, setMap] = useState<ModbusRegisterMap>(initial);
  return (
    <RegisterMapEditor
      value={map}
      onChange={(next) => { changes.push(next); setMap(next); }}
      judged={judged}
      readOnly={readOnly}
    />
  );
}

const ROW_T: ModbusRegisterMap[number] = { key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 };
const ROW_V: ModbusRegisterMap[number] = { key: 'Voltage', register: '30009', dataType: 'UINT16', scale: 0.1 };

const importFile = (content: string) => {
  const input = screen.getByLabelText('Import keys file');
  fireEvent.change(input, { target: { files: [new File([content], 'ModbusTCPReader_keys.json', { type: 'application/json' })] } });
};
const keyInputs = () => screen.queryAllByRole('textbox', { name: /^Key, row \d+$/ }) as HTMLInputElement[];

beforeEach(() => {
  changes.length = 0;
  swrKeys.length = 0;
  get.mockReset();
});

describe('RegisterMapEditor — the rows', () => {
  it('shows Key, Register, Area, Data type, Byte order, Scale and Judged as — and no Unit column', () => {
    render(<Harness initial={[ROW_T]} />);
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    for (const h of ['Key', 'Register', 'Area', 'Data type', 'Byte order', 'Scale', 'Judged as']) expect(heads).toContain(h);
    expect(heads).not.toContain('Unit');
  });

  it('names the Area from the reference: 4xxxx holding, 3xxxx input', () => {
    render(<Harness initial={[ROW_T, ROW_V]} />);
    expect(screen.getByTestId('map-area-0')).toHaveTextContent('Holding');
    expect(screen.getByTestId('map-area-1')).toHaveTextContent('Input');
  });

  it('a reference that is not a register: Area "—" and the schema message under the row', () => {
    render(<Harness initial={[{ ...ROW_T, register: '00001' }]} />);
    expect(screen.getByTestId('map-area-0')).toHaveTextContent('—');
    expect(screen.getByTestId('map-errors-0')).toHaveTextContent('Register "00001" must be a holding');
  });

  it('offers a byte order only for a 32-bit type', () => {
    render(<Harness initial={[ROW_T, ROW_V]} />);
    expect(screen.getByRole('combobox', { name: 'Byte order, row 1' })).toHaveValue('ABCD');
    expect(screen.queryByRole('combobox', { name: 'Byte order, row 2' })).not.toBeInTheDocument();
  });

  it('switching to a 16-bit type drops the byte order', () => {
    render(<Harness initial={[ROW_T]} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Data type, row 1' }), { target: { value: 'INT16' } });
    const last = changes.at(-1)!;
    expect(last[0]!.dataType).toBe('INT16');
    expect(last[0]).not.toHaveProperty('byteOrder');
  });

  it('switching to a 32-bit type leaves the byte order for the operator to choose, and says so', () => {
    render(<Harness initial={[ROW_V]} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Data type, row 1' }), { target: { value: 'FLOAT32' } });
    expect(changes.at(-1)![0]).not.toHaveProperty('byteOrder');
    expect(screen.getByTestId('map-errors-0')).toHaveTextContent('FLOAT32 needs a byte order');
  });

  it('two keys in one register are refused by the shared schema, under the row', () => {
    render(<Harness initial={[ROW_T, { key: 'Humidity', register: '40002', dataType: 'UINT16', scale: 1 }]} />);
    expect(screen.getByTestId('map-errors-1')).toHaveTextContent('40002 overlaps the registers of row 1');
  });

  it('keeps a scale being typed as typed ("0." does not snap back to "0")', () => {
    render(<Harness initial={[ROW_V]} />);
    const scale = screen.getByRole('spinbutton', { name: 'Scale, row 1' }) as HTMLInputElement;
    fireEvent.change(scale, { target: { value: '0.25' } });
    expect(changes.at(-1)![0]!.scale).toBe(0.25);
    expect(scale.value).toBe('0.25');
  });

  it('+ Add key appends a row; Remove takes one out', () => {
    render(<Harness initial={[ROW_T]} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add key' }));
    expect(keyInputs()).toHaveLength(2);
    fireEvent.change(screen.getByRole('textbox', { name: 'Key, row 2' }), { target: { value: 'Pressure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove row 1' }));
    expect(keyInputs().map((i) => i.value)).toEqual(['Pressure']);
  });
});

describe('RegisterMapEditor — Judged as is the server\'s answer', () => {
  it('is "—" for every row, a Temperature key included, until a response is passed in', () => {
    render(<Harness initial={[ROW_T, ROW_V]} />);
    expect(screen.getByTestId('map-judged-0')).toHaveTextContent('—');
    expect(screen.getByTestId('map-judged-1')).toHaveTextContent('—');
  });

  it('prints what the response said, and "Not judged" for a key it did not judge', () => {
    // The response — not the key's name — decides: a key named "Voltage"
    // reported as judged reads as judged, a key named "Temperature" reported
    // as not judged reads "Not judged".
    render(<Harness initial={[ROW_T, ROW_V]} judged={{ Temperature: null, Voltage: 'HUMIDITY' }} />);
    expect(screen.getByTestId('map-judged-0')).toHaveTextContent('Not judged');
    expect(screen.getByTestId('map-judged-1')).toHaveTextContent('Humidity');
  });

  it('a key the response did not cover stays "—"', () => {
    render(<Harness initial={[ROW_T, ROW_V]} judged={{ Temperature: 'TEMPERATURE' }} />);
    expect(screen.getByTestId('map-judged-0')).toHaveTextContent('Temperature');
    expect(screen.getByTestId('map-judged-1')).toHaveTextContent('—');
  });
});

describe('RegisterMapEditor — Import keys file', () => {
  it('fills six rows from the desktop tool\'s file; Voltage and Switch carry no byte order', async () => {
    render(<Harness />);
    importFile(JSON.stringify(SIX_KEYS));
    await waitFor(() => expect(keyInputs()).toHaveLength(6));
    expect(keyInputs().map((i) => i.value)).toEqual(['Temperature', 'Humidity', 'Pressure', 'Power', 'Voltage', 'Switch']);
    const map = changes.at(-1)!;
    expect(map[4]).toEqual({ key: 'Voltage', register: '40009', dataType: 'UINT16', scale: 1 });
    expect(map[5]).toEqual({ key: 'Switch', register: '40010', dataType: 'INT16', scale: 1 });
    expect(map[0]).toEqual({ key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 });
    expect(screen.queryByRole('combobox', { name: 'Byte order, row 5' })).not.toBeInTheDocument();
  });

  it('a file the converter refuses shows its row errors and changes nothing', async () => {
    render(<Harness initial={[ROW_T]} />);
    const bad = { keys: [SIX_KEYS.keys[0], { key: 'X', register: '40003', data_type: 'FLOAT64', byte_order: 'ABCD' }] };
    importFile(JSON.stringify(bad));
    expect(await screen.findByText(/^Row 2: Data type must be one of/)).toBeInTheDocument();
    expect(changes).toHaveLength(0);
    expect(keyInputs().map((i) => i.value)).toEqual(['Temperature']);
  });

  it('a file that is not JSON is refused by name and changes nothing', async () => {
    render(<Harness initial={[ROW_T]} />);
    importFile('this is not json');
    expect(await screen.findByText(/is not a JSON file/)).toBeInTheDocument();
    expect(changes).toHaveLength(0);
  });
});

describe('RegisterMapEditor — Copy from instrument', () => {
  it('lists TCP/IP instruments only, and fills the map from the picked instrument\'s GET /:id', async () => {
    get.mockResolvedValue({ id: 'i-9', code: 'CWH/RDU/101-01', modbusRegisters: COPIED_MAP });
    render(<Harness />);
    // Nothing is fetched before the picker opens.
    expect(swrKeys.filter((k) => k !== null)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Copy from instrument…' }));
    expect(swrKeys.some((k) => typeof k === 'string' && k.startsWith('/api/instruments?connection=MODBUS_TCP'))).toBe(true);
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Instrument' }), { target: { value: 'i-9' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy map' }));
    await waitFor(() => expect(keyInputs()).toHaveLength(2));
    expect(get).toHaveBeenCalledWith('/api/instruments/i-9');
    expect(changes.at(-1)).toEqual(COPIED_MAP);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('an instrument with no map says so and copies nothing', async () => {
    get.mockResolvedValue({ id: 'i-8', code: 'CWH/RDU/102-01', modbusRegisters: [] });
    render(<Harness initial={[ROW_T]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy from instrument…' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Instrument' }), { target: { value: 'i-8' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy map' }));
    expect(await within(dialog).findByText(/CWH\/RDU\/102-01 has no register map to copy/)).toBeInTheDocument();
    expect(changes).toHaveLength(0);
  });
});

describe('RegisterMapEditor — read only', () => {
  it('prints the rows with no inputs and no buttons', () => {
    render(<Harness initial={[ROW_T, ROW_V]} readOnly />);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByLabelText('Import keys file')).not.toBeInTheDocument();
    expect(screen.getByText('Temperature')).toBeInTheDocument();
    expect(screen.getByTestId('map-area-1')).toHaveTextContent('Input');
  });
});
