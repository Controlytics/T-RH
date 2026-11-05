import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import { isSecretLeaf, MASKED_SECRET } from '../../secrets.js';
import type { RuleNodeHandler } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import { processPattern } from '../action/support.js';
import { messageText } from './template.js';
import { maskedSecretPaths, credentialNotSetError } from './credentials.js';
import { ruleHttp, requestError, httpStatusName, httpStatusReason, type RuleHttpResponse } from './http.js';

export const REST_API_CALL_TYPE = 'tb:external:rest-api-call';

/** ThingsBoard's `TbRestApiCallNodeConfiguration`, as the catalogue models it (plus `queryParams` / `maxInMemoryBufferSizeInKb` from its defaults). */
export interface RestApiCallConfig {
  restEndpointUrlPattern: string;
  requestMethod: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string> | null;
  queryParams?: unknown;
  readTimeoutMs?: number;
  maxParallelRequestsCount?: number;
  ignoreRequestBody?: boolean;
  parseToPlainText?: boolean;
  /** ThingsBoard 4's body template (review B I-3): non-empty → it is the body, filled from the message. */
  requestBodyTemplate?: string | null;
  enableProxy?: boolean;
  maxInMemoryBufferSizeInKb?: number;
  credentials?: { type?: string; username?: string; password?: string } | null;
}

/** ThingsBoard (master) sends a body for these only, and only without `ignoreRequestBody`. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_BUFFER_KB = 256;
/** `error_body` is cut at 4 KB: a failing server's HTML page is not a message (review minor 2). */
export const ERROR_BODY_MAX_BYTES = 4096;
/** Cookies are credentials whatever `isSecretLeaf` says of their names (review minor 1). */
const COOKIE_HEADERS = new Set(['cookie', 'set-cookie']);

/**
 * REST API call (`TbRestApiCallNode` / `TbHttpClient`; spec §6, §7). Read
 * from ThingsBoard's source (v3.6.4 and master):
 *  - URL, header names and header values are templated (`${metadata}`,
 *    `$[data]`); `queryParams` entries too, appended to the URL;
 *  - the body (POST / PUT / PATCH / DELETE, unless `ignoreRequestBody`) is
 *    `requestBody`: a non-empty `requestBodyTemplate` filled from the
 *    message, else the message data (`parseToPlainText`: a string goes
 *    unquoted);
 *  - basic credentials add `Authorization: Basic …` (it replaces a configured
 *    one; ThingsBoard sends both). A bearer token is an `Authorization`
 *    header. `cert.PEM` is refused — the transport sends no client
 *    certificate (narrowing);
 *  - sent through `ruleHttp` (http.ts): the TARGET GUARD (ruling S-6,
 *    target-guard.ts) refuses a link-local / unspecified / cloud-metadata
 *    address — an IP literal before any I/O, a name after its one DNS lookup —
 *    with `TARGET_NOT_ALLOWED: <address> …`; loopback and private networks
 *    are allowed; the socket connects to the address that was judged;
 *  - redirects are NOT followed (ThingsBoard's client does not follow them);
 *  - 2xx → `Success`: the response body REPLACES the data (JSON when it
 *    parses, else the text; empty = `{}`), metadata `status` (Spring's name,
 *    `OK`), `statusCode`, `statusReason` and every response header;
 *  - 4xx / 5xx → `Failure` with `status` (the reason phrase — ThingsBoard's
 *    exception path), `statusCode`, `error_body`; any other status (3xx) →
 *    `Failure` with `status` (the name), `statusCode`, `statusReason`,
 *    `error_body` and the headers (`error_body` cut at 4 KB, `…[truncated]`);
 *    a timeout, a refused connection or a body
 *    over `maxInMemoryBufferSizeInKb` → `Failure` with `error`;
 *  - `readTimeoutMs` 0 = the engine's `httpTimeoutMs`; `maxParallelRequestsCount`
 *    bounds the requests ONE node has open (the rest wait, first come first
 *    served);
 *    `enableProxy` is ignored (spec §7).
 * A response header named like a credential (`isSecretLeaf` — `x-auth-token`,
 * `authorization` … — and `cookie` / `set-cookie`) is put in the metadata as
 * `"***"`: the metadata is what
 * debug events record (spec §12). The request's own headers never enter the
 * message, and nothing here logs them.
 */
