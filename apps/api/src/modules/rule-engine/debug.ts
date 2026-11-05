import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import type { RuleMessage } from './message.js';

/**
 * DEBUG EVENTS (rule chains, 2026-11-03; spec §4, §6) — ThingsBoard's per-node
 * "Debug" tab: one `rule_node_debug_events` row per message IN or OUT of a
 * node whose `debugMode` is on (`all`, or `failures` = only an OUT Failure and
 * the IN that led to it).
 *
 * Batched: `record` is O(1) and snapshots the message AT ONCE (the next node
 * may change it); a timer writes every 500 ms, or sooner at 200 rows. A row
 * for a chain deleted in the meantime is skipped by the INSERT itself (the
 * table keys to the chain, so one deleted chain must not fail the batch). A
 * write that fails is logged and its rows dropped — debug output is never
 * worth a retry storm. The buffer is bounded; past it the oldest rows go.
 *
 * NOT a §11 record: swept by age (`debugRetentionHours`) and capped per node
 * (`debugMaxEventsPerNode`) by the hourly `rule_engine_debug_sweep` task.
 *
 * ── How the relation column reads (Task 7 renders it) ──
 *  - IN:  the relation the message ARRIVED on; NULL at a chain's first node,
 *         at a delivery to the node itself (`tellSelf`) and at an injection.
 *  - OUT: the relation it left on — `Success`, `True`, `Failure`, a label …
 *    with a suffix when nothing was connected to it:
 *         `Failure (unhandled)`  a Failure with no Failure connection;
 *         `<relation> (unconnected)`  any other label with no connection;
 *         `<label> (no caller)`  an Output node in a chain nobody called.
 *    The message ENDS at a suffixed OUT. `error` is set on every Failure.
 */
export type RuleDebugDirection = 'IN' | 'OUT';

export const DEBUG_FLUSH_MS = 500;
export const DEBUG_BATCH_ROWS = 200;
export const DEBUG_BUFFER_MAX = 10_000;
/** A message whose data serialises longer than this is stored as a truncated preview. */
export const DEBUG_DATA_MAX_CHARS = 64 * 1024;

export const UNHANDLED_SUFFIX = ' (unhandled)';
export const UNCONNECTED_SUFFIX = ' (unconnected)';
export const NO_CALLER_SUFFIX = ' (no caller)';

export interface RuleDebugEventInput {
  chainId: string;
  nodeId: string;
  direction: RuleDebugDirection;
  relation: string | null;
  msg: RuleMessage;
  error?: string | null;
  ts?: Date;
}

/** One row, its JSON already serialised. */
export interface RuleDebugRow {
  chainId: string;
  nodeId: string;
  ts: Date;
  direction: RuleDebugDirection;
  relation: string | null;
  msgId: string;
  msgType: string;
  originatorType: string;
  originatorId: string;
  data: string;
  metadata: string;
  error: string | null;
}

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n));

function jsonOf(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value === undefined ? null : value);
  } catch (e) {
    text = JSON.stringify({ _unserialisable: (e as Error).message });
  }
  if (text === undefined) text = 'null';
  if (text.length > DEBUG_DATA_MAX_CHARS) {
    return JSON.stringify({ _truncated: true, size: text.length, preview: text.slice(0, 2_000) });
  }
  return text;
}

/** Snapshot an event NOW, column lengths respected. */
export function toDebugRow(e: RuleDebugEventInput): RuleDebugRow {
  return {
    chainId: e.chainId,
    nodeId: e.nodeId,
    ts: e.ts ?? new Date(),
    direction: e.direction,
    relation: e.relation === null ? null : clip(e.relation, 128),
    msgId: clip(e.msg.id, 64),
    msgType: clip(e.msg.type, 255),
    originatorType: clip(e.msg.originator.type, 20),
    originatorId: clip(e.msg.originator.id, 255),
    data: jsonOf(e.msg.data),
    metadata: jsonOf(e.msg.metadata),
    error: e.error ?? null,
  };
}

/**
 * Write rows, skipping any whose chain no longer exists. Returns how many were inserted.
 *
 * BATCH ORDER IS KEPT (found by FW-N2, 2026-11-05). The rows of one batch usually
 * share a millisecond, so the id is what orders them (`listDebug` reads `ts DESC, id
 * DESC`; the per-node trim keeps `ts DESC, id DESC`). The identity is assigned in the
 * order the SELECT hands rows to the INSERT — but the `WHERE EXISTS` semi-join lets
 * the planner HASH the VALUES side and probe it with `rule_chains`, and then rows come
 * out in hash-bucket order: a batch of one chain came out REVERSED. It does so as soon
 * as rule_chains is estimated bigger than the batch (any install with more chains than
 * rows in a batch — measured with 31 chains and 3 rows) and with some small-table
 * estimates. So each row carries its place (`ord`) and the SELECT is ORDER BY it: the
 * ids follow the batch whatever the plan (proven on the test database, and pinned in
 * rule-engine.e2e "debug rows").
 */
