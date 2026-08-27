/**
 * One HTTP attempt at a webhook target. No retry, no database — the worker owns both.
 *
 * OUTBOUND-REQUEST STANCE (design doc, "Outbound-request stance"): the URL is
 * operator-typed and there is deliberately NO allowlist, because a hooter lives on the
 * operator's LAN and any allowlist would have to contain it. The guards are the hard
 * timeout, redirect:'error' (a hooter does not redirect, and following one is how an
 * internal-IP POST becomes an external one), no credentials/cookies, and the delivery
 * log recording the exact URL, body and response.
 */

/** VARCHAR(1000) on alarm_webhook_deliveries.response_snippet. */
const SNIPPET_MAX = 1000;

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
 */
export function decideSuccess(status: number, body: string, successRegex: string | null): boolean {
  if (status < 200 || status >= 300) return false;
  if (!successRegex) return true;
  try {
    return new RegExp(successRegex).test(body);
  } catch {
    // An unparseable regex must fail closed rather than throw inside the worker.
    // The operator sees a FAILED row with the response body and can fix the pattern.
    return false;
  }
}

export async function attemptDelivery(req: WebhookRequest): Promise<AttemptResult> {
  const method = req.method.toUpperCase();
  const sendsBody = method !== 'GET' && method !== 'HEAD';
  try {
    const res = await fetch(req.url, {
      method,
      headers: sendsBody ? { 'Content-Type': req.contentType, ...req.headers } : { ...req.headers },
      body: sendsBody ? req.body : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    const text = await res.text();
    const snippet = text.slice(0, SNIPPET_MAX);
    return {
      ok: decideSuccess(res.status, text, req.successRegex),
      httpStatus: res.status,
      responseSnippet: snippet,
      error: null,
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
