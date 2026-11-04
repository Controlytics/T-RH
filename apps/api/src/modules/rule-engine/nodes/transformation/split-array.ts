import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import { copyMessage, newMessageId } from '../../message.js';

/**
 * Split array msg — ThingsBoard's `TbSplitArrayMsgNode` (spec §7): a message
 * whose data is an ARRAY leaves as one message per element, each with the
 * original type, originator and metadata, on `Success`.
 *  - one element → that element, the SAME id;
 *  - several → each a NEW id (ThingsBoard enqueues each as a new message);
 *  - an empty array → nothing leaves (ThingsBoard acknowledges it);
 *  - data that is not an array → `Failure` "Msg data is not a JSON Array!".
 */
export const SPLIT_ARRAY = 'tb:transformation:split-array-msg';

export const splitArray: RuleNodeHandler = (ctx, msg) => {
  if (!Array.isArray(msg.data)) throw new Error('Msg data is not a JSON Array!');
  const items = msg.data;
  if (items.length === 1) {
    ctx.tellNext(copyMessage(msg, { data: items[0] }), RULE_RELATION_SUCCESS);
    return;
  }
  for (const item of items) ctx.tellNext(copyMessage(msg, { id: newMessageId(), data: item }), RULE_RELATION_SUCCESS);
};
