/**
 * Instrument liveness sweep.
 *
 * "Stopped reporting" is the failure that matters most and the one a heartbeat
 * cannot see — a device that dies silently never sends anything. So liveness is
 * inferred from silence, not from a heartbeat message.
 *
 * State is PERSISTED in instrument_liveness. Without that, an instrument dark
 * for a week would raise a fresh signed-ack-required excursion on every sweep.
 * NotificationRule.cooldownMinutes cannot substitute: it is an in-memory Map
 * (notification-dispatcher.ts:19) wiped on every restart.
 */
import { prisma } from '../lib/prisma.js';
import { configRepository } from '../modules/config/config.repository.js';
import { auditLog } from '../lib/audit.js';
import { dispatchNotification } from '../modules/notification-delivery/notification-dispatcher.js';

export interface LivenessSettings { gracePeriodMultiplier: number }

/** Must match liveness.def.ts's declared default. */
const DEFAULTS: LivenessSettings = { gracePeriodMultiplier: 2 };

export async function livenessSettings(): Promise<LivenessSettings> {
  const stored = await configRepository.getSystemConfig('liveness');
  const value = (stored?.configValue as Partial<LivenessSettings> | null) ?? {};
  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof LivenessSettings)[]) {
    if (typeof value[key] === typeof DEFAULTS[key]) merged[key] = value[key] as number;
  }
  // Below 1 the grace window is shorter than the reporting interval itself and
  // every instrument alarms constantly. Clamp rather than trust a mis-set value.
  merged.gracePeriodMultiplier = Math.max(1, merged.gracePeriodMultiplier);
  return merged;
}

export async function sweepLiveness(now = new Date()): Promise<{ wentOffline: string[] }> {
  const { gracePeriodMultiplier } = await livenessSettings();

  // Candidates only: monitored, active, seen at least once, and not ALREADY
  // offline. The `state <> 'OFFLINE'` clause is what makes the sweep idempotent.
  const rows = await prisma.$queryRaw<{ instrument_id: string; name: string }[]>`
    SELECT l.instrument_id, i.name
      FROM instrument_liveness l
      JOIN instruments i ON i.id = l.instrument_id
     WHERE i.expected_interval_sec IS NOT NULL
       AND i.is_active = true
       AND l.last_seen_at IS NOT NULL
       AND l.state <> 'OFFLINE'
       -- make_interval rather than string-concatenation + ::interval: the bind
       -- parameter arrives as 'unknown' to the planner, and 'integer * unknown'
       -- can fail to resolve depending on driver type inference.
       AND l.last_seen_at < ${now}::timestamptz
                          - make_interval(secs => i.expected_interval_sec * ${gracePeriodMultiplier}::int)`;

  const wentOffline: string[] = [];

  for (const row of rows) {
    const alarm = await prisma.alarm.create({
      data: {
        instrumentId: row.instrument_id, key: '__liveness__', thresholdId: null,
        severity: 'MAJOR', state: 'ACTIVE',
        firstBreachAt: now, lastBreachAt: now, breachCount: 1,
      },
      select: { id: true },
    });
    await prisma.instrumentLiveness.update({
      where: { instrumentId: row.instrument_id },
      data: { state: 'OFFLINE', stateChangedAt: now, offlineAlarmId: alarm.id },
    });
    wentOffline.push(row.instrument_id);

    await auditLog({
      action: 'DEVICE_WENT_OFFLINE', targetType: 'Instrument', targetId: row.instrument_id,
      afterValue: { alarmId: alarm.id, detectedAt: now.toISOString() },
    });
    await dispatchNotification({
      eventType: 'DEVICE_OFFLINE',
      context: { severity: 'MAJOR', instrumentId: row.instrument_id },
      variables: {
        deviceName: row.name, unsPath: '', timestamp: now.toISOString(),
      },
    });
  }

  return { wentOffline };
}

/** graphile-worker task. Registered as `instrument_liveness_sweep`. */
export const livenessSweepTask = async (
  _payload: unknown,
  helpers?: { logger?: { info: (m: string) => void; error: (m: string) => void } },
): Promise<void> => {
  try {
    const { wentOffline } = await sweepLiveness();
    if (wentOffline.length > 0) {
      helpers?.logger?.info(`liveness sweep: ${wentOffline.length} instrument(s) went offline`);
    }
  } catch (err) {
    // Loud. A silent failure here means device-offline detection is dead while
    // everything else looks healthy.
    helpers?.logger?.error(`liveness sweep FAILED: ${(err as Error).message}`);
    throw err;
  }
};
