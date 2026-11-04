import type { RuleContext } from '../../context.js';
import { copyMessage, type RuleMessage } from '../../message.js';
import { bodyFields, metadataText, processPatterns, type JsonObject } from '../action/support.js';

/**
 * What the enrichment nodes share (rule chains, Task 5): where fetched values
 * go (ThingsBoard's `fetchTo`), and the attribute / latest-reading fetch that
 * Originator attributes and Related device attributes both make.
 */
export type FetchTo = 'DATA' | 'METADATA';

export const fetchToOf = (v: unknown, fallback: FetchTo): FetchTo => (v === 'DATA' || v === 'METADATA' ? v : fallback);

/**
 * A COPY of `msg` with `entries` added: to the metadata as strings, or to the
 * message data. Throws when the data is not a JSON object.
 */
export function withFetched(msg: RuleMessage, fetchTo: FetchTo, entries: readonly (readonly [string, unknown])[], node: string): RuleMessage {
  const out = copyMessage(msg);
  if (fetchTo === 'METADATA') {
    for (const [k, v] of entries) out.metadata[k] = metadataText(v);
    return out;
  }
  const fields = bodyFields(out.data);
  if (!fields) throw new Error(`DATA_NOT_OBJECT: ${node} adds to the message data, which is not a JSON object`);
  for (const [k, v] of entries) fields[k] = v;
  return out;
}

export interface AttributeFetchConfig extends JsonObject {
  clientAttributeNames?: string[];
  sharedAttributeNames?: string[];
  serverAttributeNames?: string[];
  latestTsKeyNames?: string[];
  fetchTo?: FetchTo;
  tellFailureIfAbsent?: boolean;
  getLatestValueWithTs?: boolean;
}

/**
 * ThingsBoard's `TbAbstractGetAttributesNode`: each scope's keys (patterns
 * allowed) from the instrument's attributes — ThingsBoard's three scopes are
 * ONE table here, so a key asked for in two scopes is the same value — named
 * with ThingsBoard's prefixes (`cs_` client, `shared_` shared, `ss_` server);
 * the latest readings under their own key, or `{ ts, value }` with
 * `getLatestValueWithTs`. A key not found fails the message when
 * `tellFailureIfAbsent`, naming every missing key; otherwise it is left out.
 */
export async function fetchAttributes(
  ctx: RuleContext<AttributeFetchConfig>, msg: RuleMessage, instrumentId: string, node: string,
): Promise<RuleMessage> {
  const cfg = ctx.config;
  const scoped: [string, string[]][] = [
    ['cs_', processPatterns(cfg.clientAttributeNames, msg)],
    ['shared_', processPatterns(cfg.sharedAttributeNames, msg)],
    ['ss_', processPatterns(cfg.serverAttributeNames, msg)],
  ];
  const tsKeys = processPatterns(cfg.latestTsKeyNames, msg);
  const attrKeys = [...new Set(scoped.flatMap(([, keys]) => keys))];
  // `latest(id, [])` means EVERY key — never call it with none.
  const [attributes, latest] = await Promise.all([
    attrKeys.length > 0 ? ctx.services.attributes.get(instrumentId, attrKeys) : Promise.resolve({} as Record<string, string>),
    tsKeys.length > 0 ? ctx.services.telemetry.latest(instrumentId, tsKeys) : Promise.resolve({} as Record<string, { value: unknown; ts: Date }>),
  ]);
  const entries: [string, unknown][] = [];
  const missing: string[] = [];
  for (const [prefix, keys] of scoped) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(attributes, key)) entries.push([`${prefix}${key}`, attributes[key]]);
      else missing.push(`${prefix}${key}`);
    }
  }
  for (const key of tsKeys) {
    const hit = Object.prototype.hasOwnProperty.call(latest, key) ? latest[key] : undefined;
    if (!hit) {
      missing.push(key);
      continue;
    }
    entries.push([key, cfg.getLatestValueWithTs === true ? { ts: hit.ts.getTime(), value: hit.value } : hit.value]);
  }
  if (missing.length > 0 && cfg.tellFailureIfAbsent !== false) {
    throw new Error(`The following attribute/telemetry keys could not be found: [${missing.join(', ')}]`);
  }
  return withFetched(msg, fetchToOf(cfg.fetchTo, 'METADATA'), entries, node);
}
