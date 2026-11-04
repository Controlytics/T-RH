import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleNodeHandler } from '../../context.js';
import { copyMessage, type RuleMessage } from '../../message.js';
import { processPattern } from './pattern.js';
import { processDatePatterns, resolveTimeZone } from './date-pattern.js';

/**
 * To email — ThingsBoard's `TbMsgToEmailNode` (spec §5, §7): builds an email
 * from templates and sends it on as a `SEND_EMAIL` message (Send email, Task 6,
 * sends it). SAME id, originator and metadata; `Success`.
 *
 * Templates are ThingsBoard's (`processPattern`): `${key}` reads metadata,
 * `$[key]` / `$[a.b]` reads data, `${*}` / `$[*]` the whole of either; an
 * unknown placeholder stays as written. Subject and body ALSO get `%d{…}` —
 * NOW in SimpleDateFormat syntax, in the zone `metadata.emailTimezone` names
 * (date-pattern.ts). A blank cc / bcc is null.
 *
 * HTML: `mailBodyType` `'true'` → HTML, `'false'` → plain, `'dynamic'` → the
 * `isHtmlTemplate` result read as Java's `Boolean.parseBoolean` (`true`,
 * ignoring case; anything else false).
 *
 * THE DATA CONTRACT (Task 6 reads it):
 *   { from, to, cc, bcc, subject, body, html, isHtml }
 * `html` is ThingsBoard's `TbEmail` field name (a script written for
 * ThingsBoard reads `msg.html`); `isHtml` is spec §5's name; the two are
 * always equal. ThingsBoard's `images` / `attachments` / `reports` (metadata
 * keys naming stored files) are not carried — there is no file store for
 * them here.
 */
export const TO_EMAIL = 'tb:transformation:to-email';

export interface ToEmailConfig {
  fromTemplate: string;
  toTemplate: string;
  ccTemplate?: string | null;
  bccTemplate?: string | null;
  subjectTemplate: string;
  bodyTemplate: string;
  mailBodyType?: 'false' | 'true' | 'dynamic';
  isHtmlTemplate?: string | null;
}

export interface SendEmailData {
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  body: string | null;
  html: boolean;
  isHtml: boolean;
}

/** ThingsBoard's `fromTemplate`: null for an empty template, else the template filled. */
function fill(template: string | null | undefined, msg: RuleMessage): string | null {
  return typeof template === 'string' && template !== '' ? processPattern(template, msg) : null;
}

const parseBoolean = (s: string | null) => s !== null && s.toLowerCase() === 'true';

export const toEmail: RuleNodeHandler<ToEmailConfig> = (ctx, msg) => {
  const cfg = ctx.config;
  const now = new Date();
  const zone = resolveTimeZone(msg.metadata.emailTimezone);
  const withDate = (template: string | null | undefined) => {
    const filled = fill(template, msg);
    return filled === null ? null : processDatePatterns(filled, now, zone);
  };
  const html = parseBoolean(cfg.mailBodyType === 'dynamic' ? fill(cfg.isHtmlTemplate, msg) : (cfg.mailBodyType ?? 'false'));
  const email: SendEmailData = {
    from: fill(cfg.fromTemplate, msg),
    to: fill(cfg.toTemplate, msg),
    cc: fill(cfg.ccTemplate, msg),
    bcc: fill(cfg.bccTemplate, msg),
    subject: withDate(cfg.subjectTemplate),
    body: withDate(cfg.bodyTemplate),
    html,
    isHtml: html,
  };
  ctx.tellNext(copyMessage(msg, { type: 'SEND_EMAIL', data: email }), RULE_RELATION_SUCCESS);
};
