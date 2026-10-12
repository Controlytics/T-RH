/**
 * Telemetry persistence — the ONLY file in this module containing raw SQL.
 *
 * Raw because:
 *  - the history table is PARTITIONED, which Prisma cannot express, and
 *  - ingest writes must be BATCHED; one Prisma call per reading will not survive
 *    a real fleet.
 *
 * NOTE: telemetry writes are deliberately NOT audited (spec D5). Telemetry is
 * process data, not a 21 CFR §11 electronic record. Do not add auditLog() here.
 *
 * Ported from the pre-data-injection-drop tag's `data-injection/telemetry.repository.ts`
 * and adapted to the CURRENT schema (see apps/api/prisma/schema.prisma +
 * migrations/20260804120000_instruments_p1/migration.sql):
 *  - `instrument_telemetry_latest` / `instrument_telemetry_history` have only
 *    (instrument_id, key, value, value_type, ts) — no `quality` or
 *    `received_at` columns, so those are not written here even though
 *    `Reading.quality` still exists as an optional field on the type.
 *  - `dead_letters` columns are (id, instrument_id, transport, reason,
 *    raw_payload, received_at) — no `topic`/`payload`/`detail`/`protocolKey`
 *    columns, so `writeDeadLetters` takes rows shaped for the current model.
 *  - `writeBatch` takes a flat array of readings (each carrying its own
 *    `instrumentId`) rather than `(batches, receivedAt)` — matching how
 *    Task 5's ingest route calls it and how the DB has no `received_at` to
 *    stamp on telemetry rows.
 */
import { Prisma } from '@prisma/client';
import { MKT_DELTA_H_OVER_R_K, KELVIN_OFFSET } from '@digilog/shared';
import { resolvePageSize } from '../../lib/page-size.js';
import { prisma } from '../../lib/prisma.js';
import type { Reading } from './payload-parser.js';

export interface TelemetryRow {
  key: string;
  value: unknown;
  valueType: string;
  ts: Date;
}

/**
 * The ONE SQL definition of "this stored `value` is a reading", as a float8 or
 * NULL — the SQL half of `coerceReading` in @digilog/shared.
 *
 * Casts inside a CASE, never a bare `::float8`: telemetry `value` is jsonb and
 * this database really contains a non-numeric one (a device sent the string
 * "hello"). A `WHERE jsonb_typeof(value) = 'number'` is NOT a reliable guard —
 * Postgres does not promise the filter runs before the projection, so a query
 * passes under one plan and fails under another. CASE guarantees the order.
 *
 * A QUOTED number counts too (operator, 2026-08-31). The regex is
 * `coerceReading`'s NUMERIC_STRING: if you widen one, widen the other, or the
 * SQL population and the chart drawn from the same range would disagree.
 *
 * Shared by `getRangeSummary` here, `telemetry-aggregate.ts` (the dashboard's
 * trend card) and `floorplans/room-history.ts` (audit 2026-10-03, INGEST-9):
 * each of those carried its own `jsonb_typeof(value) = 'number'` copy, so the
 * gateway-fed instruments — whose firmware quotes every reading — vanished from
 * the trend card and the room history while the table beside them showed the
 * readings. A reading filter belongs in `WHERE ${NUMERIC_READING} IS NOT NULL`,
 * never in a second `jsonb_typeof` test.
 */
export const NUMERIC_READING = Prisma.sql`CASE
    WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::float8
    WHEN jsonb_typeof(value) = 'string'
      AND btrim(value #>> '{}') ~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)$'
      THEN btrim(value #>> '{}')::float8
  END`;

/**
 * TWO READINGS AT ONE INSTANT: THE LAST ONE IN ARRIVAL ORDER WINS, EVERYWHERE
 * (audit 2026-10-03, INGEST-14). Until then history kept the FIRST (`ON
 * CONFLICT DO NOTHING`) while `latest` kept the LAST (`ts <= EXCLUDED.ts`), so
 * a device stamping whole seconds that sent two values inside one second
 * showed the second on the dashboard and printed the first in every report.
 * Nothing is dead-lettered: a same-instant pair is ordinary behaviour for a
 * coarse clock, not a fault, and the rule is stated here rather than recorded
 * per occurrence. Redelivery of the SAME reading remains idempotent — the
 * update writes the value it already holds.
 *
 * Collapsed to one row per (instrument, key, ts) BEFORE the INSERT, because
 * Postgres refuses an ON CONFLICT DO UPDATE whose VALUES carry the same
 * conflict target twice ("cannot affect row a second time") — and that would
 * discard the whole batch, not the duplicate.
 */
