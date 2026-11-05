import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import { copyMessage } from '../../message.js';
import { isPlainObject } from '../filter/support.js';
import { keyMatcher, keyPatternScope } from './pattern.js';

/**
 * Delete key-value pairs — ThingsBoard's `TbDeleteKeysNode` (spec §7): every
 * key of the metadata (`deleteFrom: METADATA`) or of the data (`DATA`, which
 * must then be a JSON object) that matches `keys` — regular expressions the
 * WHOLE key must match — is removed. Nothing removed → the SAME message.
 * Always `Success` (an invalid pattern → Failure).
 */
export const DELETE_KEYS = 'tb:transformation:delete-key-value-pairs';

export interface DeleteKeysConfig {
  deleteFrom?: 'DATA' | 'METADATA';
  keys?: string[];
}

export const deleteKeys: RuleNodeHandler<DeleteKeysConfig> = (ctx, msg) => {
  const matches = keyMatcher(ctx.config.keys, keyPatternScope(ctx));
  if (ctx.config.deleteFrom === 'METADATA') {
    const gone = Object.keys(msg.metadata).filter(matches);
    if (gone.length === 0) {
      ctx.tellNext(msg, RULE_RELATION_SUCCESS);
      return;
    }
    const out = copyMessage(msg);
    for (const k of gone) delete out.metadata[k];
    ctx.tellNext(out, RULE_RELATION_SUCCESS);
    return;
  }
  const gone = isPlainObject(msg.data) ? Object.keys(msg.data).filter(matches) : [];
  if (gone.length === 0) {
    ctx.tellNext(msg, RULE_RELATION_SUCCESS);
    return;
  }
  const out = copyMessage(msg);
  const data = out.data as Record<string, unknown>;
  for (const k of gone) delete data[k];
  ctx.tellNext(out, RULE_RELATION_SUCCESS);
};
