import { toRuleOriginatorType } from '@digilog/shared';
import type { RuleContext } from '../../context.js';
import { newMessage, type RuleMessage, type RuleOriginator } from '../../message.js';
import { coerceMetadata } from '../../script-vm.js';
import { isPlainObject, jsScriptOf, type JsonObject } from './support.js';

/**
 * GENERATOR — ThingsBoard's `TbMsgGeneratorNode` (rule chains, Task 5).
 *
 * A SOURCE node: `onInit` (engine start, or the node saved) arms a timer; every
 * `periodInSeconds` the script runs and its `{ msg, metadata, msgType }` leaves
 * on `Success` as a NEW message through the queue (the lifecycle context's
 * `tellNext`, ruling T3-1), from the originator the node names. `msgCount` > 0
 * stops it after that many; 0 = no limit. `onDestroy` (node changed or removed,
 * chain deleted, engine stopped) clears the timer. The schedule is
 * ThingsBoard's: each tick one period after the previous one was DUE, so a slow
 * script does not drift it. The count restarts with the node, as in ThingsBoard.
 *
 * The script sees ThingsBoard's names for the previous output — `prevMsg`,
 * `prevMetadata`, `prevMsgType` (`{}`, `{}`, `''` before the first) — through a
 * one-line prefix declaring them from the VM's own `msg` / `metadata` / `msgType`
 * (kept on the first line so a script error's line numbers stay the script's).
 * The message type is the script's `msgType`, else the previous one's (as
 * ThingsBoard falls back), else GENERATOR_NODE_SELF_MSG (spec §5). A script that
 * throws sends a Failure (a GENERATOR_NODE_SELF_MSG) and the timer goes on.
 *
 * Originator: `RULE_NODE` (this node — ThingsBoard's default), `INSTRUMENT` /
 * ThingsBoard's `DEVICE` with `originatorId`, or `TENANT` / `SYSTEM` (the
 * system). Anything else — and an instrument without an id — refuses to start
 * (counted as an init error, logged). An incoming message ends here: a
 * ThingsBoard Generator has no input.
 */
export const GENERATOR_TYPE = 'tb:action:generator';
export const GENERATOR_MSG_TYPE = 'GENERATOR_NODE_SELF_MSG';

/** Declares ThingsBoard's names for the previous output; on the script's first line, so its line numbers hold. */
export const GENERATOR_PREV_PREFIX = 'var prevMsg = msg, prevMetadata = metadata, prevMsgType = msgType; ';

interface GeneratorConfig extends JsonObject {
  msgCount?: number;
  periodInSeconds: number;
  originatorType?: string;
  originatorId?: string | null;
  scriptLang?: string;
  jsScript: string;
}

interface Running { timer: NodeJS.Timeout | null; stopped: boolean }
/** By `ctx.nodeKey`: the onInit and onDestroy contexts are different objects for one node. */
const running = new Map<string, Running>();

export function generatorOriginator(cfg: GeneratorConfig, nodeId: string): RuleOriginator {
  const raw = typeof cfg.originatorType === 'string' && cfg.originatorType.trim() ? cfg.originatorType.trim() : 'RULE_NODE';
  if (raw === 'RULE_NODE') return { type: 'RULE_NODE', id: nodeId };
  const type = toRuleOriginatorType(raw);
  if (type === 'INSTRUMENT') {
    const id = typeof cfg.originatorId === 'string' ? cfg.originatorId.trim() : '';
    if (!id) throw new Error('GENERATOR_ORIGINATOR_REQUIRED: the Generator is set to an instrument originator but names no instrument');
    return { type: 'INSTRUMENT', id };
  }
  if (type === 'SYSTEM') return { type: 'SYSTEM', id: 'SYSTEM' };
  throw new Error(`GENERATOR_ORIGINATOR_UNSUPPORTED: "${raw}" cannot originate a message here (this rule node, an instrument or the system)`);
}

interface Generated { msg: unknown; metadata: Record<string, string>; msgType: string }

function shapeOutput(raw: unknown, prev: Generated): Generated {
  if (!isPlainObject(raw)) throw new Error('SCRIPT_RESULT: a generator script must return { msg, metadata, msgType }');
  const type = typeof raw.msgType === 'string' && raw.msgType.trim() ? raw.msgType : (prev.msgType || GENERATOR_MSG_TYPE);
  return {
    msg: 'msg' in raw && raw.msg !== undefined ? raw.msg : {},
    metadata: coerceMetadata(raw.metadata, prev.metadata),
    msgType: type,
  };
}

export function stopGenerator(ctx: RuleContext<GeneratorConfig>): void {
  const r = running.get(ctx.nodeKey);
  if (!r) return;
  r.stopped = true;
  if (r.timer) clearTimeout(r.timer);
  running.delete(ctx.nodeKey);
}

export function startGenerator(ctx: RuleContext<GeneratorConfig>): void {
  stopGenerator(ctx);
  const cfg = ctx.config;
  const script = GENERATOR_PREV_PREFIX + jsScriptOf(cfg, 'jsScript');
  const originator = generatorOriginator(cfg, ctx.node.id);
  const periodMs = Math.max(1, Math.floor(Number(cfg.periodInSeconds) || 1)) * 1000;
  const limit = Math.max(0, Math.floor(Number(cfg.msgCount) || 0));
  const state: Running = { timer: null, stopped: false };
  running.set(ctx.nodeKey, state);

  let count = 0;
  let prev: Generated = { msg: {}, metadata: {}, msgType: '' };
  let dueAt = Date.now();
  const schedule = () => {
    if (state.stopped || (limit > 0 && count >= limit)) return;
    dueAt += periodMs;
    state.timer = setTimeout(tick, Math.max(0, dueAt - Date.now()));
    state.timer.unref?.();
  };
  const tick = () => {
    state.timer = null;
    if (state.stopped) return;
    try {
      // The previous output IS the script's msg / metadata / msgType (the prefix names them prevMsg …).
      const raw = ctx.runScript('generator', script, newMessage(prev.msgType, originator, prev.msg, prev.metadata));
      const out = shapeOutput(raw, prev);
      prev = out;
      ctx.tellNext(newMessage(out.msgType, originator, out.msg, out.metadata), 'Success');
    } catch (err) {
      ctx.tellFailure(newMessage(GENERATOR_MSG_TYPE, originator, {}), err);
    }
    count++;
    schedule();
  };
  schedule();
}

/** An incoming message ends here: a Generator has no input. */
export function generatorInput(_ctx: RuleContext<GeneratorConfig>, _msg: RuleMessage): void {
  // ThingsBoard's Generator has no input port; a message wired into it is acknowledged.
}
