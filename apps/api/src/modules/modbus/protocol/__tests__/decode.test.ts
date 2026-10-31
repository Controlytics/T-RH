import { describe, it, expect } from 'vitest';
import type { ModbusByteOrder, ModbusDataType, ModbusRegisterMap } from '@digilog/shared';
import { decodeMap } from '../decode.js';

function one(dataType: ModbusDataType, words: number[], byteOrder?: ModbusByteOrder, scale = 1, key = 'v') {
  const map: ModbusRegisterMap = [{ key, register: '40001', dataType, ...(byteOrder ? { byteOrder } : {}), scale }];
  const w = new Map<string, number>();
  words.forEach((x, i) => w.set(`HOLDING:${i}`, x));
  return decodeMap(map, w);
}

describe('decodeMap', () => {
  it.each([
    ['ABCD', [0x41b3, 0x3333]],
    ['CDAB', [0x3333, 0x41b3]],
    ['BADC', [0xb341, 0x3333]],
    ['DCBA', [0x3333, 0xb341]],
  ] as const)('FLOAT32 %s decodes 22.4', (order, words) => {
    const r = one('FLOAT32', [...words], order);
    expect(r.rejected).toEqual([]);
    expect(r.values.v).toBe(22.4);
  });

  it('rounds a scaled UINT16 to the decimals of the scale (230.1, not 230.10000000000002)', () => {
    expect(one('UINT16', [2301], undefined, 0.1).values.v).toBe(230.1);
  });

  it('leaves an unscaled integer an integer and reads INT16 as signed', () => {
    expect(one('UINT16', [2301]).values.v).toBe(2301);
    expect(one('INT16', [0xffff]).values.v).toBe(-1);
    expect(one('INT16', [0x7fff]).values.v).toBe(32767);
  });

  it('decodes UINT32 and INT32 in two byte orders', () => {
    expect(one('UINT32', [0x0001, 0x0002], 'ABCD').values.v).toBe(0x00010002);
    expect(one('UINT32', [0x0002, 0x0001], 'CDAB').values.v).toBe(0x00010002);
    expect(one('UINT32', [0xffff, 0xffff], 'ABCD').values.v).toBe(4294967295);
    expect(one('INT32', [0xffff, 0xffff], 'ABCD').values.v).toBe(-1);
    expect(one('INT32', [0xffff, 0xfffe], 'CDAB').values.v).toBe(-65537);
    expect(one('INT32', [0xffff, 0xfffe], 'ABCD').values.v).toBe(-2);
  });

  it('rejects FLOAT32 NaN and infinity instead of storing them', () => {
    const nan = one('FLOAT32', [0x7fc0, 0x0000], 'ABCD');
    expect(nan.values).not.toHaveProperty('v');
    expect(nan.rejected).toHaveLength(1);
    expect(nan.rejected[0]!.key).toBe('v');
    expect(nan.rejected[0]!.reason).toMatch(/not a number/i);
    expect(nan.rejected[0]!.reason).toContain('words 0x7FC0 0x0000');
    const inf = one('FLOAT32', [0x7f80, 0x0000], 'ABCD');
    expect(inf.values).not.toHaveProperty('v');
    expect(inf.rejected[0]!.reason).toMatch(/infinite/i);
    expect(inf.rejected[0]!.reason).toContain('words 0x7F80 0x0000');
    // CDAB: the words as received are 0x0000 0x7F80 — the reason prints them as received.
    expect(one('FLOAT32', [0x0000, 0x7f80], 'CDAB').rejected[0]!.reason).toContain('words 0x0000 0x7F80');
    // finite float32 whose scaled value overflows to Infinity
    const ovf = one('FLOAT32', [0x7f7f, 0xffff], 'ABCD', 1e300);
    expect(ovf.values).not.toHaveProperty('v');
    expect(ovf.rejected[0]!.reason).toMatch(/scaled value is infinite, words 0x7F7F 0xFFFF/);
  });

  it('rounds FLOAT32 22.399999618 to 7 significant digits', () => {
    // 0x41B33333 is the nearest float32 to 22.4 = 22.3999996185...
    expect(one('FLOAT32', [0x41b3, 0x3333], 'ABCD').values.v).toBe(22.4);
    expect(one('FLOAT32', [0x41b3, 0x3333], 'ABCD', 10).values.v).toBe(224);
  });

  it('rejects a key whose register was not returned', () => {
    const map: ModbusRegisterMap = [{ key: 'gone', register: '40001', dataType: 'UINT16', scale: 1 }];
    const r = decodeMap(map, new Map());
    expect(r.values).not.toHaveProperty('gone');
    expect(r.rejected).toEqual([{ key: 'gone', reason: expect.stringMatching(/not (returned|read)/i) }]);
  });

  it('reads input registers from the INPUT area', () => {
    const map: ModbusRegisterMap = [{ key: 'in', register: '30001', dataType: 'UINT16', scale: 1 }];
    expect(decodeMap(map, new Map([['INPUT:0', 7]])).values.in).toBe(7);
  });

  it('is immune to a key named __proto__ (own data property, no pollution)', () => {
    const r = one('UINT16', [5], undefined, 1, '__proto__');
    expect(Object.getPrototypeOf(r.values)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(r.values, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(r.values, '__proto__')!.value).toBe(5);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(Object.keys(Object.prototype)).toEqual([]);
    const c = one('UINT16', [6], undefined, 1, 'constructor');
    expect(c.values.constructor).toBe(6);
  });
});