export function lastPerInstant<R extends { instrumentId: string; key: string; ts: Date }>(rows: R[]): R[] {
  const byInstant = new Map<string, R>();
  for (const r of rows) byInstant.set(`${r.instrumentId}|${r.key}|${r.ts.getTime()}`, r);
  return [...byInstant.values()];
}

export async function writeBatch(
  rows: (Reading & { instrumentId: string })[],
): Promise<void> {
  if (rows.length === 0) return;

  // `raw_value` is what the device sent when a sensor offset corrected the
  // reading (2026-10-01) — kept for the record, NULL otherwise, never shown.
  const histValues = Prisma.join(lastPerInstant(rows).map((r) => Prisma.sql`(
    ${r.instrumentId}, ${r.key}, ${JSON.stringify(r.value)}::jsonb, ${r.valueType}, ${r.ts},
    ${r.rawValue === undefined ? null : JSON.stringify(r.rawValue)}::jsonb)`));

  // Collapse to ONE row per (instrument, key), keeping the newest ts — and on
  // a tie the LAST in arrival order, the same rule `lastPerInstant` applies to
  // history, so the two tables cannot disagree about one instant.
  //
  // Not an optimisation — a correctness requirement. Postgres rejects an
  // INSERT ... ON CONFLICT DO UPDATE whose VALUES contain the same conflict
  // target twice:
  //   ERROR: ON CONFLICT DO UPDATE command cannot affect row a second time
  // A single writeBatch call can carry several readings for the same
  // (instrument, key) — e.g. a batch payload keyed by device — so without
  // this collapse a duplicate would discard EVERY reading in the batch, not
  // just its own.
  const newestPerKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.instrumentId}|${r.key}`;
    const prev = newestPerKey.get(k);
    if (!prev || r.ts >= prev.ts) newestPerKey.set(k, r);
  }

  const latestValues = Prisma.join([...newestPerKey.values()].map((r) => Prisma.sql`(
    ${r.instrumentId}, ${r.key}, ${JSON.stringify(r.value)}::jsonb, ${r.valueType}, ${r.ts})`));

  await prisma.$transaction([
    // Same (instrument, key, ts) again → the LAST arrival wins (see
    // `lastPerInstant`). An identical redelivery rewrites the row with the
    // value it already holds, so history stays idempotent under QoS 1.
    prisma.$executeRaw`
      INSERT INTO instrument_telemetry_history
        (instrument_id, key, value, value_type, ts, raw_value)
      VALUES ${histValues}
      ON CONFLICT (instrument_id, key, ts) DO UPDATE SET
        value = EXCLUDED.value, value_type = EXCLUDED.value_type, raw_value = EXCLUDED.raw_value`,
    prisma.$executeRaw`
      INSERT INTO instrument_telemetry_latest
        (instrument_id, key, value, value_type, ts)
      VALUES ${latestValues}
      ON CONFLICT (instrument_id, key) DO UPDATE SET
        value = EXCLUDED.value, value_type = EXCLUDED.value_type, ts = EXCLUDED.ts
      WHERE instrument_telemetry_latest.ts <= EXCLUDED.ts`,
    // The WHERE guard stops an out-of-order arrival overwriting a NEWER value;
    // `<=`, not `<`, is what lets the last arrival at one instant win here too.
  ]);
}

export async function getLatest(instrumentId: string): Promise<TelemetryRow[]> {
  return prisma.$queryRaw<TelemetryRow[]>`
    SELECT key, value, value_type AS "valueType", ts
    FROM instrument_telemetry_latest
    WHERE instrument_id = ${instrumentId}
    ORDER BY key`;
}

export async function getHistory(opts: {
  instrumentId: string; key?: string; from?: Date; to?: Date; limit?: number; offset?: number;
}): Promise<{ rows: TelemetryRow[]; total: number }> {
  // NO ceiling (operator, 2026-09-02). This `Math.min(…, 1000)` is the exact cap
  // recorded in CLAUDE.md as the trend page's truncation defect: with `ORDER BY ts
  // DESC` it silently returned the newest 1,000 readings for ANY range, so a 7-day
  // chart plotted roughly the last day while the axis claimed a week. The chart was
  // given its own `points` path to escape it; the TABLE path was left capped.
  // `total` is the true count in range and is returned beside the rows.
  const limit = resolvePageSize(opts.limit, 100);
  const offset = opts.offset ?? 0;
  const where = Prisma.sql`
    WHERE instrument_id = ${opts.instrumentId}
    ${opts.key ? Prisma.sql`AND key = ${opts.key}` : Prisma.empty}
    ${opts.from ? Prisma.sql`AND ts >= ${opts.from}` : Prisma.empty}
    ${opts.to ? Prisma.sql`AND ts <= ${opts.to}` : Prisma.empty}`;

  const rows = await prisma.$queryRaw<TelemetryRow[]>`
    SELECT key, value, value_type AS "valueType", ts
    FROM instrument_telemetry_history ${where}
    ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}`;

  const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM instrument_telemetry_history ${where}`;

  return { rows, total: Number(count) };
}

/** One stored instant of one instrument: every key it reported at that `ts`. */
export interface MultiHistoryRow {
  instrumentId: string;
  ts: Date;
  /** `{ key: stored value }` — the raw JSON values, exactly as ingested. */
  values: Record<string, unknown>;
}

/**
 * The merged readings of SEVERAL instruments, newest first, paged — the
 * Instruments page's history widget (2026-09-05).
 *
 * Pivoted in SQL, one row per (instrument, ts), so a page boundary can never
 * split a temperature from the humidity reported at the same instant — paging
 * the long rows and pivoting in the browser would print half a reading at the
 * foot of one page and the other half at the head of the next. `total` counts
 * the same (instrument, ts) groups, so the pager describes the rows it pages.
 *
 * Values are returned RAW and unfiltered by key: which key is this
 * instrument's temperature is resolved by `telemetry-overview` per instrument,
 * and the caller reads it from there. Filtering here by a site-wide alias list
 * would silently drop an instrument whose keys have drifted.
 *
 * The caller has ALREADY reduced `instrumentIds` to the ones the user may see
 * (visibility is applied to the id set in the route); this function trusts
 * the list it is given. An empty list returns nothing rather than everything.
 */
export async function getMultiInstrumentHistory(opts: {
  instrumentIds: string[]; from?: Date; to?: Date; limit?: number; offset?: number;
}): Promise<{ rows: MultiHistoryRow[]; total: number }> {
  if (opts.instrumentIds.length === 0) return { rows: [], total: 0 };
  const limit = resolvePageSize(opts.limit, 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = Prisma.sql`
    WHERE instrument_id IN (${Prisma.join(opts.instrumentIds)})
    ${opts.from ? Prisma.sql`AND ts >= ${opts.from}` : Prisma.empty}
    ${opts.to ? Prisma.sql`AND ts <= ${opts.to}` : Prisma.empty}`;

  const rows = await prisma.$queryRaw<MultiHistoryRow[]>`
    SELECT instrument_id AS "instrumentId", ts, jsonb_object_agg(key, value) AS values
    FROM instrument_telemetry_history ${where}
    GROUP BY instrument_id, ts
    ORDER BY ts DESC, instrument_id
    LIMIT ${limit} OFFSET ${offset}`;

  const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM (
      SELECT 1 FROM instrument_telemetry_history ${where} GROUP BY instrument_id, ts
    ) AS instants`;

  return { rows, total: Number(count) };
}

