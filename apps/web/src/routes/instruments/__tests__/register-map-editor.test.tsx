import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MODBUS_MAX_KEYS, type ModbusRegisterMap } from '@digilog/shared';

/**
 * The register map of a TCP/IP (Modbus) instrument (2026-10-31): the keys this
 * server reads from the device, one row each. What the editor may say on its
 * own is only the SHAPE of what was typed — the shared schema's messages, and
 * what a Modicon reference reads (area and range — a pure parse of the user's
 * own input). Whether a key is judged is the SERVER's answer, read from a
 * Test-connection response and passed in as `judged`; with none, the column
 * says "—".
 *
 * CR-1 (2026-11-02): a Quantity column (1 or 2 registers) that limits the data
 * types and CLEARS the type when changed (Ruling CR1-1, revised); the range
 * read; byte orders by name (Ruling CR1-4); and a per-key Test — the same
 * route with a one-key map, its answer on a line under the row (Rulings CR1-2,
 * CR1-5).
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
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), put: vi.fn(), delete: vi.fn() },
}));

const { RegisterMapEditor } = await import('../register-map-editor');

type Judged = Record<string, 'TEMPERATURE' | 'HUMIDITY' | null>;
type Target = { profileId: string; host: string; port: number; unitId: number; instrumentId?: string };
const changes: ModbusRegisterMap[] = [];

function Harness({ initial = [], judged, readOnly, testTarget }: {
  initial?: ModbusRegisterMap; judged?: Judged; readOnly?: boolean; testTarget?: Target;
}) {
  const [map, setMap] = useState<ModbusRegisterMap>(initial);
  return (
    <RegisterMapEditor
      value={map}
      onChange={(next) => { changes.push(next); setMap(next); }}
      judged={judged}
      readOnly={readOnly}
      testTarget={testTarget}
    />
  );
}

const TARGET: Target = { profileId: 't-1', host: '192.168.1.24', port: 502, unitId: 7 };

const ROW_T: ModbusRegisterMap[number] = { key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 };
const ROW_V: ModbusRegisterMap[number] = { key: 'Voltage', register: '30009', dataType: 'UINT16', scale: 0.1 };

const importFile = (content: string) => {
  const input = screen.getByLabelText('Import keys file');
  fireEvent.change(input, { target: { files: [new File([content], 'ModbusTCPReader_keys.json', { type: 'application/json' })] } });
};
const keyInputs = () => screen.queryAllByRole('textbox', { name: /^Key, row \d+$/ }) as HTMLInputElement[];

const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const optionTexts = (name: string) => Array.from(select(name).options).map((o) => o.textContent);
const shownText = (name: string) => select(name).selectedOptions[0]?.textContent;

/** The draft row a "+ Add key" opens (2026-11-03): typed and tested, in no map until Add. */
const openDraft = () => fireEvent.click(screen.getByRole('button', { name: '+ Add key' }));
const addButton = () => screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
const draftTest = () => screen.getByRole('button', { name: 'Test new key' }) as HTMLButtonElement;
/** A whole FLOAT32 key: key, register and the byte order a two-register type needs. */
const fillDraft = (key: string, register: string) => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Key, new key' }), { target: { value: key } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Register, new key' }), { target: { value: register } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Byte order, new key' }), { target: { value: 'ABCD' } });
};

beforeEach(() => {
  changes.length = 0;
  swrKeys.length = 0;
  get.mockReset();
  post.mockReset();
});

