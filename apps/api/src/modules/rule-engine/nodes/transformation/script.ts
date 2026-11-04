import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import { copyMessage, newMessageId } from '../../message.js';
import { runNodeScript } from '../filter/support.js';

/**
 * Script (transformation) — ThingsBoard's `TbTransformMsgNode` /
 * `TbAbstractTransformNode` (spec §7). The JavaScript returns
 * `{ msg, metadata, msgType }` (a part left out keeps the original) or an
 * array of them:
 *  - one → the message transformed, SAME id, `Success`;
 *  - several → one message each, each a NEW id, every one on `Success`
 *    (ThingsBoard enqueues each as a new message);
 *  - none (`[]`) → `Failure` "Message or messages list are empty!".
 * A throw, a time-out or a malformed result → `Failure` (script-vm.ts).
 */
export const SCRIPT_TRANSFORM = 'tb:transformation:script';

export interface ScriptTransformConfig {
  jsScript: string;
}

export const scriptTransform: RuleNodeHandler<ScriptTransformConfig> = (ctx, msg) => {
  const results = runNodeScript(ctx, 'transform', msg);
  if (results.length === 0) throw new Error('Message or messages list are empty!');
  const many = results.length > 1;
  for (const r of results) {
    ctx.tellNext(copyMessage(msg, {
      ...(many ? { id: newMessageId() } : {}),
      type: r.msgType, metadata: r.metadata, data: r.msg,
    }), RULE_RELATION_SUCCESS);
  }
};
