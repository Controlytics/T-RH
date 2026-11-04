import { RULE_RELATION_FALSE, RULE_RELATION_TRUE } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import { isPlainObject } from './support.js';

/**
 * Alarm status filter — ThingsBoard's `TbCheckAlarmStatusNode` (spec §7).
 *
 * ThingsBoard parses the message DATA as the alarm, re-reads the LATEST row by
 * its id, and routes `True` when that alarm's status is one of
 * `alarmStatusList`, else `False`. Here the status is built from our row:
 * ACTIVE / CLEARED from `state`, ACK / UNACK from whether `acknowledgedAt` is
 * set — the four values of ThingsBoard's `AlarmStatus`.
 *
 * Failure: data without an alarm id; an alarm that no longer exists
 * ("No such alarm found.", ThingsBoard's text).
 */
export const ALARM_STATUS_FILTER = 'tb:filter:alarm-status-filter';

export interface AlarmStatusFilterConfig {
  alarmStatusList: string[];
}

/** ThingsBoard's `AlarmStatus` of one of our alarms. */
export function alarmStatusOf(alarm: { state: string; acknowledgedAt: Date | null }): string {
  return `${alarm.state === 'ACTIVE' ? 'ACTIVE' : 'CLEARED'}_${alarm.acknowledgedAt ? 'ACK' : 'UNACK'}`;
}

export const alarmStatusFilter: RuleNodeHandler<AlarmStatusFilterConfig> = async (ctx, msg) => {
  const id = isPlainObject(msg.data) && typeof msg.data.id === 'string' && msg.data.id !== '' ? msg.data.id : null;
  if (!id) throw new Error('The message data is not an alarm: it has no id');
  const alarm = await ctx.services.alarms.byId(id);
  if (!alarm) throw new Error('No such alarm found.');
  const wanted = Array.isArray(ctx.config.alarmStatusList) ? ctx.config.alarmStatusList : [];
  ctx.tellNext(msg, wanted.includes(alarmStatusOf(alarm)) ? RULE_RELATION_TRUE : RULE_RELATION_FALSE);
};
