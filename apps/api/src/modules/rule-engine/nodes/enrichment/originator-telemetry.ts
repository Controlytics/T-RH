import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleContext } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import type { RuleTelemetryAggregation } from '../../services.js';
import { instrumentIdOf, javaValueText, processPattern, processPatterns, type JsonObject } from '../action/support.js';
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
 * No keys configured → every message FAILS with ThingsBoard's init error
 * "Telemetry should be specified!" (ThingsBoard refuses to start such a node and
 * fails each message sent to it; TB-P 4).
 *
 * `fetchMode` FIRST / LAST → the earliest / newest reading per key: ThingsBoard's
 * `getValueAsString` (`Double.toString` for a fraction), written to the metadata
 * as ThingsBoard writes it — a JSON STRING, quotes included (`"21.5"`; TB-P 4);
 * ALL → `[{ ts, value }, …]` per key, at
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
  // TB-P 4: ThingsBoard's init refuses a node with no keys ("Telemetry should be specified!")
  // and fails every message sent to it. No init path stops messages here, so the handler fails each.
  if (!Array.isArray(cfg.latestTsKeyNames) || cfg.latestTsKeyNames.length === 0) throw new Error('Telemetry should be specified!');
  const instrumentId = instrumentIdOf(msg, 'Originator telemetry');
  const keys = processPatterns(cfg.latestTsKeyNames, msg);
  const { from, to } = windowOf(cfg, msg, Date.now());
  if (from > to) throw new Error('Interval start should be less than Interval end');
  if (keys.length === 0) {
    ctx.tellNext(msg, RULE_RELATION_SUCCESS);
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
      // ThingsBoard: resultNode.put(key, entry.getValueAsString()), then the metadata gets
      // resultNode.get(key).toString() — the text as a JSON STRING, quotes included ("\"21.5\"").
      const text = javaValueText(list[0].value);
      entries.push([key, fetchTo === 'METADATA' ? JSON.stringify(text) : text]);
    }
  }
  ctx.tellNext(withFetched(msg, fetchTo, entries, 'Originator telemetry'), RULE_RELATION_SUCCESS);
}
