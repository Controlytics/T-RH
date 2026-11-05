/**
 * The rule engine's MAIN queue (rule chains, 2026-11-03; spec §6) — in memory,
 * bounded, FIFO per originator (ThingsBoard's SequentialByOriginator): the
 * messages of one instrument are processed in order, different instruments in
 * parallel up to `concurrency`.
 *
 * `push` is O(1) and NEVER throws — it is called after an ingest transaction
 * committed, and a reading must never be lost or delayed by the engine (G5).
 * When the queue is full the OLDEST message of the LARGEST originator backlog
 * is dropped (the MQTT bridge's buffer rule): one chatty instrument loses its
 * own oldest messages before a quiet one loses anything. Finding the largest
 * backlog is O(originators) — paid only on the drop path.
 *
 * Processing starts on the next turn of the event loop (`setImmediate`), so a
 * synchronous burst of pushes is admitted (and, past capacity, trimmed) before
 * the first item runs.
 *
 * KEPT ITEMS (ruling RE-2, 2026-11-05): an item `isDroppable` says no to (the
 * engine's durable resumes — a Delay / Checkpoint message whose graphile job
 * already completed) is NEVER evicted. "Largest" then counts the items that may
 * be dropped, and the oldest of THOSE goes, wherever it sits behind a kept
 * one. A queue full of kept items refuses the newcomer (`push` false; counted
 * as dropped when it is droppable) rather than grow past its capacity.
 */
export interface OriginatorQueueOptions<T> {
  capacity: number;
  concurrency: number;
  keyOf: (item: T) => string;
  process: (item: T) => Promise<void>;
  /** May this item be evicted when the queue is full? Default: every item may. */
  isDroppable?: (item: T) => boolean;
  /** A dropped item (capacity). Never allowed to throw into `push`. */
  onDrop?: (item: T, key: string) => void;
  /** A processor that threw — the queue carries on. */
  onError?: (err: unknown, item: T) => void;
}

export class OriginatorQueue<T> {
  private readonly backlogs = new Map<string, T[]>();
  /** Per key: how many of its waiting items may NOT be dropped. Absent = 0. */
  private readonly kept = new Map<string, number>();
  /** Keys with a pending item and nothing in flight, in the order they became ready. */
  private readonly ready = new Set<string>();
  /** Keys with an item in flight. */
  private readonly active = new Set<string>();
  private pending = 0;
  private droppedCount = 0;
  private scheduled = false;
  private paused = false;
  private idleWaiters: (() => void)[] = [];
  private capacity: number;
  private concurrency: number;

  constructor(private readonly opts: OriginatorQueueOptions<T>) {
    this.capacity = Math.max(1, Math.floor(opts.capacity));
    this.concurrency = Math.max(1, Math.floor(opts.concurrency));
  }

  /** Messages waiting (not in flight). */
  get size(): number { return this.pending; }
  /** Messages being processed now. */
  get inFlight(): number { return this.active.size; }
  /** Messages dropped because the queue was full, since construction. */
  get dropped(): number { return this.droppedCount; }

  /** Takes effect for the next push / dispatch; a smaller capacity trims nothing already queued. */
  configure(opts: { capacity?: number; concurrency?: number }): void {
    if (opts.capacity !== undefined) this.capacity = Math.max(1, Math.floor(opts.capacity));
    if (opts.concurrency !== undefined) this.concurrency = Math.max(1, Math.floor(opts.concurrency));
    this.schedule();
  }

