import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';

/**
 * Acknowledge — ThingsBoard's `TbAckNode` (spec §6, §7 Flow): `ctx.ack(msg)`
 * then `tellSuccess(msg)`. ThingsBoard's acknowledgement tells its queue the
 * message is done (so a failure further on is not retried); the Main queue
 * here does not retry, so it is a no-op, and the message goes on unchanged
 * under `Success`. Debug records the node's IN and OUT as for any node.
 */
export const ACKNOWLEDGE = 'tb:flow:acknowledge';

export const acknowledge: RuleNodeHandler = (ctx, msg) => {
  ctx.tellNext(msg, RULE_RELATION_SUCCESS);
};
