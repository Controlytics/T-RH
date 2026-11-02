import { describe, it, expect } from 'vitest';
import {
  MODBUS_CONNECTIONS, MODBUS_INTERVAL, MODBUS_UNIT_ID, MODBUS_PORT_DEFAULT, MODBUS_MAX_KEYS,
  MODBUS_MAX_REGISTERS_PER_REQUEST, DEVICE_NETWORKS_DEFAULT, PAYLOAD_META_KEYS,
  parseModiconRef, registersFor, modbusRegisterMapSchema, coerceModbusRegisterMap,
  modbusHostSchema, parseDeviceNetworks, ipInNetworks, fromDesktopKeysFile,
  modbusUnitIdSchema, modbusIntervalSchema, MODBUS_UNIT_ID_MESSAGE, MODBUS_INTERVAL_MESSAGE,
  isModbusReadInterval, BULK_TCPIP_HEADINGS,
} from '../modbus.js';
import { effectiveExpectedIntervalSec } from '../../schemas/config.js';
import {
  createInstrumentProfileSchema, updateInstrumentProfileSchema, PROFILE_READING_MOVED_MESSAGE,
} from '../../schemas/instrument-profiles.js';
import { createInstrumentSchema, updateInstrumentSchema, bulkCreateInstrumentsSchema } from '../../schemas/instruments.js';

const SIX_KEYS = [
  { key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Humidity', register: '40003', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Pressure', register: '40005', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Power', register: '40007', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Voltage', register: '40009', dataType: 'UINT16', scale: 1 },
  { key: 'Switch', register: '40010', dataType: 'INT16', scale: 1 },
];
const reg = (o: Record<string, unknown>) => ({ key: 'k', register: '40001', dataType: 'UINT16', scale: 1, ...o });

describe('constants', () => {
  it('match the spec', () => {
    expect(MODBUS_CONNECTIONS).toEqual(['PUSH', 'MODBUS_TCP']);
    expect(MODBUS_INTERVAL).toEqual({ min: 10, max: 3600, default: 60 });
    expect(MODBUS_UNIT_ID).toEqual({ min: 0, max: 255, default: 1 });
    expect(MODBUS_PORT_DEFAULT).toBe(502);
    expect(MODBUS_MAX_KEYS).toBe(100);
    expect(MODBUS_MAX_REGISTERS_PER_REQUEST).toBe(125);
    expect([...PAYLOAD_META_KEYS].sort()).toEqual(['devices', 'quality', 'timestamp', 'ts']);
    expect(DEVICE_NETWORKS_DEFAULT).toBe('10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16');
  });
});

describe('parseModiconRef', () => {
  it('reads holding and input references', () => {
    expect(parseModiconRef('40001')).toEqual({ area: 'HOLDING', address: 0 });
    expect(parseModiconRef('40003')).toEqual({ area: 'HOLDING', address: 2 });
    expect(parseModiconRef('30001')).toEqual({ area: 'INPUT', address: 0 });
    expect(parseModiconRef('465536')).toEqual({ area: 'HOLDING', address: 65535 });
  });
  it.each(['00001', '10001', '40000', '4001', '465537', 'abc', ''])('refuses %j naming it', (r) => {
    expect(() => parseModiconRef(r)).toThrow(Error);
    expect(() => parseModiconRef(r)).toThrow(JSON.stringify(r).slice(1, -1) || 'register');
  });
  it('registersFor', () => {
    expect(registersFor('UINT16')).toBe(1);
    expect(registersFor('INT16')).toBe(1);
    expect(registersFor('UINT32')).toBe(2);
    expect(registersFor('INT32')).toBe(2);
    expect(registersFor('FLOAT32')).toBe(2);
  });
});

