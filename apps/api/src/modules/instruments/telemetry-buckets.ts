/**
 * Readings binned into LOCAL hours, days or weeks — the dashboard's bar chart
 * (dashboard builder phase 2, 2026-10-30).
 *
 * **EVERY VALUE THIS RETURNS IS DERIVED.** An hourly average is not a reading,
 * and the widget says so on its face ("Hourly average", "from N readings"), for
 * the same reason `telemetry-aggregate.ts` labels its band: a computed value that
 * looks like a recorded one is a misrepresentation on a 21 CFR Part 11 system.
 * `readings` (and `instruments`) ride on every point so the face can say what
 * the bar was computed from. A bucket with no reading has NO point — the web
 * draws a gap; a zero here would be a reading nobody took.
 *
 * Bucket edges are LOCAL to the `datetime` config's timezone: a day starts at
 * local midnight and a week on a local Monday. A reading at 23:00Z on an
 * Asia/Kolkata install is 04:30 the NEXT local day, and its bar is that day's.
 * Binning on UTC would put it in the wrong day's bar and put every hourly edge
 * on :30 local.
 *
 * Raw SQL because `instrument_telemetry_history` is PARTITIONED, which Prisma
 * cannot express — the same reason `telemetry-aggregate.ts` and
 * `telemetry.repository.ts` are raw.
 */
import { Prisma } from '@prisma/client';
import type { WIDGET_BAR_AGGS, WIDGET_BAR_BUCKETS, WIDGET_BAR_GROUPS } from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { getDatetimeConfig } from '../../lib/format-datetime.js';
import { NUMERIC_READING } from './telemetry.repository.js';

export type BarBucket = (typeof WIDGET_BAR_BUCKETS)[number];
export type BarAgg = (typeof WIDGET_BAR_AGGS)[number];
export type BarGroup = (typeof WIDGET_BAR_GROUPS)[number];

/** The most buckets one request may span. */
export const BUCKETS_MAX = 1000;

export const BUCKET_SECONDS: Record<BarBucket, number> = { hour: 3600, day: 86400, week: 604800 };

/**
 * What `date_bin` steps by. Bound as a parameter (`::interval`), never
 * interpolated; these three strings are the only values it can take.
 */
const BUCKET_INTERVAL: Record<BarBucket, string> = { hour: '1 hour', day: '1 day', week: '7 days' };

const BUCKET_UNIT: Record<BarBucket, string> = { hour: 'hours', day: 'days', week: 'weeks' };

/**
 * The aggregate over the reading. A function name cannot be a bound parameter,
 * so it is chosen from this fixed map by the (schema-validated) `agg`. `count`
 * is the number of NUMERIC readings: the WHERE clause already excludes the rest.
 */
const AGG_SQL: Record<BarAgg, Prisma.Sql> = {
  avg: Prisma.sql`avg(${NUMERIC_READING})`,
  min: Prisma.sql`min(${NUMERIC_READING})`,
  max: Prisma.sql`max(${NUMERIC_READING})`,
  count: Prisma.sql`count(*)`,
};

/**
 * "That window holds more than 1,000 hours; …", or null when the window fits.
 * Counted as `ceil((to - from) / bucket)`: the request's size, not the number of
 * points that will come back (a bucket with no reading has none).
 */
export function bucketCapError(from: Date, to: Date, bucket: BarBucket): string | null {
  const n = Math.ceil((to.getTime() - from.getTime()) / 1000 / BUCKET_SECONDS[bucket]);
  if (n <= BUCKETS_MAX) return null;
  return `That window holds more than 1,000 ${BUCKET_UNIT[bucket]}; choose a larger bucket or a shorter window`;
}

/**
 * Whether Postgres knows `tz` as a NAMED zone, cached per string (the catalogue
 * scan takes ~200 ms here; the answer does not change while the process runs).
 *
 * Checked against `pg_timezone_names`, not `Intl`, because Postgres is the one
 * applying it. The two disagree where it matters: `Intl` accepts `+05:30` as
 * UTC+05:30, while Postgres reads a bare offset as a POSIX zone with the sign
 * INVERTED (UTC-05:30) — every bucket edge would move eleven hours. Exact match:
 * the config writer stores the canonical name.
 */
