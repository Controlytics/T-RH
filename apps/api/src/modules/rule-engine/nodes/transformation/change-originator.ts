import { RULE_RELATION_SUCCESS, toRuleOriginatorType } from '@digilog/shared';
import type { RuleContext, RuleNodeHandler } from '../../context.js';
import { copyMessage, type RuleMessage, type RuleOriginator } from '../../message.js';
import { configError } from '../filter/support.js';
import { processPattern } from '../action/support.js';

/**
 * Change originator — ThingsBoard's `TbChangeOriginatorNode` (spec §7). The
 * message leaves on `Success` with another originator; its id, type, data and
 * METADATA are kept (ThingsBoard's `transformMsgOriginator` — metadata such as
 * `instrumentCode` is NOT refreshed, as in ThingsBoard). A new originator
 * equal to the current one passes the same message.
 *
 * `originatorSource`:
 *  - ALARM_ORIGINATOR — the originator must be an ALARM; its instrument.
 *    Another type → "Unexpected originator EntityType <type>".
 *  - ENTITY — the instrument whose CODE `entityNamePattern` makes
 *    (`${metadata}` / `$[data]`, ignoring case). ThingsBoard looks up a name;
 *    here the code is the identifier (catalogue: "An instrument, by code").
 *    `entityType` must be DEVICE (= instrument); no type or no pattern →
 *    CONFIG_INVALID, ThingsBoard's init messages.
 *  - RELATED — NARROWED (catalogue): the instrument's GATEWAY, the one
 *    relation here; `relationsQuery` is kept for export, not read.
 *  - TENANT — the system (`SYSTEM`).
 *  - CUSTOMER — there are no customers: Failure.
 * Not found → "Failed to find new originator!" (ThingsBoard's text).
 */
export const CHANGE_ORIGINATOR = 'tb:transformation:change-originator';

export interface ChangeOriginatorConfig {
  originatorSource: 'CUSTOMER' | 'TENANT' | 'RELATED' | 'ALARM_ORIGINATOR' | 'ENTITY';
  entityType?: string | null;
  entityNamePattern?: string | null;
}

const NOT_FOUND = 'Failed to find new originator!';

async function newOriginator(ctx: RuleContext<ChangeOriginatorConfig>, msg: RuleMessage): Promise<RuleOriginator> {
  const source = ctx.config.originatorSource;
  switch (source) {
    case 'TENANT':
      return { type: 'SYSTEM', id: 'SYSTEM' };
    case 'ALARM_ORIGINATOR': {
      if (msg.originator.type !== 'ALARM') throw new Error(`Unexpected originator EntityType ${msg.originator.type}`);
      const alarm = await ctx.services.alarms.byId(msg.originator.id);
      if (!alarm) throw new Error(NOT_FOUND);
      const instrument = await ctx.services.instruments.byId(alarm.instrumentId);
      return { type: 'INSTRUMENT', id: alarm.instrumentId, ...(instrument ? { code: instrument.code } : {}) };
    }
    case 'RELATED': {
      if (msg.originator.type !== 'INSTRUMENT') throw new Error(NOT_FOUND);
      const gateway = await ctx.services.instruments.gatewayOf(msg.originator.id);
      if (!gateway) throw new Error(NOT_FOUND);
      return { type: 'INSTRUMENT', id: gateway.id, code: gateway.code };
    }
    case 'ENTITY': {
      const { entityType, entityNamePattern } = ctx.config;
      if (!entityType) throw configError("Entity type should be specified if 'Entity by name pattern' source is selected.");
      if (typeof entityNamePattern !== 'string' || entityNamePattern.trim() === '') {
        throw configError("Name pattern should be specified if 'Entity by name pattern' source is selected.");
      }
      if (toRuleOriginatorType(entityType) !== 'INSTRUMENT') throw configError(`only an instrument can be the new originator, not ${entityType}`);
      const code = processPattern(entityNamePattern, msg).trim();
      const instrument = await ctx.services.instruments.byCode(code);
      if (!instrument) throw new Error(`Failed to find instrument with code '${code}'`);
      return { type: 'INSTRUMENT', id: instrument.id, code: instrument.code };
    }
    case 'CUSTOMER':
      throw new Error(`${NOT_FOUND} There are no customers in this system.`);
    default:
      throw new Error(`Unexpected originator source ${String(source)}`);
  }
}

export const changeOriginator: RuleNodeHandler<ChangeOriginatorConfig> = async (ctx, msg) => {
  const next = await newOriginator(ctx, msg);
  if (next.type === msg.originator.type && next.id === msg.originator.id) {
    ctx.tellNext(msg, RULE_RELATION_SUCCESS);
    return;
  }
  ctx.tellNext(copyMessage(msg, { originator: next }), RULE_RELATION_SUCCESS);
};
