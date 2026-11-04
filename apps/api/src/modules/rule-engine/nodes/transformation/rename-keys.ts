import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import { copyMessage } from '../../message.js';
import { isPlainObject } from '../filter/support.js';

/**
 * Rename keys — ThingsBoard's `TbRenameKeysNode` (spec §7): each entry of
 * `renameKeysMapping` (old name → new name), IN ORDER, moves a present key's
 * value to the new name in the metadata (`renameIn: METADATA`) or the data
 * (`DATA`, which must be a JSON object). A new name that exists is
 * overwritten; `{a: b, b: c}` therefore moves a's value to c. Nothing renamed
 * → the SAME message. Always `Success`.
 *
 * DEVIATION (ruling T4-6): a key mapped to ITSELF is left alone. ThingsBoard
 * puts then removes it, so the key and its value VANISH — a data loss nobody
 * configures on purpose.
 */
export const RENAME_KEYS = 'tb:transformation:rename-keys';

export interface RenameKeysConfig {
  renameIn?: 'DATA' | 'METADATA';
  renameKeysMapping: Record<string, string>;
}

const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

function rename(target: Record<string, unknown>, mapping: [string, unknown][]): boolean {
  let changed = false;
  for (const [from, to] of mapping) {
    if (typeof to !== 'string' || from === to || !has(target, from)) continue;
    target[to] = target[from];
    delete target[from];
    changed = true;
  }
  return changed;
}

export const renameKeys: RuleNodeHandler<RenameKeysConfig> = (ctx, msg) => {
  const mapping = isPlainObject(ctx.config.renameKeysMapping) ? Object.entries(ctx.config.renameKeysMapping) : [];
  const inMetadata = ctx.config.renameIn === 'METADATA';
  if (!inMetadata && !isPlainObject(msg.data)) {
    ctx.tellNext(msg, RULE_RELATION_SUCCESS);
    return;
  }
  const out = copyMessage(msg);
  const changed = rename(inMetadata ? out.metadata : (out.data as Record<string, unknown>), mapping);
  ctx.tellNext(changed ? out : msg, RULE_RELATION_SUCCESS);
};
