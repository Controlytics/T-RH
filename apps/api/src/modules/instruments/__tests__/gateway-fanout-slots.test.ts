import { describe, it, expect } from 'vitest';
import { fanoutDevices, type ChildMap } from '../gateway-fanout.js';
import { parsePayload } from '../payload-parser.js';

/**
 * The LIST batch shape (operator, 2026-09-05: "devN is common key for all,
 * value will change"): `{"devices": [ {"devN": "<code>", ...}, ... ]}`, beside
 * the code-keyed shape that still works.
 */
const TS = new Date('2026-09-05T10:00:00.000Z');
const map: ChildMap = new Map([
  ['CWH/RDU/001-00', { id: 'i-1', isActive: true }],
  ['CWH/RDU/002-01', { id: 'i-2', isActive: true }],
]);

describe('parsePayload — the devices LIST', () => {
  it('folds a list onto dev1, dev2, … keeping each block intact', () => {
    const p = parsePayload(Buffer.from(JSON.stringify({
      devices: [
        { devN: 'CWH/RDU/001-00', temperature: 22.5, humidity: 54 },
        { devN: 'CWH/RDU/002-01', temperature: 23, humidity: 43 },
      ],
    })));
    expect(p.ok).toBe(true);
    expect(p.devices).toEqual({
      dev1: { devN: 'CWH/RDU/001-00', temperature: 22.5, humidity: 54 },
      dev2: { devN: 'CWH/RDU/002-01', temperature: 23, humidity: 43 },
    });
    expect(p.values).toEqual({});
  });

  it('still returns the code-keyed object untouched', () => {
    const p = parsePayload(Buffer.from(JSON.stringify({ devices: { 'CWH/RDU/001-00': { temperature: 1 } } })));
    expect(p.devices).toEqual({ 'CWH/RDU/001-00': { temperature: 1 } });
  });
});

describe('fanoutDevices — blocks carrying the code in `devN`', () => {
  it('resolves each slot by its `devN`, and does not store `devN` as a reading', () => {
    const r = fanoutDevices({
      dev1: { devN: 'CWH/RDU/001-00', temperature: 21.5, humidity: 47 },
      dev2: { devN: 'CWH/RDU/002-01', temperature: 22.0 },
    }, map, TS, 'IOTGW01');
    expect(r.rejected).toEqual([]);
    expect(r.readings.map((x) => [x.instrumentId, x.key, x.value])).toEqual([
      ['i-1', 'temperature', 21.5], ['i-1', 'humidity', 47], ['i-2', 'temperature', 22.0],
    ]);
    expect(r.readings.some((x) => x.key === 'devN')).toBe(false);
  });

  it('end to end from the wire: the list form lands per child', () => {
    const p = parsePayload(Buffer.from(JSON.stringify({
      devices: [{ devN: 'CWH/RDU/001-00', temperature: 22.5 }, { devN: 'CWH/RDU/002-01', temperature: 23 }],
    })));
    const r = fanoutDevices(p.devices!, map, TS, 'IOTGW01');
    expect(r.rejected).toEqual([]);
    expect(r.readings.map((x) => [x.instrumentId, x.value])).toEqual([['i-1', 22.5], ['i-2', 23]]);
  });

  it('still accepts the code-keyed shape, unchanged', () => {
    const r = fanoutDevices({ 'CWH/RDU/001-00': { temperature: 21.5 } }, map, TS, 'IOTGW01');
    expect(r.rejected).toEqual([]);
    expect(r.readings.map((x) => x.instrumentId)).toEqual(['i-1']);
  });

  it('applies the same authorisation: a block naming an instrument this gateway does not own is rejected by CODE', () => {
    const r = fanoutDevices({ dev1: { devN: 'CWH/RDU/099-00', temperature: 1 } }, map, TS, 'IOTGW01');
    expect(r.readings).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].code).toBe('CWH/RDU/099-00');
    expect(r.rejected[0].reason).toMatch(/not linked to gateway "IOTGW01"/);
  });

  it('rejects a block whose `devN` is not a string, naming the slot', () => {
    const r = fanoutDevices({ dev1: { devN: 7, temperature: 1 } }, map, TS, 'IOTGW01');
    expect(r.readings).toEqual([]);
    expect(r.rejected).toEqual([{ code: 'dev1', reason: '"dev1": "devN" must be the instrument\'s code as a string' }]);
  });

  it('`devN` wins over the outer key when both are present', () => {
    const r = fanoutDevices({ 'CWH/RDU/001-00': { devN: 'CWH/RDU/002-01', temperature: 5 } }, map, TS, 'IOTGW01');
    expect(r.readings.map((x) => x.instrumentId)).toEqual(['i-2']);
  });

  it('an empty `devN` falls back to the outer key', () => {
    const r = fanoutDevices({ 'CWH/RDU/001-00': { devN: '', temperature: 5 } }, map, TS, 'IOTGW01');
    expect(r.readings.map((x) => x.instrumentId)).toEqual(['i-1']);
  });
});
