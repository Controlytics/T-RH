import type { RuleContext } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import type { RuleTelemetryAggregation } from '../../services.js';
import { instrumentIdOf, metadataText, processPattern, processPatterns, type JsonObject } from '../action/support.js';
import { fetchToOf, withFetched } from './fetch.js';

/**
 * ORIGINATOR TELEMETRY — ThingsBoard's `TbGetTelemetryNode` (rule chains,
 * Task 5): the originator instrument's stored readings of `latestTsKeyNames`
 * (patterns allowed) inside a window, from `instrument_telemetry_history`.
 *
 * The window is [now − startInterval, now − endInterval] in their units, or —
 * with `useMetadataIntervalPatterns` — two patterns that must come out as
 * millisecond instants. A window that starts after it ends fails ("Interval
 * start should be less than Interval end", ThingsBoard's wording).
 *
 * `fetchMode` FIRST / LAST → the earliest / newest reading per key, as TEXT
 * (ThingsBoard's `getValueAsString`); ALL → `[{ ts, value }, …]` per key, at
 * most `limit`, in `orderBy` order — or with an `aggregation` one
 * `[{ ts: windowEnd, value }]` over the whole window (numeric readings only,
 * quoted numbers included; COUNT counts every reading). A key with nothing in
 * the window is left out. Results go to the metadata (ThingsBoard's only place
 * for this node; an ALL array as JSON text) unless an imported config says
 * `fetchTo: 'DATA'`.
 */
export const ORIGINATOR_TELEMETRY_TYPE = 'tb:enrichment:originator-telemetry';

type Unit = 'MILLISECONDS' | 'SECONDS' | 'MINUTES' | 'HOURS' | 'DAYS';

interface OriginatorTelemetryConfig extends JsonObject {
  latestTsKeyNames?: string[];
  fetchMode?: 'FIRST' | 'LAST' | 'ALL';
  aggregation?: RuleTelemetryAggregation;
  orderBy?: 'ASC' | 'DESC';
  limit?: number;
  useMetadataIntervalPatterns?: boolean;
  startInterval?: number;
  startIntervalTimeUnit?: Unit;
  endInterval?: number;
  endIntervalTimeUnit?: Unit;
  startIntervalPattern?: string | null;
  endIntervalPattern?: string | null;
  fetchTo?: 'DATA' | 'METADATA';
}

const UNIT_MS: Record<Unit, number> = { MILLISECONDS: 1, SECONDS: 1_000, MINUTES: 60_000, HOURS: 3_600_000, DAYS: 86_400_000 };

function windowOf(cfg: OriginatorTelemetryConfig, msg: RuleMessage, now: number): { from: number; to: number } {
  if (cfg.useMetadataIntervalPatterns === true) {
    const read = (pattern: string | null | undefined, which: string) => {
      const text = processPattern(pattern ?? '', msg).trim();
      if (!/^-?\d+$/.test(text)) throw new Error(`INTERVAL_PATTERN_INVALID: the ${which} pattern came out as "${text}", not a millisecond instant`);
      return Number(text);
    };
    return { from: read(cfg.startIntervalPattern, 'start'), to: read(cfg.endIntervalPattern, 'end') };
  }
  const ms = (n: unknown, unit: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0) * (UNIT_MS[unit as Unit] ?? UNIT_MS.MINUTES);
  return { from: now - ms(cfg.startInterval, cfg.startIntervalTimeUnit), to: now - ms(cfg.endInterval, cfg.endIntervalTimeUnit) };
}

export async function originatorTelemetry(ctx: RuleContext<OriginatorTelemetryConfig>, msg: RuleMessage): Promise<void> {
  const cfg = ctx.config;
  const instrumentId = instrumentIdOf(msg, 'Originator telemetry');
  const keys = processPatterns(cfg.latestTsKeyNames, msg);
  const { from, to } = windowOf(cfg, msg, Date.now());
  if (from > to) throw new Error('Interval start should be less than Interval end');
  if (keys.length === 0) {
    ctx.tellNext(msg, 'Success');
    return;
  }
  const mode = cfg.fetchMode ?? 'FIRST';
  const all = mode === 'ALL';
  const agg: RuleTelemetryAggregation = all ? (cfg.aggregation ?? 'NONE') : 'NONE';
  const order = all ? (cfg.orderBy === 'DESC' ? 'DESC' : 'ASC') : mode === 'LAST' ? 'DESC' : 'ASC';
  const limit = all ? Math.max(1, Math.min(1000, Math.floor(cfg.limit ?? 1000))) : 1;
  const rows = await ctx.services.telemetry.history(instrumentId, keys, new Date(from), new Date(to), agg, order, limit);

  const fetchTo = fetchToOf(cfg.fetchTo, 'METADATA');
  const entries: [string, unknown][] = [];
  for (const key of keys) {
    const list = rows[key];
    if (!list || list.length === 0) continue;
    if (all) {
      const arr = list.map((r) => ({ ts: r.ts, value: r.value }));
      entries.push([key, fetchTo === 'METADATA' ? JSON.stringify(arr) : arr]);
    } else {
      entries.push([key, metadataText(list[0].value)]);
    }
  }
  ctx.tellNext(withFetched(msg, fetchTo, entries, 'Originator telemetry'), 'Success');
}
