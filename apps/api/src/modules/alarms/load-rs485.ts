import { prisma } from '../../lib/prisma.js';
import { failureText, type Rs485AlarmConfig } from '@digilog/shared';

/**
 * The administered `rs485-alarms` config.
 *
 * **Reads `enabled !== false`, like `loadLimitConfig` and UNLIKE
 * `loadInactivityConfig`.** An absent or half-seeded row therefore means ENABLED,
 * and that is the deliberate half of the difference: inactivity fails closed
 * because failing open would raise one alarm per silent instrument (101 on this
 * installation), while this one raises an alarm only for a sensor that is
 * actively reporting rubbish — measured at ZERO instruments here, across every
 * retained reading on a slot key. A fault detector that quietly defaults to off
 * detects nothing.
 *
 * The two loaders are not a shared helper for exactly this reason: the single
 * character between `!== false` and `=== true` encodes which way each feature
 * should fail, and merging them would make that invisible.
 */
export async function loadRs485Config(): Promise<Rs485AlarmConfig> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'rs485-alarms' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;

  return {
    enabled: cfg.enabled !== false,
    // Through the shared resolver, so a blank field falls back the same way here
    // (notification and webhook bodies) as it does in the browser. Two fallbacks
    // would eventually be two different words for one fault.
    failureText: failureText(cfg.failureText as string | undefined),
  };
}
