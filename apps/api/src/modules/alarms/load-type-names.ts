import { prisma } from '../../lib/prisma.js';
import { ALARM_TYPE_KEYS, alarmTypeName, type AlarmTypeNames } from '@digilog/shared';

/**
 * What each kind of alarm is CALLED, every key resolved against its shipped
 * default so no caller has to know which fields are set.
 *
 * Lives with the other alarm loaders rather than beside the route that serves it:
 * the EVALUATOR reads this on every pass to label notifications and webhooks, and
 * a worker importing a Fastify route module would drag the HTTP layer into the
 * job runner for one query.
 */
export async function loadAlarmTypeNames(): Promise<Record<string, string>> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'alarm-type-names' } });
  const cfg = (row?.configValue ?? {}) as AlarmTypeNames;
  const out: Record<string, string> = {};
  for (const key of ALARM_TYPE_KEYS) out[key] = alarmTypeName(cfg, key);
  return out;
}
