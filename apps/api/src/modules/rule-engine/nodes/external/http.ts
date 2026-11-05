import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { STATUS_CODES } from 'node:http';
import { targetNotAllowed, ruleTargetLookup } from './target-guard.js';

/**
 * The HTTP transport of the REST API call and Send to Slack nodes (rule chains,
 * 2026-11-03; ruling S-6 2026-11-04).
 *
 * `node:http` / `node:https`, NOT `fetch` (the services have no HTTP primitive at all since fix round 3): the request
 * must connect to the address the guard judged (`ruleTargetLookup`, one DNS
 * lookup, no rebinding window) while keeping the Host header and TLS SNI of the
 * NAME — fetch cannot be given a lookup without an undici dispatcher, and undici
 * is not a dependency here. So:
 *  - an IP-literal host is judged BEFORE any I/O (Node never calls `lookup`
 *    for one); a name is judged inside the connect;
 *  - `agent: false` — a fresh connection per request, never a pooled socket;
 *  - redirects are not followed (ThingsBoard's client does not follow them);
 *  - the WHOLE exchange (DNS, connect, response, body) is bounded by `timeoutMs`,
 *    and an abort at any point is a timeout (`HTTP_TIMEOUT`);
 *  - the body read stops past `capKb` KB (`HTTP_RESPONSE_TOO_LARGE`);
 *  - no `Accept-Encoding` is sent, so a server answers uncompressed; a body a
 *    server compresses anyway is NOT decoded (narrowing);
 *  - defaults the earlier fetch transport sent are kept when the node does not
 *    set them: `Accept: *\/*`, `User-Agent: node`, and `Content-Type:
 *    text/plain;charset=UTF-8` for a body;
 *  - `Content-Length` is always the transport's: the body's byte length, or
 *    none at all for a request without a body (a node's own is dropped).
 */
export interface RuleHttpRequest {
  url: URL;
  method: string;
  headers: Headers;
  body?: string;
  timeoutMs: number;
  capKb: number;
}

export interface RuleHttpResponse {
  status: number;
  statusText: string;
  headers: Headers;
  text: string;
}

const timeoutError = () => Object.assign(new Error('the request timed out'), { name: 'TimeoutError' });

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const h = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) for (const v of value) h.append(name, v);
    else if (typeof value === 'string') h.set(name, value);
  }
  return h;
}

async function sendGuarded(req: RuleHttpRequest): Promise<RuleHttpResponse> {
  const host = req.url.hostname.replace(/^\[|\]$/g, '');
  const literal = targetNotAllowed(host);
  if (literal) throw Object.assign(new Error(literal), { code: 'TARGET_NOT_ALLOWED' });
  if (req.url.protocol !== 'http:' && req.url.protocol !== 'https:') throw new Error(`HTTP_URL_INVALID: only http and https URLs are called, not ${req.url.protocol}`);

  const headers: Record<string, string> = {};
  req.headers.forEach((value, name) => { headers[name] = value; });
  if (req.body !== undefined) {
    headers['content-length'] = String(Buffer.byteLength(req.body));
    if (!('content-type' in headers)) headers['content-type'] = 'text/plain;charset=UTF-8';
  } else {
    // A node's own Content-Length on a request with NO body would leave the server waiting for bytes
    // that never come, until the time-out (task-6b review minor 5): there is nothing to measure.
    delete headers['content-length'];
  }
  if (!('accept' in headers)) headers.accept = '*/*';
  if (!('user-agent' in headers)) headers['user-agent'] = 'node';
  const isHttps = req.url.protocol === 'https:';
  const signal = AbortSignal.timeout(Math.max(1, req.timeoutMs));
  const maxBytes = req.capKb * 1024;

  return new Promise<RuleHttpResponse>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const fail = (e: unknown) => done(() => reject(signal.aborted ? timeoutError() : e));
    const request = (isHttps ? https : http).request(req.url, {
      method: req.method,
      headers,
      lookup: ruleTargetLookup,
      agent: false,
      signal,
      ...(isHttps && net.isIP(host) === 0 ? { servername: host } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let ended = false;
      res.on('data', (c: Buffer) => {
        if (settled) return;
        size += c.length;
        if (size > maxBytes) {
          done(() => reject(new Error(`HTTP_RESPONSE_TOO_LARGE: the response is larger than ${req.capKb} KB`)));
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        ended = true;
        done(() => resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: toHeaders(res.headers),
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      res.on('error', fail);
      res.on('close', () => { if (!ended) fail(new Error('HTTP_REQUEST_FAILED: the connection closed before the response ended')); });
    });
    request.on('error', fail);
    if (req.body !== undefined) request.end(req.body);
    else request.end();
  });
}

/**
 * The transport the two nodes call. A plain object so a test can stand in for
 * `send` (the Slack tests: slack.com is not reachable from a test) and put it
 * back after; nothing else replaces it.
 */
export const ruleHttp: { send: (req: RuleHttpRequest) => Promise<RuleHttpResponse> } = { send: sendGuarded };

/** What a failed request ends the message with: a timeout, a refused or failed connection, or our own coded error as it came. */
export function requestError(err: unknown, timeoutMs: number): Error {
  const e = err as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return new Error(`HTTP_TIMEOUT: no response within ${timeoutMs} ms`);
  const message = typeof e?.message === 'string' ? e.message : String(err);
  if (/^[A-Z][A-Z_]+: /.test(message)) return err instanceof Error ? err : new Error(message);
  const cause = e?.cause as { code?: unknown; message?: unknown } | undefined;
  const why = typeof e?.code === 'string' ? e.code
    : typeof cause?.code === 'string' ? cause.code
      : typeof cause?.message === 'string' && cause.message ? cause.message : message;
  return new Error(`HTTP_REQUEST_FAILED: ${why}`);
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
