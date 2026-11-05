import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleContext } from '../../context.js';
import { copyMessage, RULE_ENGINE_ORIGIN_KEY, SYSTEM_ORIGIN, type RuleMessage } from '../../message.js';
import { ALARM_FLAG } from '../../emit.js';

/**
 * DEVICE PROFILE (deprecated) — ThingsBoard's `TbDeviceProfileNode` (rule
 * chains, Task 5; built 2026-11-04 because every ThingsBoard release v3.6–v4.2
 * ships its root chain with this node as the ENTRY).
 *
 * In ThingsBoard the node evaluates the device profile's alarm rules and sends
 * each alarm it creates, updates or clears on its own label — "Alarm Created",
 * "Alarm Updated", "Alarm Severity Updated", "Alarm Cleared" — as a NEW message
 * of type ALARM from the device (`AlarmState.pushMsg`, master e48b5780), while
 * every incoming message goes on Success (`DeviceState.process` → `tellSuccess`;
 * a non-device originator → `tellSuccess`, `TbDeviceProfileNode.onMsg`).
 *
 * Here this system's alarm EVALUATOR stands in for the profile alarm rules (its
 * instrument-limit, inactivity, RS485 and range alarms — Configuration →
 * Instrument Limit Alarms and the rest), raised for every reading whether or not
 * a chain runs; it announces each one as an ALARM / ALARM_CLEAR message, origin
 * `system`, from the instrument (ruling AL-1). So (ruling DP-1, 2026-11-05):
 *  - such a message — origin `system`, an INSTRUMENT originator, type ALARM or
 *    ALARM_CLEAR, and ThingsBoard's flag (`ALARM_FLAG`) — leaves on its label
 *    ONLY: it IS the message ThingsBoard's node would have created, so it never
 *    also goes on Success. The flags are judged in `AlarmState.pushMsg`'s order:
 *    isNewAlarm → Created, isSeverityUpdated → Severity Updated, isExistingAlarm
 *    → Updated, isClearedAlarm → Cleared. On "Alarm Cleared" the evaluator's
 *    ALARM_CLEAR is sent as type ALARM, as `pushMsg` sends all four;
 *  - everything else goes on Success, as ThingsBoard routes it: telemetry,
 *    attributes, activity events, the acknowledge route's ALARM_ACK (origin
 *    `user`), and a rule node's own alarm messages (origin `rule_node:…`) even
 *    though they carry isNewAlarm — in ThingsBoard those come from the alarm
 *    node, never from this one.
 * The evaluator only RAISES and CLEARS (alarm-evaluation.worker.ts: `alarm.create`,
 * `claimClear`): it never updates an alarm or changes its severity, so only
 * "Alarm Created" and "Alarm Cleared" occur here today; the other two labels are
 * routed for parity.
 *
 * `persistAlarmRulesState` / `fetchAlarmRulesStateOnStart` are accepted and ignored.
 */
export const DEVICE_PROFILE_TYPE = 'tb:action:device-profile';

/** ThingsBoard's four alarm labels (`TbDeviceProfileNode` relationTypes; the catalogue's relations). */
export const DEVICE_PROFILE_ALARM_RELATION = {
  CREATED: 'Alarm Created',
  UPDATED: 'Alarm Updated',
  SEVERITY_UPDATED: 'Alarm Severity Updated',
  CLEARED: 'Alarm Cleared',
} as const;

/** The label ThingsBoard's node would send this message on — set only for the evaluator's alarms; null = Success. */
export function profileAlarmRelation(msg: Pick<RuleMessage, 'type' | 'originator' | 'metadata'>): string | null {
  if (msg.metadata[RULE_ENGINE_ORIGIN_KEY] !== SYSTEM_ORIGIN || msg.originator.type !== 'INSTRUMENT') return null;
  const flag = (name: string) => msg.metadata[name] === 'true';
  if (msg.type === 'ALARM_CLEAR') return flag(ALARM_FLAG.CLEARED) ? DEVICE_PROFILE_ALARM_RELATION.CLEARED : null;
  if (msg.type !== 'ALARM') return null;
  if (flag(ALARM_FLAG.NEW)) return DEVICE_PROFILE_ALARM_RELATION.CREATED;
  if (flag(ALARM_FLAG.SEVERITY_UPDATED)) return DEVICE_PROFILE_ALARM_RELATION.SEVERITY_UPDATED;
  if (flag(ALARM_FLAG.EXISTING)) return DEVICE_PROFILE_ALARM_RELATION.UPDATED;
  if (flag(ALARM_FLAG.CLEARED)) return DEVICE_PROFILE_ALARM_RELATION.CLEARED;
  return null;
}

export function deviceProfile(ctx: RuleContext, msg: RuleMessage): void {
  const relation = profileAlarmRelation(msg);
  if (relation === null) {
    ctx.tellNext(msg, RULE_RELATION_SUCCESS);
    return;
  }
  ctx.tellNext(msg.type === 'ALARM' ? msg : copyMessage(msg, { type: 'ALARM' }), relation);
}
