import type { RuleContext } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import { nodeScriptOf, type JsonObject } from './support.js';

/**
 * LOG — ThingsBoard's `TbLogNode` (rule chains, Task 5): the script's return
 * value (a string, anything else as JSON) goes to the API log at `info`, as
 * `[rule-chain <chain>/<node>] …`; the message passes on `Success` unchanged.
 * With debug on, the node's OUT row shows the message; the text itself is in
 * the API log.
 */
export const LOG_TYPE = 'tb:action:log';

export function logNode(ctx: RuleContext<JsonObject>, msg: RuleMessage): void {
  // The script scriptLang selects (ruling TB-L): a stored TBEL node runs its TBEL text as JavaScript.
  const script = nodeScriptOf(ctx.node.type, ctx.config);
  const result = ctx.runScript('log', script, msg);
  ctx.log('info', typeof result === 'string' ? result : (JSON.stringify(result) ?? 'undefined'));
  ctx.tellNext(msg, 'Success');
}
