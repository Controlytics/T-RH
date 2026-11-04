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
 * NARROWED by the writer, kept for export:
 *  - `updateAttributesOnlyOnValueChange: false` — an unchanged value is never
 *    re-written (it would be an audit row of a change that did not happen);
 *  - `sendAttributesUpdatedNotification` / `sendAttributesDeletedNotification`
 *    — the event is always emitted; whether it re-enters is the chain's
 *    "Re-enter on rule-node writes" switch (spec §5);
 *  - Delete attributes' `notifyDevice` — a removal is always announced.
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
}

export async function saveAttributes(ctx: RuleContext<SaveAttributesConfig>, msg: RuleMessage): Promise<void> {
  if (msg.type !== 'POST_ATTRIBUTES_REQUEST') throw new Error(`Unsupported msg type: ${msg.type}`);
  if (skipsIngestOrigin(ctx, msg)) {
    ctx.tellNext(msg, 'Success');
    return;
  }
  const instrumentId = instrumentIdOf(msg, 'Save attributes');
  if (!isPlainObject(msg.data)) throw new Error('DATA_NOT_OBJECT: Save attributes saves the message data, which is not a JSON object');
  const kv: Record<string, string> = {};
  for (const [k, v] of Object.entries(msg.data)) {
    const text = attributeText(k, v);
    if (text !== undefined) kv[k] = text;
  }
  await ctx.services.attributes.save(instrumentId, kv, ctx.origin, ctx.config.notifyDevice === true, scopeOf(msg, ctx.config.scope));
  ctx.tellNext(msg, 'Success');
}

interface DeleteAttributesConfig extends JsonObject {
  keys?: string[];
  scope?: string;
}

export async function deleteAttributes(ctx: RuleContext<DeleteAttributesConfig>, msg: RuleMessage): Promise<void> {
  const instrumentId = instrumentIdOf(msg, 'Delete attributes');
  const keys = processPatterns(ctx.config.keys, msg);
  if (keys.length > 0) await ctx.services.attributes.delete(instrumentId, keys, ctx.origin, scopeOf(msg, ctx.config.scope));
  ctx.tellNext(msg, 'Success');
}