export async function insertDebugRows(rows: readonly RuleDebugRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values = Prisma.join(rows.map((r, i) => Prisma.sql`(
    ${i}::int, ${r.chainId}::uuid, ${r.nodeId}::uuid, ${r.ts}::timestamptz, ${r.direction}::varchar, ${r.relation}::varchar,
    ${r.msgId}::varchar, ${r.msgType}::varchar, ${r.originatorType}::varchar, ${r.originatorId}::varchar,
    ${r.data}::jsonb, ${r.metadata}::jsonb, ${r.error}::text)`));
  return prisma.$executeRaw`
    INSERT INTO rule_node_debug_events
      (chain_id, node_id, ts, direction, relation, msg_id, msg_type, originator_type, originator_id, data, metadata, error)
    SELECT v.chain_id, v.node_id, v.ts, v.direction, v.relation, v.msg_id, v.msg_type, v.originator_type, v.originator_id,
           v.data, v.metadata, v.error
    FROM (VALUES ${values}) AS v(ord, chain_id, node_id, ts, direction, relation, msg_id, msg_type, originator_type, originator_id, data, metadata, error)
    WHERE EXISTS (SELECT 1 FROM rule_chains c WHERE c.id = v.chain_id)
    ORDER BY v.ord`;
}

/** Delete one node's rows beyond its newest `keep`, in one statement. Returns how many went. */
export async function trimDebugNode(chainId: string, nodeId: string, keep: number): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM rule_node_debug_events
    WHERE chain_id = ${chainId}::uuid AND node_id = ${nodeId}::uuid AND id IN (
      SELECT id FROM rule_node_debug_events
      WHERE chain_id = ${chainId}::uuid AND node_id = ${nodeId}::uuid
      ORDER BY ts DESC, id DESC OFFSET ${Math.max(0, Math.floor(keep))}::int)`;
}

/** A node is trimmed at most this often (ruled 2026-11-04). */
export const DEBUG_TRIM_INTERVAL_MS = 10_000;

export interface RuleDebugWriterOptions {
  insert?: (rows: readonly RuleDebugRow[]) => Promise<number>;
  trim?: (chainId: string, nodeId: string, keep: number) => Promise<number>;
  flushMs?: number;
  batchRows?: number;
  bufferMax?: number;
  /** Rows kept per node (Configuration → Rule Engine → debugMaxEventsPerNode); the engine sets it on every config read. */
  maxPerNode?: number;
  trimIntervalMs?: number;
  now?: () => number;
}

export class RuleDebugWriter {
  private buffer: RuleDebugRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private writtenCount = 0;
  private droppedCount = 0;
  private lastErrorLogAt = 0;
  private readonly insert: (rows: readonly RuleDebugRow[]) => Promise<number>;
  private readonly trim: (chainId: string, nodeId: string, keep: number) => Promise<number>;
  private readonly flushMs: number;
  private readonly batchRows: number;
  private readonly bufferMax: number;
  private readonly trimIntervalMs: number;
  private readonly now: () => number;
  private maxPerNode: number;
  /** Per (chain, node): rows written since its last trim, and when that trim was. */
  private readonly sinceTrim = new Map<string, number>();
  private readonly lastTrimAt = new Map<string, number>();
  private trimming: Promise<void> | null = null;
  private trimmedCount = 0;

  constructor(opts: RuleDebugWriterOptions = {}) {
    this.insert = opts.insert ?? insertDebugRows;
    this.trim = opts.trim ?? trimDebugNode;
    this.flushMs = opts.flushMs ?? DEBUG_FLUSH_MS;
    this.batchRows = opts.batchRows ?? DEBUG_BATCH_ROWS;
    this.bufferMax = opts.bufferMax ?? DEBUG_BUFFER_MAX;
    this.trimIntervalMs = opts.trimIntervalMs ?? DEBUG_TRIM_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.maxPerNode = opts.maxPerNode ?? 1_000;
  }

  /** The per-node cap, from Configuration → Rule Engine (the engine calls this on every config read). */
  configure(opts: { maxPerNode?: number }): void {
    if (opts.maxPerNode !== undefined && Number.isFinite(opts.maxPerNode)) this.maxPerNode = Math.max(1, Math.floor(opts.maxPerNode));
  }

  /** Rows deleted by the per-node cap since construction. */
  get trimmed(): number { return this.trimmedCount; }

  get buffered(): number { return this.buffer.length; }
  get written(): number { return this.writtenCount; }
  get dropped(): number { return this.droppedCount; }

  /** O(1); never throws. */
  record(event: RuleDebugEventInput): void {
    try {
      this.buffer.push(toDebugRow(event));
      if (this.buffer.length > this.bufferMax) {
        const over = this.buffer.length - this.bufferMax;
        this.buffer.splice(0, over);
        this.droppedCount += over;
      }
      if (this.buffer.length >= this.batchRows) void this.flush();
    } catch (err) {
      this.droppedCount++;
      this.logError(err);
    }
  }

  /**
   * Writes everything buffered now, in batches. A call during a write waits
   * for it, then writes whatever arrived meanwhile.
   *
   * `flushing` is cleared in a `.finally` on the very promise it holds — a
   * MICROTASK, so always after the assignment. (Cleared inside the async body
   * instead, an empty buffer ran the body to its end synchronously, cleared it
   * BEFORE it was assigned, and every later flush chained onto itself forever:
   * the heap filled and no timer ever ran again. The e2e found it.)
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing.then(() => (this.buffer.length > 0 ? this.flush() : undefined));
    if (this.buffer.length === 0) return Promise.resolve();
    const run: Promise<void> = this.writeBuffered().finally(() => {
      if (this.flushing === run) this.flushing = null;
    });
    this.flushing = run;
    return run;
  }

  private async writeBuffered(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.batchRows);
      try {
        this.writtenCount += await this.insert(batch);
        for (const row of batch) {
          const key = `${row.chainId}:${row.nodeId}`;
          this.sinceTrim.set(key, (this.sinceTrim.get(key) ?? 0) + 1);
        }
      } catch (err) {
        this.droppedCount += batch.length;
        this.logError(err);
      }
    }
    await this.trimDue();
  }

  /**
   * THE PER-NODE CAP, as the writer goes (ruled 2026-11-04 — the hourly sweep
   * alone let one busy node write a million rows between sweeps). A node that
   * has had more than `maxPerNode` rows written since its last trim has its
   * rows beyond the newest `maxPerNode` deleted in ONE statement — at most once
   * per node per 10 s, so a busy node costs one DELETE per 10 s, not one per
   * flush. The count restarts at each trim; a node over the cap but inside its
   * 10 s is trimmed by a later flush or timer tick. The hourly sweep still
   * removes rows by AGE (and anything written before this process started).
   * BETWEEN trims a node holds up to about TWICE the cap (N kept + N new before
   * the next trim fires), plus whatever it writes during the 10 s wait.
   * Never throws.
   */
  trimDue(): Promise<void> {
    if (this.trimming) return this.trimming;
    const run: Promise<void> = (async () => {
      const now = this.now();
      for (const [key, count] of [...this.sinceTrim]) {
        if (count <= this.maxPerNode) continue;
        if (now - (this.lastTrimAt.get(key) ?? -Infinity) < this.trimIntervalMs) continue;
        const [chainId, nodeId] = key.split(':');
        this.lastTrimAt.set(key, now);
        this.sinceTrim.set(key, 0);
        try {
          this.trimmedCount += await this.trim(chainId, nodeId, this.maxPerNode);
        } catch (err) {
          this.logError(err);
        }
      }
      for (const [key, at] of [...this.lastTrimAt]) {
        if (now - at > this.trimIntervalMs && (this.sinceTrim.get(key) ?? 0) === 0) {
          this.lastTrimAt.delete(key);
          this.sinceTrim.delete(key);
        }
      }
    })().finally(() => {
      if (this.trimming === run) this.trimming = null;
    });
    this.trimming = run;
    return run;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush().then(() => this.trimDue()); }, this.flushMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    if (this.trimming) await this.trimming;
  }

  private logError(err: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < 60_000) return;
    this.lastErrorLogAt = now;
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[rule-engine] debug events could not be written — dropped (logged once a minute)');
  }
}

/**
 * The hourly sweep (`rule_engine_debug_sweep`): rows older than
 * `retentionHours` go, then each node keeps its newest `maxPerNode`. A node is
 * keyed by (chain, node) — two chains may share node ids.
 */
export async function sweepDebugEvents(opts: { retentionHours: number; maxPerNode: number }): Promise<{ aged: number; capped: number }> {
  const aged = await prisma.$executeRaw`
    DELETE FROM rule_node_debug_events WHERE ts < now() - make_interval(hours => ${Math.floor(opts.retentionHours)}::int)`;
  const capped = await prisma.$executeRaw`
    DELETE FROM rule_node_debug_events d
    USING (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY chain_id, node_id ORDER BY ts DESC, id DESC) AS rn
        FROM rule_node_debug_events
      ) ranked WHERE ranked.rn > ${Math.floor(opts.maxPerNode)}::int
    ) excess
    WHERE d.id = excess.id`;
  return { aged, capped };
}
