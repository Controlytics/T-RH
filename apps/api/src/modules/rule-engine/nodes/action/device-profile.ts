import type { RuleContext } from '../../context.js';
import type { RuleMessage } from '../../message.js';

/**
 * DEVICE PROFILE (deprecated) — ThingsBoard's `TbDeviceProfileNode` (rule
 * chains, Task 5; built as a PASS-THROUGH by the 2026-11-04 catalogue ruling).
 *
 * Every ThingsBoard release v3.6–v4.2 ships its root chain with this node as
 * the entry, so an imported ThingsBoard root chain must not die here. In
 * ThingsBoard it evaluates the device profile's alarm rules; this system's
 * profile alarm rules ARE its instrument-limit alarms (Configuration →
 * Instrument Limit Alarms), raised by the evaluator for every reading whether
 * or not a chain runs. So the node passes the message on `Success` unchanged.
 * `persistAlarmRulesState` / `fetchAlarmRulesStateOnStart` are accepted and
 * ignored.
 */
export const DEVICE_PROFILE_TYPE = 'tb:action:device-profile';

export function deviceProfile(ctx: RuleContext, msg: RuleMessage): void {
  ctx.tellNext(msg, 'Success');
}