const knownZone = new Map<string, boolean>();
async function isNamedZone(tz: unknown): Promise<boolean> {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  const cached = knownZone.get(tz);
  if (cached !== undefined) return cached;
  const [{ ok }] = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ${tz}) AS ok`;
  knownZone.set(tz, ok);
  return ok;
}

/**
 * The zone bucket edges are local to: the `datetime` config's `timezone`, read
 * through `getDatetimeConfig()` — the server's one reader of that row, the one
 * notifications format with. (`GET /api/config/datetime/current` parses the same
 * row through the shared schema, whose `timezone` is the literal `Asia/Kolkata`,
 * so a stored zone that is not Kolkata reads there as Kolkata; the config's own
 * PUT refuses any other, so through the API the two agree.)
 *
 * An unknown zone is `UTC`, and the response says `timezone: 'UTC'` — the same
 * fallback `formatConfiguredDateTime` makes for an invalid zone.
 */
export async function bucketTimezone(): Promise<string> {
  const { timezone } = await getDatetimeConfig();
  return (await isNamedZone(timezone)) ? timezone : 'UTC';
}

export interface BucketPoint {
  /** The bucket's START, a UTC instant. */
  ts: string;
  value: number;
  /** How many numeric readings the value was computed from. */
  readings: number;
  /** How many instruments contributed to this bucket (always 1 by instrument). */
  instruments: number;
}

export interface BucketSeries {
  /** `null` = aggregated across every instrument asked for (`groupBy=all`). */
  instrumentId: string | null;
  key: string;
  points: BucketPoint[];
}

interface BucketRow {
  ts: Date;
  key: string;
  instrumentId: string | null;
  value: number | bigint | null;
  readings: bigint;
  instruments: bigint;
}

export interface BucketOptions {
  /** Already reduced to the caller's visible instruments. */
  instrumentIds: string[];
  /** Matched EXACTLY, as stored — `T` and `t` are two keys. */
  keys: string[];
  from: Date;
  to: Date;
  bucket: BarBucket;
  agg: BarAgg;
  groupBy: BarGroup;
  timezone: string;
}

/**
 * The binned series, ordered as asked: by instrument (in `instrumentIds` order)
 * then by key (in `keys` order), so a series keeps its colour between refreshes.
 * A series exists only when it has at least one point, in BOTH modes — an empty
 * one would be a bar the server invented the absence of; `series: []` is "no
 * readings in this window".
 */
export async function getTelemetryBuckets(opts: BucketOptions): Promise<BucketSeries[]> {
  if (opts.instrumentIds.length === 0 || opts.keys.length === 0) return [];

  // Local binning. `ts AT TIME ZONE $tz` is the local wall-clock time (a
  // `timestamp`), `date_bin` steps it from a local Monday midnight (2000-01-03
  // was a Monday, so weeks start Monday), and `AT TIME ZONE $tz` turns the local
  // bucket start back into an instant. The origin is a plain TIMESTAMP so the
  // `timestamp` overload is used throughout — the SESSION TimeZone never enters
  // (on this machine it is Asia/Calcutta, on RDS UTC). Verified against
  // Postgres 18 on America/New_York: day and week edges stay on local midnight
  // across a DST change (a day bucket is then 23 or 25 hours long), and on the
  // fall-back night both local 01:00 hours fall in ONE hourly bucket, stamped
  // with the later instant. India has no DST.
  const tz = Prisma.sql`${opts.timezone}::text`;
  const bin = Prisma.sql`date_bin(${BUCKET_INTERVAL[opts.bucket]}::interval, h.ts AT TIME ZONE ${tz}, TIMESTAMP '2000-01-03 00:00:00') AT TIME ZONE ${tz}`;
  const byInstrument = opts.groupBy === 'instrument';

  // Filtered on the RAW `ts` with the same inclusive bounds and the same exact
  // `key IN (…)` as `getHistory`, so a bar and a trend line on one widget key
  // read the same rows — and the partition bounds still prune. GROUP BY by
  // ordinal: Prisma gives every `${}` its own placeholder, so repeating the bin
  // expression there would not match the SELECT's.
  const rows = await prisma.$queryRaw<BucketRow[]>`
    SELECT ${bin} AS ts,
           h.key AS key,
           ${byInstrument ? Prisma.sql`h.instrument_id` : Prisma.sql`NULL::text`} AS "instrumentId",
           ${AGG_SQL[opts.agg]} AS value,
           count(*) AS readings,
           count(DISTINCT h.instrument_id) AS instruments
    FROM instrument_telemetry_history h
    WHERE h.instrument_id IN (${Prisma.join(opts.instrumentIds)})
      AND h.key IN (${Prisma.join(opts.keys)})
      AND h.ts >= ${opts.from} AND h.ts <= ${opts.to}
      AND ${NUMERIC_READING} IS NOT NULL
    GROUP BY 1, 2, 3
    ORDER BY 1 ASC`;

  // Postgres `count()` arrives as a BigInt, and JSON.stringify THROWS on one —
  // a 500 at serialisation, long after the query looked healthy.
  const bySeries = new Map<string, BucketPoint[]>();
  for (const r of rows) {
    if (r.value === null) continue;
    const id = `${r.instrumentId ?? ''}\u0000${r.key}`;
    const points = bySeries.get(id) ?? [];
    points.push({
      ts: r.ts.toISOString(),
      value: Number(r.value),
      readings: Number(r.readings),
      instruments: Number(r.instruments),
    });
    bySeries.set(id, points);
  }

  const owners: (string | null)[] = byInstrument ? opts.instrumentIds : [null];
  const out: BucketSeries[] = [];
  for (const instrumentId of owners) {
    for (const key of opts.keys) {
      const points = bySeries.get(`${instrumentId ?? ''}\u0000${key}`);
      if (points && points.length > 0) out.push({ instrumentId, key, points });
    }
  }
  return out;
}
