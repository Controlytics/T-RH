import { describe, it, expect } from 'vitest';
import { RuleDebugWriter, toDebugRow, DEBUG_DATA_MAX_CHARS, type RuleDebugRow } from '../debug.js';
import { newMessage } from '../message.js';

/**
 * The batched debug writer (spec §6): O(1) record that snapshots the message
 * at once, a write every flush interval or at the batch size, a bounded
 * buffer, and a failed write that drops its rows without throwing.
 */
const CHAIN = '0f000000-0000-4000-8000-0000000000aa';
const NODE = '0f000000-0000-4000-8000-0000000000bb';

const event = (i: number, data: unknown = { i }) => ({
  chainId: CHAIN, nodeId: NODE, direction: 'IN' as const, relation: null,
  msg: newMessage('POST_TELEMETRY_REQUEST', { type: 'INSTRUMENT', id: 'inst' }, data, { n: i }),
});

function recordingInsert() {
  const batches: RuleDebugRow[][] = [];
  return { batches, insert: async (rows: readonly RuleDebugRow[]) => { batches.push([...rows]); return rows.length; } };
}

describe('toDebugRow', () => {
  it('snapshots the message NOW: a later change to it does not reach the row', () => {
    const e = event(1, { t: 1 });
    const row = toDebugRow(e);
    (e.msg.data as { t: number }).t = 99;
    e.msg.metadata.n = 'changed';
    expect(JSON.parse(row.data)).toEqual({ t: 1 });
    expect(JSON.parse(row.metadata)).toEqual({ n: '1' });
  });

  it('a huge message is stored as a truncated preview; long strings are clipped to their columns', () => {
    const big = { blob: 'x'.repeat(DEBUG_DATA_MAX_CHARS + 10) };
    const row = toDebugRow({ ...event(1, big), relation: 'R'.repeat(300) });
    const data = JSON.parse(row.data);
    expect(data._truncated).toBe(true);
    expect(data.size).toBeGreaterThan(DEBUG_DATA_MAX_CHARS);
    expect(row.relation).toHaveLength(128);
  });

  it('records an OUT error', () => {
    expect(toDebugRow({ ...event(1), direction: 'OUT', relation: 'Failure (unhandled)', error: 'boom' }).error).toBe('boom');
  });
});

