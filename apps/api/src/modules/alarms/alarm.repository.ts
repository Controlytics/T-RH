/**
 * All database access for alarms, thresholds and liveness.
 *
 * The evaluator and state machine are pure; this file is the only place in the
 * alarm path that touches Postgres. Caches are loaded ONCE PER FLUSH, mirroring
 * how ingestion.service.ts already loads buildResolverCache() and unsSettings()
 * once per flush rather than once per message.
 */
import { Prisma, type AlarmSeverity } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { ThresholdSpec } from './threshold-evaluator.js';
import type { OpenAlarmView } from './alarm-state.js';

/** Threshold-cache key: looked up once per reading, before the threshold is known. */
export const seriesKey = (instrumentId: string, key: string) => `${instrumentId}|${key}`;

/**
 * Open-alarm key. Includes the THRESHOLD because one telemetry key can carry
 * several thresholds, and each is an independent excursion condition with its
 * own severity. Keying on (instrument, key) alone lets a high-limit breach
 * satisfy a low-limit threshold's recovery test and resolve the alarm it just
 * raised. Liveness alarms have no threshold and use a fixed sentinel.
 */
export const alarmKey = (instrumentId: string, key: string, thresholdId: string | null) =>
  `${instrumentId}|${key}|${thresholdId ?? '__liveness__'}`;

export async function loadThresholdCache(): Promise<Map<string, ThresholdSpec[]>> {
  const rows = await prisma.alarmThreshold.findMany({ where: { isActive: true } });
  const map = new Map<string, ThresholdSpec[]>();
  for (const r of rows) {
    const k = seriesKey(r.instrumentId, r.key);
    const list = map.get(k) ?? [];
    list.push({
      id: r.id, key: r.key, operator: r.operator,
      limit: r.limit, limitLow: r.limitLow, limitHigh: r.limitHigh,
      hysteresis: r.hysteresis, severity: r.severity,
    });
    map.set(k, list);
  }
  return map;
}

export async function loadOpenAlarms(): Promise<Map<string, OpenAlarmView>> {
  const rows = await prisma.alarm.findMany({
    where: { state: { not: 'CLOSED' } },
    select: {
      id: true, instrumentId: true, key: true, thresholdId: true,
      state: true, breachCount: true, peakValue: true,
    },
  });
  return new Map(rows.map(r => [
    alarmKey(r.instrumentId, r.key, r.thresholdId),
    { id: r.id, state: r.state, breachCount: r.breachCount, peakValue: r.peakValue },
  ]));
}

/**
 * Returns null when an open alarm for this series already exists.
 *
 * The partial unique index alarms_one_open_per_threshold_key is the real guard —
 * the in-memory open-alarm cache is loaded once per flush, so two concurrent
 * flushes can both believe the series is clear. A P2002 here is the expected
 * outcome of that race, not an error worth surfacing.
 */
export async function raiseAlarm(input: {
  instrumentId: string; key: string; thresholdId: string | null;
  severity: AlarmSeverity; value: number | null; ts: Date;
}): Promise<{ id: string } | null> {
  try {
    const row = await prisma.alarm.create({
      data: {
        instrumentId: input.instrumentId, key: input.key, thresholdId: input.thresholdId,
        // Copied at raise time so a later edit to the threshold never rewrites
        // the severity of a historical excursion.
        severity: input.severity,
        state: 'ACTIVE',
        firstBreachAt: input.ts, lastBreachAt: input.ts,
        breachCount: 1, triggerValue: input.value, peakValue: input.value,
      },
      select: { id: true },
    });
    return row;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}

export async function rebreachAlarm(
  alarmId: string, value: number | null, ts: Date, backToActive: boolean,
): Promise<void> {
  // Raw SQL because peakValue must be `GREATEST(peak_value, $value)` — a
  // read-modify-write in JS would lose a concurrent flush's higher peak.
  // `alarms.id` is TEXT (Prisma's default uuid()-as-string PK, not a native
  // pg `uuid` column) — no `::uuid` cast on the id comparison.
  await prisma.$executeRaw`
    UPDATE alarms
       SET breach_count = breach_count + 1,
           last_breach_at = ${ts},
           peak_value = CASE
             WHEN ${value}::double precision IS NULL THEN peak_value
             WHEN peak_value IS NULL THEN ${value}::double precision
             ELSE GREATEST(peak_value, ${value}::double precision)
           END,
           state = CASE WHEN ${backToActive} THEN 'ACTIVE'::"AlarmState" ELSE state END,
           resolved_at = CASE WHEN ${backToActive} THEN NULL ELSE resolved_at END
     WHERE id = ${alarmId}`;
}

export async function resolveAlarm(alarmId: string, ts: Date, close: boolean): Promise<void> {
  await prisma.alarm.update({
    where: { id: alarmId },
    data: close
      ? { state: 'CLOSED', resolvedAt: ts, closedAt: ts }
      : { state: 'RESOLVED_UNACKED', resolvedAt: ts },
  });
}

/** Upsert last-seen for every instrument that produced a reading in this flush. */
export async function touchLiveness(instrumentIds: string[], seenAt: Date): Promise<void> {
  if (instrumentIds.length === 0) return;
  // `instrument_liveness.instrument_id` is TEXT, same reasoning as alarms.id above.
  const values = Prisma.join(instrumentIds.map(id => Prisma.sql`(${id}, ${seenAt}, 'UNKNOWN')`));
  await prisma.$executeRaw`
    INSERT INTO instrument_liveness (instrument_id, last_seen_at, state)
    VALUES ${values}
    ON CONFLICT (instrument_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`;
}
