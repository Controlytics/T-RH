import type { RuleNodeHandler } from '../../context.js';

/**
 * Output — ThingsBoard's `TbRuleChainOutputNode` (spec §6, §7 Flow): returns
 * the message to the Rule chain node that called this chain, out under THIS
 * node's NAME (`ctx.output`; the engine pops the call stack). In a chain
 * nobody called, the message ends there (`<name> (no caller)` in debug).
 * Output has no relations of its own (ThingsBoard: `outEnabled = false`).
 */
export const OUTPUT = 'tb:flow:output';

export const output: RuleNodeHandler = (ctx, msg) => {
  ctx.output(msg, ctx.node.name);
};
