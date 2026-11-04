import { RULE_RELATION_FALSE, RULE_RELATION_TRUE } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import { isPlainObject } from './support.js';

/**
 * Check fields presence — ThingsBoard's `TbCheckMessageNode` (spec §7).
 *
 * `checkAllKeys` on: `True` when EVERY key of `messageNames` is in the data and
 * every key of `metadataNames` is in the metadata (an empty list is satisfied).
 * Off: `True` when AT LEAST ONE of them is present (an empty list contributes
 * nothing). "Present" is ThingsBoard's `containsKey` — a key whose value is
 * null is present.
 *
 * Both lists empty: `True` with `checkAllKeys`, `False` without. ThingsBoard
 * master does NOT refuse that at init (Task 1's concern 6 expected it to; the
 * source says otherwise — ruling T4-3).
 *
 * The data is read only when a data key is asked for, and must then be a JSON
 * object; anything else is a `Failure` (ThingsBoard's Gson parse throws).
 */
export const CHECK_FIELDS_PRESENCE = 'tb:filter:check-fields-presence';

export interface CheckFieldsPresenceConfig {
  messageNames?: string[];
  metadataNames?: string[];
  checkAllKeys?: boolean;
}

const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

function dataOf(msg: RuleMessage): Record<string, unknown> {
  if (!isPlainObject(msg.data)) throw new Error('The message data is not a JSON object');
  return msg.data;
}

export const checkFieldsPresence: RuleNodeHandler<CheckFieldsPresenceConfig> = (ctx, msg) => {
  const dataKeys = Array.isArray(ctx.config.messageNames) ? ctx.config.messageNames : [];
  const metaKeys = Array.isArray(ctx.config.metadataNames) ? ctx.config.metadataNames : [];
  let pass: boolean;
  if (ctx.config.checkAllKeys !== false) {
    // ThingsBoard's order: the data first (and short-circuit), then the metadata.
    pass = (dataKeys.length === 0 || dataKeys.every((k) => has(dataOf(msg), k)))
      && metaKeys.every((k) => has(msg.metadata, k));
  } else {
    pass = (dataKeys.length > 0 && dataKeys.some((k) => has(dataOf(msg), k)))
      || metaKeys.some((k) => has(msg.metadata, k));
  }
  ctx.tellNext(msg, pass ? RULE_RELATION_TRUE : RULE_RELATION_FALSE);
};