/**
 * The keys this instrument has ACTUALLY sent, newest activity first.
 *
 * The trend page's "add a key" picker offers these and nothing else: ingest
 * stores whatever key a device sends, so a free-text field would invite a key
 * that has never existed and a widget that can never draw.
 */
export async function getDistinctKeys(instrumentId: string): Promise<{ key: string; lastSeen: Date }[]> {
  return prisma.$queryRaw<{ key: string; lastSeen: Date }[]>`
    SELECT key, max(ts) AS "lastSeen"
    FROM instrument_telemetry_history
    WHERE instrument_id = ${instrumentId}
    GROUP BY key
    ORDER BY max(ts) DESC`;
}

export async function writeDeadLetters(
  rows: { id?: string; instrumentId: string | null; transport: string; reason: string; rawPayload?: string | null }[],
): Promise<void> {
  if (rows.length === 0) return;
  await prisma.deadLetter.createMany({
    data: rows.map((r) => ({
      ...(r.id ? { id: r.id } : {}),
      instrumentId: r.instrumentId,
      transport: r.transport,
      reason: r.reason,
      rawPayload: r.rawPayload ?? null,
    })),
  });
}

export interface RangeSummary {
  count: number; min: number; max: number; avg: number; first: Date; last: Date;
  /**
   * Readings in the range that carry a NUMBER, which is the population every
   * other number here is computed over — min/max/avg skip a non-numeric value
   * and so do the two breach counts. `count` counts every stored value,
   * numeric or not, and the two can legitimately differ.
   *
   * Kept separate rather than folded into `count` because the trend page's
   * "Showing N of M readings" note is written against `count`'s no-guard
   * meaning: narrowing it there would make the page claim readings had been
   * sampled away when the only thing missing was a string.
   */
  numericCount: number;
  /**
   * Readings strictly below / above the bound the caller passed, over the WHOLE
   * range — not over whatever the sampler drew.
   *
   * `null` means NO BOUND WAS GIVEN, which is a different statement from `0`.
   * Zero says "checked, nothing breached"; null says "nothing was checked", and
   * a §11 record that prints the first when the second is true claims
   * compliance the data cannot support. Callers must keep the distinction.
   */
  belowCount: number | null;
  aboveCount: number | null;
  /** Sum of the bounds that WERE given; null only when neither was. */
  outOfSpecCount: number | null;
  /**
   * The MEAN of exp(-10000 / (reading + 273.15)) over every numeric reading in
   * the range — the Mean Kinetic Temperature's inner sum (ICH Q1A / USP
   * <1150>), computed here for the same reason `max` is: MKT over the printed
   * interval rows would miss the hot readings between them. Turned into
   * degrees by `mktFromExpMean` in @digilog/shared. Only meaningful for a
   * temperature key in °C; the ROUTE decides whether to expose it. Null when
   * no reading is above absolute zero.
   */
  mktExpMean: number | null;
}

