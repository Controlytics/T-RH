import { describe, it, expect } from 'vitest';
import { OriginatorQueue } from '../queue.js';

/**
 * The Main queue (spec §6): FIFO per originator, parallel across originators
 * up to `concurrency`, bounded with drop-the-oldest-of-the-largest-backlog,
 * and `push` never throws.
 */
interface Item { key: string; id: string }
const item = (key: string, n: number): Item => ({ key, id: `${key}${n}` });

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { open, opened };
}

describe('per-originator FIFO', () => {
  it('A1, B1, A2: A1 finishes before A2 starts; B1 runs while A1 is still running', async () => {
    const log: string[] = [];
    const a1 = gate();
    const q = new OriginatorQueue<Item>({
      capacity: 100, concurrency: 8, keyOf: (i) => i.key,
      process: async (i) => {
        log.push(`start ${i.id}`);
        if (i.id === 'A1') await a1.opened;
        log.push(`end ${i.id}`);
      },
    });
    q.push(item('A', 1));
    q.push(item('B', 1));
    q.push(item('A', 2));
    await new Promise((r) => setTimeout(r, 20));
    // A1 is held open: B1 ran and finished, A2 has not started.
    expect(log).toEqual(['start A1', 'start B1', 'end B1']);
    a1.open();
    await q.onIdle();
    expect(log).toEqual(['start A1', 'start B1', 'end B1', 'end A1', 'start A2', 'end A2']);
  });

  it('never runs more than `concurrency` originators at once', async () => {
    let running = 0;
    let peak = 0;
    const q = new OriginatorQueue<Item>({
      capacity: 100, concurrency: 2, keyOf: (i) => i.key,
      process: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
      },
    });
    for (const k of ['A', 'B', 'C', 'D', 'E']) q.push(item(k, 1));
    await q.onIdle();
    expect(peak).toBe(2);
  });
});

describe('capacity', () => {
  it('capacity 5, push 7: 2 dropped — the OLDEST of the LARGEST backlog each time', async () => {
    const processed: string[] = [];
    const dropped: string[] = [];
    const q = new OriginatorQueue<Item>({
      capacity: 5, concurrency: 1, keyOf: (i) => i.key,
      process: async (i) => { processed.push(i.id); },
      onDrop: (i) => dropped.push(i.id),
    });
    // Synchronous burst: nothing is dispatched before the next turn of the loop.
    for (const i of [item('A', 1), item('A', 2), item('A', 3), item('A', 4), item('B', 1), item('B', 2), item('B', 3)]) {
      expect(q.push(i)).toBe(true);
    }
    expect(q.dropped).toBe(2);
    expect(dropped).toEqual(['A1', 'A2']);
    expect(q.size).toBe(5);
    await q.onIdle();
    expect(processed.sort()).toEqual(['A3', 'A4', 'B1', 'B2', 'B3']);
  });

  it('a reconfigured capacity applies to the next push', () => {
    const q = new OriginatorQueue<Item>({ capacity: 10, concurrency: 1, keyOf: (i) => i.key, process: async () => undefined });
    q.configure({ capacity: 2 });
    for (let n = 1; n <= 4; n++) q.push(item('A', n));
    expect(q.dropped).toBe(2);
    q.clear();
  });
});

