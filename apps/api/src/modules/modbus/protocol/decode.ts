import { parseModiconRef, registersFor, type ModbusByteOrder, type ModbusRegisterMap } from '@digilog/shared';
import { wordKey } from './plan.js';

function hex4(w: number): string {
  return `0x${(w & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

export type Rejected = { key: string; reason: string };

/** Fractional digits of a scale: 0.1 -> 1, 0.05 -> 2, 1e-7 -> 7, 10 -> 0. */
function decimalsOf(scale: number): number {
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(Math.abs(scale)));
  if (!m) return 0;
  const frac = m[2]?.length ?? 0;
  const exp = Number(m[3] ?? 0);
  return Math.min(100, Math.max(0, frac - exp));
}

/** The four bytes A B C D (A most significant) of a 32-bit value from the two words as received. */
function bytesFor(order: ModbusByteOrder, w1: number, w2: number): Buffer {
  const b = [w1 >> 8, w1 & 0xff, w2 >> 8, w2 & 0xff];
  switch (order) {
    case 'ABCD': return Buffer.from([b[0]!, b[1]!, b[2]!, b[3]!]);
    case 'BADC': return Buffer.from([b[1]!, b[0]!, b[3]!, b[2]!]);
    case 'CDAB': return Buffer.from([b[2]!, b[3]!, b[0]!, b[1]!]);
    case 'DCBA': return Buffer.from([b[3]!, b[2]!, b[1]!, b[0]!]);
  }
}

/**
 * Decode every key of the map from the register words read (`words`, keyed
 * "HOLDING:<address>" / "INPUT:<address>", 0-based). A value that cannot be
 * stored (NaN, infinity, register not returned) goes to `rejected` with the
 * reason and never into `values`. `values` has no prototype: keys are user
 * input and `__proto__` must be an ordinary key.
 *
 * Rounding: FLOAT32 -> 7 significant digits; scaled integer -> the decimals of
 * the scale (so 2301 x 0.1 is 230.1, not 230.10000000000002); unscaled integer
 * stays an integer.
 */
export function decodeMap(
  map: ModbusRegisterMap,
  words: Map<string, number>,
): { values: Record<string, number>; rejected: Rejected[] } {
  const values: Record<string, number> = Object.create(null);
  const rejected: Rejected[] = [];

  for (const r of map) {
    const { area, address } = parseModiconRef(r.register);
    const n = registersFor(r.dataType);
    const w1 = words.get(wordKey(area, address));
    const w2 = n === 2 ? words.get(wordKey(area, address + 1)) : undefined;
    if (w1 === undefined || (n === 2 && w2 === undefined)) {
      rejected.push({ key: r.key, reason: `register ${r.register} was not returned by the device` });
      continue;
    }

    let raw: number;
    if (r.dataType === 'UINT16') raw = w1 & 0xffff;
    else if (r.dataType === 'INT16') raw = (w1 & 0xffff) >= 0x8000 ? (w1 & 0xffff) - 0x10000 : w1 & 0xffff;
    else {
      const buf = bytesFor(r.byteOrder!, w1 & 0xffff, (w2 as number) & 0xffff);
      raw = r.dataType === 'UINT32' ? buf.readUInt32BE(0) : r.dataType === 'INT32' ? buf.readInt32BE(0) : buf.readFloatBE(0);
    }

    const rawWords = n === 2 ? `${hex4(w1)} ${hex4(w2 as number)}` : hex4(w1);
    if (!Number.isFinite(raw)) {
      rejected.push({ key: r.key, reason: `${Number.isNaN(raw) ? 'the device sent a value that is not a number (NaN)' : 'the device sent an infinite value'}, words ${rawWords}` });
      continue;
    }

    const scaled = r.scale === 1 ? raw : raw * r.scale;
    if (!Number.isFinite(scaled)) {
      rejected.push({ key: r.key, reason: `the scaled value is infinite, words ${rawWords}` });
      continue;
    }
    let v: number;
    if (r.dataType === 'FLOAT32') v = Number(scaled.toPrecision(7));
    else if (r.scale === 1) v = scaled;
    else v = Number(scaled.toFixed(decimalsOf(r.scale)));
    values[r.key] = v === 0 ? 0 : v; // no negative zero
  }
  return { values, rejected };
}