export const restApiCallHandler: RuleNodeHandler<RestApiCallConfig> = async (ctx, msg) => {
  const cfg = ctx.config;
  const masked = maskedSecretPaths(cfg as unknown as Record<string, unknown>);
  if (masked.length > 0) return ctx.tellFailure(msg, credentialNotSetError(masked));
  const creds = cfg.credentials ?? { type: 'anonymous' };
  if (creds.type === 'cert.PEM') {
    return ctx.tellFailure(msg, new Error('CREDENTIALS_NOT_SUPPORTED: client certificates (cert.PEM) are not supported by the REST API call node here — use basic credentials or an Authorization header'));
  }

  let url: URL;
  try {
    url = new URL(processPattern(cfg.restEndpointUrlPattern, msg));
  } catch {
    return ctx.tellFailure(msg, new Error('HTTP_URL_INVALID: the URL is not a valid absolute URL'));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return ctx.tellFailure(msg, new Error(`HTTP_URL_INVALID: only http and https URLs are called, not ${url.protocol}`));
  }
  if (Array.isArray(cfg.queryParams)) {
    for (const p of cfg.queryParams as { key?: unknown; value?: unknown }[]) {
      if (!p || typeof p.key !== 'string' || !p.key) continue;
      url.searchParams.append(processPattern(p.key, msg), processPattern(typeof p.value === 'string' ? p.value : '', msg));
    }
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(cfg.headers ?? {})) {
    const name = processPattern(k, msg);
    try {
      headers.set(name, processPattern(String(v ?? ''), msg));
    } catch {
      return ctx.tellFailure(msg, new Error(`HTTP_HEADER_INVALID: header "${name}" has a name or value HTTP does not allow`));
    }
  }
  if (creds.type === 'basic') {
    headers.set('Authorization', `Basic ${Buffer.from(`${creds.username ?? ''}:${creds.password ?? ''}`, 'utf8').toString('base64')}`);
  }

  const method = cfg.requestMethod;
  let body: string | undefined;
  try {
    body = BODY_METHODS.has(method) && cfg.ignoreRequestBody !== true ? requestBody(cfg, msg) : undefined;
  } catch (err) {
    return ctx.tellFailure(msg, err);
  }
  const timeoutMs = typeof cfg.readTimeoutMs === 'number' && cfg.readTimeoutMs > 0 ? cfg.readTimeoutMs : ctx.services.config().httpTimeoutMs;
  const capKb = typeof cfg.maxInMemoryBufferSizeInKb === 'number' && cfg.maxInMemoryBufferSizeInKb > 0 ? cfg.maxInMemoryBufferSizeInKb : DEFAULT_BUFFER_KB;

  const release = await acquireLane(ctx.nodeKey, typeof cfg.maxParallelRequestsCount === 'number' ? cfg.maxParallelRequestsCount : 0);
  let res: RuleHttpResponse;
  try {
    res = await ruleHttp.send({ url, method, headers, ...(body !== undefined ? { body } : {}), timeoutMs, capKb });
  } catch (err) {
    return ctx.tellFailure(msg, requestError(err, timeoutMs));
  } finally {
    release();
  }
  const text = res.text;

  const code = res.status;
  const metadata: Record<string, string> = { ...msg.metadata };
  if (code >= 200 && code < 300) {
    metadata.status = httpStatusName(code);
    metadata.statusCode = String(code);
    metadata.statusReason = httpStatusReason(code, res.statusText);
    copyHeaders(res.headers, metadata);
    return ctx.tellNext(withResult(msg, metadata, responseData(text)), RULE_RELATION_SUCCESS);
  }
  const reason = res.statusText || httpStatusReason(code, '');
  if (code >= 400) {
    metadata.status = reason;
    metadata.statusCode = String(code);
    metadata.error_body = errorBody(text);
  } else {
    metadata.status = httpStatusName(code);
    metadata.statusCode = String(code);
    metadata.statusReason = httpStatusReason(code, res.statusText);
    metadata.error_body = errorBody(text);
    copyHeaders(res.headers, metadata);
  }
  return ctx.tellFailure({ ...msg, metadata }, new Error(`HTTP_ERROR: ${code} ${reason}`.trim()));
};

