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
import { prisma } from '../../lib/prisma.js';
import type { Reading } from './payload-parser.js';

export interface TelemetryRow {
  key: string;
  value: unknown;
  valueType: string;
  ts: Date;
}

export async function writeBatch(
  rows: (Reading & { instrumentId: string })[],
): Promise<void> {
  if (rows.length === 0) return;

  const histValues = Prisma.join(rows.map((r) => Prisma.sql`(
    ${r.instrumentId}, ${r.key}, ${JSON.stringify(r.value)}::jsonb, ${r.valueType}, ${r.ts})`));

  // Collapse to ONE row per (instrument, key), keeping the newest ts.
  //
  // Not an optimisation — a correctness requirement. Postgres rejects an
  // INSERT ... ON CONFLICT DO UPDATE whose VALUES contain the same conflict
  // target twice:
  //   ERROR: ON CONFLICT DO UPDATE command cannot affect row a second time
  // A single writeBatch call can carry several readings for the same
  // (instrument, key) — e.g. a batch payload keyed by device — so without
  // this collapse a duplicate would discard EVERY reading in the batch, not
  // just its own.
  //
  // History is unaffected: it keeps every row, deduplicated on (instrument,
  // key, ts) by DO NOTHING.
  const newestPerKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.instrumentId}|${r.key}`;
    const prev = newestPerKey.get(k);
    if (!prev || r.ts >= prev.ts) newestPerKey.set(k, r);
  }

  const latestValues = Prisma.join([...newestPerKey.values()].map((r) => Prisma.sql`(
    ${r.instrumentId}, ${r.key}, ${JSON.stringify(r.value)}::jsonb, ${r.valueType}, ${r.ts})`));

  await prisma.$transaction([
    prisma.$executeRaw`
      INSERT INTO instrument_telemetry_history
        (instrument_id, key, value, value_type, ts)
      VALUES ${histValues}
      ON CONFLICT (instrument_id, key, ts) DO NOTHING`,
    // A device that re-sends the same (instrument, key, ts) is a duplicate, not
    // new information — DO NOTHING keeps history idempotent under redelivery.
    prisma.$executeRaw`
      INSERT INTO instrument_telemetry_latest
        (instrument_id, key, value, value_type, ts)
      VALUES ${latestValues}
      ON CONFLICT (instrument_id, key) DO UPDATE SET
        value = EXCLUDED.value, value_type = EXCLUDED.value_type, ts = EXCLUDED.ts
      WHERE instrument_telemetry_latest.ts <= EXCLUDED.ts`,
    // The WHERE guard stops an out-of-order arrival overwriting a NEWER value.
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
  const limit = Math.min(opts.limit ?? 100, 1000);
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
 * Casts inside a CASE, never a bare `::float8`: telemetry `value` is jsonb and this
 * database really contains a non-numeric one (a device sent the string "hello").
 * A WHERE on jsonb_typeof is NOT a reliable guard — Postgres does not promise the
 * filter runs before the projection, so the query passes under one plan and fails
 * under another. room-history.ts does the same thing for the same reason.
 */
export async function getRangeSummary(opts: {
  instrumentId: string; key: string; from?: Date; to?: Date;
  /** Resolved limits for this key, or null/undefined where the instrument (and
   *  its room) declares none. Passed in already resolved — this file must never
   *  work out which attribute is a limit. */
  low?: number | null; high?: number | null;
}): Promise<RangeSummary | null> {
  // The SAME `CASE`-wrapped cast the aggregates use, reused rather than
  // repeated: a bare `(value #>> '{}')::float8` in the FILTER would throw on
  // this database's one non-numeric reading under any plan that projects
  // before it filters.
  const numeric = Prisma.sql`CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::float8 END`;
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
  }[]>`
    SELECT count(*)::bigint AS count,
           count(${numeric})::bigint AS "numericCount",
           min(${numeric}) AS min,
           max(${numeric}) AS max,
           avg(${numeric}) AS avg,
           min(ts) AS first,
           max(ts) AS last,
           ${below} AS "belowCount",
           ${above} AS "aboveCount"
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
