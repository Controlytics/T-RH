/**
 * SMS Channel — Sends SMS via multiple providers (Twilio, Vonage, generic HTTP Gateway).
 *
 * P3 (2026-05-02): AWS SNS dropped. Previous implementation shelled out to the
 * `aws` CLI which made the runtime depend on the AWS CLI being installed on
 * the Windows host — incompatible with the local-Windows-only deployment goal.
 * Operators who want AWS SNS can configure the http-gateway provider against
 * the SNS REST endpoint, or pick MSG91 / Plivo / AfricasTalking / Kaleyra etc.
 * which all expose simple POST APIs.
 */

import type { SmsConfig, NotificationPayload, DeliveryResult, NotificationChannel as IChannel } from '../types.js';
import { getSmsConfig } from '../config-loader.js';

/**
 * Normalize phone number by adding country code if missing.
 */
function normalizePhone(phone: string, defaultCountryCode?: string): string {
  let normalized = phone.replace(/[\s\-()]/g, '');
  if (!normalized.startsWith('+')) {
    const code = defaultCountryCode ?? '+91';
    normalized = code.startsWith('+') ? `${code}${normalized}` : `+${code}${normalized}`;
  }
  return normalized;
}

/**
 * Validate phone number format (basic E.164 check).
 */
function isValidPhone(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}

