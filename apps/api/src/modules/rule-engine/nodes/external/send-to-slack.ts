import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import { processPattern } from '../action/support.js';
import { maskedSecretPaths, credentialNotSetError } from './credentials.js';
import { ruleHttp, requestError } from './http.js';

export const SEND_TO_SLACK_TYPE = 'tb:external:send-to-slack';
export const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';
const SLACK_RESPONSE_KB = 256;

/** ThingsBoard's `TbSlackNodeConfiguration`, as the catalogue models it. */
export interface SendToSlackConfig {
  botToken?: string | null;
  useSystemSettings?: boolean;
  messageTemplate: string;
  conversationType?: 'PUBLIC_CHANNEL' | 'PRIVATE_CHANNEL' | 'DIRECT';
  conversation?: string | { id?: string } | null;
}

/**
 * Send to Slack (`TbSlackNode`; spec §7). Posts the templated message to the
 * conversation (a channel or user id; ThingsBoard stores `{ id, name, … }`,
 * a plain id is accepted) with Slack's `chat.postMessage` and the node's BOT
 * TOKEN, through `ruleHttp` (http.ts — the engine's `httpTimeoutMs`; the
 * target guard of ruling S-6 judges slack.com's resolved addresses as it does a
 * REST call's; redirects are not followed, so a 3xx is `SLACK_HTTP_ERROR`).
 * `Success` with the message unchanged when Slack answers `{ ok: true }`;
 * `Failure` when it answers `{ ok: false, error }` (`SLACK_ERROR: <error>` —
 * Slack says that with HTTP 200), on an HTTP error (`SLACK_HTTP_ERROR`), a
 * timeout or a refused connection.
 * Refused before any request: `useSystemSettings` (there are no system Slack
 * settings here), no token ("Slack token is missing", ThingsBoard's words), a
 * token masked on export (`CREDENTIAL_NOT_SET: botToken`), no conversation.
 * Not built: posting to an incoming-webhook URL — the catalogue has no field
 * for one (a shared change).
 */
export const sendToSlackHandler: RuleNodeHandler<SendToSlackConfig> = async (ctx, msg) => {
  const cfg = ctx.config;
  if (cfg.useSystemSettings === true) {
    return ctx.tellFailure(msg, new Error('SLACK_SYSTEM_SETTINGS_UNSUPPORTED: there are no system Slack settings here — enter the node\'s bot token'));
  }
  const masked = maskedSecretPaths(cfg as unknown as Record<string, unknown>);
  if (masked.length > 0) return ctx.tellFailure(msg, credentialNotSetError(masked));
  const token = typeof cfg.botToken === 'string' ? cfg.botToken.trim() : '';
  if (!token) return ctx.tellFailure(msg, new Error('Slack token is missing'));
  const c = cfg.conversation;
  const channel = (typeof c === 'string' ? c : typeof c?.id === 'string' ? c.id : '').trim();
  if (!channel) return ctx.tellFailure(msg, new Error('SLACK_CONVERSATION_REQUIRED: the node names no channel or user'));
  const text = processPattern(cfg.messageTemplate, msg);

  const timeoutMs = ctx.services.config().httpTimeoutMs;
  let status: number;
  let statusText: string;
  let body: string;
  try {
    const res = await ruleHttp.send({
      url: new URL(SLACK_POST_MESSAGE_URL),
      method: 'POST',
      headers: new Headers({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }),
      body: JSON.stringify({ channel, text }),
      timeoutMs,
      capKb: SLACK_RESPONSE_KB,
    });
    status = res.status;
    statusText = res.statusText;
    body = res.text;
  } catch (err) {
    return ctx.tellFailure(msg, requestError(err, timeoutMs));
  }
  if (status < 200 || status >= 300) return ctx.tellFailure(msg, new Error(`SLACK_HTTP_ERROR: ${status} ${statusText}`.trim()));
  let answer: { ok?: unknown; error?: unknown } | null = null;
  try {
    answer = JSON.parse(body) as { ok?: unknown; error?: unknown };
  } catch {
    answer = null;
  }
  if (!answer || answer.ok !== true) {
    return ctx.tellFailure(msg, new Error(`SLACK_ERROR: ${typeof answer?.error === 'string' ? answer.error : 'Slack did not confirm the message'}`));
  }
  ctx.tellNext(msg, RULE_RELATION_SUCCESS);
};