describe('RegisterMapEditor — the rows', () => {
  it('edit: Key, Register, Quantity, Data type, Byte order, Scale — what a register reads and Judged as are captions, not columns (fix round 1: it fits)', () => {
    render(<Harness initial={[ROW_T]} />);
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Key', 'Register', 'Quantity', 'Data type', 'Byte order', 'Scale', 'Actions']);
  });

  it('read view: the same columns plus Judged as — and no Unit column', () => {
    render(<Harness initial={[ROW_T]} readOnly />);
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Key', 'Register', 'Quantity', 'Data type', 'Byte order', 'Scale', 'Judged as']);
  });

  it('the read view breaks a long key after its underscores, never mid-word', () => {
    const key = 'Differential_Pressure_Corridor_to_Room_12';
    render(<Harness initial={[{ ...ROW_T, key }]} readOnly />);
    const cell = screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === key && el.querySelector('wbr') !== null);
    expect(cell.querySelectorAll('wbr')).toHaveLength(5);
    expect(cell.className.split(/\s+/)).not.toContain('[overflow-wrap:anywhere]');
    expect(Array.from(cell.children).map((c) => c.textContent)).toEqual(['Differential_', 'Pressure_', 'Corridor_', 'to_', 'Room_', '12']);
  });

  it('the selects carry their own width — a cell\'s min-width is ignored by Chrome', () => {
    // Render check 2026-11-02: at a 1240 px window with the sidebar open the
    // Data type select was squeezed to "FLOAT3" while its CELL said min-w.
    // The Byte order select sizes to its longest NAME ("Little-endian, byte
    // swap (CDAB)") — `w-auto` replacing the primitive's `w-full`.
    render(<Harness initial={[ROW_T]} />);
    const classes = (name: string) => screen.getByRole('combobox', { name }).className.split(/\s+/);
    expect(classes('Data type, row 1')).toContain('min-w-[7rem]');
    expect(classes('Byte order, row 1')).toContain('w-auto');
    expect(classes('Byte order, row 1')).not.toContain('w-full');
    expect(classes('Quantity, row 1')).toContain('w-16');
  });

  it('under the Register: the area and the references read — two registers "40001–40002", one register "30009"', () => {
    render(<Harness initial={[ROW_T, ROW_V]} />);
    expect(screen.getByTestId('map-reads-0')).toHaveTextContent(/^Holding · 40001–40002$/);
    expect(screen.getByTestId('map-reads-1')).toHaveTextContent(/^Input · 30009$/);
    // A caption in the Register cell, beside its input — not a column of its own.
    expect(screen.getByTestId('map-reads-0').closest('td')).toContainElement(screen.getByRole('textbox', { name: 'Register, row 1' }));
  });

  it('the caption keeps the 6-digit form the reference was typed in', () => {
    render(<Harness initial={[{ ...ROW_T, register: '400001' }, { ...ROW_V, register: '300010' }]} />);
    expect(screen.getByTestId('map-reads-0')).toHaveTextContent(/^Holding · 400001–400002$/);
    expect(screen.getByTestId('map-reads-1')).toHaveTextContent(/^Input · 300010$/);
  });

  it('a two-register key at the very end of its area: no bogus range, and the schema says why', () => {
    render(<Harness initial={[{ ...ROW_T, register: '49999' }]} />);
    expect(screen.getByTestId('map-reads-0')).toHaveTextContent(/^Holding · —$/);
    expect(screen.getByTestId('map-reads-0')).not.toHaveTextContent('50000');
    expect(screen.getByTestId('map-errors-0')).toHaveTextContent('runs past the end of the register area');
  });

  it('a reference that is not a register: the caption is "—" and the schema message is under the row', () => {
    render(<Harness initial={[{ ...ROW_T, register: '00001' }]} />);
    expect(screen.getByTestId('map-reads-0')).toHaveTextContent(/^—$/);
    expect(screen.getByTestId('map-errors-0')).toHaveTextContent('Register "00001" must be a holding');
  });

  it('offers a byte order only for two registers, each by its name — the value stays the code', () => {
    render(<Harness initial={[ROW_T, ROW_V]} />);
    expect(select('Byte order, row 1')).toHaveValue('ABCD');
    expect(shownText('Byte order, row 1')).toBe('Big-endian (ABCD)');
    expect(optionTexts('Byte order, row 1')).toEqual([
      'Choose…', 'Big-endian (ABCD)', 'Big-endian, byte swap (BADC)', 'Little-endian, byte swap (CDAB)', 'Little-endian (DCBA)',
    ]);
    expect(screen.queryByRole('combobox', { name: 'Byte order, row 2' })).not.toBeInTheDocument();
    fireEvent.change(select('Byte order, row 1'), { target: { value: 'CDAB' } });
    expect(changes.at(-1)![0]!.byteOrder).toBe('CDAB');
  });

  it('another two-register type keeps the byte order already chosen', () => {
    render(<Harness initial={[ROW_T]} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Data type, row 1' }), { target: { value: 'INT32' } });
    expect(changes.at(-1)![0]).toEqual({ ...ROW_T, dataType: 'INT32' });
  });

  it('one register → two: the byte order is left for the operator to choose, and the schema says so', () => {
    render(<Harness initial={[ROW_V]} />);
    fireEvent.change(select('Quantity, row 1'), { target: { value: '2' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Data type, row 1' }), { target: { value: 'FLOAT32' } });
    expect(changes.at(-1)![0]!.dataType).toBe('FLOAT32');
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

  it('a key added from the draft is a row like any other; Remove takes one out', () => {
    // No test target here, so Add takes a valid draft untested (2026-11-03).
    render(<Harness initial={[ROW_T]} />);
    openDraft();
    expect(keyInputs()).toHaveLength(1);
    fillDraft('Pressure', '40005');
    fireEvent.click(addButton());
    expect(keyInputs()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove row 1' }));
    expect(keyInputs().map((i) => i.value)).toEqual(['Pressure']);
  });
});

describe('RegisterMapEditor — Quantity (CR-1, Ruling CR1-1)', () => {
  it('is 2 for a 32-bit type and 1 for a 16-bit one, and limits the data types offered to it', () => {
    render(<Harness initial={[ROW_T, ROW_V]} />);
    expect(select('Quantity, row 1')).toHaveValue('2');
    expect(select('Quantity, row 2')).toHaveValue('1');
    expect(optionTexts('Data type, row 1')).toEqual(['UINT32', 'INT32', 'FLOAT32']);
    expect(optionTexts('Data type, row 2')).toEqual(['UINT16', 'INT16']);
  });

  it('a new key\'s draft is FLOAT32 — Quantity 2 — with its byte order left to choose', () => {
    render(<Harness />);
    openDraft();
    expect(select('Quantity, new key')).toHaveValue('2');
    expect(select('Data type, new key')).toHaveValue('FLOAT32');
    expect(select('Byte order, new key')).toHaveValue('');
    expect(changes).toHaveLength(0);
  });

  it('the draft\'s Quantity follows the rows\' rule: changing it clears the type, choosing one makes it whole', () => {
    render(<Harness />);
    openDraft();
    fireEvent.change(select('Quantity, new key'), { target: { value: '1' } });
    expect(select('Data type, new key')).toHaveValue('');
    expect(optionTexts('Data type, new key')).toEqual(['Choose…', 'UINT16', 'INT16']);
    expect(screen.queryByRole('combobox', { name: 'Byte order, new key' })).not.toBeInTheDocument();
    fireEvent.change(select('Data type, new key'), { target: { value: 'INT16' } });
    expect(select('Quantity, new key')).toHaveValue('1');
    expect(changes).toHaveLength(0);
  });

  it('changing Quantity 2 → 1 CLEARS the data type and drops the byte order: "Choose…", the schema\'s message, nothing guessed', () => {
    render(<Harness initial={[ROW_T]} />);
    fireEvent.change(select('Quantity, row 1'), { target: { value: '1' } });
    const row = changes.at(-1)![0]!;
    expect(row.dataType).toBe('');
    expect(row).not.toHaveProperty('byteOrder');
    expect(row.key).toBe('Temperature');
    expect(row.register).toBe('40001');
    // The chosen quantity survives while the type is unset.
    expect(select('Quantity, row 1')).toHaveValue('1');
    expect(select('Data type, row 1')).toHaveValue('');
    expect(optionTexts('Data type, row 1')).toEqual(['Choose…', 'UINT16', 'INT16']);
    expect(screen.getByTestId('map-byte-order-0')).toHaveTextContent('—');
    expect(screen.queryByRole('combobox', { name: 'Byte order, row 1' })).not.toBeInTheDocument();
    expect(screen.getByTestId('map-reads-0')).toHaveTextContent(/^Holding · 40001$/);
    expect(screen.getByTestId('map-errors-0')).toHaveTextContent('Data type must be one of');
  });

  it('changing Quantity 1 → 2 clears the type too and leaves the byte order to choose', () => {
    render(<Harness initial={[ROW_V]} />);
    fireEvent.change(select('Quantity, row 1'), { target: { value: '2' } });
    expect(changes.at(-1)![0]!.dataType).toBe('');
    expect(select('Quantity, row 1')).toHaveValue('2');
    expect(optionTexts('Data type, row 1')).toEqual(['Choose…', 'UINT32', 'INT32', 'FLOAT32']);
    expect(select('Byte order, row 1')).toHaveValue('');
    expect(screen.getByTestId('map-reads-0')).toHaveTextContent(/^Input · 30009–30010$/);
    expect(screen.getByTestId('map-errors-0')).toHaveTextContent('Data type must be one of');
  });

  it('choosing a type after the clear makes the row whole again', () => {
    render(<Harness initial={[ROW_T]} />);
    fireEvent.change(select('Quantity, row 1'), { target: { value: '1' } });
    fireEvent.change(select('Data type, row 1'), { target: { value: 'INT16' } });
    expect(changes.at(-1)![0]).toEqual({ key: 'Temperature', register: '40001', dataType: 'INT16', scale: 1 });
    expect(select('Quantity, row 1')).toHaveValue('1');
    expect(screen.queryByTestId('map-errors-0')).not.toBeInTheDocument();
  });

  it('the same Quantity again changes nothing', () => {
    render(<Harness initial={[ROW_T]} />);
    fireEvent.change(select('Quantity, row 1'), { target: { value: '2' } });
    expect(changes).toHaveLength(0);
  });

  it('a removed row takes its Quantity with it — the row after it keeps its own', () => {
    render(<Harness initial={[ROW_V, ROW_T]} />);
    fireEvent.change(select('Quantity, row 1'), { target: { value: '2' } }); // row 1 cleared at 2
    fireEvent.change(select('Quantity, row 2'), { target: { value: '1' } }); // row 2 cleared at 1
    fireEvent.click(screen.getByRole('button', { name: 'Remove row 1' }));
    expect(keyInputs().map((i) => i.value)).toEqual(['Temperature']);
    expect(select('Quantity, row 1')).toHaveValue('1');
  });

  it('an imported map replaces the rows: no Quantity chosen for an old row follows its index', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Harness initial={[ROW_T]} />);
    fireEvent.change(select('Quantity, row 1'), { target: { value: '1' } });
    importFile(JSON.stringify(SIX_KEYS));
    await waitFor(() => expect(keyInputs()).toHaveLength(6));
    expect(select('Quantity, row 1')).toHaveValue('2');
    expect(select('Data type, row 1')).toHaveValue('FLOAT32');
    expect(select('Quantity, row 5')).toHaveValue('1');
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });
});

describe('RegisterMapEditor — per-key Test (CR-1, Rulings CR1-2 / CR1-5)', () => {
  const ANSWER = (value: unknown, judgedAs: 'TEMPERATURE' | 'HUMIDITY' | null) =>
    ({ ok: true, elapsedMs: 12, requests: 1, values: [{ key: 'Temperature', value, judgedAs }], rejected: [] });
  const testKey = (n: number) => fireEvent.click(screen.getByRole('button', { name: `Test key, row ${n}` }));

  it('sends the SAME route with a ONE-key map and the target\'s Slave ID', async () => {
    post.mockResolvedValue(ANSWER(22.4, 'TEMPERATURE'));
    render(<Harness initial={[ROW_T, ROW_V]} testTarget={{ ...TARGET, instrumentId: 'i-9' }} />);
    testKey(2);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/api/instruments/modbus/test', {
      profileId: 't-1', modbusHost: '192.168.1.24', modbusPort: 502, modbusUnitId: 7,
      modbusRegisters: [ROW_V], instrumentId: 'i-9',
    });
  });

  it('prints the value read and the server\'s judgement on a line under the row — not as the row\'s Judged as', async () => {
    post.mockResolvedValue(ANSWER(22.4, 'TEMPERATURE'));
    render(<Harness initial={[ROW_T, ROW_V]} testTarget={TARGET} />);
    testKey(1);
    expect(await screen.findByTestId('map-test-0')).toHaveTextContent('Read now: 22.4 · judged as Temperature');
    expect(screen.queryByTestId('map-test-1')).not.toBeInTheDocument();
    // The per-key answer does not write the judgement (Ruling CR1-5): no caption under the Key.
    expect(screen.queryByTestId('map-judged-0')).not.toBeInTheDocument();
  });

  it('a key the server did not judge prints its value alone', async () => {
    post.mockResolvedValue(ANSWER(101.7, null));
    render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    testKey(1);
    const line = await screen.findByTestId('map-test-0');
    expect(line).toHaveTextContent('Read now: 101.7');
    expect(line).not.toHaveTextContent('judged');
  });

  it('a key the device could not decode: "Not readable — " and the server\'s reason', async () => {
    post.mockResolvedValue({ ok: true, elapsedMs: 9, requests: 1, values: [], rejected: [{ key: 'Temperature', reason: 'Temperature decoded to NaN from 7FC0 0000' }] });
    render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    testKey(1);
    expect(await screen.findByTestId('map-test-0')).toHaveTextContent('Not readable — Temperature decoded to NaN from 7FC0 0000');
  });

  it('a device that did not answer: the pill word and the server\'s sentence, verbatim', async () => {
    const message = '192.168.1.24 : 502 did not answer within 3 s — check the IP, the cable, and that the device is on.';
    post.mockResolvedValue({ ok: false, code: 'NO_ANSWER', message });
    render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    testKey(1);
    const line = await screen.findByTestId('map-test-0');
    expect(line).toHaveTextContent('No answer');
    expect(line).toHaveTextContent(message);
  });

  it('a 429 (30 tests a minute) has its own pill word and prints the server\'s sentence', async () => {
    post.mockRejectedValue(Object.assign(new Error('Rate limit exceeded, retry in 59 seconds'), { status: 429, code: 'TOO_MANY_REQUESTS' }));
    render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    testKey(1);
    const line = await screen.findByTestId('map-test-0');
    expect(line).toHaveTextContent('Too many tests');
    expect(line).toHaveTextContent('Rate limit exceeded, retry in 59 seconds');
  });

  it('a refused request (400) prints its message under the row', async () => {
    post.mockRejectedValue(Object.assign(new Error('192.168.1.24 is outside the device networks this server may read.'), { status: 400, code: 'ADDRESS_NOT_ALLOWED' }));
    render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    testKey(1);
    const line = await screen.findByTestId('map-test-0');
    expect(line).toHaveTextContent('Not allowed');
    expect(line).toHaveTextContent('outside the device networks');
  });

  it('the answer is dropped when its row changes', async () => {
    post.mockResolvedValue(ANSWER(22.4, 'TEMPERATURE'));
    render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    testKey(1);
    await screen.findByTestId('map-test-0');
    fireEvent.change(select('Byte order, row 1'), { target: { value: 'DCBA' } });
    expect(screen.queryByTestId('map-test-0')).not.toBeInTheDocument();
  });

  it('a dropped answer does not come back when the row is put back as it was', async () => {
    // Scale is edited in place (the row keeps its key order), so putting it
    // back makes the SAME request again — the answer must still be gone.
    post.mockResolvedValue(ANSWER(22.4, 'TEMPERATURE'));
    render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    testKey(1);
    await screen.findByTestId('map-test-0');
    const scale = screen.getByRole('spinbutton', { name: 'Scale, row 1' });
    fireEvent.change(scale, { target: { value: '2' } });
    expect(screen.queryByTestId('map-test-0')).not.toBeInTheDocument();
    fireEvent.change(scale, { target: { value: '1' } });
    expect(changes.at(-1)![0]).toEqual(ROW_T);
    expect(screen.queryByTestId('map-test-0')).not.toBeInTheDocument();
  });

  it('the answer is dropped when the target changes (another Slave ID)', async () => {
    post.mockResolvedValue(ANSWER(22.4, 'TEMPERATURE'));
    const { rerender } = render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    testKey(1);
    await screen.findByTestId('map-test-0');
    rerender(<Harness initial={[ROW_T]} testTarget={{ ...TARGET, unitId: 8 }} />);
    expect(screen.queryByTestId('map-test-0')).not.toBeInTheDocument();
  });

  it('an answer that arrives after its row changed is not shown', async () => {
    let resolve!: (v: unknown) => void;
    post.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    testKey(1);
    fireEvent.change(screen.getByRole('textbox', { name: 'Key, row 1' }), { target: { value: 'Temp' } });
    resolve(ANSWER(22.4, 'TEMPERATURE'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('map-test-0')).not.toBeInTheDocument();
  });

  it('is disabled, saying why, while the target is incomplete', () => {
    const cases: Array<[Partial<Target>, string]> = [
      [{ host: '' }, 'Set the IP address to test.'],
      [{ port: Number.NaN }, 'Set a port from 1 to 65535 to test.'],
      [{ port: 70000 }, 'Set a port from 1 to 65535 to test.'],
      [{ unitId: Number.NaN }, 'Set a Slave ID from 0 to 255 to test.'],
      [{ unitId: 256 }, 'Set a Slave ID from 0 to 255 to test.'],
    ];
    for (const [over, why] of cases) {
      const { unmount } = render(<Harness initial={[ROW_T]} testTarget={{ ...TARGET, ...over }} />);
      const button = screen.getByRole('button', { name: 'Test key, row 1' });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', why);
      unmount();
    }
  });

  it('is disabled for a row the schema refuses — a cleared data type included', () => {
    render(<Harness initial={[ROW_T, { ...ROW_V, key: '' }]} testTarget={TARGET} />);
    expect(screen.getByRole('button', { name: 'Test key, row 1' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Test key, row 2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test key, row 2' })).toHaveAttribute('title', 'Fix this row first — see the message under it.');
    fireEvent.change(select('Quantity, row 1'), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Test key, row 1' })).toBeDisabled();
  });

  it('no target, no Test buttons', () => {
    render(<Harness initial={[ROW_T]} />);
    expect(screen.queryByRole('button', { name: /^Test key/ })).not.toBeInTheDocument();
  });

  it('read-only rows still have Test (and nothing else to press)', async () => {
    post.mockResolvedValue(ANSWER(22.4, 'TEMPERATURE'));
    render(<Harness initial={[ROW_T, ROW_V]} readOnly testTarget={TARGET} />);
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Test key, row 1', 'Test key, row 2']);
    testKey(1);
    expect(await screen.findByTestId('map-test-0')).toHaveTextContent('Read now: 22.4');
  });
});

describe('RegisterMapEditor — a key is tested before it is added (2026-11-03)', () => {
  // Operator: "when key was adding at that time give a test option before
  // adding the key; once test is completed value was coming then user will
  // add that key". "+ Add key" opens a DRAFT row (in no map); Add is enabled
  // once the draft's own Test brought a value back.
  const PRESSURE: ModbusRegisterMap[number] = { key: 'Pressure', register: '40005', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 };
  const VALUE = (value: unknown) => ({ ok: true, elapsedMs: 11, requests: 1, values: [{ key: 'Pressure', value, judgedAs: null }], rejected: [] });
  const UNTESTED = 'Test the key first — Add is enabled once a value comes back.';
  const draftKey = () => screen.queryByRole('textbox', { name: 'Key, new key' }) as HTMLInputElement | null;
  /** N one-register keys, 40001 on, no two overlapping. */
  const KEYS = (n: number): ModbusRegisterMap =>
    Array.from({ length: n }, (_, i) => ({ key: `K${i + 1}`, register: String(40001 + i), dataType: 'UINT16', scale: 1 }));
  const testDraftOk = async (value = 101.3) => {
    post.mockResolvedValue(VALUE(value));
    fireEvent.click(draftTest());
    expect(await screen.findByTestId('map-test-draft')).toHaveTextContent(`Read now: ${value}`);
  };

  it('+ Add key opens ONE draft row under the map — the map is untouched (no onChange)', () => {
    render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    openDraft();
    expect(changes).toHaveLength(0);
    expect(keyInputs()).toHaveLength(1);
    expect(draftKey()).toHaveValue('');
    expect(draftKey()).toHaveFocus();
    // One draft at a time.
    expect(screen.getByRole('button', { name: '+ Add key' })).toBeDisabled();
    // The draft's Test, Add and Cancel; the map's row keeps its Test and Remove.
    expect(draftTest()).toBeInTheDocument();
    expect(addButton()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel new key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test key, row 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove row 1' })).toBeInTheDocument();
  });

  it('on an empty map the draft stands where "No keys" was', () => {
    render(<Harness testTarget={TARGET} />);
    expect(screen.getByText('No keys')).toBeInTheDocument();
    openDraft();
    expect(screen.queryByText('No keys')).not.toBeInTheDocument();
  });

  it('Add is disabled before any test; Test waits for a valid draft, the schema\'s message under it', () => {
    render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    openDraft();
    expect(screen.getByTestId('map-errors-draft')).toHaveTextContent('Key is required');
    expect(draftTest()).toBeDisabled();
    expect(draftTest()).toHaveAttribute('title', 'Fix this row first — see the message under it.');
    expect(addButton()).toBeDisabled();
    fillDraft('Pressure', '40005');
    expect(screen.queryByTestId('map-errors-draft')).not.toBeInTheDocument();
    expect(draftTest()).toBeEnabled();
    expect(draftTest()).toHaveAttribute('title', 'Read this key from the device now — nothing is stored.');
    // Valid is not enough: nothing has been read yet.
    expect(addButton()).toBeDisabled();
    expect(addButton()).toHaveAttribute('title', UNTESTED);
    expect(addButton().parentElement).toHaveAttribute('title', UNTESTED);
    // A target to test against: no "added untested" note.
    expect(screen.queryByTestId('map-note-draft')).not.toBeInTheDocument();
  });

  it('Test waits for the target too, saying what is missing', () => {
    render(<Harness initial={[ROW_T]} testTarget={{ ...TARGET, host: '' }} />);
    openDraft();
    fillDraft('Pressure', '40005');
    expect(draftTest()).toBeDisabled();
    expect(draftTest()).toHaveAttribute('title', 'Set the IP address to test.');
    expect(addButton()).toBeDisabled();
  });

  it('a value came back: Add appends the draft to the map, and the value stays under the new row', async () => {
    render(<Harness initial={[ROW_T]} testTarget={{ ...TARGET, instrumentId: 'i-9' }} />);
    openDraft();
    fillDraft('Pressure', '40005');
    await testDraftOk(101.3);
    // The same route as a row's Test, with the DRAFT as the one-key map.
    expect(post).toHaveBeenCalledWith('/api/instruments/modbus/test', {
      profileId: 't-1', modbusHost: '192.168.1.24', modbusPort: 502, modbusUnitId: 7,
      modbusRegisters: [PRESSURE], instrumentId: 'i-9',
    });
    expect(changes).toHaveLength(0);
    expect(addButton()).toBeEnabled();
    expect(addButton()).toHaveAttribute('title', 'Add this key to the register map.');
    fireEvent.click(addButton());
    expect(changes).toEqual([[ROW_T, PRESSURE]]);
    expect(keyInputs().map((i) => i.value)).toEqual(['Temperature', 'Pressure']);
    expect(screen.getByTestId('map-test-1')).toHaveTextContent('Read now: 101.3');
    expect(screen.queryByTestId('map-test-0')).not.toBeInTheDocument();
    // The draft is gone, and another can be opened.
    expect(draftKey()).toBeNull();
    expect(screen.queryByTestId('map-test-draft')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add key' })).toBeEnabled();
    // Add read nothing again.
    expect(post).toHaveBeenCalledTimes(1);
    // From here it is a row like any other: change it and its answer goes.
    fireEvent.change(select('Byte order, row 2'), { target: { value: 'DCBA' } });
    expect(screen.queryByTestId('map-test-1')).not.toBeInTheDocument();
  });

  it.each([
    ['a refused request (400)', 'Not allowed', () => post.mockRejectedValue(Object.assign(
      new Error('192.168.1.24 is outside the device networks this server may read.'), { status: 400, code: 'ADDRESS_NOT_ALLOWED' }))],
    ['a device that did not answer', 'No answer', () => post.mockResolvedValue(
      { ok: false, code: 'NO_ANSWER', message: '192.168.1.24 : 502 did not answer within 3 s.' })],
    ['reading switched off on this server', 'Reading off', () => post.mockResolvedValue(
      { ok: false, code: 'READING_OFF', message: 'Reading devices from this server is off.' })],
    ['an answer with no value ("Not readable")', 'Not readable', () => post.mockResolvedValue(
      { ok: true, elapsedMs: 9, requests: 1, values: [], rejected: [{ key: 'Pressure', reason: 'Pressure decoded to NaN from 7FC0 0000' }] })],
  ])('%s: the answer is printed under the draft and Add stays disabled', async (_name, word, arrange) => {
    arrange();
    render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    openDraft();
    fillDraft('Pressure', '40005');
    fireEvent.click(draftTest());
    expect(await screen.findByTestId('map-test-draft')).toHaveTextContent(word);
    expect(addButton()).toBeDisabled();
    expect(addButton()).toHaveAttribute('title', UNTESTED);
  });

  it('editing the draft after a test drops the answer and disables Add — putting it back brings neither back', async () => {
    render(<Harness testTarget={TARGET} />);
    openDraft();
    fillDraft('Pressure', '40005');
    await testDraftOk();
    expect(addButton()).toBeEnabled();
    const scale = screen.getByRole('spinbutton', { name: 'Scale, new key' });
    fireEvent.change(scale, { target: { value: '2' } });
    expect(screen.queryByTestId('map-test-draft')).not.toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    fireEvent.change(scale, { target: { value: '1' } });
    expect(screen.queryByTestId('map-test-draft')).not.toBeInTheDocument();
    expect(addButton()).toBeDisabled();
  });

  it('another target (Slave ID) drops the draft\'s answer and disables Add — the old target back brings neither back', async () => {
    const { rerender } = render(<Harness testTarget={TARGET} />);
    openDraft();
    fillDraft('Pressure', '40005');
    await testDraftOk();
    rerender(<Harness testTarget={{ ...TARGET, unitId: 8 }} />);
    expect(screen.queryByTestId('map-test-draft')).not.toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    rerender(<Harness testTarget={TARGET} />);
    expect(screen.queryByTestId('map-test-draft')).not.toBeInTheDocument();
    expect(addButton()).toBeDisabled();
  });

  it('an answer that arrives after the draft changed is dropped — putting the draft back does not bring it (or Add) back', async () => {
    let resolve!: (v: unknown) => void;
    post.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<Harness testTarget={TARGET} />);
    openDraft();
    fillDraft('Pressure', '40005');
    fireEvent.click(draftTest());
    fireEvent.change(draftKey()!, { target: { value: 'Pressure2' } });
    resolve(VALUE(101.3));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('map-test-draft')).not.toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    // The rows' rule: an answer for a request no longer on screen is gone.
    fireEvent.change(draftKey()!, { target: { value: 'Pressure' } });
    expect(screen.queryByTestId('map-test-draft')).not.toBeInTheDocument();
    expect(addButton()).toBeDisabled();
  });

  it('with no test target, Add takes a valid draft untested — and says so', () => {
    render(<Harness initial={[ROW_T]} />);
    openDraft();
    expect(screen.queryByRole('button', { name: 'Test new key' })).not.toBeInTheDocument();
    expect(screen.getByTestId('map-note-draft')).toHaveTextContent(/^Test is not available here — the key is added untested\.$/);
    expect(addButton()).toBeDisabled();
    fillDraft('Pressure', '40005');
    expect(addButton()).toBeEnabled();
    fireEvent.click(addButton());
    expect(changes).toEqual([[ROW_T, PRESSURE]]);
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByTestId('map-note-draft')).not.toBeInTheDocument();
  });

  it('Cancel discards the draft and its answer; the map is untouched and the next draft starts blank', async () => {
    render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    openDraft();
    fillDraft('Pressure', '40005');
    await testDraftOk();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel new key' }));
    expect(draftKey()).toBeNull();
    expect(screen.queryByTestId('map-test-draft')).not.toBeInTheDocument();
    expect(changes).toHaveLength(0);
    openDraft();
    expect(draftKey()).toHaveValue('');
    expect(screen.queryByTestId('map-test-draft')).not.toBeInTheDocument();
    expect(addButton()).toBeDisabled();
  });

  it('an answer for a cancelled draft is dropped, even when the next draft is typed the same', async () => {
    let resolve!: (v: unknown) => void;
    post.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<Harness testTarget={TARGET} />);
    openDraft();
    fillDraft('Pressure', '40005');
    fireEvent.click(draftTest());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel new key' }));
    openDraft();
    fillDraft('Pressure', '40005');
    resolve(VALUE(101.3));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('map-test-draft')).not.toBeInTheDocument();
    expect(addButton()).toBeDisabled();
  });

  it('leaving edit discards the draft — the instrument page keeps this editor mounted between its views', async () => {
    const { rerender } = render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    openDraft();
    fillDraft('Pressure', '40005');
    await testDraftOk();
    rerender(<Harness initial={[ROW_T]} testTarget={TARGET} readOnly />);
    expect(draftKey()).toBeNull();
    rerender(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    expect(draftKey()).toBeNull();
    expect(screen.queryByTestId('map-test-draft')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add key' })).toBeEnabled();
    expect(changes).toHaveLength(0);
  });

  it('the draft is judged as the map\'s NEXT row: a key another row has is named, and nothing can be tested or added', () => {
    render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    openDraft();
    fillDraft('temperature', '40005');
    expect(screen.getByTestId('map-errors-draft')).toHaveTextContent('Key "temperature" is already used by row 1');
    expect(draftTest()).toBeDisabled();
    expect(addButton()).toBeDisabled();
  });

  it('a tested draft that a row edit turns into a duplicate cannot be added', async () => {
    render(<Harness initial={[ROW_T]} testTarget={TARGET} />);
    openDraft();
    fillDraft('Pressure', '40005');
    await testDraftOk();
    expect(addButton()).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Key, row 1' }), { target: { value: 'Pressure' } });
    expect(screen.getByTestId('map-errors-draft')).toHaveTextContent('Key "Pressure" is already used by row 1');
    expect(addButton()).toBeDisabled();
  });

  it(`a map of ${MODBUS_MAX_KEYS} keys opens no draft`, () => {
    render(<Harness initial={KEYS(MODBUS_MAX_KEYS)} />);
    expect(screen.getByRole('button', { name: '+ Add key' })).toBeDisabled();
  });

  it('the cap applies to Add: a map that filled up while the draft was open refuses it', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Harness initial={KEYS(MODBUS_MAX_KEYS - 1)} />);
    openDraft();
    fillDraft('Extra', '40201');
    expect(addButton()).toBeEnabled();
    importFile(JSON.stringify({
      keys: KEYS(MODBUS_MAX_KEYS).map((k) => ({ key: k.key, register: k.register, data_type: 'UINT16', byte_order: 'ABCD' })),
    }));
    await waitFor(() => expect(keyInputs()).toHaveLength(MODBUS_MAX_KEYS));
    expect(addButton()).toBeDisabled();
    expect(addButton()).toHaveAttribute('title', `The register map already holds ${MODBUS_MAX_KEYS} keys, the most it can.`);
    fireEvent.click(addButton());
    expect(changes.at(-1)).toHaveLength(MODBUS_MAX_KEYS);
    confirm.mockRestore();
  });
});

describe('RegisterMapEditor — Judged as is the server\'s answer', () => {
  it('read view: "—" for every row, a Temperature key included, until a response is passed in', () => {
    render(<Harness initial={[ROW_T, ROW_V]} readOnly />);
    expect(screen.getByTestId('map-judged-0')).toHaveTextContent('—');
    expect(screen.getByTestId('map-judged-1')).toHaveTextContent('—');
  });

  it('read view: what the response said, and "Not judged" for a key it did not judge', () => {
    // The response — not the key's name — decides: a key named "Voltage"
    // reported as judged reads as judged, a key named "Temperature" reported
    // as not judged reads "Not judged".
    render(<Harness initial={[ROW_T, ROW_V]} judged={{ Temperature: null, Voltage: 'HUMIDITY' }} readOnly />);
    expect(screen.getByTestId('map-judged-0')).toHaveTextContent('Not judged');
    expect(screen.getByTestId('map-judged-1')).toHaveTextContent('Humidity');
  });

  it('read view: a key the response did not cover stays "—"', () => {
    render(<Harness initial={[ROW_T, ROW_V]} judged={{ Temperature: 'TEMPERATURE' }} readOnly />);
    expect(screen.getByTestId('map-judged-0')).toHaveTextContent('Temperature');
    expect(screen.getByTestId('map-judged-1')).toHaveTextContent('—');
  });

  it('edit: no caption until a response, a Temperature key included', () => {
    render(<Harness initial={[ROW_T, ROW_V]} />);
    expect(screen.queryByTestId('map-judged-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('map-judged-1')).not.toBeInTheDocument();
  });

  it('edit: "Judged as …" under the Key exactly when the response judged it — the response decides, not the name', () => {
    render(<Harness initial={[ROW_T, ROW_V]} judged={{ Temperature: null, Voltage: 'HUMIDITY' }} />);
    expect(screen.queryByTestId('map-judged-0')).not.toBeInTheDocument();
    expect(screen.getByTestId('map-judged-1')).toHaveTextContent(/^Judged as Humidity$/);
    expect(screen.getByTestId('map-judged-1').closest('td')).toContainElement(screen.getByRole('textbox', { name: 'Key, row 2' }));
  });

  it('edit: the lookup trims the key as the server does', () => {
    render(<Harness initial={[{ ...ROW_T, key: ' Temperature ' }]} judged={{ Temperature: 'TEMPERATURE' }} />);
    expect(screen.getByTestId('map-judged-0')).toHaveTextContent(/^Judged as Temperature$/);
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
    expect(screen.getByTestId('map-reads-1')).toHaveTextContent(/^Input · 30009$/);
  });

  it('prints the Quantity, and the byte order by its name', () => {
    render(<Harness initial={[ROW_T, { ...ROW_T, key: 'Humidity', register: '40003', byteOrder: 'CDAB' }, ROW_V]} readOnly />);
    expect(screen.getByTestId('map-quantity-0')).toHaveTextContent(/^2$/);
    expect(screen.getByTestId('map-quantity-2')).toHaveTextContent(/^1$/);
    expect(screen.getByTestId('map-byte-order-0')).toHaveTextContent(/^Big-endian \(ABCD\)$/);
    expect(screen.getByTestId('map-byte-order-1')).toHaveTextContent(/^Little-endian, byte swap \(CDAB\)$/);
    expect(screen.getByTestId('map-byte-order-2')).toHaveTextContent(/^—$/);
  });
});
