import { describe, it, expect } from 'vitest';
import type { ModbusRegisterMap } from '@digilog/shared';
import { planReads } from '../plan.js';

const u16 = (key: string, register: string) => ({ key, register, dataType: 'UINT16' as const, scale: 1 });

describe('planReads', () => {
  it('turns a six-key map over 40001-40010 into ONE FC 03 request', () => {
    const map: ModbusRegisterMap = [
      { key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
      { key: 'Humidity', register: '40003', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
      { key: 'Pressure', register: '40005', dataType: 'FLOAT32', byteOrder: 'CDAB', scale: 1 },
      u16('Power', '40007'),
      u16('Voltage', '40008'),
      { key: 'Switch', register: '40009', dataType: 'UINT32', byteOrder: 'ABCD', scale: 1 },
    ];
    const reqs = planReads(map);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ functionCode: 3, address: 0, quantity: 10 });
    expect(reqs[0]!.keys).toEqual(['Temperature', 'Humidity', 'Pressure', 'Power', 'Voltage', 'Switch']);
  });

  it('does not bridge a gap that would exceed 125 registers', () => {
    const reqs = planReads([u16('a', '40001'), u16('b', '40200')]);
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ functionCode: 3, address: 0, quantity: 1, keys: ['a'] });
    expect(reqs[1]).toMatchObject({ functionCode: 3, address: 199, quantity: 1, keys: ['b'] });
  });

  it('bridges a gap that stays within the 125 cap', () => {
    const reqs = planReads([u16('a', '40001'), u16('b', '40125')]);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ address: 0, quantity: 125 });
  });

  it('splits input registers (FC 04) from holding registers (FC 03)', () => {
    const reqs = planReads([u16('in', '30001'), u16('hold', '40001')]);
    expect(reqs).toHaveLength(2);
    expect(reqs.map((r) => r.functionCode).sort()).toEqual([3, 4]);
    expect(reqs.find((r) => r.functionCode === 4)!.keys).toEqual(['in']);
    expect(reqs.find((r) => r.functionCode === 3)!.keys).toEqual(['hold']);
  });

  it('splits 130 consecutive UINT16 into 125 + 5', () => {
    const map = Array.from({ length: 130 }, (_, i) => u16(`k${i}`, String(400001 + i)));
    const reqs = planReads(map);
    expect(reqs.map((r) => [r.address, r.quantity])).toEqual([[0, 125], [125, 5]]);
  });

  it('plans a map given out of address order and returns no requests for an empty map', () => {
    const reqs = planReads([u16('b', '40002'), u16('a', '40001')]);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ address: 0, quantity: 2 });
    expect(planReads([])).toEqual([]);
  });

  it('never lets a 32-bit value straddle two requests', () => {
    const map: ModbusRegisterMap = [
      ...Array.from({ length: 124 }, (_, i) => u16(`k${i}`, String(400001 + i))),
      { key: 'wide', register: '400125', dataType: 'UINT32', byteOrder: 'ABCD', scale: 1 },
    ];
    const reqs = planReads(map);
    expect(reqs.map((r) => [r.address, r.quantity])).toEqual([[0, 124], [124, 2]]);
    expect(reqs[1]!.keys).toEqual(['wide']);
  });
});
