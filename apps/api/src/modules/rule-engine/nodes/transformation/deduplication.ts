import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleContext, RuleNodeHandler } from '../../context.js';
import type { RuleNodeLifecycle } from '../../registry.js';
import { errorText, newMessage, type RuleMessage } from '../../message.js';
import { configError } from '../filter/support.js';

/**
 * Deduplication — ThingsBoard's `TbMsgDeduplicationNode` (spec §7), per
 * ORIGINATOR, in memory (a restart loses what is waiting, as ThingsBoard's
 * in-memory state does).
 *
 * Every message is HELD (the flow ends here — ThingsBoard acks it). Its time is
 * `metadata.ts` when that is a whole number, else the moment it arrived
 * (ThingsBoard's `getMetaDataTs()`: the ts metadata, else the message's own
 * creation time). The first held message of an originator starts a tick
 * `interval` seconds + 1 ms later; at each tick, while the earliest held time
 * + interval has passed, that PACK (held times in [earliest, earliest +
 * interval)) leaves as ONE message on `Success`:
 *  - FIRST — the pack's earliest message; LAST — its latest. A tie keeps the
 *    one that arrived first (ThingsBoard compares strictly). The same type,
 *    originator, data and metadata, a NEW id and no rule-chain call stack
 *    (ThingsBoard's `copyWithNewCtx`).
 *  - ALL — a new message of `outMsgType` (POST_TELEMETRY_REQUEST when none is
 *    set — ThingsBoard's editor default; ThingsBoard itself does not check),
 *    the originator, data `[{ msg, metadata }, …]` in arrival order,
 *    metadata `{ ts: <now> }`.
 * Messages left after the packs wait for the next tick (interval + 1 ms on).
 * More than `maxPendingMsgs` held for one originator → that message goes to
 * `Failure` with ThingsBoard's text.
 *
 * The output is sent AFTER the handler settled, so it enters the Main queue
 * at this node's connections (context.ts). It is sent through the node's
 * LIFECYCLE context when there is one (`onInit`): that context belongs to no
 * message, so a window's output cannot be dropped because one message's flow
 * was abandoned; until the engine has initialised the node, through the
 * latest message's context. `maxRetries` is kept for export and not used: the
 * in-memory queue does not fail a push the way ThingsBoard's producer can (a
 * refused push is counted `late_dropped`).
 *
 * State is per (chain, node): the same node id can sit in two chains (a copy
 * of a chain keeps its node ids). `onDestroy` (node changed or removed, chain
 * deleted, engine stopped) drops what is held and its timers, as ThingsBoard's
 * `destroy` clears its map.
 */
export const DEDUPLICATION = 'tb:transformation:deduplication';

export interface DeduplicationConfig {
  interval: number;
  strategy?: 'FIRST' | 'LAST' | 'ALL';
  outMsgType?: string | null;
  maxPendingMsgs?: number;
  maxRetries?: number;
}

const DEFAULT_OUT_MSG_TYPE = 'POST_TELEMETRY_REQUEST';
const DEFAULT_MAX_PENDING = 100;
/** setTimeout's ceiling (~24.8 days); a longer interval just ticks again. */
const MAX_TIMER_MS = 2_147_483_647;

interface Held {
  msg: RuleMessage;
  ts: number;
}

interface Window {
  held: Held[];
  timer: ReturnType<typeof setTimeout> | null;
  /** The latest message's context: the sender until the node has a lifecycle context. */
  ctx: RuleContext<DeduplicationConfig>;
}

interface NodeState {
  init: RuleContext<DeduplicationConfig> | null;
  windows: Map<string, Window>;
}

const nodes = new Map<string, NodeState>();

const nodeKey = (ctx: RuleContext<DeduplicationConfig>) => `${ctx.chain.id}:${ctx.node.id}`;

function stateOf(key: string): NodeState {
  let state = nodes.get(key);
  if (!state) {
    state = { init: null, windows: new Map() };
    nodes.set(key, state);
  }
  return state;
}

