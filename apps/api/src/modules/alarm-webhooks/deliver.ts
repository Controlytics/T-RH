/**
 * One HTTP attempt at a webhook target. No retry, no database — the worker owns both.
 *
 * OUTBOUND-REQUEST STANCE (design doc, "Outbound-request stance"): the URL is
 * operator-typed and there is deliberately NO allowlist, because a hooter lives on the
 * operator's LAN and any allowlist would have to contain it. The guards are a
 * BLOCKLIST of what no hooter can be (link-local / cloud metadata, loopback,
 * unspecified — lib/outbound-guard.ts, judged after DNS since 2026-10-12), the hard
 * timeout, no redirects (a hooter does not redirect, and following one is how an
 * internal-IP POST becomes an external one), no credentials/cookies, and the delivery
 * log recording the exact URL, body and response.
 */

import vm from 'node:vm';
import { guardedRequest } from '../../lib/outbound-guard.js';

/** VARCHAR(1000) on alarm_webhook_deliveries.response_snippet. */
const SNIPPET_MAX = 1000;

/**
 * How long one success-regex test may run. The pattern is operator-typed, and a
 * nested quantifier (`(a+)+$`) against a body it does not match backtracks
 * exponentially — V8's regexp engine is interruptible, so a `vm` time budget
 * turns a stalled worker slot into a FAILED row the operator can read.
 */
export const REGEX_BUDGET_MS = 100;

export interface WebhookRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  contentType: string;
  body: string;
  timeoutMs: number;
  successRegex: string | null;
}

export interface AttemptResult {
  ok: boolean;
  httpStatus: number | null;
  responseSnippet: string | null;
  error: string | null;
}

/**
 * When a success regex is set it is AUTHORITATIVE over the body — cheap hardware
 * returns HTTP 200 on failure, the lesson already recorded at
 * SmsConfig.httpGatewaySuccessRegex (#sms-2xx). A non-2xx status still fails
 * regardless: a matching string in a 500 body is not a delivery.
 *
 * Judged against the SNIPPET the delivery row stores, never the whole body
 * (audit 2026-10-03, INGEST-15): what the operator reads in the log is exactly
 * what was judged, and a hooter's answer is a few bytes — a pattern that only
 * matches beyond the first 1,000 characters is matching a page, not an
 * acknowledgement. Run under REGEX_BUDGET_MS in its own `vm` context, so a
 * pathological pattern fails closed instead of holding the worker.
 */
export function decideSuccess(status: number, body: string, successRegex: string | null): boolean {
  if (status < 200 || status >= 300) return false;
  if (!successRegex) return true;
  try {
    return vm.runInNewContext(
      'new RegExp(pattern).test(text)',
      { pattern: successRegex, text: body.slice(0, SNIPPET_MAX) },
      { timeout: REGEX_BUDGET_MS },
    ) === true;
  } catch {
    // An unparseable regex — or one that ran out its budget — must fail closed
    // rather than throw inside the worker. The operator sees a FAILED row with
    // the response snippet and can fix the pattern.
    return false;
  }
}

/**
 * Sent through `guardedRequest` (lib/outbound-guard.ts), not `fetch` (audit
 * 2026-10-12 #1): the target URL is operator-typed, and a target at
 * 169.254.169.254 read the EC2 instance metadata service — token by PUT, role
 * credentials by GET — with the test-fire handing back the response. The guard
 * refuses link-local, loopback and unspecified addresses AFTER DNS resolution and
 * connects to exactly the address it checked (no rebinding window). `fetch` cannot
 * be given that lookup without the `undici` package. Redirects are still never
 * followed: a 3xx comes back as its status and fails `decideSuccess`.
 */
export async function attemptDelivery(req: WebhookRequest): Promise<AttemptResult> {
  const method = req.method.toUpperCase();
  const sendsBody = method !== 'GET' && method !== 'HEAD';
  try {
    const res = await guardedRequest({
      url: req.url,
      method,
      headers: sendsBody ? { 'Content-Type': req.contentType, ...req.headers } : { ...req.headers },
      body: sendsBody ? req.body : undefined,
      timeoutMs: req.timeoutMs,
      maxBodyChars: SNIPPET_MAX,
    });
    const isRedirect = res.status >= 300 && res.status < 400;
    return {
      ok: decideSuccess(res.status, res.text, req.successRegex),
      httpStatus: res.status,
      responseSnippet: res.text,
      error: isRedirect ? `Redirect refused (HTTP ${res.status}): a hooter does not redirect, and following one is not allowed.` : null,
    };
  } catch (e) {
    // Timeout, DNS failure, connection refused, or a refused redirect. No status
    // exists, and that absence is itself the diagnostic.
    return {
      ok: false,
      httpStatus: null,
      responseSnippet: null,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}