describe('RuleDebugWriter', () => {
  it('writes at the batch size without waiting for the timer', async () => {
    const r = recordingInsert();
    const w = new RuleDebugWriter({ insert: r.insert, batchRows: 200, flushMs: 60_000 });
    for (let i = 0; i < 200; i++) w.record(event(i));
    await w.flush();
    expect(r.batches.map((b) => b.length)).toEqual([200]);
    expect(w.written).toBe(200);
  });

  it('writes on the timer (500 ms) below the batch size', async () => {
    const r = recordingInsert();
    const w = new RuleDebugWriter({ insert: r.insert, flushMs: 500 });
    w.start();
    try {
      w.record(event(1));
      w.record(event(2));
      expect(r.batches).toEqual([]);
      await new Promise((res) => setTimeout(res, 650));
      expect(r.batches.map((b) => b.length)).toEqual([2]);
    } finally {
      await w.stop();
    }
  });

  it('a flush of an EMPTY buffer does not wedge the writer: the next record is written', async () => {
    // Regression (found by the e2e, 2026-11-03): the empty flush's body ran synchronously, cleared
    // `flushing` BEFORE it was assigned, and every later flush chained onto itself forever.
    const r = recordingInsert();
    const w = new RuleDebugWriter({ insert: r.insert, flushMs: 60_000 });
    await w.flush();
    w.record(event(1));
    await w.flush();
    w.record(event(2));
    await w.flush();
    expect(r.batches.flat()).toHaveLength(2);
    expect(w.buffered).toBe(0);
  });

  it('records arriving DURING a write are written by the same flush call', async () => {
    let release!: () => void;
    const batches: number[] = [];
    const w = new RuleDebugWriter({
      flushMs: 60_000,
      insert: async (rows) => {
        batches.push(rows.length);
        if (batches.length === 1) await new Promise<void>((res) => { release = res; });
        return rows.length;
      },
    });
    w.record(event(1));
    const first = w.flush();
    await new Promise((res) => setImmediate(res));
    w.record(event(2));
    const second = w.flush();
    release();
    await Promise.all([first, second]);
    expect(batches).toEqual([1, 1]);
    expect(w.buffered).toBe(0);
  });

  it('the per-node cap: a node past maxPerNode since its last trim is trimmed to its newest N, at most once per 10 s', async () => {
    const r = recordingInsert();
    const trims: [string, string, number][] = [];
    let clock = 1_000_000;
    const w = new RuleDebugWriter({
      insert: r.insert, flushMs: 60_000, maxPerNode: 3, now: () => clock,
      trim: async (chainId, nodeId, keep) => { trims.push([chainId, nodeId, keep]); return 1; },
    });
    const OTHER = '0f000000-0000-4000-8000-0000000000cc';
    const at = (nodeId: string, i: number) => ({ ...event(i), nodeId });
    // 4 rows on NODE passes the cap of 3; 2 on OTHER do not.
    for (let i = 0; i < 4; i++) w.record(at(NODE, i));
    for (let i = 0; i < 2; i++) w.record(at(OTHER, i));
    await w.flush();
    expect(trims).toEqual([[CHAIN, NODE, 3]]);
    expect(w.trimmed).toBe(1);
    // 10 s on, the count restarted at the trim: 3 more is NOT past the cap.
    clock += 10_000;
    for (let i = 0; i < 3; i++) w.record(at(NODE, i));
    await w.flush();
    expect(trims).toHaveLength(1);
    // One more is: trimmed again.
    w.record(at(NODE, 3));
    await w.flush();
    expect(trims).toHaveLength(2);
    // Past it again, but inside 10 s of that trim: not yet.
    for (let i = 0; i < 4; i++) w.record(at(NODE, i));
    await w.flush();
    expect(trims).toHaveLength(2);
    // 10 s later the next tick trims it, with nothing new to write.
    clock += 10_000;
    await w.trimDue();
    expect(trims).toEqual([[CHAIN, NODE, 3], [CHAIN, NODE, 3], [CHAIN, NODE, 3]]);
  });

  it('the cap follows configure(); a failing trim is logged, never thrown', async () => {
    const trims: number[] = [];
    const w = new RuleDebugWriter({
      insert: async (rows) => rows.length, flushMs: 60_000, maxPerNode: 100,
      trim: async (_c, _n, keep) => { trims.push(keep); throw new Error('db down'); },
    });
    w.configure({ maxPerNode: 2 });
    for (let i = 0; i < 3; i++) w.record(event(i));
    await expect(w.flush()).resolves.toBeUndefined();
    expect(trims).toEqual([2]);
  });

  it('stop() writes what is left', async () => {
    const r = recordingInsert();
    const w = new RuleDebugWriter({ insert: r.insert, flushMs: 60_000 });
    w.start();
    w.record(event(1));
    await w.stop();
    expect(r.batches.flat()).toHaveLength(1);
  });

  it('a failed write drops its rows, counts them, and never throws', async () => {
    const w = new RuleDebugWriter({ insert: async () => { throw new Error('db down'); }, flushMs: 60_000 });
    w.record(event(1));
    w.record(event(2));
    await expect(w.flush()).resolves.toBeUndefined();
    expect(w.dropped).toBe(2);
    expect(w.buffered).toBe(0);
  });

  it('the buffer is bounded: past it the OLDEST rows go', async () => {
    const r = recordingInsert();
    const w = new RuleDebugWriter({ insert: r.insert, bufferMax: 3, batchRows: 1_000, flushMs: 60_000 });
    for (let i = 1; i <= 5; i++) w.record(event(i));
    expect(w.dropped).toBe(2);
    await w.flush();
    expect(r.batches.flat().map((row) => JSON.parse(row.data).i)).toEqual([3, 4, 5]);
  });
});
