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
import { raiseAlarm } from '../modules/alarms/alarm.repository.js';

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
                          - make_interval(secs => i.expected_interval_sec * ${gracePeriodMultiplier}::int)
     -- Deterministic order (most-stale first) — incidental benefit, not load-bearing:
     -- lets the race-survival test control which row hits the unique-violation path.
     ORDER BY l.last_seen_at ASC`;

  const wentOffline: string[] = [];

  for (const row of rows) {
    // alarms_one_open_liveness_key (instrument_id, WHERE state <> 'CLOSED' AND
    // threshold_id IS NULL) guards this insert. raiseAlarm() already handles
    // the P2002 from a concurrent sweep winning the same race and returns null
    // — that race IS expected here, not a bug: two sweeps can both select this
    // instrument as a candidate before either writes. A bare create() would
    // throw, aborting the loop and starving every LATER instrument in this
    // batch of its own offline detection for the tick. Skip and move on: the
    // other sweep already owns this instrument's offline alarm.
    const alarm = await raiseAlarm({
      instrumentId: row.instrument_id, key: '__liveness__', thresholdId: null,
      severity: 'MAJOR', value: null, ts: now,
    });
    if (!alarm) continue;

    await prisma.instrumentLiveness.update({
      where: { instrumentId: row.instrument_id },
      data: { state: 'OFFLINE', stateChangedAt: now, offlineAlarmId: alarm.id },
    });
    wentOffline.push(row.instrument_id);

    await auditLog({
      action: 'DEVICE_WENT_OFFLINE', targetType: 'Instrument', targetId: row.instrument_id,
      afterValue: { alarmId: alarm.id, detectedAt: now.toISOString() },
    });
    // Fire-and-forget with a logged catch — the same pattern as
    // alarm.service.ts's ALARM_RAISED dispatch and routes.ts's
    // ALARM_ACKNOWLEDGED dispatch. Awaited, a rejecting notifier would unwind
    // this loop and starve every LATER instrument in this tick of its own
    // offline detection. The alarm row, the liveness flip and the audit row
    // are all committed above, so the regulated record is safe regardless of
    // what the notifier does.
    //
    // The auditLog above is deliberately still AWAITED: it is the §11.10(e)
    // record for a state change already committed to instrument_liveness.
    // Making it fire-and-forget would let the instrument sit OFFLINE with no
    // audit row. alarm.service.ts awaits its auditLog for the same reason.
    void dispatchNotification({
      eventType: 'DEVICE_OFFLINE',
      context: { severity: 'MAJOR', instrumentId: row.instrument_id },
      variables: {
        deviceName: row.name, unsPath: '', timestamp: now.toISOString(),
      },
    }).catch(err => console.error(
      '[Liveness] DEVICE_OFFLINE notification dispatch failed:', (err as Error).message,
    ));
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
