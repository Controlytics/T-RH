import { describe, it, expect } from 'vitest';
import {
  MODBUS_CONNECTIONS, MODBUS_INTERVAL, MODBUS_UNIT_ID, MODBUS_PORT_DEFAULT, MODBUS_MAX_KEYS,
  MODBUS_MAX_REGISTERS_PER_REQUEST, DEVICE_NETWORKS_DEFAULT, PAYLOAD_META_KEYS,
  parseModiconRef, registersFor, modbusRegisterMapSchema, coerceModbusRegisterMap,
  modbusHostSchema, parseDeviceNetworks, ipInNetworks, fromDesktopKeysFile,
} from '../modbus.js';
import { effectiveExpectedIntervalSec } from '../../schemas/config.js';
import { createInstrumentProfileSchema, updateInstrumentProfileSchema } from '../../schemas/instrument-profiles.js';
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
  it('resolves', () => {
    expect(effectiveExpectedIntervalSec({ expectedIntervalSec: null }, { connection: 'MODBUS_TCP', modbusIntervalSec: 60 })).toBe(60);
    expect(effectiveExpectedIntervalSec({ expectedIntervalSec: 300 }, { connection: 'MODBUS_TCP', modbusIntervalSec: 60 })).toBe(300);
    expect(effectiveExpectedIntervalSec({ expectedIntervalSec: null }, { connection: 'PUSH', modbusIntervalSec: null })).toBeNull();
    expect(effectiveExpectedIntervalSec({ expectedIntervalSec: 120 }, { connection: 'PUSH', modbusIntervalSec: null })).toBe(120);
  });
});

describe('profile schemas', () => {
  it('a MODBUS_TCP create defaults interval 60 and unit 1', () => {
    const r = createInstrumentProfileSchema.parse({ name: 'P', connection: 'MODBUS_TCP' });
    expect(r.modbusIntervalSec).toBe(60);
    expect(r.modbusUnitId).toBe(1);
  });
  it('a PUSH create carries neither field and refuses them', () => {
    const r = createInstrumentProfileSchema.parse({ name: 'P' });
    expect(r.modbusIntervalSec ?? null).toBeNull();
    expect(createInstrumentProfileSchema.safeParse({ name: 'P', connection: 'PUSH', modbusIntervalSec: 60 }).success).toBe(false);
    expect(createInstrumentProfileSchema.safeParse({ name: 'P', modbusUnitId: 1 }).success).toBe(false);
    expect(createInstrumentProfileSchema.safeParse({ name: 'P', connection: 'PUSH', modbusIntervalSec: null, modbusUnitId: null }).success).toBe(true);
  });
  it('bounds', () => {
    for (const modbusIntervalSec of [9, 3601, 1.5]) {
      expect(createInstrumentProfileSchema.safeParse({ name: 'P', connection: 'MODBUS_TCP', modbusIntervalSec }).success).toBe(false);
    }
    for (const modbusUnitId of [-1, 256]) {
      expect(createInstrumentProfileSchema.safeParse({ name: 'P', connection: 'MODBUS_TCP', modbusUnitId }).success).toBe(false);
    }
    expect(createInstrumentProfileSchema.safeParse({ name: 'P', connection: 'MODBUS_TCP', modbusIntervalSec: 10, modbusUnitId: 0 }).success).toBe(true);
    expect(createInstrumentProfileSchema.safeParse({ name: 'P', connection: 'SMOKE' }).success).toBe(false);
  });
  it('update accepts the fields', () => {
    expect(updateInstrumentProfileSchema.safeParse({ modbusIntervalSec: 30, modbusUnitId: 2 }).success).toBe(true);
    expect(updateInstrumentProfileSchema.safeParse({ modbusIntervalSec: 5 }).success).toBe(false);
    expect(updateInstrumentProfileSchema.safeParse({ connection: 'PUSH', modbusIntervalSec: 30 }).success).toBe(false);
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
  it('bulk takes copyRegisterMapFrom uuid', () => {
    const b = { csv: 'a', profileId: base.profileId };
    expect(bulkCreateInstrumentsSchema.safeParse({ ...b, copyRegisterMapFrom: base.profileId }).success).toBe(true);
    expect(bulkCreateInstrumentsSchema.safeParse({ ...b, copyRegisterMapFrom: 'x' }).success).toBe(false);
  });
});
