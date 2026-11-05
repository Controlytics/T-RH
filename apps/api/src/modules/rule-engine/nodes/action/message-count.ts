import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleContext } from '../../context.js';
import { newMessage, type RuleMessage } from '../../message.js';
import type { JsonObject } from './support.js';

/**
 * MESSAGE COUNT — ThingsBoard's `TbMsgCountNode` (rule chains, Task 5).
 *
 * Every message that reaches it is COUNTED and ends there (ThingsBoard
 * acknowledges it). Every `interval` seconds — a timer armed in `onInit`,
 * cleared in `onDestroy`, scheduled from when each tick was due — the node
 * sends a POST_TELEMETRY_REQUEST from the SYSTEM originator on `Success`:
 * data `{ "<telemetryPrefix>_<nodeId>": <count> }` (ThingsBoard names the key
 * after its service id; one server here, so the node id keeps two counters
 * apart), metadata `delta` = the milliseconds since the previous tick. The
 * count restarts at 0 after each tick and when the node is re-initialised.
 * The data is ThingsBoard's flat shape.
 */
export const MESSAGE_COUNT_TYPE = 'tb:action:message-count';

interface MessageCountConfig extends JsonObject {
  interval: number;
  telemetryPrefix: string;
}

/** By `ctx.nodeKey`: the handler, onInit and onDestroy contexts are different objects for one node. */
const counts = new Map<string, number>();
const timers = new Map<string, { timer: NodeJS.Timeout | null; stopped: boolean }>();

export function countMessage(ctx: RuleContext<MessageCountConfig>, _msg: RuleMessage): void {
  const key = ctx.nodeKey;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function stopMessageCount(ctx: RuleContext<MessageCountConfig>): void {
  const key = ctx.nodeKey;
  const t = timers.get(key);
  if (t) {
    t.stopped = true;
    if (t.timer) clearTimeout(t.timer);
    timers.delete(key);
  }
  counts.delete(key);
}

export function startMessageCount(ctx: RuleContext<MessageCountConfig>): void {
  stopMessageCount(ctx);
  const key = ctx.nodeKey;
  const intervalMs = Math.max(1, Math.floor(Number(ctx.config.interval) || 1)) * 1000;
  const dataKey = `${String(ctx.config.telemetryPrefix || 'messageCount')}_${ctx.node.id}`;
  const state = { timer: null as NodeJS.Timeout | null, stopped: false };
  timers.set(key, state);
  counts.set(key, 0);
  let dueAt = Date.now();
  let lastTickAt = dueAt;
  const schedule = () => {
    if (state.stopped) return;
    dueAt += intervalMs;
    state.timer = setTimeout(tick, Math.max(0, dueAt - Date.now()));
    state.timer.unref?.();
  };
  const tick = () => {
    state.timer = null;
    if (state.stopped) return;
    const n = counts.get(key) ?? 0;
    counts.set(key, 0);
    const now = Date.now();
    const delta = now - lastTickAt;
    lastTickAt = now;
    ctx.tellNext(newMessage('POST_TELEMETRY_REQUEST', { type: 'SYSTEM', id: 'SYSTEM' }, { [dataKey]: n }, { delta: String(delta) }), RULE_RELATION_SUCCESS);
    schedule();
  };
  schedule();
}
