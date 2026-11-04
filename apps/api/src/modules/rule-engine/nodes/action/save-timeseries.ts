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
 * `{ ts, values }` at its own ts, or an array of either. A null value
 * fails with ThingsBoard's wording. Only POST_TELEMETRY_REQUEST is accepted,
 * as in ThingsBoard.
 *
 * NARROWED, kept for export: `defaultTTL` (monthly partitions govern retention
 * here) and `skipLatestPersistence` (the write path always updates the latest
 * readings).
 */
export const SAVE_TIMESERIES_TYPE = 'tb:action:save-timeseries';

interface SaveTimeseriesConfig extends JsonObject {
  useServerTs?: boolean;
}

export function telemetryReadings(msg: RuleMessage, useServerTs: boolean): RuleTelemetryReading[] {
  const defaultTs = useServerTs ? Date.now() : metadataTs(msg);
  const out: RuleTelemetryReading[] = [];
  for (const item of Array.isArray(msg.data) ? msg.data : [msg.data]) {
    if (!isPlainObject(item)) throw new Error('TELEMETRY_DATA_INVALID: the message data is not telemetry ({ key: value }, { ts, values } or an array of them)');
    const hasTs = typeof item.ts === 'number' && Number.isFinite(item.ts) && isPlainObject(item.values);
    const ts = new Date(hasTs ? (item.ts as number) : defaultTs);
    for (const [key, value] of Object.entries(hasTs ? (item.values as JsonObject) : item)) {
      if (value === undefined) continue;
      if (value === null) throw new Error("Can't parse value: null");
      out.push({ key, value, ts });
    }
  }
  return out;
}

export async function saveTimeseries(ctx: RuleContext<SaveTimeseriesConfig>, msg: RuleMessage): Promise<void> {
  if (msg.type !== 'POST_TELEMETRY_REQUEST') throw new Error(`Unsupported msg type: ${msg.type}`);
  if (skipsIngestOrigin(ctx, msg)) {
    ctx.tellNext(msg, 'Success');
    return;
  }
  const instrumentId = instrumentIdOf(msg, 'Save time series');
  const readings = telemetryReadings(msg, ctx.config.useServerTs === true);
  if (readings.length > 0) await ctx.services.telemetry.write(instrumentId, readings, ctx.origin);
  ctx.tellNext(msg, 'Success');
}
