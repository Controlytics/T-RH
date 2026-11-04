import type { RuleNodeHandler } from '../../context.js';
import { runNodeScript } from './support.js';

/**
 * Switch — ThingsBoard's `TbJsSwitchNode` (spec §7): the JavaScript returns
 * one relation name or an array of them; the message goes down each.
 * ThingsBoard collects the names in a SET, so a name returned twice is one
 * relation (first occurrence keeps its place). An empty array routes nowhere
 * — the message ends there. A throw, a time-out, or a non-string → `Failure`.
 */
export const SWITCH = 'tb:filter:switch';

export interface SwitchConfig {
  jsScript: string;
}

export const switchNode: RuleNodeHandler<SwitchConfig> = (ctx, msg) => {
  ctx.tellNext(msg, [...new Set(runNodeScript(ctx, 'switch', msg))]);
};
