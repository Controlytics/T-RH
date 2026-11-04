import { RULE_RELATION_FALSE, RULE_RELATION_TRUE, toRuleOriginatorType } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';

/**
 * Entity type filter — ThingsBoard's `TbOriginatorTypeFilterNode` (spec §7):
 * `True` when the originator's type is one of `originatorTypes`, else `False`.
 * The list holds OUR types (INSTRUMENT, ALARM, USER, SYSTEM, RULE_NODE);
 * ThingsBoard's DEVICE and TENANT read as INSTRUMENT and SYSTEM, any other
 * ThingsBoard type (ASSET, CUSTOMER …) matches nothing here.
 */
export const ENTITY_TYPE_FILTER = 'tb:filter:entity-type-filter';

export interface EntityTypeFilterConfig {
  originatorTypes: string[];
}

export const entityTypeFilter: RuleNodeHandler<EntityTypeFilterConfig> = (ctx, msg) => {
  const listed = Array.isArray(ctx.config.originatorTypes) ? ctx.config.originatorTypes : [];
  const pass = listed.some((t) => typeof t === 'string' && toRuleOriginatorType(t) === msg.originator.type);
  ctx.tellNext(msg, pass ? RULE_RELATION_TRUE : RULE_RELATION_FALSE);
};