describe('items the queue may never drop (isDroppable; ruling RE-2)', () => {
  /** Ids with a K are KEPT (a durable resume in the engine). */
  const keptQueue = (capacity: number, processed: string[] = [], dropped: string[] = []) => new OriginatorQueue<Item>({
    capacity, concurrency: 1, keyOf: (i) => i.key,
    isDroppable: (i) => !i.id.includes('K'),
    process: async (i) => { processed.push(i.id); },
    onDrop: (i) => dropped.push(i.id),
  });
  const kept = (key: string, n: number): Item => ({ key, id: `${key}K${n}` });

  it('a kept item is never evicted: the oldest DROPPABLE item of the largest backlog goes, even behind a kept one', async () => {
    const processed: string[] = [];
    const dropped: string[] = [];
    const q = keptQueue(5, processed, dropped);
    for (const i of [kept('A', 1), item('A', 2), item('A', 3), item('A', 4), item('B', 1), item('B', 2), item('B', 3)]) {
      expect(q.push(i)).toBe(true);
    }
    expect(dropped).toEqual(['A2', 'A3']);
    expect(q.size).toBe(5);
    await q.onIdle();
    expect(processed.sort()).toEqual(['A4', 'AK1', 'B1', 'B2', 'B3']);
  });

  it('"largest" counts what may be dropped: a backlog of kept items is passed over', () => {
    const dropped: string[] = [];
    const q = keptQueue(4, [], dropped);
    for (const i of [kept('A', 1), kept('A', 2), kept('A', 3), item('B', 1)]) q.push(i);
    expect(q.push(item('B', 2))).toBe(true);
    expect(dropped).toEqual(['B1']);
    q.clear();
  });

  it('full of kept items: a newcomer is REFUSED (push false) and capacity holds — a droppable one counted as dropped, a kept one not', () => {
    const dropped: string[] = [];
    const q = keptQueue(3, [], dropped);
    for (const i of [kept('A', 1), kept('A', 2), kept('B', 1)]) expect(q.push(i)).toBe(true);
    expect(q.push(item('C', 1))).toBe(false);
    expect(dropped).toEqual(['C1']);
    expect(q.dropped).toBe(1);
    expect(q.push(kept('C', 2))).toBe(false);
    expect(q.dropped).toBe(1);
    expect(q.size).toBe(3);
    q.clear();
  });

  it('the kept count follows dispatch and clear: once the kept items are gone, eviction works again', async () => {
    const dropped: string[] = [];
    const q = keptQueue(2, [], dropped);
    q.push(kept('A', 1));
    q.push(kept('A', 2));
    await q.onIdle();
    for (const i of [item('A', 3), item('A', 4), item('A', 5)]) expect(q.push(i)).toBe(true);
    expect(dropped).toEqual(['A3']);
    expect(q.clear().map((i) => i.id)).toEqual(['A4', 'A5']);
    q.push(item('B', 1));
    q.push(item('B', 2));
    expect(q.push(item('B', 3))).toBe(true);
    expect(dropped).toEqual(['A3', 'B1']);
    q.clear();
  });
});

describe('push never throws', () => {
  it('a processor that throws (sync or async) is reported, and the queue carries on', async () => {
    const errors: string[] = [];
    const done: string[] = [];
    const q = new OriginatorQueue<Item>({
      capacity: 100, concurrency: 1, keyOf: (i) => i.key,
      process: (i) => {
        if (i.id === 'A1') throw new Error('sync boom');
        if (i.id === 'A2') return Promise.reject(new Error('async boom'));
        done.push(i.id);
        return Promise.resolve();
      },
      onError: (e) => errors.push((e as Error).message),
    });
    expect(() => q.push(item('A', 1))).not.toThrow();
    expect(q.push(item('A', 2))).toBe(true);
    expect(q.push(item('A', 3))).toBe(true);
    await q.onIdle();
    expect(errors).toEqual(['sync boom', 'async boom']);
    expect(done).toEqual(['A3']);
  });

  it('a keyOf that throws is reported and push returns false', () => {
    const errors: unknown[] = [];
    const q = new OriginatorQueue<Item>({
      capacity: 10, concurrency: 1, keyOf: () => { throw new Error('bad key'); },
      process: async () => undefined, onError: (e) => errors.push(e),
    });
    expect(q.push(item('A', 1))).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe('clear / pause', () => {
  it('clear returns the waiting items and leaves the in-flight one', async () => {
    const g = gate();
    const q = new OriginatorQueue<Item>({ capacity: 10, concurrency: 1, keyOf: (i) => i.key, process: async () => { await g.opened; } });
    q.push(item('A', 1));
    await new Promise((r) => setImmediate(r));
    q.push(item('A', 2));
    q.push(item('B', 1));
    expect(q.inFlight).toBe(1);
    expect(q.clear().map((i) => i.id).sort()).toEqual(['A2', 'B1']);
    expect(q.size).toBe(0);
    expect(q.dropped).toBe(0);
    g.open();
    await q.onIdle();
  });

  it('a paused queue admits nothing', () => {
    const q = new OriginatorQueue<Item>({ capacity: 10, concurrency: 1, keyOf: (i) => i.key, process: async () => undefined });
    q.pause();
    expect(q.push(item('A', 1))).toBe(false);
    expect(q.size).toBe(0);
  });
});
