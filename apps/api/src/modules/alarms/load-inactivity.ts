import { prisma } from '../../lib/prisma.js';
import {
  INACTIVITY_ALARMS_DEFAULT,
  INACTIVITY_GRACE_MIN,
  INACTIVITY_GRACE_MAX,
  type InactivityAlarmConfig,
} from '@digilog/shared';

/**
 * The administered `inactivity-alarms` config.
 *
 * Loaded the same way `loadLimitConfig()` loads `alarm-limits`: one row, shipped
 * defaults as the fallback.
 *
 * **One deliberate difference from `loadLimitConfig`, and it is the important
 * one.** That function reads `cfg.enabled !== false`, so an absent or
 * half-seeded row means ENABLED — right for limit alarms, which ship on. Here an
 * absent row must mean DISABLED, because the failure modes are not symmetrical:
 * a limit feature that fails closed stops watching for excursions, while an
 * inactivity feature that fails OPEN raises one alarm per silent instrument,
 * each with a notification and a webhook fire. `=== true` is the whole
 * difference and it is why this is not a shared helper.
 */
export async function loadInactivityConfig(): Promise<InactivityAlarmConfig> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'inactivity-alarms' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;

  const grace = Number(cfg.graceMinutes);

  return {
    // See above: absent means OFF, never on.
    enabled: cfg.enabled === true,
    graceMinutes: Number.isFinite(grace)
      // Clamped rather than trusted. The config page bounds it, but a row edited
      // by hand or restored from an older backup must not produce a negative
      // grace (raise on everything) or a NaN (which compares false against every
      // threshold and would raise on nothing, silently).
      ? Math.min(INACTIVITY_GRACE_MAX, Math.max(INACTIVITY_GRACE_MIN, Math.trunc(grace)))
      : INACTIVITY_ALARMS_DEFAULT.graceMinutes,
  };
}
