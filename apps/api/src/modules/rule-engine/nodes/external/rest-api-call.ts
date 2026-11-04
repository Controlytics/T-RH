import { isSecretLeaf, MASKED_SECRET } from '../../secrets.js';
import type { RuleNodeHandler } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import { processPattern, messageText } from './template.js';
import { maskedSecretPaths, credentialNotSetError } from './credentials.js';
import { requestError, readCapped, httpStatusName, httpStatusReason } from './http.js';

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
  enableProxy?: boolean;
  maxInMemoryBufferSizeInKb?: number;
  credentials?: { type?: string; username?: string; password?: string } | null;
}

/** ThingsBoard (master) sends a body for these only, and only without `ignoreRequestBody`. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_BUFFER_KB = 256;

/**
 * REST API call (`TbRestApiCallNode` / `TbHttpClient`; spec §6, §7). Read
 * from ThingsBoard's source (v3.6.4 and master):
 *  - URL, header names and header values are templated (`${metadata}`,
 *    `$[data]`); `queryParams` entries too, appended to the URL;
 *  - the body is the message data (`parseToPlainText`: a string goes
 *    unquoted) for POST / PUT / PATCH / DELETE unless `ignoreRequestBody`;
 *  - basic credentials add `Authorization: Basic …` (it replaces a configured
 *    one; ThingsBoard sends both). A bearer token is an `Authorization`
 *    header. `cert.PEM` is refused — `services.http.fetch` has no client
 *    certificate (narrowing);
 *  - redirects are NOT followed (ThingsBoard's client does not follow them);
 *  - 2xx → `Success`: the response body REPLACES the data (JSON when it
 *    parses, else the text; empty = `{}`), metadata `status` (Spring's name,
 *    `OK`), `statusCode`, `statusReason` and every response header;
 *  - 4xx / 5xx → `Failure` with `status` (the reason phrase — ThingsBoard's
 *    exception path), `statusCode`, `error_body`; any other status (3xx) →
 *    `Failure` with `status` (the name), `statusCode`, `statusReason`,
 *    `error_body` and the headers; a timeout, a refused connection or a body
 *    over `maxInMemoryBufferSizeInKb` → `Failure` with `error`;
 *  - `readTimeoutMs` 0 = the engine's `httpTimeoutMs`; `maxParallelRequestsCount`
 *    bounds the requests ONE node has open (the rest wait their turn);
 *    `enableProxy` is ignored (spec §7).
 * A response header named like a credential (`isSecretLeaf` — `x-auth-token`,
 * `authorization` …) is put in the metadata as `"***"`: the metadata is what
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
  const body = BODY_METHODS.has(method) && cfg.ignoreRequestBody !== true ? messageText(msg.data, cfg.parseToPlainText === true) : undefined;
  const timeoutMs = typeof cfg.readTimeoutMs === 'number' && cfg.readTimeoutMs > 0 ? cfg.readTimeoutMs : undefined;
  const effectiveTimeout = timeoutMs ?? ctx.services.config().httpTimeoutMs;
  const capKb = typeof cfg.maxInMemoryBufferSizeInKb === 'number' && cfg.maxInMemoryBufferSizeInKb > 0 ? cfg.maxInMemoryBufferSizeInKb : DEFAULT_BUFFER_KB;

  const release = await acquireLane(ctx.nodeKey, typeof cfg.maxParallelRequestsCount === 'number' ? cfg.maxParallelRequestsCount : 0);
  let res: Response;
  let text: string;
  try {
    res = await ctx.services.http.fetch(url.toString(), { method, headers, redirect: 'manual', ...(body !== undefined ? { body } : {}) }, timeoutMs);
    text = await readCapped(res, capKb * 1024, capKb);
  } catch (err) {
    return ctx.tellFailure(msg, requestError(err, effectiveTimeout));
  } finally {
    release();
  }

  const code = res.status;
  const metadata: Record<string, string> = { ...msg.metadata };
  if (code >= 200 && code < 300) {
    metadata.status = httpStatusName(code);
    metadata.statusCode = String(code);
    metadata.statusReason = httpStatusReason(code, res.statusText);
    copyHeaders(res.headers, metadata);
    return ctx.tellNext(withResult(msg, metadata, responseData(text)), 'Success');
  }
  const reason = res.statusText || httpStatusReason(code, '');
  if (code >= 400) {
    metadata.status = reason;
    metadata.statusCode = String(code);
    metadata.error_body = text;
  } else {
    metadata.status = httpStatusName(code);
    metadata.statusCode = String(code);
    metadata.statusReason = httpStatusReason(code, res.statusText);
    metadata.error_body = text;
    copyHeaders(res.headers, metadata);
  }
  return ctx.tellFailure({ ...msg, metadata }, new Error(`HTTP_ERROR: ${code} ${reason}`.trim()));
};

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

/** ThingsBoard's `headersToMetaData`: one value as itself, several as a JSON array. Names arrive lower-cased (fetch). */
function copyHeaders(headers: Headers, metadata: Record<string, string>): void {
  headers.forEach((value, name) => {
    if (name === 'set-cookie') return;
    metadata[name] = isSecretLeaf(name, false) ? MASKED_SECRET : value;
  });
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) metadata['set-cookie'] = cookies.length === 1 ? cookies[0] : JSON.stringify(cookies);
}

/**
 * Per-node request lanes, keyed by `ctx.nodeKey`: `maxParallelRequestsCount`
 * requests of one node at once (0 = no limit); the rest wait in arrival order. In memory — a lane
 * empties itself when its last request finishes.
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
  while (l.active >= max) await new Promise<void>((resolve) => l.waiting.push(resolve));
  l.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    l.active--;
    const next = l.waiting.shift();
    if (next) next();
    else if (l.active === 0 && lanes.get(nodeKey) === l) lanes.delete(nodeKey);
  };
}
