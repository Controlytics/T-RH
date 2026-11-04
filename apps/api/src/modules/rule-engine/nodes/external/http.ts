import { STATUS_CODES } from 'node:http';

/**
 * HTTP helpers for the REST API call and Send to Slack nodes (rule chains,
 * 2026-11-03). Both send through `services.http.fetch`, which applies the
 * timeout (`AbortSignal.timeout`, the engine's `httpTimeoutMs` when the node
 * passes none).
 */

/** What a failed request ends the message with: a timeout, a refused connection, or our own coded error as it came. */
export function requestError(err: unknown, timeoutMs: number): Error {
  const e = err as { name?: unknown; message?: unknown; cause?: unknown } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return new Error(`HTTP_TIMEOUT: no response within ${timeoutMs} ms`);
  const message = typeof e?.message === 'string' ? e.message : String(err);
  if (/^[A-Z][A-Z_]+: /.test(message)) return err instanceof Error ? err : new Error(message);
  const cause = e?.cause as { code?: unknown; message?: unknown } | undefined;
  const why = typeof cause?.code === 'string' ? cause.code
    : typeof cause?.message === 'string' && cause.message ? cause.message : message;
  return new Error(`HTTP_REQUEST_FAILED: ${why}`);
}

/**
 * The response body as text, refusing more than `maxBytes` — ThingsBoard's
 * `maxInMemoryBufferSizeInKb` (256 KB by default): the body is read in chunks
 * and the read stops at the cap, so a huge response is never held whole.
 */
export async function readCapped(res: Response, maxBytes: number, capKb: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`HTTP_RESPONSE_TOO_LARGE: the response is larger than ${capKb} KB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Spring's `HttpStatus` names where they differ from the reason phrase Node knows. */
const STATUS_NAME_OVERRIDES: Readonly<Record<number, string>> = { 416: 'REQUESTED_RANGE_NOT_SATISFIABLE', 418: 'I_AM_A_TEAPOT' };

/** ThingsBoard's `metadata.status` on a response it accepts: Spring's `HttpStatus.name()` — `OK`, `NOT_FOUND`… */
export function httpStatusName(code: number): string {
  const override = STATUS_NAME_OVERRIDES[code];
  if (override) return override;
  const phrase = STATUS_CODES[code];
  return phrase ? phrase.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') : String(code);
}

/** ThingsBoard's `metadata.statusReason`: the status's reason phrase (`Not Found`). */
export function httpStatusReason(code: number, statusText: string): string {
  return STATUS_CODES[code] ?? statusText;
}
