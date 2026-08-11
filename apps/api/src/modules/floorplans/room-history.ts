/**
 * Every instrument in one room, both slots, one request.
 *
 * A three-instrument room would otherwise poll six per-instrument endpoints
 * every few seconds while its chart panel is open.
 *
 * Raw SQL because `instrument_telemetry_history` is PARTITIONED, which Prisma
 * cannot express — the same reason telemetry.repository.ts is raw.
 *
 * Design: docs/superpowers/specs/2026-08-11-instrument-dashboard-floorplan-design.md
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  parseTelemetryAliases,
  TELEMETRY_SLOT_ALIASES_DEFAULT,
  type TelemetrySlot,
} from '@digilog/shared';

export type HistoryWindow = '15m' | '1h' | '6h' | '24h' | '7d';

/**
 * `bucketSec: null` means return raw rows.
 *
 * Above six hours the raw row count stops being drawable — a 7-day window at a
 * 5-second publish interval is ~120k points per series, which no chart can
 * render and no browser should receive. Those windows are averaged into buckets
 * sized to land near 500 points.
 */
export const WINDOW_SPEC: Record<HistoryWindow, { ms: number; bucketSec: number | null }> = {
  '15m': { ms: 15 * 60_000, bucketSec: null },
  '1h': { ms: 60 * 60_000, bucketSec: null },
  '6h': { ms: 6 * 3_600_000, bucketSec: null },
  '24h': { ms: 24 * 3_600_000, bucketSec: 180 },   // 480 points
  '7d': { ms: 7 * 86_400_000, bucketSec: 1_260 },  // 480 points
};

export const HISTORY_WINDOWS = Object.keys(WINDOW_SPEC) as HistoryWindow[];

export interface SeriesPoint { ts: string; value: number }

export interface Series {
  instrumentId: string;
  instrumentCode: string;
  slot: TelemetrySlot;
  key: string;
  points: SeriesPoint[];
}

interface RawPoint { instrumentId: string; key: string; ts: Date; value: number | null }

async function slotAliases(): Promise<Record<TelemetrySlot, string[]>> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'telemetry-slots' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;
  return {
    temperature: parseTelemetryAliases(
      (cfg.temperatureKeys as string) ?? TELEMETRY_SLOT_ALIASES_DEFAULT.temperature,
    ),
    humidity: parseTelemetryAliases(
      (cfg.humidityKeys as string) ?? TELEMETRY_SLOT_ALIASES_DEFAULT.humidity,
    ),
  };
}

/**
 * Cast jsonb → float8 ONLY inside a CASE.
 *
 * `value` is jsonb and this table really does contain non-numeric readings — a
 * device sent the string "hello". A bare `(value #>> '{}')::float8` in the
 * SELECT list errors on that row with "invalid input syntax for type double
 * precision", and adding `WHERE jsonb_typeof(value) = 'number'` is NOT a
 * reliable fix: Postgres does not guarantee the filter is evaluated before the
 * projection, so the query works under one plan and fails under another. CASE
 * does guarantee evaluation order, so the cast is only ever reached for a row
 * already known to be a number.
 */
const NUMERIC_VALUE = Prisma.sql`
  CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::float8 END`;

export async function getRoomHistory(roomId: string, window: HistoryWindow) {
  const spec = WINDOW_SPEC[window];
  const to = new Date();
  const from = new Date(to.getTime() - spec.ms);

  const instruments = await prisma.instrument.findMany({
    where: { roomId },
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });
  if (instruments.length === 0) {
    return { from: from.toISOString(), to: to.toISOString(), bucketSeconds: spec.bucketSec, series: [] };
  }

  const aliases = await slotAliases();
  const allKeys = [...new Set([...aliases.temperature, ...aliases.humidity])];
  if (allKeys.length === 0) {
    return { from: from.toISOString(), to: to.toISOString(), bucketSeconds: spec.bucketSec, series: [] };
  }

  const ids = instruments.map((i) => i.id);

  const rows = spec.bucketSec === null
    ? await prisma.$queryRaw<RawPoint[]>`
        SELECT instrument_id AS "instrumentId", key, ts, ${NUMERIC_VALUE} AS value
        FROM instrument_telemetry_history
        WHERE instrument_id = ANY(${ids}::text[])
          AND lower(key) = ANY(${allKeys}::text[])
          AND ts >= ${from} AND ts <= ${to}
          AND jsonb_typeof(value) = 'number'
        ORDER BY ts ASC`
    : await prisma.$queryRaw<RawPoint[]>`
        SELECT instrument_id AS "instrumentId", key,
               to_timestamp(floor(extract(epoch FROM ts) / ${spec.bucketSec}) * ${spec.bucketSec}) AS ts,
               avg(${NUMERIC_VALUE}) AS value
        FROM instrument_telemetry_history
        WHERE instrument_id = ANY(${ids}::text[])
          AND lower(key) = ANY(${allKeys}::text[])
          AND ts >= ${from} AND ts <= ${to}
          AND jsonb_typeof(value) = 'number'
        GROUP BY instrument_id, key, 3
        ORDER BY 3 ASC`;

  const codeOf = new Map(instruments.map((i) => [i.id, i.code]));
  const slotOf = (key: string): TelemetrySlot | null => {
    const k = key.toLowerCase();
    if (aliases.temperature.includes(k)) return 'temperature';
    if (aliases.humidity.includes(k)) return 'humidity';
    return null;
  };

  // Group by (instrument, key). A series exists ONLY where points exist — an
  // empty series renders as axes with no line, which reads as "flat" rather
  // than "nothing here".
  const grouped = new Map<string, Series>();
  for (const r of rows) {
    if (r.value === null || !Number.isFinite(r.value)) continue;
    const slot = slotOf(r.key);
    if (slot === null) continue;

    const gk = `${r.instrumentId}|${r.key}`;
    let series = grouped.get(gk);
    if (!series) {
      series = {
        instrumentId: r.instrumentId,
        instrumentCode: codeOf.get(r.instrumentId) ?? r.instrumentId,
        slot,
        key: r.key,
        points: [],
      };
      grouped.set(gk, series);
    }
    series.points.push({ ts: r.ts.toISOString(), value: r.value });
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    bucketSeconds: spec.bucketSec,
    series: [...grouped.values()].sort(
      (a, b) => a.instrumentCode.localeCompare(b.instrumentCode) || a.slot.localeCompare(b.slot),
    ),
  };
}