describe('modbusRegisterMapSchema', () => {
  it('accepts the six-key map', () => {
    expect(modbusRegisterMapSchema.safeParse(SIX_KEYS).success).toBe(true);
  });
  it('defaults scale to 1 and trims the key', () => {
    const r = modbusRegisterMapSchema.parse([{ key: '  T ', register: '40001', dataType: 'UINT16' }]);
    expect(r[0]).toMatchObject({ key: 'T', scale: 1 });
  });
  it.each<[string, unknown[]]>([
    ['duplicate key ignoring case', [reg({ key: 'Temperature' }), reg({ key: 'temperature', register: '40002' })]],
    ['reserved ts', [reg({ key: 'ts' })]],
    ['reserved quality', [reg({ key: 'quality' })]],
    ['reserved timestamp', [reg({ key: 'Timestamp' })]],
    ['reserved devN', [reg({ key: 'dev3' })]],
    ['65-char key', [reg({ key: 'a'.repeat(65) })]],
    ['empty key', [reg({ key: '  ' })]],
    ['FLOAT32 overlapping UINT16', [reg({ key: 'a', dataType: 'FLOAT32', byteOrder: 'ABCD' }), reg({ key: 'b', register: '40002' })]],
    ['UINT16 inside a later 32-bit', [reg({ key: 'b', register: '40002' }), reg({ key: 'a', dataType: 'INT32', byteOrder: 'ABCD' })]],
    ['FLOAT32 at 49999 runs past the area', [reg({ register: '49999', dataType: 'FLOAT32', byteOrder: 'ABCD' })]],
    ['FLOAT32 at 465536 runs past the area', [reg({ register: '465536', dataType: 'FLOAT32', byteOrder: 'ABCD' })]],
    ['FLOAT32 without byteOrder', [reg({ dataType: 'FLOAT32' })]],
    ['INT16 with byteOrder', [reg({ dataType: 'INT16', byteOrder: 'ABCD' })]],
    ['scale 0', [reg({ scale: 0 })]],
    ['scale NaN', [reg({ scale: Number.NaN })]],
    ['coil reference', [reg({ register: '00001' })]],
    ['unknown data type', [reg({ dataType: 'FLOAT64' })]],
  ])('refuses %s', (_n, map) => {
    expect(modbusRegisterMapSchema.safeParse(map).success).toBe(false);
  });
  it('same address in different areas is not an overlap', () => {
    expect(modbusRegisterMapSchema.safeParse([reg({ key: 'a', register: '30001' }), reg({ key: 'b', register: '40001' })]).success).toBe(true);
  });
  it('accepts a 32-bit at 49998 and at 465535', () => {
    expect(modbusRegisterMapSchema.safeParse([reg({ register: '49998', dataType: 'FLOAT32', byteOrder: 'ABCD' })]).success).toBe(true);
    expect(modbusRegisterMapSchema.safeParse([reg({ register: '465535', dataType: 'UINT32', byteOrder: 'CDAB' })]).success).toBe(true);
  });
  it('refuses 101 keys, accepts 100', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => reg({ key: `k${i}x`, register: String(40001 + i) }));
    expect(modbusRegisterMapSchema.safeParse(mk(100)).success).toBe(true);
    expect(modbusRegisterMapSchema.safeParse(mk(101)).success).toBe(false);
  });
  it('coerceModbusRegisterMap returns [] for anything invalid', () => {
    expect(coerceModbusRegisterMap(SIX_KEYS)).toHaveLength(6);
    expect(coerceModbusRegisterMap('x')).toEqual([]);
    expect(coerceModbusRegisterMap(null)).toEqual([]);
    expect(coerceModbusRegisterMap([reg({ key: 'ts' })])).toEqual([]);
  });
});

describe('modbusHostSchema', () => {
  it.each(['127.0.0.1', '169.254.169.254', '0.1.2.3', '224.0.0.1', '240.0.0.1', '255.255.255.255', 'host.local', '192.168.1.256', '192.168.1', '010.0.0.1', ' 10.0.0.5'])('refuses %j', (h) => {
    expect(modbusHostSchema.safeParse(h).success).toBe(false);
  });
  it.each(['192.168.1.24', '10.0.0.5', '8.8.8.8'])('accepts %j', (h) => {
    expect(modbusHostSchema.safeParse(h).success).toBe(true);
  });
});

