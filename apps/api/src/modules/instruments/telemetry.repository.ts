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