  /**
   * Admit one item. Returns false when the queue is paused, or full of items
   * that may not be dropped (a refused droppable newcomer counts as dropped).
   * Never throws.
   */
  push(item: T): boolean {
    try {
      if (this.paused) return false;
      const key = this.opts.keyOf(item);
      while (this.pending >= this.capacity) {
        if (!this.dropOldestOfLargest()) {
          if (this.droppable(item)) {
            this.droppedCount++;
            try { this.opts.onDrop?.(item, key); } catch { /* never into push */ }
          }
          return false;
        }
      }
      let backlog = this.backlogs.get(key);
      if (!backlog) {
        backlog = [];
        this.backlogs.set(key, backlog);
      }
      backlog.push(item);
      if (!this.droppable(item)) this.kept.set(key, (this.kept.get(key) ?? 0) + 1);
      this.pending++;
      if (!this.active.has(key)) this.ready.add(key);
      this.schedule();
      return true;
    } catch (err) {
      try { this.opts.onError?.(err, item); } catch { /* the queue's own reporting must not throw into push */ }
      return false;
    }
  }

  /** Drop every waiting item (not those in flight) and return them. Not counted as `dropped`. */
  clear(): T[] {
    const removed: T[] = [];
    for (const backlog of this.backlogs.values()) removed.push(...backlog);
    this.backlogs.clear();
    this.kept.clear();
    this.ready.clear();
    this.pending = 0;
    this.notifyIdle();
    return removed;
  }

  /** Stop admitting and dispatching; in-flight items finish. */
  pause(): void { this.paused = true; }

  resume(): void {
    this.paused = false;
    this.schedule();
  }

  /** Resolves when nothing is waiting and nothing is in flight. */
  onIdle(): Promise<void> {
    if (this.pending === 0 && this.active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private droppable(item: T): boolean {
    return this.opts.isDroppable ? this.opts.isDroppable(item) : true;
  }

  /** The largest backlog by the items it may LOSE, and its oldest such item. False when nothing may be dropped. */
  private dropOldestOfLargest(): boolean {
    let largestKey: string | null = null;
    let largest = 0;
    for (const [key, backlog] of this.backlogs) {
      const losable = backlog.length - (this.kept.get(key) ?? 0);
      if (losable > largest) {
        largest = losable;
        largestKey = key;
      }
    }
    if (largestKey === null) return false;
    const backlog = this.backlogs.get(largestKey)!;
    const at = backlog.findIndex((i) => this.droppable(i));
    if (at < 0) return false; // the count says otherwise; never evict a kept item to make it true
    const [item] = backlog.splice(at, 1) as [T];
    this.pending--;
    this.droppedCount++;
    if (backlog.length === 0) {
      this.backlogs.delete(largestKey);
      this.ready.delete(largestKey);
    }
    try { this.opts.onDrop?.(item, largestKey); } catch { /* never into push */ }
    return true;
  }

  private schedule(): void {
    if (this.scheduled || this.paused) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (!this.paused && this.active.size < this.concurrency && this.ready.size > 0) {
      const key = this.ready.values().next().value as string;
      this.ready.delete(key);
      const backlog = this.backlogs.get(key);
      if (!backlog || backlog.length === 0) {
        this.backlogs.delete(key);
        continue;
      }
      const item = backlog.shift() as T;
      this.pending--;
      if (!this.droppable(item)) {
        const left = (this.kept.get(key) ?? 1) - 1;
        if (left > 0) this.kept.set(key, left);
        else this.kept.delete(key);
      }
      if (backlog.length === 0) this.backlogs.delete(key);
      this.active.add(key);
      let run: Promise<void>;
      try {
        run = Promise.resolve(this.opts.process(item));
      } catch (err) {
        run = Promise.reject(err);
      }
      run
        .catch((err) => {
          try { this.opts.onError?.(err, item); } catch { /* keep the queue alive */ }
        })
        .finally(() => {
          this.active.delete(key);
          if ((this.backlogs.get(key)?.length ?? 0) > 0) this.ready.add(key);
          if (this.pending === 0 && this.active.size === 0) this.notifyIdle();
          this.schedule();
        });
    }
    if (this.pending === 0 && this.active.size === 0) this.notifyIdle();
  }

  private notifyIdle(): void {
    if (this.pending !== 0 || this.active.size !== 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}
