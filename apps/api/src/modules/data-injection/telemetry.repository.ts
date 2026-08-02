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
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { Reading } from './payload-parser.js';

export interface TelemetryRow {
  key: string;
  value: unknown;
  valueType: string;
  quality: string | null;
  ts: Date;
  receivedAt: Date;
}

export async function writeBatch(
  batches: { instrumentId: string; readings: Reading[] }[],
  receivedAt: Date,
): Promise<void> {
  const flat = batches.flatMap(b => b.readings.map(r => ({ instrumentId: b.instrumentId, r })));
  if (flat.length === 0) return;

  const histValues = Prisma.join(flat.map(({ instrumentId, r }) => Prisma.sql`(
    ${instrumentId}, ${r.key}, ${JSON.stringify(r.value)}::jsonb,
    ${r.valueType}, ${r.quality ?? null}, ${r.ts}, ${receivedAt})`));

  // Collapse to ONE row per (instrument, key), keeping the newest ts.
  //
  // Not an optimisation — a correctness requirement. Postgres rejects an
  // INSERT ... ON CONFLICT DO UPDATE whose VALUES contain the same conflict
  // target twice:
  //   ERROR: ON CONFLICT DO UPDATE command cannot affect row a second time
  // The ingestion service flushes many messages through one writeBatch call, so
  // any instrument publishing twice within a flush window would hit this — and
  // because the whole thing runs in one transaction, a single duplicate would
  // discard EVERY reading in the flush, not just its own.
  //
  // History is unaffected: it keeps every row, deduplicated on (instrument, key,
  // ts) by DO NOTHING.
  const newestPerKey = new Map<string, (typeof flat)[number]>();
  for (const item of flat) {
    const k = `${item.instrumentId}|${item.r.key}`;
    const prev = newestPerKey.get(k);
    if (!prev || item.r.ts >= prev.r.ts) newestPerKey.set(k, item);
  }

  const latestValues = Prisma.join([...newestPerKey.values()].map(({ instrumentId, r }) => Prisma.sql`(
    ${instrumentId}, ${r.key}, ${JSON.stringify(r.value)}::jsonb,
    ${r.valueType}, ${r.quality ?? null}, ${r.ts}, ${receivedAt})`));

  await prisma.$transaction([
    prisma.$executeRaw`
      INSERT INTO instrument_telemetry_history
        (instrument_id, key, value, value_type, quality, ts, received_at)
      VALUES ${histValues}
      ON CONFLICT (instrument_id, key, ts) DO NOTHING`,
    // A device that re-sends the same (instrument, key, ts) is a duplicate, not
    // new information — DO NOTHING keeps history idempotent under redelivery,
    // which MQTT QoS 1 makes routine.
    prisma.$executeRaw`
      INSERT INTO instrument_telemetry_latest
        (instrument_id, key, value, value_type, quality, ts, received_at)
      VALUES ${latestValues}
      ON CONFLICT (instrument_id, key) DO UPDATE SET
        value = EXCLUDED.value, value_type = EXCLUDED.value_type,
        quality = EXCLUDED.quality, ts = EXCLUDED.ts, received_at = EXCLUDED.received_at
      WHERE instrument_telemetry_latest.ts <= EXCLUDED.ts`,
    // The WHERE guard stops an out-of-order arrival overwriting a NEWER value.
  ]);
}

export async function getLatest(instrumentId: string): Promise<TelemetryRow[]> {
  return prisma.$queryRaw<TelemetryRow[]>`
    SELECT key, value, value_type AS "valueType", quality, ts, received_at AS "receivedAt"
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
    SELECT key, value, value_type AS "valueType", quality, ts, received_at AS "receivedAt"
    FROM instrument_telemetry_history ${where}
    ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}`;

  const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM instrument_telemetry_history ${where}`;

  return { rows, total: Number(count) };
}

export async function writeDeadLetters(
  rows: { protocolKey: string; topic: string; payload: string; reason: string; detail?: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  await prisma.deadLetter.createMany({
    data: rows.map(r => ({ ...r, detail: r.detail ?? null })),
  });
}

/**
 * Slug/deviceKey → instrumentId lookup for the fan-out resolver.
 *
 * Keys are joined with '|', which sanitizeSlug can never emit (it strips
 * everything outside [a-z0-9-]). Plain concatenation would collide:
 * gateway 'gw-1' + instrument '0temp' would equal 'gw-10' + 'temp'.
 * Loaded once per flush rather than per message: a 500-reading batch would
 * otherwise issue 500 lookups for what is almost always the same few gateways.
 */
export async function buildResolverCache(): Promise<{
  bySlug: Map<string, string>; byDeviceKey: Map<string, string>;
}> {
  const rows = await prisma.instrument.findMany({
    where: { isActive: true, gateway: { isNot: null } },
    select: { id: true, slug: true, deviceKey: true, gateway: { select: { slug: true } } },
  });
  const bySlug = new Map<string, string>();
  const byDeviceKey = new Map<string, string>();
  for (const r of rows) {
    if (!r.gateway) continue;
    bySlug.set(`${r.gateway.slug}|${r.slug}`, r.id);
    if (r.deviceKey) byDeviceKey.set(`${r.gateway.slug}|${r.deviceKey}`, r.id);
  }
  return { bySlug, byDeviceKey };
}
