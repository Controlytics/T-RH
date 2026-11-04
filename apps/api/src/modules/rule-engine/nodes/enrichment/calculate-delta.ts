import type { RuleContext } from '../../context.js';
import { copyMessage, type RuleMessage } from '../../message.js';
import { bodyFields, metadataTs, roundHalfUp, toNumber, type JsonObject } from '../action/support.js';

/**
 * CALCULATE DELTA — ThingsBoard's `CalculateDeltaNode` (rule chains, Task 5).
 *
 * For a POST_TELEMETRY_REQUEST carrying `inputValueKey`: adds
 * `outputValueKey` = this value minus the originator's previous one (0 for the
 * first), rounded to `round` places (HALF_UP) when set, and with
 * `addPeriodBetweenMsgs` the milliseconds since the previous one under
 * `periodValueKey`. `Other` for any other message type or a message without
 * the key; `Failure` for a non-numeric value or, with
 * `tellFailureIfDeltaIsNegative`, a negative delta ("Delta value is
 * negative!"). With `excludeZeroDeltas` a zero delta passes on UNCHANGED.
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

async function previousFromDb(ctx: RuleContext<CalculateDeltaConfig>, msg: RuleMessage, key: string, ts: number): Promise<Previous | null> {
  // Readings belong to instruments; another originator has only the cache.
  if (msg.originator.type !== 'INSTRUMENT') return null;
  const rows = await ctx.services.telemetry.history(msg.originator.id, [key], new Date(0), new Date(ts - 1), 'NONE', 'DESC', 1);
  const row = rows[key]?.[0];
  const value = row ? toNumber(row.value) : null;
  return row && value !== null ? { ts: row.ts, value } : null;
}

export async function calculateDelta(ctx: RuleContext<CalculateDeltaConfig>, msg: RuleMessage): Promise<void> {
  const cfg = ctx.config;
  const fields = msg.type === 'POST_TELEMETRY_REQUEST' ? bodyFields(msg.data) : null;
  if (!fields || !Object.prototype.hasOwnProperty.call(fields, cfg.inputValueKey)) {
    ctx.tellNext(msg, 'Other');
    return;
  }
  const current = toNumber(fields[cfg.inputValueKey]);
  if (current === null) throw new Error(`Calculate delta: the value of "${cfg.inputValueKey}" is not a number`);
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
  if (cfg.tellFailureIfDeltaIsNegative !== false && delta < 0) throw new Error('Delta value is negative!');
  if (cfg.excludeZeroDeltas === true && delta === 0) {
    ctx.tellNext(msg, 'Success');
    return;
  }
  if (typeof cfg.round === 'number') delta = roundHalfUp(delta, cfg.round);

  const out = copyMessage(msg);
  const outFields = bodyFields(out.data)!;
  outFields[cfg.outputValueKey] = delta;
  if (cfg.addPeriodBetweenMsgs === true) {
    outFields[typeof cfg.periodValueKey === 'string' && cfg.periodValueKey ? cfg.periodValueKey : 'periodInMs'] = previous ? ts - previous.ts : 0;
  }
  ctx.tellNext(out, 'Success');
}
