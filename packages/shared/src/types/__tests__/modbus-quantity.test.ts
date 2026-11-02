import { describe, it, expect } from 'vitest';
import {
  MODBUS_BYTE_ORDERS, MODBUS_BYTE_ORDER_LABELS, MODBUS_DATA_TYPES, MODBUS_QUANTITY_TYPES,
  registerRange, registersFor,
} from '../modbus.js';

/**
 * Change request CR-1 (2026-11-02): the register map editor names each byte
 * order, offers a Quantity (1 or 2 registers) that limits the data types, and
 * shows the range of references each key reads. The vocabulary for all three
 * lives here so the editor, its read-only view and any later surface say the
 * same thing. (A file of its own: `modbus.test.ts` is being changed by CR-1's
 * server half at the same time.)
 */

describe('MODBUS_BYTE_ORDER_LABELS', () => {
  it('names every byte order the Modbus Poll way (ledger Ruling CR1-4)', () => {
    expect(MODBUS_BYTE_ORDER_LABELS).toEqual({
      ABCD: 'Big-endian (ABCD)',
      DCBA: 'Little-endian (DCBA)',
      BADC: 'Big-endian, byte swap (BADC)',
      CDAB: 'Little-endian, byte swap (CDAB)',
    });
  });

  it('has a label for every code, and nothing else', () => {
    expect(Object.keys(MODBUS_BYTE_ORDER_LABELS).sort()).toEqual([...MODBUS_BYTE_ORDERS].sort());
  });
});

describe('MODBUS_QUANTITY_TYPES', () => {
  it('1 register: UINT16, INT16 — 2 registers: UINT32, INT32, FLOAT32', () => {
    expect(MODBUS_QUANTITY_TYPES[1]).toEqual(['UINT16', 'INT16']);
    expect(MODBUS_QUANTITY_TYPES[2]).toEqual(['UINT32', 'INT32', 'FLOAT32']);
  });

  it('every data type is under exactly the quantity registersFor gives it', () => {
    for (const t of MODBUS_DATA_TYPES) {
      const q = registersFor(t);
      expect(MODBUS_QUANTITY_TYPES[q]).toContain(t);
      expect(MODBUS_QUANTITY_TYPES[q === 1 ? 2 : 1]).not.toContain(t);
    }
  });
});

describe('registerRange', () => {
  it('a two-register type reads its reference and the next — 5 digits stay 5', () => {
    expect(registerRange('40001', 'FLOAT32')).toEqual({ first: '40001', last: '40002' });
    expect(registerRange('30009', 'INT32')).toEqual({ first: '30009', last: '30010' });
    expect(registerRange('40099', 'UINT32')).toEqual({ first: '40099', last: '40100' });
  });

  it('6 digits stay 6, leading zeros kept', () => {
    expect(registerRange('400001', 'FLOAT32')).toEqual({ first: '400001', last: '400002' });
    expect(registerRange('309999', 'UINT32')).toEqual({ first: '309999', last: '310000' });
    expect(registerRange('465535', 'FLOAT32')).toEqual({ first: '465535', last: '465536' });
  });

  it('a one-register type reads only its own reference', () => {
    expect(registerRange('400001', 'UINT16')).toEqual({ first: '400001', last: '400001' });
    expect(registerRange('40010', 'INT16')).toEqual({ first: '40010', last: '40010' });
  });

  it('a reference that does not parse has no range', () => {
    for (const bad of ['', '00001', '10001', '4000', '40000', '4000001', '465537', 'abc', ' 40001']) {
      expect(registerRange(bad, 'FLOAT32')).toBeNull();
    }
  });

  it('a span running past its area\'s end has no range — never a bogus "49999–50000"', () => {
    expect(registerRange('49999', 'FLOAT32')).toBeNull();
    expect(registerRange('465536', 'UINT32')).toBeNull();
    // …while one register at the very end is a real range.
    expect(registerRange('49999', 'UINT16')).toEqual({ first: '49999', last: '49999' });
    expect(registerRange('465536', 'INT16')).toEqual({ first: '465536', last: '465536' });
  });
});