/** ThingsBoard's `getMetaDataTs()` without its fallback: `metadata.ts` when it is a whole number, else null. */
export function metadataTs(msg: RuleMessage): number | null {
  const s = msg.metadata.ts;
  if (typeof s !== 'string' || !/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function intervalMs(cfg: DeduplicationConfig): number {
  const s = cfg.interval;
  if (typeof s !== 'number' || !Number.isInteger(s) || s < 1) throw configError('the interval must be a whole number of seconds, 1 or more');
  return s * 1000;
}

function maxPending(cfg: DeduplicationConfig): number {
  const n = cfg.maxPendingMsgs;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_PENDING;
}

function schedule(key: string, originatorKey: string, w: Window, ms: number): void {
  if (w.timer) return;
  w.timer = setTimeout(() => tick(key, originatorKey), Math.min(ms + 1, MAX_TIMER_MS));
  w.timer.unref?.();
}

/** The message one pack leaves as. */
function packMessage(cfg: DeduplicationConfig, pack: Held[], now: number): RuleMessage {
  if (cfg.strategy === 'ALL') {
    const type = typeof cfg.outMsgType === 'string' && cfg.outMsgType.trim() !== '' ? cfg.outMsgType : DEFAULT_OUT_MSG_TYPE;
    const data = pack.map((h) => ({ msg: h.msg.data === undefined ? null : h.msg.data, metadata: h.msg.metadata }));
    return newMessage(type, pack[0].msg.originator, data, { ts: String(now) });
  }
  const earliest = cfg.strategy !== 'LAST';
  let pick = pack[0];
  for (const h of pack) if (earliest ? h.ts < pick.ts : h.ts > pick.ts) pick = h;
  return newMessage(pick.msg.type, pick.msg.originator, pick.msg.data, pick.msg.metadata);
}

function tick(key: string, originatorKey: string): void {
  const state = nodes.get(key);
  const w = state?.windows.get(originatorKey);
  if (!state || !w) return;
  w.timer = null;
  const cfg = w.ctx.config;
  const ms = intervalMs(cfg);
  const now = Date.now();
  const out: RuleMessage[] = [];
  while (w.held.length > 0) {
    const start = w.held.reduce((min, h) => (h.ts < min ? h.ts : min), w.held[0].ts);
    const end = start + ms;
    if (end > now) break;
    const pack = w.held.filter((h) => h.ts >= start && h.ts < end);
    w.held = w.held.filter((h) => !(h.ts >= start && h.ts < end));
    out.push(packMessage(cfg, pack, now));
  }
  const sender = state.init ?? w.ctx;
  for (const m of out) {
    try {
      sender.tellNext(m, RULE_RELATION_SUCCESS);
    } catch (err) {
      // A timer callback must not throw (it would take the process down); say what was lost.
      sender.log('error', `deduplication output for ${originatorKey} could not be sent: ${errorText(err)}`);
    }
  }
  if (w.held.length > 0) schedule(key, originatorKey, w, ms);
  else state.windows.delete(originatorKey);
  if (state.windows.size === 0 && !state.init) nodes.delete(key);
}

export const deduplication: RuleNodeHandler<DeduplicationConfig> = (ctx, msg) => {
  const ms = intervalMs(ctx.config);
  const key = nodeKey(ctx);
  const state = stateOf(key);
  const originatorKey = `${msg.originator.type}:${msg.originator.id}`;
  let w = state.windows.get(originatorKey);
  if (w && w.held.length >= maxPending(ctx.config)) {
    throw new Error(`[${ctx.node.id}] Max limit of pending messages reached for deduplication id: [${msg.originator.id}]`);
  }
  if (!w) {
    w = { held: [], timer: null, ctx };
    state.windows.set(originatorKey, w);
  }
  w.ctx = ctx;
  w.held.push({ msg, ts: metadataTs(msg) ?? Date.now() });
  schedule(key, originatorKey, w, ms);
};

export const deduplicationLifecycle: RuleNodeLifecycle<DeduplicationConfig> = {
  onInit(ctx) {
    stateOf(nodeKey(ctx)).init = ctx;
  },
  onDestroy(ctx) {
    const key = nodeKey(ctx);
    const state = nodes.get(key);
    if (!state) return;
    for (const w of state.windows.values()) if (w.timer) clearTimeout(w.timer);
    nodes.delete(key);
  },
};
