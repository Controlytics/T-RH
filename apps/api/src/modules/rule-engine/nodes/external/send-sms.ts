import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import type { RuleSendResult } from '../../services.js';
import { processPattern } from '../action/support.js';
import { sendFailureText } from './send-email.js';

export const SEND_SMS_TYPE = 'tb:external:send-sms';

/** ThingsBoard's `TbSendSmsNodeConfiguration`, as the catalogue models it. */
export interface SendSmsConfig {
  numbersToTemplate: string;
  smsMessageTemplate: string;
  useSystemSmsSettings?: boolean;
}

/**
 * Send SMS (`TbSendSmsNode`; spec §7). Both templates are processed against
 * the message; the numbers are split on commas (blank entries dropped) and the
 * message is sent to each through `services.notifications.sms` — the provider
 * under Configuration → SMS, a `notification_logs` row per number, a failed
 * attempt retried by the notification service. `Success` with the message
 * unchanged; `Failure` when no number is left (`SMS_NO_RECIPIENT`), the
 * service fails, or a number's first attempt failed (`SMS_SEND_FAILED`).
 * Narrowing: a node's own SMS provider (`useSystemSmsSettings: false`) is not
 * supported — the system's provider sends.
 */
export const sendSmsHandler: RuleNodeHandler<SendSmsConfig> = async (ctx, msg) => {
  const numbers = processPattern(ctx.config.numbersToTemplate, msg).split(',').map((s) => s.trim()).filter(Boolean);
  const message = processPattern(ctx.config.smsMessageTemplate, msg);
  let result: RuleSendResult;
  try {
    result = await ctx.services.notifications.sms({ numbers, message, origin: ctx.origin });
  } catch (err) {
    return ctx.tellFailure(msg, err);
  }
  if (result.failed.length > 0) return ctx.tellFailure(msg, new Error(sendFailureText('SMS_SEND_FAILED', 'number(s)', new Set(numbers).size, result)));
  ctx.tellNext(msg, RULE_RELATION_SUCCESS);
};
