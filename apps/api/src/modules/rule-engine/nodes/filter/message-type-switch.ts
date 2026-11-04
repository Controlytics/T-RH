import { messageTypeSwitchLabel } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';

/**
 * Message type switch — ThingsBoard's `TbMsgTypeSwitchNode` (spec §7): the
 * relation is the message type's ThingsBoard label (`Post telemetry`,
 * `Post attributes`, `Alarm`, … `REST API request`), any type without one
 * `Other` — the ONE table, `MESSAGE_TYPE_SWITCH_LABELS` in `@digilog/shared`.
 * The shipped root chain starts here.
 */
export const MESSAGE_TYPE_SWITCH = 'tb:filter:message-type-switch';

export const messageTypeSwitch: RuleNodeHandler = (ctx, msg) => {
  ctx.tellNext(msg, messageTypeSwitchLabel(msg.type));
};