/**
 * Aggregates over EVERY reading in the range, for one key.
 *
 * SEPARATE from the row query on purpose, and this is the point of the whole
 * design: the chart may be showing a SAMPLED subset, and a max computed from that
 * subset would silently understate an excursion — a 34 °C spike the sampler did not
 * pick would simply not appear in "Maximum" on a regulated record. These numbers
 * come from SQL over the full range, always.
 *
 * `count` is every reading in the range; the min/max/avg aggregates SKIP
 * non-numeric readings (see the cast below), so the two can legitimately
 * disagree on an instrument that has sent a string. `numericCount` is the
 * population they DO cover, and the denominator a breach count must be printed
 * against.
 *
 * The two BREACH counts are here for the same reason the max is: the signed
 * trend report prints "N readings out of limit", and an N counted over the
 * sampled rows understates an excursion the sampler skipped. They are counted
 * in the same single pass, against bounds the CALLER resolved.
 *
 * `NUMERIC_READING` (above) is the cast: a CASE, never a bare `::float8`, for
 * the reason recorded on it, and the same expression in the FILTER as in the
 * aggregates — a bare cast in the filter would throw on this database's one
 * non-numeric reading under any plan that projects before it filters.
 */
export async function getRangeSummary(opts: {
  instrumentId: string; key: string; from?: Date; to?: Date;
  /** Resolved limits for this key, or null/undefined where the instrument (and
   *  its room) declares none. Passed in already resolved — this file must never
   *  work out which attribute is a limit. */
  low?: number | null; high?: number | null;
}): Promise<RangeSummary | null> {
  const numeric = NUMERIC_READING;
  const below = opts.low == null
    ? Prisma.sql`NULL::bigint`
    : Prisma.sql`count(*) FILTER (WHERE ${numeric} < ${opts.low})::bigint`;
  const above = opts.high == null
    ? Prisma.sql`NULL::bigint`
    : Prisma.sql`count(*) FILTER (WHERE ${numeric} > ${opts.high})::bigint`;

  const rows = await prisma.$queryRaw<{
    count: bigint; numericCount: bigint; min: number | null; max: number | null; avg: number | null;
    first: Date | null; last: Date | null;
    belowCount: bigint | null; aboveCount: bigint | null;
    mktExpMean: number | null;
  }[]>`
    SELECT count(*)::bigint AS count,
           count(${numeric})::bigint AS "numericCount",
           min(${numeric}) AS min,
           max(${numeric}) AS max,
           avg(${numeric}) AS avg,
           min(ts) AS first,
           max(ts) AS last,
           ${below} AS "belowCount",
           ${above} AS "aboveCount",
           -- Below 15 K the term exp(-10000 / T) is under 1e-289 and Postgres
           -- raises "value out of range: underflow" near 14 K (audit
           -- 2026-10-12 #8): a sensor-fault reading 500'd the summary. The
           -- term is ~0 there, so it is counted as 0, exactly what the pure
           -- reference mktCelsius gets from Math.exp.
           avg(CASE WHEN ${numeric} + ${KELVIN_OFFSET}::float8 < 15::float8 THEN 0::float8
                    ELSE exp(-${MKT_DELTA_H_OVER_R_K}::float8 / (${numeric} + ${KELVIN_OFFSET}::float8)) END)
             FILTER (WHERE ${numeric} > -${KELVIN_OFFSET}::float8) AS "mktExpMean"
    FROM instrument_telemetry_history
    WHERE instrument_id = ${opts.instrumentId}
      AND key = ${opts.key}
      ${opts.from ? Prisma.sql`AND ts >= ${opts.from}` : Prisma.empty}
      ${opts.to ? Prisma.sql`AND ts <= ${opts.to}` : Prisma.empty}`;

  const r = rows[0];
  if (!r || Number(r.count) === 0 || r.min === null || r.max === null || r.avg === null || !r.first || !r.last) {
    return null;
  }
  const belowCount = r.belowCount === null ? null : Number(r.belowCount);
  const aboveCount = r.aboveCount === null ? null : Number(r.aboveCount);
  return {
    count: Number(r.count),
    numericCount: Number(r.numericCount),
    min: r.min, max: r.max, avg: r.avg, first: r.first, last: r.last,
    belowCount,
    aboveCount,
    // Null ONLY when neither bound was given. With one bound set the total is
    // the breaches against THAT bound — a real, checked number — and the
    // report says which bound it was assessed against.
    outOfSpecCount: belowCount === null && aboveCount === null ? null : (belowCount ?? 0) + (aboveCount ?? 0),
    mktExpMean: r.mktExpMean,
  };
}