describe('device networks', () => {
  it('parses comma and newline lists', () => {
    expect(parseDeviceNetworks('192.168.1.0/24,\n10.0.0.0/8')).toEqual({ cidrs: ['192.168.1.0/24', '10.0.0.0/8'], errors: [] });
    expect(parseDeviceNetworks(DEVICE_NETWORKS_DEFAULT).cidrs).toHaveLength(3);
  });
  it('reports bad entries, naming them', () => {
    const r = parseDeviceNetworks('192.168.1.0/33, 10.0.0.0/8, nope, 1.2.3/8');
    expect(r.cidrs).toEqual(['10.0.0.0/8']);
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toContain('192.168.1.0/33');
  });
  it('ipInNetworks', () => {
    expect(ipInNetworks('192.168.1.24', ['192.168.1.0/24'])).toBe(true);
    expect(ipInNetworks('192.168.2.1', ['192.168.1.0/24'])).toBe(false);
    expect(ipInNetworks('172.31.255.255', ['172.16.0.0/12'])).toBe(true);
    expect(ipInNetworks('172.32.0.0', ['172.16.0.0/12'])).toBe(false);
    expect(ipInNetworks('1.2.3.4', [])).toBe(false);
    expect(ipInNetworks('1.2.3.4', ['0.0.0.0/0'])).toBe(true);
  });
});

