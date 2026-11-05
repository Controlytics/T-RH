import { RULE_RELATION_OTHER, RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleContext } from '../../context.js';
import { copyMessage, type RuleMessage } from '../../message.js';
import { bodyFields, javaAsDouble, javaParseDouble, metadataTs, roundHalfUp, type JsonObject } from '../action/support.js';

/**
 * CALCULATE DELTA — ThingsBoard's `CalculateDeltaNode` (rule chains, Task 5).
 *
 * For a POST_TELEMETRY_REQUEST carrying `inputValueKey`: adds
 * `outputValueKey` = this value minus the originator's previous one (0 for the
 * first), rounded to `round` places (HALF_UP) when set, and with
 * `addPeriodBetweenMsgs` the milliseconds since the previous one under
 * `periodValueKey`. `Other` for any other message type or a message without
 * the key. The value is read as ThingsBoard reads it (`asDouble()`, TB-P 6):
 * text that is not a number counts as 0, a boolean as 1 / 0 — never a Failure.
 * `Failure` with `tellFailureIfDeltaIsNegative` for a negative delta ("Delta
 * value is negative!"), and for a delta that is not finite ("NaN" text — Java's
 * BigDecimal cannot hold it). With `excludeZeroDeltas` a zero delta passes on UNCHANGED.
 * A stored previous value is judged as ThingsBoard's `extractValue` judges the
 * latest one: unparseable text, a boolean or JSON fails.
 *
 * THE PREVIOUS VALUE. With `useCache` it is the last value this node saw for
 * the originator (kept in memory, dropped when the node is changed or removed,
 * at most `CACHE_MAX` originators per node). Otherwise — and on a cache miss —
 * it is read from the database, and here NOT from the latest table as
 * ThingsBoard does: ingest has already STORED this reading before the engine
 * sees the message, so the latest table holds the current value and every
 * delta would be 0. It is the newest stored reading strictly BEFORE this
 * message's instant (ThingsBoard's `getMetaDataTs()`: `metadata.ts`).
 */
export const CALCULATE_DELTA_TYPE = 'tb:enrichment:calculate-delta';

interface CalculateDeltaConfig extends JsonObject {
  inputValueKey: string;
  outputValueKey: string;
  round?: number | null;
  useCache?: boolean;
  tellFailureIfDeltaIsNegative?: boolean;
  excludeZeroDeltas?: boolean;
  addPeriodBetweenMsgs?: boolean;
  periodValueKey?: string | null;
}

interface Previous { ts: number; value: number }

const CACHE_MAX = 10_000;
/** `ctx.nodeKey` → originator id → the last value seen. */
const caches = new Map<string, Map<string, Previous>>();

/** The node's lifecycle `onDestroy`: a changed or removed node starts again from the database. */
export function dropDeltaCache(ctx: RuleContext<CalculateDeltaConfig>): void {
  caches.delete(ctx.nodeKey);
}

/** Test seam. */
export function clearDeltaCaches(): void {
  caches.clear();
}

/**
 * ThingsBoard's `extractValue` for the stored previous reading: a number as is;
 * text by `Double.parseDouble`, else "Calculation failed. Unable to parse value
 * [x] of telemetry [key] to Double"; a boolean or JSON value fails; null is no
 * previous value.
 */
function storedValue(key: string, v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = javaParseDouble(v);
    if (n === null) throw new Error(`Calculation failed. Unable to parse value [${v}] of telemetry [${key}] to Double`);
    return n;
  }
  if (typeof v === 'boolean') throw new Error('Calculation failed. Boolean values are not supported!');
  throw new Error('Calculation failed. JSON values are not supported!');
}

async function previousFromDb(ctx: RuleContext<CalculateDeltaConfig>, msg: RuleMessage, key: string, ts: number): Promise<Previous | null> {
  // Readings belong to instruments; another originator has only the cache.
  if (msg.originator.type !== 'INSTRUMENT') return null;
  const rows = await ctx.services.telemetry.history(msg.originator.id, [key], new Date(0), new Date(ts - 1), 'NONE', 'DESC', 1);
  const row = rows[key]?.[0];
  const value = row ? storedValue(key, row.value) : null;
  return row && value !== null ? { ts: row.ts, value } : null;
}

export async function calculateDelta(ctx: RuleContext<CalculateDeltaConfig>, msg: RuleMessage): Promise<void> {
  const cfg = ctx.config;
  const fields = msg.type === 'POST_TELEMETRY_REQUEST' ? bodyFields(msg.data) : null;
  if (!fields || !Object.prototype.hasOwnProperty.call(fields, cfg.inputValueKey)) {
    ctx.tellNext(msg, RULE_RELATION_OTHER);
    return;
  }
  // TB-P 6: ThingsBoard reads `json.get(inputValueKey).asDouble()` — text that is not a number
  // is 0, a boolean 1 / 0 — never a Failure.
  const current = javaAsDouble(fields[cfg.inputValueKey]);
  const ts = metadataTs(msg);

  let cache: Map<string, Previous> | undefined;
  let previous: Previous | null | undefined;
  if (cfg.useCache !== false) {
    cache = caches.get(ctx.nodeKey);
    if (!cache) caches.set(ctx.nodeKey, (cache = new Map()));
    previous = cache.get(msg.originator.id);
  }
  if (previous === undefined) previous = await previousFromDb(ctx, msg, cfg.inputValueKey, ts);
  if (cache) {
    cache.delete(msg.originator.id);
    cache.set(msg.originator.id, { ts, value: current });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  }

  let delta = previous ? current - previous.value : 0;
  // `BigDecimal.valueOf(delta)` throws for NaN / Infinity ("NaN" / "Infinity" text parses to them).
  if (!Number.isFinite(delta)) throw new Error(`DELTA_NOT_FINITE: the delta of "${cfg.inputValueKey}" came out as ${delta}`);
  if (cfg.tellFailureIfDeltaIsNegative !== false && delta < 0) throw new Error('Delta value is negative!');
  if (cfg.excludeZeroDeltas === true && delta === 0) {
    ctx.tellNext(msg, RULE_RELATION_SUCCESS);
    return;
  }
  if (typeof cfg.round === 'number') delta = roundHalfUp(delta, cfg.round);

  const out = copyMessage(msg);
  const outFields = bodyFields(out.data)!;
  outFields[cfg.outputValueKey] = delta;
  if (cfg.addPeriodBetweenMsgs === true) {
    outFields[typeof cfg.periodValueKey === 'string' && cfg.periodValueKey ? cfg.periodValueKey : 'periodInMs'] = previous ? ts - previous.ts : 0;
  }
  ctx.tellNext(out, RULE_RELATION_SUCCESS);
}
