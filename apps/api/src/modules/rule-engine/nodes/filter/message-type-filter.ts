import { RULE_RELATION_FALSE, RULE_RELATION_TRUE } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';

/**
 * Message type filter — ThingsBoard's `TbMsgTypeFilterNode` (spec §7): `True`
 * when the message type is one of `messageTypes` (the §5 list or a custom
 * type a Script node set), else `False`.
 */
export const MESSAGE_TYPE_FILTER = 'tb:filter:message-type-filter';

export interface MessageTypeFilterConfig {
  messageTypes: string[];
}

export const messageTypeFilter: RuleNodeHandler<MessageTypeFilterConfig> = (ctx, msg) => {
  const listed = Array.isArray(ctx.config.messageTypes) ? ctx.config.messageTypes : [];
  ctx.tellNext(msg, listed.includes(msg.type) ? RULE_RELATION_TRUE : RULE_RELATION_FALSE);
};
