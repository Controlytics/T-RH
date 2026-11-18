import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { TelemetryRow } from './telemetry.repository.js';

/**
 * The readings an INTERVAL Data Report prints — and only those (performance audit
 * 2026-11-17, G1-01; operator chose "the server builds the rows").
 *
 * The report used to fetch EVERY stored reading of the period into the browser
 * (78 MB for 26 instruments x 7 days) and then keep, per interval slot, the FIRST
 * reading (`scheduleRows` in the web app). This returns exactly the readings that
 * rule keeps, chosen in SQL by the SAME rule, so the browser builds the identical
 * report — same pivot, same schedule, same NA rows — from a fraction of the data:
 *
 *  - an INSTANT is a millisecond (`date_trunc('milliseconds', ts)`): the browser
 *    pivots readings by their ISO timestamp, which carries milliseconds, so two
 *    readings microseconds apart are one row there and must be one instant here;
 *  - only readings of `keys` make an instant (`toTableRowsWithErrors` skips any
 *    other key — a pressure-only instant is no row of a T&RH report);
 *  - slots are `intervalMs` wide, anchored on the period's FIRST instant; each keeps
 *    its first instant;
 *  - every reading of `keys` at a kept instant is returned, raw — the browser still
 *    decides numeric / failure word / NA, as before.
 *
 * Verified against the browser's own rule on 83,522 readings (perf copy,
 * 2026-11-17: 7 / 15 / 60-minute intervals, identical instants) and pinned by
 * `e2e/report-rows.e2e.test.ts`. A RAW report (no interval) prints every reading
 * and keeps the old path. `total` is every reading in the period, all keys — the
 * `historyTotal` the old whole-period fetch returned.
 */
export async function getReportSlotReadings(opts: {
  instrumentId: string;
  keys: string[];
  from: Date;
  to: Date;
  intervalMs: number;
}): Promise<{ rows: TelemetryRow[]; total: number }> {
  if (opts.keys.length === 0) return { rows: [], total: await countInPeriod(opts) };
  const where = Prisma.sql`instrument_id = ${opts.instrumentId}
    AND key IN (${Prisma.join(opts.keys)})
    AND ts >= ${opts.from} AND ts <= ${opts.to}`;
  const rows = await prisma.$queryRaw<TelemetryRow[]>`
    WITH instants AS (
      SELECT DISTINCT date_trunc('milliseconds', ts) AS t FROM instrument_telemetry_history WHERE ${where}
    ),
    anchor AS (SELECT min(t) AS a FROM instants),
    firsts AS (
      SELECT DISTINCT ON (slot) t FROM (
        SELECT t, floor(EXTRACT(EPOCH FROM (t - anchor.a)) * 1000 / ${opts.intervalMs}) AS slot FROM instants, anchor
      ) s
      ORDER BY slot, t
    )
    SELECT h.key, h.value, h.value_type AS "valueType", h.ts
    FROM instrument_telemetry_history h
    JOIN firsts f ON date_trunc('milliseconds', h.ts) = f.t
    WHERE ${where}
    ORDER BY h.ts DESC`;
  return { rows, total: await countInPeriod(opts) };
}

async function countInPeriod(opts: { instrumentId: string; from: Date; to: Date }): Promise<number> {
  const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM instrument_telemetry_history
    WHERE instrument_id = ${opts.instrumentId} AND ts >= ${opts.from} AND ts <= ${opts.to}`;
  return Number(count);
}
