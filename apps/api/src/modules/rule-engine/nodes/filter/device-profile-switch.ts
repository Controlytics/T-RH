import { RULE_ORIGINATOR_TYPE_LABELS, type RuleOriginatorType } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';

/**
 * Device profile switch — ThingsBoard's `TbDeviceTypeSwitchNode` (spec §7):
 * the relation is the originator instrument's PROFILE NAME.
 *
 * Read from the instrument itself (`instruments.byId`), never from
 * `metadata.profileName`: the engine fills that once, before the first node,
 * and a Change originator node does not refresh it — ThingsBoard reads its
 * profile cache by the originator's id for the same reason.
 *
 * Failure (ThingsBoard's wording, "Device" read as "Instrument"): a
 * non-instrument originator; an instrument with no profile, or gone.
 */
export const DEVICE_PROFILE_SWITCH = 'tb:filter:device-profile-switch';

export function originatorTypeLabel(type: string): string {
  return Object.prototype.hasOwnProperty.call(RULE_ORIGINATOR_TYPE_LABELS, type)
    ? RULE_ORIGINATOR_TYPE_LABELS[type as RuleOriginatorType]
    : type;
}

export const deviceProfileSwitch: RuleNodeHandler = async (ctx, msg) => {
  if (msg.originator.type !== 'INSTRUMENT') {
    throw new Error(`Unsupported originator type: ${originatorTypeLabel(msg.originator.type)}! Only ${RULE_ORIGINATOR_TYPE_LABELS.INSTRUMENT} type is allowed.`);
  }
  const instrument = await ctx.services.instruments.byId(msg.originator.id);
  if (!instrument?.profileName) throw new Error(`Instrument profile for entity id: ${msg.originator.id} wasn't found!`);
  ctx.tellNext(msg, instrument.profileName);
};
