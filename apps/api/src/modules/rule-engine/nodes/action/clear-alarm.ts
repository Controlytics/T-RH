import { RULE_RELATION_FALSE, ruleAlarmTypeName } from '@digilog/shared';
import type { RuleContext } from '../../context.js';
import { copyMessage, type RuleMessage } from '../../message.js';
import { alarmMessageData } from '../../emit.js';
import { processPattern, type JsonObject } from './support.js';
import { buildAlarmDetails, openRuleAlarm, snapshotDetails } from './alarm-support.js';

/**
 * CLEAR ALARM — ThingsBoard's `TbClearAlarmNode` (rule chains, Task 5).
 *
 * Which alarm: for an ALARM originator, THAT alarm (by id), under its own
 * type; otherwise the originator instrument's ACTIVE alarm of `alarmType` (a
 * pattern). It is cleared through `services.alarms.clear` — `claimClear`, the
 * evaluator's own clear, with the notification, the webhook and ALARM_CLEAR —
 * and the details script's result (over the alarm's details in
 * `metadata.prevAlarmDetails`) stored as its `clearDetails`.
 *
 * Out: `Cleared`, the message turned into ThingsBoard's (type `ALARM`, the
 * alarm JSON — its `details` the clear script's, as ThingsBoard's `clear_alarm`
 * replaces them (`alarmMessageData`, TB-P 2) — `isClearedAlarm` "true"); `False` when there is nothing to clear
 * — none open, already cleared, a clear another message won first, or an
 * originator that is neither an instrument nor an alarm.
 *
 * NARROWED: only RULE alarms. An ALARM originator naming one of the
 * evaluator's alarms (a limit, inactivity, RS485 or range alarm) is `False`:
 * the evaluator owns those and would raise the condition again on its next pass.
 */
export const CLEAR_ALARM_TYPE = 'tb:action:clear-alarm';

interface ClearAlarmConfig extends JsonObject {
  alarmType: string;
  scriptLang?: string;
  alarmDetailsBuildJs?: string;
}

export async function clearAlarm(ctx: RuleContext<ClearAlarmConfig>, msg: RuleMessage): Promise<void> {
  let instrumentId: string;
  let alarmType: string;
  let previous: unknown;
  if (msg.originator.type === 'ALARM') {
    const alarm = await ctx.services.alarms.byId(msg.originator.id);
    const name = alarm ? ruleAlarmTypeName(alarm.source, alarm.ruleSnapshot) : null;
    if (!alarm || alarm.state !== 'ACTIVE' || !name) {
      ctx.tellNext(msg, RULE_RELATION_FALSE);
      return;
    }
    instrumentId = alarm.instrumentId;
    alarmType = name;
    previous = snapshotDetails(alarm.ruleSnapshot);
  } else if (msg.originator.type === 'INSTRUMENT') {
    alarmType = processPattern(String(ctx.config.alarmType ?? ''), msg).trim();
    if (!alarmType) throw new Error('ALARM_TYPE_REQUIRED: the alarm type came out blank');
    instrumentId = msg.originator.id;
    const open = await openRuleAlarm(ctx, instrumentId, alarmType);
    if (!open) {
      ctx.tellNext(msg, RULE_RELATION_FALSE);
      return;
    }
    previous = snapshotDetails(open.ruleSnapshot);
  } else {
    ctx.tellNext(msg, RULE_RELATION_FALSE);
    return;
  }

  const details = buildAlarmDetails(ctx, msg, previous);
  const closed = await ctx.services.alarms.clear(instrumentId, alarmType, details, ctx.origin);
  if (!closed) {
    ctx.tellNext(msg, RULE_RELATION_FALSE);
    return;
  }
  const out = copyMessage(msg, { type: 'ALARM', data: alarmMessageData(closed) });
  out.metadata.isClearedAlarm = 'true';
  ctx.tellNext(out, 'Cleared');
}
