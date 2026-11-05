import { RULE_ORIGINATOR_TYPE_LABELS, RULE_RELATION_SUCCESS, type RuleOriginatorType } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import type { RuleSendResult } from '../../services.js';
import { toFlatMap } from './template.js';

export const SEND_NOTIFICATION_TYPE = 'tb:external:send-notification';

/** The catalogue's Send notification config: a template and the roles / users it goes to. */
export interface SendNotificationConfig {
  templateId?: string | null;
  targets?: { roles?: string[]; userIds?: string[] } | string[] | null;
}

/**
 * Send notification (`TbNotificationNode`; spec §7). Sends the chosen
 * notification template (Configuration → Notification templates; EMAIL or SMS
 * as the template says) to every ENABLED user in the chosen roles and every
 * chosen user, through `services.notifications.byTemplate` — one
 * `notification_logs` row per recipient.
 *
 * The template's `${…}` variables are ThingsBoard's rule-engine notification
 * data: the message METADATA, then the message DATA flattened (`a.b`, `a[0]`;
 * a data key wins over a metadata key of the same name), then
 * `originatorType` (`Instrument`, `Alarm` …), `originatorId` and `msgType`.
 * The service adds `recipientName` / `recipientEmail`.
 *
 * `Success` with `metadata.notificationRequestResult` = the result as JSON
 * (`{ sent, failed: [{ recipient, error }] }` — ThingsBoard puts its own stats
 * object there), even when some recipients failed, as ThingsBoard does.
 * `Failure` when the node names no template (`NOTIFICATION_TEMPLATE_REQUIRED`),
 * holds ThingsBoard notification-target ids from an import
 * (`NOTIFICATION_TARGETS_UNSUPPORTED`), names no role and no user
 * (`NOTIFICATION_NO_TARGETS`), or the service refuses (template missing or
 * switched off).
 */
export const sendNotificationHandler: RuleNodeHandler<SendNotificationConfig> = async (ctx, msg) => {
  const cfg = ctx.config;
  const templateId = typeof cfg.templateId === 'string' ? cfg.templateId.trim() : '';
  if (!templateId) return ctx.tellFailure(msg, new Error('NOTIFICATION_TEMPLATE_REQUIRED: the node names no notification template'));
  if (Array.isArray(cfg.targets)) {
    return ctx.tellFailure(msg, new Error('NOTIFICATION_TARGETS_UNSUPPORTED: ThingsBoard notification targets have no counterpart here — choose roles and users'));
  }
  const roles = (cfg.targets?.roles ?? []).filter((r) => typeof r === 'string' && r.trim());
  const userIds = (cfg.targets?.userIds ?? []).filter((u) => typeof u === 'string' && u.trim());
  if (roles.length === 0 && userIds.length === 0) {
    return ctx.tellFailure(msg, new Error('NOTIFICATION_NO_TARGETS: the node names no role and no user'));
  }
  const variables: Record<string, string> = {
    ...msg.metadata,
    ...toFlatMap(msg.data),
    originatorType: RULE_ORIGINATOR_TYPE_LABELS[msg.originator.type as RuleOriginatorType] ?? msg.originator.type,
    originatorId: msg.originator.id,
    msgType: msg.type,
  };
  let result: RuleSendResult;
  try {
    result = await ctx.services.notifications.byTemplate(templateId, { roles, userIds }, variables);
  } catch (err) {
    return ctx.tellFailure(msg, err);
  }
  ctx.tellNext({ ...msg, metadata: { ...msg.metadata, notificationRequestResult: JSON.stringify(result) } }, RULE_RELATION_SUCCESS);
};
