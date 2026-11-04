import type { RuleNodeHandler } from '../../context.js';
import { configError } from '../filter/support.js';

/**
 * Rule chain — ThingsBoard's `TbRuleChainInputNode` (spec §6, §7 Flow): the
 * message enters the chain `ruleChainId`; that chain's Output nodes return it
 * HERE, out under the Output node's name (the engine keeps the call stack —
 * `ctx.callChain`). A target that does not exist → `Failure`
 * `RULE_CHAIN_NOT_FOUND` (engine).
 *
 *  - No chain chosen → `Failure` "Rule chain must be set!" (ThingsBoard's init).
 *  - The target is THIS node's own chain → `Failure` with ThingsBoard's loop
 *    message, checked on every message as ThingsBoard does.
 *  - `forwardMsgToDefaultRuleChain`: ThingsBoard sends to the originator
 *    profile's default chain when it has one, else to `ruleChainId`. Profiles
 *    have no default chain here (spec §3: later), so it is always
 *    `ruleChainId` — ThingsBoard's own fallback.
 *
 * `callChain` is AWAITED: it resolves the target before it records the call,
 * and a call recorded after the handler settled would become a late message.
 */
export const RULE_CHAIN = 'tb:flow:rule-chain';

export interface RuleChainNodeConfig {
  ruleChainId?: string | null;
  forwardMsgToDefaultRuleChain?: boolean;
}

export const ruleChainNode: RuleNodeHandler<RuleChainNodeConfig> = async (ctx, msg) => {
  const target = typeof ctx.config.ruleChainId === 'string' ? ctx.config.ruleChainId.trim() : '';
  if (!target) throw configError('Rule chain must be set!');
  if (target === ctx.chain.id) {
    throw new Error(
      `TbRuleChainInputNode in rule chain [${target}] is configured to forward messages back to the same rule chain it belongs to. `
      + 'This would cause an infinite loop. Please check the rule chain configuration.',
    );
  }
  await ctx.callChain(target, msg);
};
