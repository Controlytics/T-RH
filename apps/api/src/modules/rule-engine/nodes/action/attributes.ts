import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleContext } from '../../context.js';
import { INGEST_ORIGIN, RULE_ENGINE_ORIGIN_KEY, type RuleMessage } from '../../message.js';
import { instrumentIdOf, isPlainObject, processPatterns, scopeOf, type JsonObject } from './support.js';

/**
 * SAVE ATTRIBUTES and DELETE ATTRIBUTES (rule chains, Task 5) — ThingsBoard's
 * `TbMsgAttributesNode` and `TbMsgDeleteAttributesNode`, through the
 * services' attribute writer: the routes' advisory locks, one audit row per
 * CHANGED key as user SYSTEM naming this chain and node (ruling T2-A), sensor
 * offset keys refused, the device told after the commit, and the
 * ATTRIBUTES_UPDATED / ATTRIBUTES_DELETED message emitted under the loop guard.
 *
 * Scopes: ThingsBoard's three are ONE table here; the scope (the message's own
 * `metadata.scope` when it carries one, else the node's) only labels the
 * emitted message.
 *
 * Save attributes' two toggles, as ThingsBoard's (TB-P 7, 2026-11-05):
 *  - `sendAttributesUpdatedNotification` — the ATTRIBUTES_UPDATED message is sent
 *    only when it is on and the scope is not CLIENT_SCOPE (`checkSendNotification`),
 *    and only after a save that CHANGED a value; it re-enters a chain only under
 *    that chain's "Re-enter on rule-node writes" (spec §5) — the emit path's loop guard;
 *  - `updateAttributesOnlyOnValueChange: false` — that message lists EVERY key of
 *    the message, not only the changed ones. The write itself stays change-only:
 *    an unchanged value is never re-written or audited (21 CFR Part 11 — it would
 *    be an audit row of a change that did not happen; ThingsBoard re-saves it with
 *    a new timestamp), and the instrument is told only the changed keys.
 *
 * Delete attributes' two toggles, as ThingsBoard's `TbMsgDeleteAttributesNode`
 * (master e48b5780; ruling P-10's treatment, 2026-11-05), both OFF by default as
 * ThingsBoard's `defaultConfiguration`:
 *  - `sendAttributesDeletedNotification` — the ATTRIBUTES_DELETED message
 *    (`AttributesDeleteNodeCallback`) only when on, and here only after a delete
 *    that REMOVED a key, naming the removed keys (ThingsBoard names every key it was
 *    asked to delete, existing or not; a delete that removes nothing emits nothing,
 *    so re-entry stays bounded — rulings C-1, RE-1). It re-enters a chain only under
 *    that chain's "Re-enter on rule-node writes" (the emit path's loop guard);
 *  - `notifyDevice` — the instrument is sent its attributes only when the toggle is
 *    on, or the message's `metadata.notifyDevice` is "true" (`Boolean.parseBoolean`,
 *    `checkNotifyDevice`), and again only after a removal. ThingsBoard also requires
 *    SHARED_SCOPE there; here the three scopes are ONE table and every attribute is
 *    the instrument's, so the scope is not checked — the ruling Save attributes'
 *    device notification already has (rc-p1 open item 2).
 */
export const SAVE_ATTRIBUTES_TYPE = 'tb:action:save-attributes';
export const DELETE_ATTRIBUTES_TYPE = 'tb:action:delete-attributes';

/** Ruling S-3: Save nodes skip a message ingest ALREADY STORED, while Configuration → Rule Engine says so (default ON). */
export function skipsIngestOrigin(ctx: RuleContext<JsonObject>, msg: RuleMessage): boolean {
  return msg.metadata[RULE_ENGINE_ORIGIN_KEY] === INGEST_ORIGIN && ctx.services.config().skipSaveNodesForIngestOrigin;
}

/** An attribute value as this table holds it: text; a number / boolean as written, an object or array as JSON. */
function attributeText(key: string, v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (v === null) throw new Error(`ATTRIBUTE_VALUE_NULL: "${key}" is null — Can't parse value: null`);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

interface SaveAttributesConfig extends JsonObject {
  scope?: string;
  notifyDevice?: boolean;
  sendAttributesUpdatedNotification?: boolean;
  updateAttributesOnlyOnValueChange?: boolean;
}

export async function saveAttributes(ctx: RuleContext<SaveAttributesConfig>, msg: RuleMessage): Promise<void> {
  if (msg.type !== 'POST_ATTRIBUTES_REQUEST') throw new Error(`Unsupported msg type: ${msg.type}`);
  if (skipsIngestOrigin(ctx, msg)) {
    ctx.tellNext(msg, RULE_RELATION_SUCCESS);
    return;
  }
  const instrumentId = instrumentIdOf(msg, 'Save attributes');
  if (!isPlainObject(msg.data)) throw new Error('DATA_NOT_OBJECT: Save attributes saves the message data, which is not a JSON object');
  const kv: Record<string, string> = {};
  for (const [k, v] of Object.entries(msg.data)) {
    const text = attributeText(k, v);
    if (text !== undefined) kv[k] = text;
  }
  const scope = scopeOf(msg, ctx.config.scope);
  const notify = ctx.config.sendAttributesUpdatedNotification === true && scope !== 'CLIENT_SCOPE';
  const updated = !notify ? 'none' : ctx.config.updateAttributesOnlyOnValueChange === false ? 'all' : 'changed';
  await ctx.services.attributes.save(instrumentId, kv, ctx.origin, ctx.config.notifyDevice === true, scope, { updated });
  ctx.tellNext(msg, RULE_RELATION_SUCCESS);
}

interface DeleteAttributesConfig extends JsonObject {
  keys?: string[];
  scope?: string;
  sendAttributesDeletedNotification?: boolean;
  notifyDevice?: boolean;
}

export async function deleteAttributes(ctx: RuleContext<DeleteAttributesConfig>, msg: RuleMessage): Promise<void> {
  const instrumentId = instrumentIdOf(msg, 'Delete attributes');
  const keys = processPatterns(ctx.config.keys, msg);
  if (keys.length > 0) {
    await ctx.services.attributes.delete(instrumentId, keys, ctx.origin, scopeOf(msg, ctx.config.scope), {
      sendDeleted: ctx.config.sendAttributesDeletedNotification === true,
      // ThingsBoard: `config.isNotifyDevice() || Boolean.parseBoolean(metadata.notifyDevice)`.
      notifyDevice: ctx.config.notifyDevice === true || /^true$/i.test(msg.metadata.notifyDevice ?? ''),
    });
  }
  ctx.tellNext(msg, RULE_RELATION_SUCCESS);
}
