import {
  MODBUS_MAX_REGISTERS_PER_REQUEST,
  parseModiconRef,
  registersFor,
  type ModbusRegisterMap,
} from '@digilog/shared';

export type ReadRequest = { functionCode: 3 | 4; address: number; quantity: number; keys: string[] };

/** Key of one register word in the map `decodeMap` reads: "HOLDING:0". */
export function wordKey(area: 'HOLDING' | 'INPUT', address: number): string {
  return `${area}:${address}`;
}

/**
 * Group a register map into the fewest FC 03 / FC 04 requests: per area, sorted
 * by address, neighbouring entries share a request while the request stays
 * within 125 registers (a gap is read through rather than skipped). A 32-bit
 * value is never split across two requests. Areas appear in the order the map
 * first uses them. Throws if a register reference is malformed — the map is
 * validated where it is written, so that is a programming error.
 */
export function planReads(map: ModbusRegisterMap): ReadRequest[] {
  const byArea = new Map<'HOLDING' | 'INPUT', Array<{ start: number; end: number; key: string }>>();
  for (const r of map) {
    const { area, address } = parseModiconRef(r.register);
    const list = byArea.get(area) ?? [];
    list.push({ start: address, end: address + registersFor(r.dataType) - 1, key: r.key });
    byArea.set(area, list);
  }

  const out: ReadRequest[] = [];
  for (const [area, entries] of byArea) {
    entries.sort((a, b) => a.start - b.start);
    const fc = area === 'HOLDING' ? 3 : 4;
    let cur: { start: number; end: number; keys: string[] } | null = null;
    const flush = () => {
      if (cur) out.push({ functionCode: fc, address: cur.start, quantity: cur.end - cur.start + 1, keys: cur.keys });
    };
    for (const e of entries) {
      if (cur && Math.max(cur.end, e.end) - cur.start + 1 <= MODBUS_MAX_REGISTERS_PER_REQUEST) {
        cur.end = Math.max(cur.end, e.end);
        cur.keys.push(e.key);
      } else {
        flush();
        cur = { start: e.start, end: e.end, keys: [e.key] };
      }
    }
    flush();
  }
  return out;
}
