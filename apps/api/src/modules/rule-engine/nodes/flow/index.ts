import { registerNode } from '../../registry.js';
import { ACKNOWLEDGE, acknowledge } from './acknowledge.js';
import { CHECKPOINT, checkpoint } from './checkpoint.js';
import { RULE_CHAIN, ruleChainNode } from './rule-chain.js';
import { OUTPUT, output } from './output.js';

/**
 * Flow rule nodes (rule chains, 2026-11-03; Task 4). `registerAllNodes()`
 * (../index.ts) calls this on every engine start; registering is idempotent.
 * The four flow types of `@digilog/shared`'s catalogue, ThingsBoard's semantics.
 */
export function registerFlowNodes(): void {
  registerNode(ACKNOWLEDGE, acknowledge);
  registerNode(CHECKPOINT, checkpoint);
  registerNode(RULE_CHAIN, ruleChainNode);
  registerNode(OUTPUT, output);
}
