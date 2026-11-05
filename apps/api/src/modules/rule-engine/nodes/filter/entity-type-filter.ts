import { RULE_RELATION_FALSE, RULE_RELATION_TRUE, toRuleOriginatorType } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';

/**
 * Entity type filter — ThingsBoard's `TbOriginatorTypeFilterNode` (spec §7):
 * `True` when the originator's type is one of `originatorTypes`, else `False`.
 * The list stores ThingsBoard's EntityType values (ruling SW-1, refined —
 * DEVICE for an instrument, TENANT for the system, ALARM, USER, RULE_NODE); a
 * list saved before SW-1 still holds INSTRUMENT / SYSTEM. Both spellings read
 * through `toRuleOriginatorType` (contract C2); any other ThingsBoard type
 * (ASSET, CUSTOMER …) matches nothing here.
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
