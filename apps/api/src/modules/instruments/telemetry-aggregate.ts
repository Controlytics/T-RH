/**
 * Min / mean / max across a SELECTION of instruments, bucketed over time.
 *
 * Feeds the dashboard's trend card, where the selection is whatever the viewer has
 * drilled into (`?fl=`) narrowed by their instrument visibility scope.
 *
 * Design: docs/superpowers/specs/2026-08-28-dashboard-aggregate-widgets-design.md
 *
 * **EVERY VALUE THIS RETURNS IS DERIVED.** Not one of them is a stored reading. The
 * card that draws them says so on its face, for the same reason the trend page
 * labels a bucket-averaged chart and refuses to let `lttb()` invent a point: a
 * computed value that looks like a recorded one is a misrepresentation on a 21 CFR
 * Part 11 system, not a presentational shortcut.
 *
 * Raw SQL because `instrument_telemetry_history` is PARTITIONED, which Prisma
 * cannot express — the same reason room-history.ts and telemetry.repository.ts are
 * raw.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { withVisibility, type ScopeWhere } from './visibility.js';
import { NUMERIC_READING } from './telemetry.repository.js';
import { limitsFor } from '../alarms/load-limits.js';
import { slotConfigLookup } from './profile-measurements.js';
import { WINDOW_SPEC, type HistoryWindow } from '../floorplans/room-history.js';
import { resolveLocationIds, type FlNode } from '../functional-locations/tree.js';

// `NUMERIC_READING` is the ONE SQL definition of a reading (see its comment in
// telemetry.repository.ts). This file carried its own number-only copy until
// audit 2026-10-03 INGEST-9, and the gateway-fed instruments — quoted readings
// — were missing from the trend card while the table beside it showed them.

export type AggregateSlot = 'temperature' | 'humidity';

/** One row as Postgres returns it. `instrumentCount` arrives as a BigInt. */
export interface AggregateRow {
  ts: Date;
  slot: AggregateSlot;
  min: number | null;
  avg: number | null;
  max: number | null;
  instrumentCount: bigint;
}

export interface AggregatePoint {
  ts: string;
  min: number;
  mean: number;
  max: number;
  /**
   * How many instruments reported in THIS bucket.
   *
   * Load-bearing, not decoration. If instruments go offline the band narrows, and
   * a narrowing band reads as "conditions stabilised" when it means "we are
   * hearing from fewer sensors". A chart that cannot tell those apart is worse
   * than no chart, so this ships and the card shows it.
   */
  instrumentCount: number;
}

export interface AggregateBounds { min: number | null; max: number | null }

/**
 * The bound shared by EVERY instrument in the selection, or null when they differ.
 *
 * Instruments carry their own limits — that is the whole point of `limitsFor`
 * resolving per instrument, and this database already holds instruments whose own
 * attributes override their room's. Drawing the first instrument's limits across a
 * mixed selection would be a false claim about every other instrument on the
 * chart, and it is the easy thing to do by accident.
 *
 * An instrument with NO bound makes the selection mixed rather than agreeing: a
 * line drawn then would assert a bound for an instrument that has none.
 *
 * `0` is a REAL bound. Comparisons are `===`, never truthiness.
 */
export function limitsAgree(perInstrument: AggregateBounds[]): AggregateBounds | null {
  if (perInstrument.length === 0) return null;
  const [first, ...rest] = perInstrument;
  if (first.min === null && first.max === null) return null;
  for (const b of rest) {
    if (b.min !== first.min || b.max !== first.max) return null;
  }
  return { min: first.min, max: first.max };
}

/**
 * Rows into per-slot series.
 *
 * The BigInt conversion is the point. Postgres `count()` comes back as a BigInt
 * through Prisma raw queries and `JSON.stringify` THROWS on BigInt — a 500 at
 * serialisation time, long after the query itself looked healthy.
 */
export function shapeBuckets(rows: AggregateRow[]): Record<AggregateSlot, AggregatePoint[]> {
  const out: Record<AggregateSlot, AggregatePoint[]> = { temperature: [], humidity: [] };
  for (const r of rows) {
    if (r.min === null || r.avg === null || r.max === null) continue;
    out[r.slot].push({
      ts: r.ts.toISOString(),
      min: r.min,
      mean: r.avg,
      max: r.max,
      instrumentCount: Number(r.instrumentCount),
    });
  }
  return out;
}

export interface AggregateOptions {
  functionalLocationId?: string;
  /** True = that location's OWN instruments only, not its Areas'. */
  direct?: boolean;
  window: HistoryWindow;
  visibility?: ScopeWhere;
}

export interface AggregateResult {
  from: string;
  to: string;
  bucketSeconds: number | null;
  instrumentCount: number;
  series: Record<AggregateSlot, AggregatePoint[]>;
  limits: { temperature: AggregateBounds | null; humidity: AggregateBounds | null };
  /** True when the selection's instruments do NOT share a bound for that slot. */
  limitsMixed: { temperature: boolean; humidity: boolean };
}

