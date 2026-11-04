import { RULE_RELATION_FALSE, RULE_RELATION_TRUE } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import { alarmStatus } from '../../emit.js';
import { isPlainObject } from './support.js';

/**
 * Alarm status filter — ThingsBoard's `TbCheckAlarmStatusNode` (spec §7).
 *
 * ThingsBoard parses the message DATA as the alarm, re-reads the LATEST row by
 * its id, and routes `True` when that alarm's status is one of
 * `alarmStatusList`, else `False`. The status is `emit.ts`'s `alarmStatus`
 * — the ONE rule the ALARM message's own `status` is built with: ACTIVE /
 * CLEARED from `state`, ACK / UNACK from whether `acknowledgedAt` is set.
 *
 * The alarm id is `data.id` as a string (this system's ALARM messages), or
 * ThingsBoard's alarm JSON shape `{ entityType, id }` (a message built for
 * ThingsBoard, a script's output). Like ThingsBoard's `AlarmId` reader, the
 * `entityType` is not consulted.
 *
 * Failure: data with no alarm id; an alarm that no longer exists
 * ("No such alarm found.", ThingsBoard's text).
 */
export const ALARM_STATUS_FILTER = 'tb:filter:alarm-status-filter';

export interface AlarmStatusFilterConfig {
  alarmStatusList: string[];
}

/** The alarm id a message's data carries: `id` as text, or ThingsBoard's `{ entityType, id }`. */
export function alarmIdOf(data: unknown): string | null {
  if (!isPlainObject(data)) return null;
  const id = data.id;
  if (typeof id === 'string') return id !== '' ? id : null;
  if (isPlainObject(id) && typeof id.id === 'string' && id.id !== '') return id.id;
  return null;
}

export const alarmStatusFilter: RuleNodeHandler<AlarmStatusFilterConfig> = async (ctx, msg) => {
  const id = alarmIdOf(msg.data);
  if (!id) throw new Error('The message data is not an alarm: it has no id');
  const alarm = await ctx.services.alarms.byId(id);
  if (!alarm) throw new Error('No such alarm found.');
  const wanted = Array.isArray(ctx.config.alarmStatusList) ? ctx.config.alarmStatusList : [];
  ctx.tellNext(msg, wanted.includes(alarmStatus(alarm)) ? RULE_RELATION_TRUE : RULE_RELATION_FALSE);
};
