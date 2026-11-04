import { RULE_RELATION_FALSE, RULE_RELATION_TRUE, toRuleOriginatorType } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import { configError } from './support.js';

/**
 * Check relation presence — ThingsBoard's `TbCheckRelationNode` (spec §7),
 * NARROWED as the catalogue says: the only relation between instruments here
 * is the GATEWAY link (gateway → instrument on it, `instruments.gateway_id`),
 * so it answers every `relationType` (kept for export, not consulted).
 *
 * Direction, exactly as ThingsBoard master reads it (the originator's side):
 *  - FROM — the relation starts AT THE ORIGINATOR: the originator is a gateway
 *    with an instrument on it (one chosen instrument: that instrument is on the
 *    originator).
 *  - TO — the relation ends at the originator: the originator is on a gateway
 *    (one chosen instrument: the originator is on that one).
 * `True` / `False`. A non-instrument originator has no relations → `False`.
 *
 * `checkForSingleEntity` without an entity → Failure ("Entity should be
 * specified!", which ThingsBoard throws at init); a chosen entity that is not
 * an instrument, or does not exist → Failure (ThingsBoard's init refuses an
 * entity that is not the tenant's).
 */
export const CHECK_RELATION_PRESENCE = 'tb:filter:check-relation-presence';

export interface CheckRelationPresenceConfig {
  direction?: 'FROM' | 'TO';
  relationType?: string;
  checkForSingleEntity?: boolean;
  entityType?: string | null;
  entityId?: string | null;
}

export const checkRelationPresence: RuleNodeHandler<CheckRelationPresenceConfig> = async (ctx, msg) => {
  const cfg = ctx.config;
  const fromOriginator = cfg.direction !== 'TO';
  const single = cfg.checkForSingleEntity === true;
  let targetId: string | null = null;
  if (single) {
    if (!cfg.entityType || !cfg.entityId) throw configError('Entity should be specified!');
    if (toRuleOriginatorType(cfg.entityType) !== 'INSTRUMENT') {
      throw configError(`only an instrument can be checked here, not ${cfg.entityType}`);
    }
    const target = await ctx.services.instruments.byId(cfg.entityId);
    if (!target) throw configError(`instrument ${cfg.entityId} does not exist`);
    targetId = target.id;
    if (msg.originator.type !== 'INSTRUMENT') return ctx.tellNext(msg, RULE_RELATION_FALSE);
    // FROM: originator (gateway) → target; TO: target (gateway) → originator.
    const child = fromOriginator ? target : await ctx.services.instruments.byId(msg.originator.id);
    const gatewayId = fromOriginator ? msg.originator.id : targetId;
    return ctx.tellNext(msg, child?.gatewayId === gatewayId ? RULE_RELATION_TRUE : RULE_RELATION_FALSE);
  }
  if (msg.originator.type !== 'INSTRUMENT') return ctx.tellNext(msg, RULE_RELATION_FALSE);
  let present: boolean;
  if (fromOriginator) {
    const onIt = await ctx.services.prisma.instrument.findFirst({ where: { gatewayId: msg.originator.id }, select: { id: true } });
    present = onIt !== null;
  } else {
    const self = await ctx.services.instruments.byId(msg.originator.id);
    present = !!self?.gatewayId;
  }
  ctx.tellNext(msg, present ? RULE_RELATION_TRUE : RULE_RELATION_FALSE);
};