export async function getTelemetryAggregate(opts: AggregateOptions): Promise<AggregateResult> {
  const spec = WINDOW_SPEC[opts.window];
  const to = new Date();
  const from = new Date(to.getTime() - spec.ms);
  const empty = (): AggregateResult => ({
    from: from.toISOString(), to: to.toISOString(), bucketSeconds: spec.bucketSec,
    instrumentCount: 0,
    series: { temperature: [], humidity: [] },
    limits: { temperature: null, humidity: null },
    limitsMixed: { temperature: false, humidity: false },
  });

  // The selection, resolved the SAME way the drill-down and every other location
  // filter resolve it: a Block covers its Areas via resolveLocationIds. Querying
  // functionalLocationId directly would silently omit the Areas.
  let selection: object = {};
  if (opts.functionalLocationId) {
    if (opts.direct) {
      selection = { functionalLocationId: opts.functionalLocationId };
    } else {
      const nodes = await prisma.functionalLocation.findMany({
        select: { id: true, name: true, type: true, parentId: true },
      });
      const ids = resolveLocationIds(opts.functionalLocationId, nodes as FlNode[]);
      selection = { functionalLocationId: { in: ids } };
    }
  }

  // Visibility is applied to the INSTRUMENT SET, never to the rows that come back:
  // every reading below is selected by `instrument_id = ANY(ids)`, and `ids` comes
  // from this one query. Filtering afterwards would still have read an
  // out-of-scope instrument's readings out of the database.
  const instruments = await prisma.instrument.findMany({
    where: withVisibility(selection, opts.visibility) as object,
    select: { id: true, profileId: true, attributes: { select: { key: true, value: true } } },
  });
  if (instruments.length === 0) return empty();

  // Which key is which slot is each instrument's PROFILE's (2026-10-26), so the
  // mapping is per instrument: one (instrument, key, slot) row per device-key
  // alias, joined in SQL below. A single fleet-wide "temperature keys" list
  // would read an instrument through another profile's keys.
  const slotOf = await slotConfigLookup();
  const mIds: string[] = [];
  const mKeys: string[] = [];
  const mSlots: AggregateSlot[] = [];
  for (const i of instruments) {
    const { aliases } = slotOf(i.profileId);
    for (const s of ['temperature', 'humidity'] as const) {
      for (const k of aliases[s]) { mIds.push(i.id); mKeys.push(k.toLowerCase()); mSlots.push(s); }
    }
  }
  if (mKeys.length === 0) return empty();

  const ids = instruments.map((i) => i.id);
  const resolved = instruments.map((i) => limitsFor(slotOf(i.profileId).limitKeys, i.attributes).limits);
  const tempBounds = limitsAgree(resolved.map((l) => ({ min: l.temperatureLow, max: l.temperatureHigh })));
  const humidBounds = limitsAgree(resolved.map((l) => ({ min: l.humidityLow, max: l.humidityHigh })));
  const anyTemp = resolved.some((l) => l.temperatureLow !== null || l.temperatureHigh !== null);
  const anyHumid = resolved.some((l) => l.humidityLow !== null || l.humidityHigh !== null);

  // `bucketSec === null` means the window is short enough to group by the raw
  // timestamp: still an aggregate across instruments, just not across time.
  const bucket = spec.bucketSec;
  const bucketExpr = bucket === null
    ? Prisma.sql`ts`
    : Prisma.sql`to_timestamp(floor(extract(epoch FROM ts) / ${bucket}) * ${bucket})`;

  const rows = await prisma.$queryRaw<AggregateRow[]>`
    WITH m AS (
      SELECT * FROM unnest(${mIds}::text[], ${mKeys}::text[], ${mSlots}::text[]) AS m(instrument_id, mkey, slot)
    )
    SELECT ${bucketExpr} AS ts,
           m.slot AS slot,
           min(${NUMERIC_READING}) AS min,
           avg(${NUMERIC_READING}) AS avg,
           max(${NUMERIC_READING}) AS max,
           count(DISTINCT h.instrument_id) AS "instrumentCount"
    FROM instrument_telemetry_history h
    JOIN m ON m.instrument_id = h.instrument_id AND m.mkey = lower(h.key)
    WHERE h.instrument_id = ANY(${ids}::text[])
      AND ts >= ${from} AND ts <= ${to}
      AND ${NUMERIC_READING} IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1 ASC`;

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    bucketSeconds: spec.bucketSec,
    instrumentCount: instruments.length,
    series: shapeBuckets(rows),
    limits: { temperature: tempBounds, humidity: humidBounds },
    // "Mixed" only means something when SOMETHING is bounded. A selection where
    // nobody has limits is not mixed; it is unbounded, and saying "these
    // instruments have different limits" there would be untrue.
    limitsMixed: {
      temperature: tempBounds === null && anyTemp,
      humidity: humidBounds === null && anyHumid,
    },
  };
}
