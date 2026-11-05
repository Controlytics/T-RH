import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import type { RuleSendResult } from '../../services.js';

export const SEND_EMAIL_TYPE = 'tb:external:send-email';
const SEND_EMAIL_MESSAGE = 'SEND_EMAIL';

/** ThingsBoard's `TbSendEmailNodeConfiguration`: only `useSystemSmtpSettings` is modelled — the system SMTP is always used. */
export interface SendEmailConfig {
  useSystemSmtpSettings?: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const recipients = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((s) => String(s).trim()).filter(Boolean);
const addressField = (v: unknown): string | string[] | undefined =>
  typeof v === 'string' ? v : Array.isArray(v) ? v.map(String) : undefined;

/** `<what> of <n> … failed — r: e; r: e` — every failed recipient named. */
export function sendFailureText(code: string, noun: string, total: number, result: RuleSendResult): string {
  const named = result.failed.map((f) => `${f.recipient}: ${f.error}`).join('; ');
  return `${code}: ${result.failed.length} of ${total} ${noun} failed — ${named}`;
}

/**
 * Send email (`TbSendEmailNode`; spec §7). Consumes a `SEND_EMAIL` message —
 * the To email node's output: data `{ from, to, cc, bcc, subject, body,
 * isHtml }` (ThingsBoard's own key `html` is read too; data that arrives as
 * JSON text is parsed, as ThingsBoard parses its string data).
 *  - any other message type → `Failure` "Not expected msg type <type> for
 *    SendEmail Node" (ThingsBoard's words); a blank `to` → `Failure` "Email
 *    destination can not be blank [<to>]";
 *  - sent through `services.notifications.email` — the SMTP server under
 *    Configuration → Email, one `notification_logs` row and one email PER
 *    recipient (cc / bcc are delivered as separate emails, not as copies),
 *    a failed attempt retried by the notification service;
 *  - `Success` with the message unchanged when every first attempt went out;
 *    `Failure` (`EMAIL_SEND_FAILED`, naming each failed recipient) otherwise —
 *    ThingsBoard fails the message when its send fails.
 * Narrowing: `from` is ignored (the configured sender sends), `images` are
 * not attached, and a node with its own SMTP settings
 * (`useSystemSmtpSettings: false`) still sends through the system's.
 */
export const sendEmailHandler: RuleNodeHandler<SendEmailConfig> = async (ctx, msg) => {
  if (msg.type !== SEND_EMAIL_MESSAGE) {
    return ctx.tellFailure(msg, new Error(`Not expected msg type ${msg.type} for SendEmail Node`));
  }
  let email: unknown = msg.data;
  if (typeof email === 'string') {
    try {
      email = JSON.parse(email);
    } catch {
      email = undefined;
    }
  }
  if (!isObject(email)) {
    return ctx.tellFailure(msg, new Error('EMAIL_INVALID: the SEND_EMAIL message data is not an email object { to, subject, body, … }'));
  }
  const to = recipients(email.to);
  if (to.length === 0) {
    return ctx.tellFailure(msg, new Error(`Email destination can not be blank [${typeof email.to === 'string' ? email.to : String(email.to ?? 'null')}]`));
  }
  const cc = addressField(email.cc);
  const bcc = addressField(email.bcc);
  const total = new Set([...to, ...recipients(cc), ...recipients(bcc)]).size;
  let result: RuleSendResult;
  try {
    result = await ctx.services.notifications.email({
      to: addressField(email.to)!,
      ...(cc !== undefined ? { cc } : {}),
      ...(bcc !== undefined ? { bcc } : {}),
      subject: typeof email.subject === 'string' ? email.subject : '',
      body: typeof email.body === 'string' ? email.body : '',
      isHtml: email.isHtml === true || email.html === true,
      origin: ctx.origin,
    });
  } catch (err) {
    return ctx.tellFailure(msg, err);
  }
  if (result.failed.length > 0) return ctx.tellFailure(msg, new Error(sendFailureText('EMAIL_SEND_FAILED', 'recipient(s)', total, result)));
  ctx.tellNext(msg, RULE_RELATION_SUCCESS);
};