/**
 * The reading count a chart response reports for one key.
 *
 * ALWAYS the summary's own `count(*)` where there is one. `getRangeRows` slices
 * to `hardCap`, so its row count is a POST-SLICE number: if the cap ever fires,
 * reporting it would put "Showing 5,000 of 200,000" on screen and the same
 * understated denominator in a signed PDF, for a range holding more. That is a
 * false numeric statement about the record, not a display rounding.
 *
 * The two are byte-equivalent on every non-truncating call — `getRangeSummary`
 * counts `count(*)` with no numeric guard, exactly the rows `getRangeRows`
 * selects — so this changes nothing until the cap actually fires. The row count
 * remains the fallback for a key the summary returned nothing for (an empty
 * range), where both are 0.
 */
export function chartRangeTotal(summary: { count: number } | null, sliceLength: number): number {
  return summary?.count ?? sliceLength;
}

/**
 * Every reading in the range for one key, ASCENDING, bounded by `hardCap`.
 *
 * ASC, unlike getHistory's DESC: the sampler and the chart both need chronological
 * order, and reversing 30,000 rows in JS to undo a DESC is wasted work.
 *
 * `hardCap` is a backstop against an unbounded fetch, NOT the sampling target —
 * sampling happens after this returns. If the cap is hit the caller is told, so it
 * can never silently plot a truncated window the way the route did before 2026-08-27.
 */
export async function getRangeRows(opts: {
  instrumentId: string; key: string; from?: Date; to?: Date; hardCap: number;
}): Promise<{ rows: TelemetryRow[]; truncated: boolean }> {
  const rows = await prisma.$queryRaw<TelemetryRow[]>`
    SELECT key, value, value_type AS "valueType", ts
    FROM instrument_telemetry_history
    WHERE instrument_id = ${opts.instrumentId}
      AND key = ${opts.key}
      ${opts.from ? Prisma.sql`AND ts >= ${opts.from}` : Prisma.empty}
      ${opts.to ? Prisma.sql`AND ts <= ${opts.to}` : Prisma.empty}
    ORDER BY ts ASC LIMIT ${opts.hardCap + 1}`;

  const truncated = rows.length > opts.hardCap;
  return { rows: truncated ? rows.slice(0, opts.hardCap) : rows, truncated };
}