async function sendViaTwilio(config: SmsConfig, to: string, message: string): Promise<DeliveryResult> {
  const { twilioAccountSid, twilioAuthToken, twilioFromNumber } = config;
  if (!twilioAccountSid || !twilioAuthToken || !twilioFromNumber) {
    return { success: false, error: 'Twilio credentials not configured' };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`;
  const auth = Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64');

  const body = new URLSearchParams({
    To: to,
    From: twilioFromNumber,
    Body: message,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    return { success: false, error: String(data.message ?? `Twilio error: ${res.status}`) };
  }

  return { success: true, messageId: String(data.sid ?? '') };
}

async function sendViaVonage(config: SmsConfig, to: string, message: string): Promise<DeliveryResult> {
  const { vonageApiKey, vonageApiSecret, vonageFromNumber } = config;
  if (!vonageApiKey || !vonageApiSecret) {
    return { success: false, error: 'Vonage credentials not configured' };
  }

  const res = await fetch('https://rest.nexmo.com/sms/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: vonageApiKey,
      api_secret: vonageApiSecret,
      to: to.replace('+', ''),
      from: vonageFromNumber ?? config.senderId ?? 'DigiLog',
      text: message,
    }),
  });

  const data = await res.json() as Record<string, unknown>;
  const messages = data.messages as Array<Record<string, unknown>> | undefined;
  if (messages?.[0]?.status !== '0') {
    return { success: false, error: String(messages?.[0]?.['error-text'] ?? 'Vonage send failed') };
  }

  return { success: true, messageId: String(messages?.[0]?.['message-id'] ?? '') };
}

/**
 * Inspect only for an UNAMBIGUOUS body-level failure that any sane gateway would
 * agree is an error, so this never false-positives a real success (which would
 * cause a needless retry → duplicate SMS). Only trusts a JSON object with an
 * explicit `success/ok === false` or a `status` of error/failed/etc. Anything
 * else (plain text, unknown shape, an `error: null`) → null (treated as success).
 */
export function detectUnambiguousGatewayFailure(bodyText: string): string | null {
  const t = (bodyText ?? '').trim();
  if (!t || t[0] !== '{') return null; // only trust a top-level JSON object
  let parsed: any;
  try { parsed = JSON.parse(t); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const detail = () => String(parsed.message ?? parsed.error ?? parsed.description ?? parsed.reason ?? '').trim();
  if (parsed.success === false || parsed.ok === false) {
    return detail() || 'provider returned success=false';
  }
  const status = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
  if (['error', 'failed', 'failure', 'fail', 'rejected'].includes(status)) {
    return detail() || `provider status=${parsed.status}`;
  }
  return null;
}

/**
 * #sms-2xx (2026-07-04): decide send outcome from an HTTP-gateway response.
 * Previously ANY 2xx was recorded SENT, ignoring gateways that return HTTP 200
 * with an error body (MSG91 / Plivo / custom backends commonly do). Order:
 *   1. non-2xx → fail (unchanged).
 *   2. `httpGatewaySuccessRegex` configured → AUTHORITATIVE: body must match, else
 *      fail (the correct, provider-specific control — the gateway is fully
 *      operator-configured already). An invalid regex is ignored (never crashes a
 *      send) and we fall through.
 *   3. no matcher → still catch an unambiguous JSON failure body; otherwise SENT.
 * Pure + exported for unit testing.
 */
export function interpretHttpGatewayResult(
  httpOk: boolean,
  status: number,
  bodyText: string,
  successRegex?: string,
): { ok: true } | { ok: false; error: string } {
  if (!httpOk) {
    return { ok: false, error: `HTTP Gateway error (${status}): ${bodyText.substring(0, 200)}` };
  }
  const pattern = successRegex?.trim();
  if (pattern) {
    let re: RegExp | null = null;
    try { re = new RegExp(pattern); } catch { re = null; } // invalid config → skip, don't fail the send on it
    if (re) {
      return re.test(bodyText)
        ? { ok: true }
        : { ok: false, error: `HTTP Gateway 2xx but body did not match success pattern /${pattern}/: ${bodyText.substring(0, 200)}` };
    }
  }
  const failure = detectUnambiguousGatewayFailure(bodyText);
  if (failure) return { ok: false, error: `HTTP Gateway reported failure: ${failure.substring(0, 200)}` };
  return { ok: true };
}

async function sendViaHttpGateway(config: SmsConfig, to: string, message: string): Promise<DeliveryResult> {
  const { httpGatewayUrl, httpGatewayMethod, httpGatewayHeaders, httpGatewayBodyTemplate } = config;
  if (!httpGatewayUrl) {
    return { success: false, error: 'HTTP Gateway URL not configured' };
  }

  const method = httpGatewayMethod ?? 'POST';
  let url = httpGatewayUrl;
  let body: string | undefined;

  // Replace placeholders in URL and body template
  const replacePlaceholders = (str: string) =>
    str.replace(/\{phone\}/g, to).replace(/\{message\}/g, encodeURIComponent(message));

  url = replacePlaceholders(url);

  if (method === 'POST' && httpGatewayBodyTemplate) {
    body = httpGatewayBodyTemplate
      .replace(/\{phone\}/g, to)
      .replace(/\{message\}/g, message);
  }

  const res = await fetch(url, {
    method,
    headers: httpGatewayHeaders ?? { 'Content-Type': 'application/json' },
    ...(body ? { body } : {}),
  });

  // A 2xx alone is NOT proof of delivery — many gateways return HTTP 200 with an
  // error body. Interpret the body (operator-configured success regex when set,
  // else an unambiguous JSON-failure check) instead of trusting the status code.
  const text = await res.text();
  const outcome = interpretHttpGatewayResult(res.ok, res.status, text, config.httpGatewaySuccessRegex);
  if (!outcome.ok) return { success: false, error: outcome.error };

  return { success: true, messageId: `http-${Date.now()}` };
}

export const smsChannel: IChannel = {
  name: 'SMS',

  async send(payload: NotificationPayload): Promise<DeliveryResult> {
    const config = await getSmsConfig();
    if (!config || !config.enabled) {
      return { success: false, error: 'SMS notifications are not enabled' };
    }

    const phone = normalizePhone(payload.recipient, config.defaultCountryCode);
    if (!isValidPhone(phone)) {
      return { success: false, error: `Invalid phone number: ${payload.recipient}` };
    }

    const message = payload.message.replace(/<[^>]*>/g, '').substring(0, 1600);

    switch (config.provider) {
      case 'twilio':
        return sendViaTwilio(config, phone, message);
      case 'vonage':
        return sendViaVonage(config, phone, message);
      case 'http-gateway':
        return sendViaHttpGateway(config, phone, message);
      default:
        return { success: false, error: `Unknown SMS provider: ${config.provider}` };
    }
  },

  async testConnection(): Promise<DeliveryResult> {
    const config = await getSmsConfig();
    if (!config || !config.enabled) {
      return { success: false, error: 'SMS notifications are not enabled' };
    }
    // Basic validation that credentials exist
    switch (config.provider) {
      case 'twilio':
        if (!config.twilioAccountSid || !config.twilioAuthToken)
          return { success: false, error: 'Twilio credentials missing' };
        break;
      case 'vonage':
        if (!config.vonageApiKey || !config.vonageApiSecret)
          return { success: false, error: 'Vonage credentials missing' };
        break;
      case 'http-gateway':
        if (!config.httpGatewayUrl)
          return { success: false, error: 'HTTP Gateway URL missing' };
        break;
    }
    return { success: true, messageId: 'config-validated' };
  },
};
