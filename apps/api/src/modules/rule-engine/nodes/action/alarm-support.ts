import type { RuleContext } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import { isPlainObject, jsScriptOf, type JsonObject } from './support.js';

/**
 * What Create alarm and Clear alarm share (rule chains, Task 5): the open RULE
 * alarm of a type, its details, and ThingsBoard's details script.
 */

/** The ACTIVE RULE alarm of this type on the instrument (the dedupe index's own key), or null. */
export async function openRuleAlarm(ctx: RuleContext<JsonObject>, instrumentId: string, alarmType: string): Promise<{ ruleSnapshot: unknown } | null> {
  return ctx.services.prisma.alarm.findFirst({
    where: { instrumentId, source: 'RULE', state: 'ACTIVE', ruleSnapshot: { path: ['alarmType'], equals: alarmType } },
    select: { ruleSnapshot: true },
  });
}

/** A RULE alarm's details, as the Create alarm node stored them. */
export function snapshotDetails(ruleSnapshot: unknown): unknown {
  return isPlainObject(ruleSnapshot) ? ruleSnapshot.details : undefined;
}

/**
 * ThingsBoard's `buildAlarmDetails`: the node's details script over the
 * message, with the existing alarm's details in `metadata.prevAlarmDetails`
 * (JSON) when there is one — the shipped script reads them. Only the SCRIPT
 * sees that key; the outgoing message keeps the incoming metadata. With no
 * existing alarm the message is handed over as it is (ThingsBoard's
 * `dummyMsg = msg`) — an incoming `prevAlarmDetails` included. A script
 * returning nothing gives `{}`.
 */
export function buildAlarmDetails(ctx: RuleContext<JsonObject>, msg: RuleMessage, previous: unknown): unknown {
  const script = jsScriptOf(ctx.config, 'alarmDetailsBuildJs');
  const metadata = { ...msg.metadata };
  if (previous !== undefined) metadata.prevAlarmDetails = JSON.stringify(previous);
  const out = ctx.runScript('details', script, { ...msg, metadata });
  return out === undefined ? {} : out;
}