/**
 * The request body — ThingsBoard's `TbHttpClient.getRequestBody` (master
 * e48b5780; review B I-3):
 *  - a `requestBodyTemplate` that is not EMPTY (`StringUtils.isNotEmpty`: a
 *    blank one counts) IS the body, filled by the one template rule
 *    (`processPattern`) with each `${key}` / `$[key]` value JSON-ESCAPED unless
 *    `parseToPlainText` (`escapeJson = !parseToPlainText`); `${*}` / `$[*]` go
 *    in as JSON. With `parseToPlainText` the filled text is sent as it is;
 *    otherwise it must parse as JSON or the message fails with ThingsBoard's
 *    wording (`Request body template produced invalid JSON: …`, the text cut
 *    at 4 KB as `error_body` is). ThingsBoard re-serialises the parsed JSON;
 *    the filled text is sent here as written — the same JSON, only its
 *    whitespace (and the digits of a number like `1.50`) kept as typed;
 *  - no template (absent, null, `""`) → the message data, as before.
 */
export function requestBody(cfg: Pick<RestApiCallConfig, 'requestBodyTemplate' | 'parseToPlainText'>, msg: RuleMessage): string {
  const template = cfg.requestBodyTemplate;
  const plain = cfg.parseToPlainText === true;
  if (typeof template !== 'string' || template.length === 0) return messageText(msg.data, plain);
  const filled = processPattern(template, msg, { escapeJson: !plain });
  if (plain) return filled;
  try {
    JSON.parse(filled);
  } catch {
    throw new Error(`HTTP_BODY_TEMPLATE_INVALID: Request body template produced invalid JSON: ${errorBody(filled)}`);
  }
  return filled;
}

function withResult(msg: RuleMessage, metadata: Record<string, string>, data: unknown): RuleMessage {
  return { ...msg, metadata, data };
}

/** The response body as the message data: JSON when it parses, else the text; nothing = `{}` (ThingsBoard's EMPTY_JSON_OBJECT). */
function responseData(text: string): unknown {
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `error_body`, at most 4 KB of it (a cut multi-byte character is dropped). */
export function errorBody(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= ERROR_BODY_MAX_BYTES) return text;
  return `${bytes.subarray(0, ERROR_BODY_MAX_BYTES).toString('utf8').replace(/\uFFFD+$/, '')}…[truncated]`;
}

/**
 * ThingsBoard's `headersToMetaData`: each response header as a metadata value
 * (names lower-cased). A credential-named header and the cookies go in as
 * `"***"` (spec §12: debug rows record the metadata).
 */
function copyHeaders(headers: Headers, metadata: Record<string, string>): void {
  headers.forEach((value, name) => {
    if (name === 'set-cookie') return;
    metadata[name] = COOKIE_HEADERS.has(name) || isSecretLeaf(name, false) ? MASKED_SECRET : value;
  });
  if (headers.getSetCookie().length > 0) metadata['set-cookie'] = MASKED_SECRET;
}

/**
 * Per-node request lanes, keyed by `ctx.nodeKey`: at most
 * `maxParallelRequestsCount` requests of one node open at once (0 = no limit).
 * FIFO: a request that finds the lane full queues, and a finishing request
 * hands its slot straight to the oldest one waiting — a newcomer never takes a
 * slot while others wait. In memory; a lane deletes itself when its last
 * request finishes (nothing is held for `onDestroy` to release — deleting a
 * lane that still had waiters would strand them).
 */
const lanes = new Map<string, { active: number; waiting: (() => void)[] }>();

async function acquireLane(nodeKey: string, max: number): Promise<() => void> {
  if (!(max > 0)) return () => undefined;
  let lane = lanes.get(nodeKey);
  if (!lane) {
    lane = { active: 0, waiting: [] };
    lanes.set(nodeKey, lane);
  }
  const l = lane;
  if (l.active < max && l.waiting.length === 0) l.active++;
  else await new Promise<void>((resolve) => l.waiting.push(resolve)); // the slot is handed over, `active` unchanged
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = l.waiting.shift();
    if (next) {
      next();
      return;
    }
    l.active--;
    if (l.active === 0 && lanes.get(nodeKey) === l) lanes.delete(nodeKey);
  };
}