describe('fromDesktopKeysFile', () => {
  const file = (keys: unknown[]) => ({ keys });
  const six = [
    { key: 'Temperature', register: '40001', data_type: 'FLOAT32', byte_order: 'ABCD' },
    { key: 'Humidity', register: '40003', data_type: 'FLOAT32', byte_order: 'ABCD' },
    { key: 'Pressure', register: '40005', data_type: 'FLOAT32', byte_order: 'ABCD' },
    { key: 'Power', register: '40007', data_type: 'FLOAT32', byte_order: 'ABCD' },
    { key: 'Voltage', register: '40009', data_type: 'UINT16', byte_order: 'ABCD' },
    { key: 'Switch', register: '40010', data_type: 'INT16', byte_order: 'ABCD' },
  ];
  it('takes the six-key shape and drops byte_order for 16-bit', () => {
    const r = fromDesktopKeysFile(file(six));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.map).toHaveLength(6);
    expect(r.map[0]).toEqual({ key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 });
    expect(r.map[4]).toEqual({ key: 'Voltage', register: '40009', dataType: 'UINT16', scale: 1 });
    expect('byteOrder' in r.map[5]!).toBe(false);
  });
  it.each<[string, Record<string, unknown>, number]>([
    ['coil register', { register: '00001' }, 2],
    ['discrete register', { register: '10001' }, 2],
    ['unknown data type', { data_type: 'FLOAT64' }, 2],
    ['FLOAT32 missing byte_order', { byte_order: undefined }, 2],
  ])('refuses %s naming the row', (_n, patch, row) => {
    const keys = [six[0], { key: 'X', register: '40003', data_type: 'FLOAT32', byte_order: 'ABCD', ...patch }];
    const r = fromDesktopKeysFile(file(keys));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes(`Row ${row}`))).toBe(true);
    expect('map' in r).toBe(false);
  });
  it('refuses a duplicate key naming the row', () => {
    const r = fromDesktopKeysFile(file([six[0], { ...six[1], key: 'temperature' }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('Row 2');
  });
  it('refuses non-files', () => {
    for (const bad of [null, 'x', {}, { keys: 'a' }, { keys: [] }, { keys: [5] }]) {
      expect(fromDesktopKeysFile(bad).ok).toBe(false);
    }
  });
});

describe('effectiveExpectedIntervalSec', () => {
  // CR-1 (2026-11-02): the read interval is the INSTRUMENT's; the profile is
  // asked only for its connection. 45 is no default, so a hard-coded 60 fails.
  it('a TCP/IP instrument with no own expected interval is expected at its OWN read interval', () => {
    expect(effectiveExpectedIntervalSec({ expectedIntervalSec: null, modbusIntervalSec: 45 }, { connection: 'MODBUS_TCP' })).toBe(45);
  });
  it('the instrument\'s own expected interval wins', () => {
    expect(effectiveExpectedIntervalSec({ expectedIntervalSec: 300, modbusIntervalSec: 45 }, { connection: 'MODBUS_TCP' })).toBe(300);
    expect(effectiveExpectedIntervalSec({ expectedIntervalSec: 120, modbusIntervalSec: null }, { connection: 'PUSH' })).toBe(120);
  });
  it('a Gateway instrument with no expected interval is exempt, whatever a read-interval column holds', () => {
    expect(effectiveExpectedIntervalSec({ expectedIntervalSec: null, modbusIntervalSec: null }, { connection: 'PUSH' })).toBeNull();
    expect(effectiveExpectedIntervalSec({ expectedIntervalSec: null, modbusIntervalSec: 45 }, { connection: 'PUSH' })).toBeNull();
  });
  it('a TCP/IP instrument with no read interval stored (a hand-edited row) is exempt, never 0 or a default', () => {
    expect(effectiveExpectedIntervalSec({ expectedIntervalSec: null, modbusIntervalSec: null }, { connection: 'MODBUS_TCP' })).toBeNull();
  });
  it('a stored read interval the Reader refuses (hand-edited 5 s or 5000 s) is no expectation — the site window decides, as for "not read" (review M4)', () => {
    for (const modbusIntervalSec of [5, 9, 3601, 5000, 0, -60, 30.5]) {
      expect(effectiveExpectedIntervalSec({ expectedIntervalSec: null, modbusIntervalSec }, { connection: 'MODBUS_TCP' }), String(modbusIntervalSec)).toBeNull();
    }
    // The bounds themselves are read, so they are expected.
    expect(effectiveExpectedIntervalSec({ expectedIntervalSec: null, modbusIntervalSec: 10 }, { connection: 'MODBUS_TCP' })).toBe(10);
    expect(effectiveExpectedIntervalSec({ expectedIntervalSec: null, modbusIntervalSec: 3600 }, { connection: 'MODBUS_TCP' })).toBe(3600);
    // The instrument's own expected interval still wins, as the brief wrote it.
    expect(effectiveExpectedIntervalSec({ expectedIntervalSec: 300, modbusIntervalSec: 5000 }, { connection: 'MODBUS_TCP' })).toBe(300);
  });
  it('isModbusReadInterval is the one test of a stored interval (the Reader, the status route and this resolver ask it)', () => {
    for (const ok of [10, 60, 3600]) expect(isModbusReadInterval(ok), String(ok)).toBe(true);
    for (const bad of [9, 3601, 5000, 30.5, null, undefined, '60', NaN]) expect(isModbusReadInterval(bad), String(bad)).toBe(false);
  });
});

describe('BULK_TCPIP_HEADINGS (review M7)', () => {
  it('is the ONE spelling of the bulk TCP/IP columns the template prints and the parser reads', () => {
    expect(BULK_TCPIP_HEADINGS).toEqual({ host: 'IP address', port: 'Port', unitId: 'Slave ID', interval: 'Read every' });
  });
});

describe('profile schemas — the profile only chooses Gateway or TCP/IP (CR-1)', () => {
  it('a MODBUS_TCP create carries no Slave ID and no read interval', () => {
    const r = createInstrumentProfileSchema.parse({ name: 'P', connection: 'MODBUS_TCP' });
    expect(r).toEqual({ name: 'P', connection: 'MODBUS_TCP', isActive: true });
  });
  it('a body still carrying either old field is REFUSED on that field, by name — any value, null included', () => {
    for (const schema of [createInstrumentProfileSchema, updateInstrumentProfileSchema]) {
      for (const connection of ['MODBUS_TCP', 'PUSH', undefined]) {
        for (const [field, value] of [['modbusIntervalSec', 60], ['modbusUnitId', 1], ['modbusIntervalSec', null], ['modbusUnitId', null]] as const) {
          const r = schema.safeParse({ name: 'P', ...(connection ? { connection } : {}), [field]: value });
          expect(r.success, `${field}=${value} on ${connection}`).toBe(false);
          if (!r.success) expect(r.error.flatten().fieldErrors[field]).toEqual([PROFILE_READING_MOVED_MESSAGE]);
        }
      }
    }
  });
  it('a connection is still validated', () => {
    expect(createInstrumentProfileSchema.safeParse({ name: 'P', connection: 'SMOKE' }).success).toBe(false);
    expect(updateInstrumentProfileSchema.safeParse({ connection: 'PUSH' }).success).toBe(true);
  });
});

describe('instrument schemas', () => {
  const base = { name: 'n', code: 'c', profileId: '11111111-1111-4111-8111-111111111111' };
  it('create takes host, port, registers', () => {
    const r = createInstrumentSchema.parse({ ...base, modbusHost: '192.168.1.24', modbusPort: 502, modbusRegisters: SIX_KEYS });
    expect(r.modbusRegisters).toHaveLength(6);
  });
  it('refuses a hostname, a bad port, a bad map', () => {
    expect(createInstrumentSchema.safeParse({ ...base, modbusHost: 'plc.local' }).success).toBe(false);
    expect(createInstrumentSchema.safeParse({ ...base, modbusPort: 0 }).success).toBe(false);
    expect(createInstrumentSchema.safeParse({ ...base, modbusPort: 65536 }).success).toBe(false);
    expect(createInstrumentSchema.safeParse({ ...base, modbusRegisters: [reg({ key: 'ts' })] }).success).toBe(false);
  });
  it('update takes the fields (null clears) and a reason', () => {
    expect(updateInstrumentSchema.safeParse({ modbusHost: null, modbusPort: null, modbusRegisters: null, reason: 'moved' }).success).toBe(true);
    expect(updateInstrumentSchema.safeParse({ modbusHost: '10.0.0.5', modbusPort: 1502 }).success).toBe(true);
    expect(updateInstrumentSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
  });
  it('Slave ID (0..255) and read interval (10..3600 s) are the INSTRUMENT\'s, on create and update (CR-1)', () => {
    for (const schema of [createInstrumentSchema, updateInstrumentSchema]) {
      const ok = schema.safeParse({ ...base, modbusUnitId: 7, modbusIntervalSec: 45 });
      expect(ok.success).toBe(true);
      if (ok.success) expect([ok.data.modbusUnitId, ok.data.modbusIntervalSec]).toEqual([7, 45]);
      for (const modbusUnitId of [0, 255, null]) expect(schema.safeParse({ ...base, modbusUnitId }).success, String(modbusUnitId)).toBe(true);
      for (const modbusIntervalSec of [10, 3600, null]) expect(schema.safeParse({ ...base, modbusIntervalSec }).success, String(modbusIntervalSec)).toBe(true);
      for (const modbusUnitId of [-1, 256, 1.5, '7']) {
        const r = schema.safeParse({ ...base, modbusUnitId });
        expect(r.success, String(modbusUnitId)).toBe(false);
        if (!r.success) expect(r.error.flatten().fieldErrors.modbusUnitId).toEqual([MODBUS_UNIT_ID_MESSAGE]);
      }
      for (const modbusIntervalSec of [9, 3601, 1.5, '60']) {
        const r = schema.safeParse({ ...base, modbusIntervalSec });
        expect(r.success, String(modbusIntervalSec)).toBe(false);
        if (!r.success) expect(r.error.flatten().fieldErrors.modbusIntervalSec).toEqual([MODBUS_INTERVAL_MESSAGE]);
      }
    }
  });
  it('the field schemas say the range in one sentence each', () => {
    expect(MODBUS_UNIT_ID_MESSAGE).toBe('Slave ID must be a whole number from 0 to 255.');
    expect(MODBUS_INTERVAL_MESSAGE).toBe('Read every must be a whole number of seconds from 10 to 3600.');
    expect(modbusUnitIdSchema.safeParse(7).success).toBe(true);
    expect(modbusIntervalSchema.safeParse(45).success).toBe(true);
  });
  it('bulk takes copyRegisterMapFrom uuid', () => {
    const b = { csv: 'a', profileId: base.profileId };
    expect(bulkCreateInstrumentsSchema.safeParse({ ...b, copyRegisterMapFrom: base.profileId }).success).toBe(true);
    expect(bulkCreateInstrumentsSchema.safeParse({ ...b, copyRegisterMapFrom: 'x' }).success).toBe(false);
  });
});
