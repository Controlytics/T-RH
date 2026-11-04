import { RULE_ORIGINATOR_TYPE_LABELS, type RuleOriginatorType } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';

/**
 * Entity type switch — ThingsBoard's `TbOriginatorTypeSwitchNode` (spec §7):
 * the relation is the originator type's name — Instrument, Alarm, User,
 * System, Rule node (ThingsBoard's `EntityType.getNormalName()`, "Device" read
 * as "Instrument"). Any other type → Failure.
 */
export const ENTITY_TYPE_SWITCH = 'tb:filter:entity-type-switch';

export const entityTypeSwitch: RuleNodeHandler = (ctx, msg) => {
  const type = msg.originator.type;
  if (!Object.prototype.hasOwnProperty.call(RULE_ORIGINATOR_TYPE_LABELS, type)) {
    throw new Error(`Unsupported originator type: ${type}`);
  }
  ctx.tellNext(msg, RULE_ORIGINATOR_TYPE_LABELS[type as RuleOriginatorType]);
};
