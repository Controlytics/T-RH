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
import { prisma } from '../../lib/prisma.js';
import {
  parseTelemetryAliases,
  TELEMETRY_SLOT_ALIASES_DEFAULT,
  type TelemetrySlot,
} from '@digilog/shared';
import { loadDecimalsConfig, decimalsFor } from '../instruments/decimals.js';
import { withVisibility, type ScopeWhere } from '../instruments/visibility.js';
import { NUMERIC_READING } from '../instruments/telemetry.repository.js';

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
  /**
   * The precision THIS instrument's readings are shown to, from its own
   * attributes. Carried per series, not per chart: two probes in one room can
   * legitimately resolve differently, and a single chart-wide number would
   * misreport one of them on the very axis meant to compare them.
   */
  decimals: number;
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

// `NUMERIC_READING` (telemetry.repository.ts) is the ONE SQL definition of a
// reading — a CASE-guarded cast that also accepts a quoted number. This file
// carried its own number-only copy until audit 2026-10-03 INGEST-9, so a room
// of gateway-fed instruments (quoted readings) drew an empty chart.

/**
 * `visibility` is the caller's resolved instrument scope, or undefined when they
 * are unrestricted. It is applied to the ROOM MEMBERSHIP query, so an instrument
 * the caller may not see contributes no series — every reading below is selected
 * by `instrument_id = ANY(ids)`, and `ids` comes from this one query. Filtering
 * the returned series instead would still have read the rows out of the database
 * and left the next refactor one step from shipping them.
 */
export async function getRoomHistory(roomId: string, window: HistoryWindow, visibility?: ScopeWhere) {
  const spec = WINDOW_SPEC[window];
  const to = new Date();
  const from = new Date(to.getTime() - spec.ms);

  const instruments = await prisma.instrument.findMany({
    where: withVisibility({ roomId }, visibility) as { roomId: string },
    select: { id: true, code: true, attributes: { select: { key: true, value: true } } },
    orderBy: { code: 'asc' },
  });
  if (instruments.length === 0) {
    return { from: from.toISOString(), to: to.toISOString(), bucketSeconds: spec.bucketSec, series: [] };
  }

  const [aliases, decimalsCfg] = await Promise.all([slotAliases(), loadDecimalsConfig()]);
  const allKeys = [...new Set([...aliases.temperature, ...aliases.humidity])];
  if (allKeys.length === 0) {
    return { from: from.toISOString(), to: to.toISOString(), bucketSeconds: spec.bucketSec, series: [] };
  }

  const ids = instruments.map((i) => i.id);

  const rows = spec.bucketSec === null
    ? await prisma.$queryRaw<RawPoint[]>`
        SELECT instrument_id AS "instrumentId", key, ts, ${NUMERIC_READING} AS value
        FROM instrument_telemetry_history
        WHERE instrument_id = ANY(${ids}::text[])
          AND lower(key) = ANY(${allKeys}::text[])
          AND ts >= ${from} AND ts <= ${to}
          AND ${NUMERIC_READING} IS NOT NULL
        ORDER BY ts ASC`
    : await prisma.$queryRaw<RawPoint[]>`
        SELECT instrument_id AS "instrumentId", key,
               to_timestamp(floor(extract(epoch FROM ts) / ${spec.bucketSec}) * ${spec.bucketSec}) AS ts,
               avg(${NUMERIC_READING}) AS value
        FROM instrument_telemetry_history
        WHERE instrument_id = ANY(${ids}::text[])
          AND lower(key) = ANY(${allKeys}::text[])
          AND ts >= ${from} AND ts <= ${to}
          AND ${NUMERIC_READING} IS NOT NULL
        GROUP BY instrument_id, key, 3
        ORDER BY 3 ASC`;

  const codeOf = new Map(instruments.map((i) => [i.id, i.code]));
  const decimalsOf = new Map(instruments.map((i) => [i.id, decimalsFor(decimalsCfg, i.attributes)]));
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
        decimals: decimalsOf.get(r.instrumentId)?.[slot] ?? decimalsCfg.fallback[slot],
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
