import { prisma } from '../../lib/prisma.js';
import {
  ALARM_TYPE_KEYS, alarmTypeName, alarmTypeKeyFor, ruleAlarmTypeName, RS485_TYPE_LABEL, SENSOR_RANGE_TYPE_LABEL,
  type AlarmTypeNames,
} from '@digilog/shared';

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

/**
 * The name an alarm is ANNOUNCED under — email, SMS, hooter payload — from the
 * loaded names, with the same per-source fallbacks the evaluator uses when it
 * raises one. Exists so the ACKNOWLEDGED webhook (alarms/routes.ts) names the
 * alarm exactly as its RAISED payload did; it used to read `ruleSnapshot.name`,
 * which only the removed RULE alarms carried, so every acknowledgement went out
 * as `ruleName: ""` (audit 2026-10-12 #12).
 *
 * A RULE alarm raised by a rule chain (2026-11-03) is announced under its
 * Create alarm node's type, `ruleSnapshot.alarmType`, through the shared
 * `ruleAlarmTypeName` the Alarms page uses too. `ruleSnapshot` is optional so
 * the callers that have no rule alarm to name need not pass it; a caller that
 * may hold a RULE alarm must, or the alarm is announced as its metric, `CUSTOM`.
 */
export function alarmDisplayName(
  names: Record<string, string>,
  source: string,
  metric: string,
  limitKind: string | null,
  ruleSnapshot?: unknown,
): string {
  const ruleName = ruleAlarmTypeName(source, ruleSnapshot);
  if (ruleName) return ruleName;
  const key = alarmTypeKeyFor(source, metric, limitKind);
  if (key) return alarmTypeName(names as AlarmTypeNames, key);
  if (source === 'RS485_FAILURE') return RS485_TYPE_LABEL[metric as keyof typeof RS485_TYPE_LABEL] ?? 'Sensor failure';
  if (source === 'SENSOR_RANGE') return SENSOR_RANGE_TYPE_LABEL[metric as keyof typeof SENSOR_RANGE_TYPE_LABEL] ?? 'Sensor range';
  if (source === 'INACTIVITY') return 'Inactivity';
  return limitKind ? `${metric} ${limitKind} limit` : metric;
}
