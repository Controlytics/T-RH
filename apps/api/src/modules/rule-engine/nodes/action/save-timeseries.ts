import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleContext } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import type { RuleTelemetryReading } from '../../services.js';
import { instrumentIdOf, isPlainObject, metadataTs, type JsonObject } from './support.js';
import { skipsIngestOrigin } from './attributes.js';

/**
 * SAVE TIME SERIES — ThingsBoard's `TbMsgTimeseriesNode` (rule chains, Task 5),
 * through `services.telemetry.write`: the ONE ingest write path
 * (`writeBatchOrDeadLetter`, transport `rule-engine`, sensor offsets NOT applied
 * again, partitions and dead letters included), POST_TELEMETRY_REQUEST emitted
 * under the loop guard. The same value written back at a stored instant is a
 * no-op that keeps the stored raw value (T3-11).
 *
 * Ruling S-3: with Configuration → Rule Engine's "Skip Save nodes for
 * ingest-origin messages" ON (the default), a message ingest ALREADY STORED is
 * not written again — it passes on `Success`, so the chain continues.
 *
 * The data: ThingsBoard's three telemetry shapes — flat `{ key: value }` at
 * `metadata.ts` (or the server time with `useServerTs`; ingest's shape here),
 * `{ ts, values }` at its own ts, or an array of either — read as ThingsBoard's
 * `JsonConverter.convertToTelemetry` reads them (master e48b5780):
 *  - an object holding BOTH `ts` and `values` is the timed shape, whatever their
 *    types (`jo.has("ts") && jo.has("values")`). Its `ts` is Gson's `getAsLong`
 *    (Gson 65df6e5a): a JSON number toward zero, a STRING by `Long.parseLong` — so
 *    `"1699999999999"` is an instant (review B M-2) — and anything else, or a
 *    `values` that is not an object, fails. Never two junk readings named `ts` /
 *    `values`;
 *  - every failure inside one object — a null value, a bad `ts` — is
 *    ThingsBoard's `Can't parse value: <that object>` (`parseObject` wraps the
 *    error with the WHOLE object, per array element): `{"t":null}` fails with
 *    `Can't parse value: {"t":null}`. A body that is not an object or an array of
 *    objects is `Can't parse value: <it>`; nothing is written for any of them;
 *  - a body with no reading at all is "Msg body is empty: {}".
 * The instant is then judged by the write path (ruling TS-1, `services.telemetry.write`):
 * before 2000 or more than 10 minutes ahead FAILS, nothing stored.
 * Only POST_TELEMETRY_REQUEST is accepted, as in ThingsBoard.
 *
 * `skipLatestPersistence` writes history only (the write path's `skipLatest`):
 * `instrument_telemetry_latest` is left as it was. It is the ONE source of truth
 * (ruling CV-3): ThingsBoard 4.x's `processingSettings` is converted to and from
 * it at import / export (`@digilog/shared` `fromThingsboardConfig`), never read here.
 *
 * NARROWED, kept for export: `defaultTTL` (monthly partitions govern retention here);
 * the processing strategies not built here (Deduplicate, WebSockets only, a time
 * series Skip — the import warns, naming them).
 */
export const SAVE_TIMESERIES_TYPE = 'tb:action:save-timeseries';

interface SaveTimeseriesConfig extends JsonObject {
  useServerTs?: boolean;
  skipLatestPersistence?: boolean;
}

/** ThingsBoard's `JsonConverter.CAN_T_PARSE_VALUE` + the JSON it could not read. */
const cantParse = (json: unknown) => new Error(`Can't parse value: ${JSON.stringify(json)}`);

const LONG_MIN = -9223372036854775808n;
const LONG_MAX = 9223372036854775807n;

/**
 * Gson's `JsonPrimitive.getAsLong()` for a `ts` (Gson 65df6e5a): a number → its
 * `longValue()` (toward zero); a string → `Long.parseLong` (an optional sign, digits
 * only, within a long); anything else throws — null here.
 */
export function telemetryTsOf(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : null;
  if (typeof raw !== 'string' || !/^[+-]?\d+$/.test(raw)) return null;
  const n = BigInt(raw);
  return n < LONG_MIN || n > LONG_MAX ? null : Number(n);
}

export function telemetryReadings(msg: RuleMessage, useServerTs: boolean): RuleTelemetryReading[] {
  const defaultTs = useServerTs ? Date.now() : metadataTs(msg);
  const out: RuleTelemetryReading[] = [];
  const items = Array.isArray(msg.data) ? msg.data : isPlainObject(msg.data) ? [msg.data] : null;
  if (!items) throw cantParse(msg.data);
  for (const item of items) {
    if (!isPlainObject(item)) throw cantParse(item);
    const own = (k: string) => Object.prototype.hasOwnProperty.call(item, k);
    let values: JsonObject = item;
    let ts = defaultTs;
    if (own('ts') && own('values')) {
      const at = telemetryTsOf(item.ts);
      if (at === null || !isPlainObject(item.values)) throw cantParse(item);
      values = item.values;
      ts = at;
    }
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (value === null) throw cantParse(item);
      out.push({ key, value, ts: new Date(ts) });
    }
  }
  return out;
}

export async function saveTimeseries(ctx: RuleContext<SaveTimeseriesConfig>, msg: RuleMessage): Promise<void> {
  if (msg.type !== 'POST_TELEMETRY_REQUEST') throw new Error(`Unsupported msg type: ${msg.type}`);
  if (skipsIngestOrigin(ctx, msg)) {
    ctx.tellNext(msg, RULE_RELATION_SUCCESS);
    return;
  }
  const instrumentId = instrumentIdOf(msg, 'Save time series');
  const readings = telemetryReadings(msg, ctx.config.useServerTs === true);
  // TbMsgTimeseriesNode: `if (tsKvMap.isEmpty()) tellFailure("Msg body is empty: " + src)` (TB-P 3).
  if (readings.length === 0) throw new Error(`Msg body is empty: ${JSON.stringify(msg.data)}`);
  await ctx.services.telemetry.write(instrumentId, readings, ctx.origin, { skipLatest: ctx.config.skipLatestPersistence === true });
  ctx.tellNext(msg, RULE_RELATION_SUCCESS);
}
