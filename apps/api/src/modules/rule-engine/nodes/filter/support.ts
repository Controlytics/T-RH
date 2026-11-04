import type { RuleContext } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import type { RuleScriptResult } from '../../script-vm.js';

/**
 * Helpers shared by Task 4's filter, flow and transformation handlers (rule
 * chains, 2026-11-04).
 */

/**
 * A configuration ThingsBoard refuses when the node STARTS (its `init` throws
 * a TbNodeException). The schemas here accept such a config so a ThingsBoard
 * default parses; the handler sends each message to `Failure` with this text
 * instead (Task 1 report, concern 6). ThingsBoard's own wording after the code.
 */
export function configError(text: string): Error {
  return new Error(`CONFIG_INVALID: ${text}`);
}

/** A JSON object — not an array, not null (Jackson's `isObject()`). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The node's JavaScript (`jsScript`). An import's `scriptLang: 'TBEL'` still runs the JavaScript — TBEL does not run here (spec §3). */
function jsScriptOf(ctx: RuleContext<{ jsScript?: unknown }>): string {
  const script = ctx.config.jsScript;
  if (typeof script !== 'string' || script.trim() === '') throw configError('the node has no JavaScript (jsScript)');
  return script;
}

/**
 * Run the node's script against the message through `ctx.runScript` — never
 * script-vm's `runScript` directly: the context's run is keyed to this node
 * and chain version, so a script that times out three times in a row is
 * switched off (`SCRIPT_DISABLED`) until the chain is saved, and it uses
 * Configuration → Rule Engine's script time-out.
 */
export function runNodeScript<K extends 'filter' | 'switch' | 'transform'>(
  ctx: RuleContext<{ jsScript?: unknown }>, kind: K, msg: RuleMessage,
): RuleScriptResult<K> {
  return ctx.runScript(kind, jsScriptOf(ctx), msg);
}
