import { RULE_RELATION_FALSE, RULE_RELATION_TRUE } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import { runNodeScript } from './support.js';

/**
 * Script (filter) — ThingsBoard's `TbJsFilterNode` (spec §7): the JavaScript
 * function body of `msg`, `metadata`, `msgType` returns `true` → `True`,
 * `false` → `False`. A throw, a time-out, or anything but a boolean →
 * `Failure` (script-vm.ts). The message passes unchanged.
 */
export const SCRIPT_FILTER = 'tb:filter:script';

export interface ScriptFilterConfig {
  jsScript: string;
}

export const scriptFilter: RuleNodeHandler<ScriptFilterConfig> = (ctx, msg) => {
  ctx.tellNext(msg, runNodeScript(ctx, 'filter', msg) ? RULE_RELATION_TRUE : RULE_RELATION_FALSE);
};
