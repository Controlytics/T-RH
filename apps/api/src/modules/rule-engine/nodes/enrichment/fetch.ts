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
 * A COPY of `msg` with `entries` added: to the metadata as strings
 * (`metadataText` — a JSON null is the TEXT `null`, as ThingsBoard writes it;
 * M-10), or to the message data as they are. Throws when the data is not a
 * JSON object.
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
 * An attribute value as ThingsBoard puts it into the message DATA (M-3,
 * 2026-11-05). ThingsBoard's attribute has a data type — BOOLEAN, LONG, DOUBLE,
 * STRING, JSON — and `JacksonUtil.addKvEntry` adds it typed. This system keeps
 * an attribute's VALUE as text, so the type is read back from the text: exactly
 * `true` / `false` is a boolean, and a text that is EXACTLY how its number
 * prints (`25`, `0.5`, `-3.25`, `1e-7` — what a device's JSON number is stored
 * as) is that number. Anything else stays text: `007`, `1.50`, ` 25`, a serial
 * too long for a JavaScript number, JSON text (ThingsBoard's JSON type is not
 * reproduced). A device that sent the STRING "25" cannot be told from one that
 * sent the number 25 — both are typed 25 here.
 */
export function attributeDataValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return Number.isFinite(n) && String(n) === value ? n : value;
}

/** What `fetchAttributes` made: the ENRICHED message, and the failure to send it with when keys were missing. */
export interface AttributeFetchResult {
  msg: RuleMessage;
  missing: Error | null;
}

/**
 * ThingsBoard's `TbAbstractGetAttributesNode`: each scope's keys (patterns
 * allowed) from the instrument's attributes — ThingsBoard's three scopes are
 * ONE table here, so a key asked for in two scopes is the same value — named
 * with ThingsBoard's prefixes (`cs_` client, `shared_` shared, `ss_` server);
 * the latest readings under their own key, or `{ ts, value }` with
 * `getLatestValueWithTs`. Into the DATA an attribute is typed
 * (`attributeDataValue`, M-3); into the metadata it is its text.
 *
 * A key not found (M-11): with `tellFailureIfAbsent` (ThingsBoard's default)
 * the ENRICHED message — everything that WAS found added — goes to Failure
 * with ThingsBoard's `reportFailures` text: `The following attribute/telemetry
 * keys is not present in the DB: ` then one `\t[<SCOPE>]:[k1, k2]` line per
 * scope (unprefixed keys; `LATEST_TS` for readings). ThingsBoard iterates a
 * hash set for those lines; here they come in a fixed order — client, shared,
 * server, latest. Without the switch the key is left out.
 */
export async function fetchAttributes(
  ctx: RuleContext<AttributeFetchConfig>, msg: RuleMessage, instrumentId: string, node: string,
): Promise<AttributeFetchResult> {
  const cfg = ctx.config;
  const fetchTo = fetchToOf(cfg.fetchTo, 'METADATA');
  const scoped: [string, string, string[]][] = [
    ['cs_', 'CLIENT_SCOPE', processPatterns(cfg.clientAttributeNames, msg)],
    ['shared_', 'SHARED_SCOPE', processPatterns(cfg.sharedAttributeNames, msg)],
    ['ss_', 'SERVER_SCOPE', processPatterns(cfg.serverAttributeNames, msg)],
  ];
  const tsKeys = processPatterns(cfg.latestTsKeyNames, msg);
  const attrKeys = [...new Set(scoped.flatMap(([, , keys]) => keys))];
  // `latest(id, [])` means EVERY key — never call it with none.
  const [attributes, latest] = await Promise.all([
    attrKeys.length > 0 ? ctx.services.attributes.get(instrumentId, attrKeys) : Promise.resolve({} as Record<string, string>),
    tsKeys.length > 0 ? ctx.services.telemetry.latest(instrumentId, tsKeys) : Promise.resolve({} as Record<string, { value: unknown; ts: Date }>),
  ]);
  const entries: [string, unknown][] = [];
  const missing: [scope: string, keys: string[]][] = [];
  for (const [prefix, scope, keys] of scoped) {
    const absent: string[] = [];
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(attributes, key)) absent.push(key);
      else entries.push([`${prefix}${key}`, fetchTo === 'DATA' ? attributeDataValue(attributes[key]) : attributes[key]]);
    }
    if (absent.length > 0) missing.push([scope, absent]);
  }
  const absentTs: string[] = [];
  for (const key of tsKeys) {
    const hit = Object.prototype.hasOwnProperty.call(latest, key) ? latest[key] : undefined;
    if (!hit) {
      absentTs.push(key);
      continue;
    }
    entries.push([key, cfg.getLatestValueWithTs === true ? { ts: hit.ts.getTime(), value: hit.value } : hit.value]);
  }
  if (absentTs.length > 0) missing.push(['LATEST_TS', absentTs]);
  const out = withFetched(msg, fetchTo, entries, node);
  if (missing.length === 0 || cfg.tellFailureIfAbsent === false) return { msg: out, missing: null };
  const lines = missing.map(([scope, keys]) => `\t[${scope}]:[${keys.join(', ')}]\n`).join('');
  return { msg: out, missing: new Error(`The following attribute/telemetry keys is not present in the DB: \n${lines}`) };
}

/** Send what `fetchAttributes` made: the enriched message on Success, or to Failure with what was missing. */
export function sendFetched(ctx: RuleContext<AttributeFetchConfig>, r: AttributeFetchResult): void {
  if (r.missing) ctx.tellFailure(r.msg, r.missing);
  else ctx.tellNext(r.msg, 'Success');
}
