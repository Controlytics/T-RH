import type { RuleContext } from '../../context.js';
import { copyMessage, type RuleMessage } from '../../message.js';
import { alarmMessageData } from '../../emit.js';
import { instrumentIdOf, isPlainObject, processPattern, type JsonObject } from './support.js';
import { buildAlarmDetails, openRuleAlarm, snapshotDetails } from './alarm-support.js';

/**
 * CREATE ALARM — ThingsBoard's `TbCreateAlarmNode` (rule chains, Task 5).
 *
 * Raises an alarm of `alarmType` (a pattern) on the originator INSTRUMENT, or
 * updates the ACTIVE one of that type: an `alarms` row `source RULE`, `metric
 * CUSTOM`, `ruleSnapshot { alarmType, nodeId, chainId, details }` through
 * `services.alarms.createOrUpdate` — which notifies, fires the webhook and
 * emits ALARM exactly as the evaluator's alarms do, and dedupes on the partial
 * unique index `alarms_active_rule_type_unique`. The Alarms page names it by
 * that `alarmType`.
 *
 *  - Severity: `severity`, or with `dynamicSeverity` the PATTERN that field
 *    holds; it must come out as CRITICAL / MAJOR / MINOR or ThingsBoard's
 *    WARNING / INDETERMINATE (stored as MINOR) — anything else FAILS, as
 *    ThingsBoard's `AlarmSeverity.valueOf` does, never a silent MINOR.
 *  - Details: the details script, with the OPEN alarm's details in
 *    `metadata.prevAlarmDetails` — none on create, as ThingsBoard's
 *    `buildAlarmDetails(msg, null)`. With `useMessageAlarmData` the message data
 *    IS an alarm (`type`, `severity`, `details`, `originator.id` — what an
 *    ALARM message carries): its details are used as they are unless
 *    `overwriteAlarmDetails`, when the script builds them instead.
 *  - Out: Created (new) or Updated (the open one), the message turned into
 *    ThingsBoard's: type `ALARM`, data = the alarm JSON (`alarmMessageData`),
 *    metadata = the incoming metadata + `isNewAlarm` / `isExistingAlarm` "true"
 *    (`TbAbstractAlarmNode.toAlarmMsg`, master e48b5780 :79-90). A REPEAT on the
 *    open alarm is Updated even when its severity and details are the same
 *    (ruling AL-3): ThingsBoard's TbCreateAlarmNode.updateAlarm sets `endTs = now`
 *    on every repeat (:159), so update_alarm reports it modified and onMsg sends
 *    it on Updated. Here such a no-op writes nothing and sends no root-chain
 *    ENTITY_UPDATED (`unchanged`, ruling RE-1 — ThingsBoard sends one every time).
 *  - `propagate*` and `relationTypes` are kept for export and not applied:
 *    there are no related entities to propagate to.
 */
export const CREATE_ALARM_TYPE = 'tb:action:create-alarm';

/** ThingsBoard's five severities; this system stores the first three (services.ts `ruleAlarmSeverity`). */
const TB_SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR', 'WARNING', 'INDETERMINATE'];

interface CreateAlarmConfig extends JsonObject {
  alarmType: string;
  severity: string;
  dynamicSeverity?: boolean;
  useMessageAlarmData?: boolean;
  overwriteAlarmDetails?: boolean;
  scriptLang?: string;
  alarmDetailsBuildJs?: string;
}

export function severityOf(text: string): string {
  const v = String(text ?? '').trim().toUpperCase();
  if (!TB_SEVERITIES.includes(v)) {
    throw new Error(`ALARM_SEVERITY_INVALID: "${String(text ?? '').trim()}" is not a severity (CRITICAL, MAJOR or MINOR; WARNING and INDETERMINATE read as MINOR)`);
  }
  return v;
}

const configuredSeverity = (cfg: CreateAlarmConfig, msg: RuleMessage) =>
  (cfg.dynamicSeverity === true ? processPattern(String(cfg.severity ?? ''), msg) : String(cfg.severity ?? 'CRITICAL'));

export async function createAlarm(ctx: RuleContext<CreateAlarmConfig>, msg: RuleMessage): Promise<void> {
  const cfg = ctx.config;
  let instrumentId: string;
  let alarmType: string;
  let severity: string;
  let messageDetails: unknown;
  const fromMessage = cfg.useMessageAlarmData === true;
  if (fromMessage) {
    const a = msg.data;
    if (!isPlainObject(a) || typeof a.type !== 'string' || !a.type.trim()) {
      throw new Error('ALARM_DATA_INVALID: "Use the alarm data in the message" needs an alarm in the message data — an object with a type');
    }
    alarmType = a.type.trim();
    const own = isPlainObject(a.originator) && typeof a.originator.id === 'string' && a.originator.id ? a.originator.id : null;
    instrumentId = own ?? instrumentIdOf(msg, 'Create alarm');
    severity = severityOf(typeof a.severity === 'string' && a.severity.trim() ? a.severity : configuredSeverity(cfg, msg));
    messageDetails = a.details ?? {};
  } else {
    instrumentId = instrumentIdOf(msg, 'Create alarm');
    alarmType = processPattern(String(cfg.alarmType ?? ''), msg).trim();
    if (!alarmType) throw new Error('ALARM_TYPE_REQUIRED: the alarm type came out blank');
    severity = severityOf(configuredSeverity(cfg, msg));
  }

  const open = await openRuleAlarm(ctx, instrumentId, alarmType);
  // TB-P 8: ThingsBoard's createNewAlarm builds the details with NO previous alarm
  // (`buildAlarmDetails(msg, null)`); only updateAlarm passes the open alarm's details.
  const details = fromMessage && cfg.overwriteAlarmDetails !== true
    ? messageDetails
    : buildAlarmDetails(ctx, msg, open ? snapshotDetails(open.ruleSnapshot) : undefined);

  const { alarm, created } = await ctx.services.alarms.createOrUpdate({
    instrumentId, alarmType, severity, details, nodeId: ctx.node.id, chainId: ctx.chain.id,
  });
  const out = copyMessage(msg, { type: 'ALARM', data: alarmMessageData(alarm) });
  out.metadata[created ? 'isNewAlarm' : 'isExistingAlarm'] = 'true';
  ctx.tellNext(out, created ? 'Created' : 'Updated');
}
