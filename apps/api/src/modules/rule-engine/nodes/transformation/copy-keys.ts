import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import { copyMessage } from '../../message.js';
import { isPlainObject } from '../filter/support.js';
import { keyMatcher } from './pattern.js';

/**
 * Copy key-value pairs — ThingsBoard's `TbCopyKeysNode` (spec §7).
 *
 *  - `copyFrom: DATA` — every data key matching `keys` is copied into the
 *    metadata: a string as it is, anything else as its JSON text — a JSON
 *    null is the TEXT `null` (ThingsBoard `JacksonUtil.toString(NullNode)`,
 *    TbCopyKeysNode master e48b5780; M-10), never dropped.
 *  - `copyFrom: METADATA` — every metadata key matching `keys` is copied into
 *    the data AS A STRING (ThingsBoard `ObjectNode.put(String, String)`; "42"
 *    stays "42").
 * A key in `keys` is a regular expression the WHOLE key must match. Either
 * way the data must be a JSON object; otherwise, or when nothing matched, the
 * SAME message goes on. Always `Success` (an invalid pattern → Failure).
 */
export const COPY_KEYS = 'tb:transformation:copy-key-value-pairs';

export interface CopyKeysConfig {
  copyFrom?: 'DATA' | 'METADATA';
  keys?: string[];
}

export const copyKeys: RuleNodeHandler<CopyKeysConfig> = (ctx, msg) => {
  const matches = keyMatcher(ctx.config.keys);
  if (!isPlainObject(msg.data)) {
    ctx.tellNext(msg, RULE_RELATION_SUCCESS);
    return;
  }
  if (ctx.config.copyFrom === 'METADATA') {
    const hits = Object.entries(msg.metadata).filter(([k]) => matches(k));
    if (hits.length === 0) {
      ctx.tellNext(msg, RULE_RELATION_SUCCESS);
      return;
    }
    const out = copyMessage(msg);
    const data = out.data as Record<string, unknown>;
    for (const [k, v] of hits) data[k] = v;
    ctx.tellNext(out, RULE_RELATION_SUCCESS);
    return;
  }
  const hits = Object.entries(msg.data).filter(([k]) => matches(k));
  if (hits.length === 0) {
    ctx.tellNext(msg, RULE_RELATION_SUCCESS);
    return;
  }
  const out = copyMessage(msg);
  for (const [k, v] of hits) out.metadata[k] = typeof v === 'string' ? v : JSON.stringify(v) ?? 'null';
  ctx.tellNext(out, RULE_RELATION_SUCCESS);
};
