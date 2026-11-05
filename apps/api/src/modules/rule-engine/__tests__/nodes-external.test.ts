import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { BUILT_RULE_NODE_TYPES, type RuleChainDocument } from '@digilog/shared';
import { createRuleServices, mqttClientIdFor, type RuleServicesHandle } from '../services.js';
import { RULE_ENGINE_CONFIG_DEFAULTS } from '../config.js';
import { clearRegistry, getHandler, registerNode } from '../registry.js';
import { createRuleEngine } from '../engine.js';
import { exportChain, importChain } from '../import-export.js';
import type { RuleNodeHandler, RuleContext } from '../context.js';
import { fakeContext, fakeServices, testMessage, nodeOf, docOf, chainOf, memoryDeps } from '../../../test-support/rule-engine.js';
import { registerExternalNodes } from '../nodes/external/index.js';
import { toFlatMap } from '../nodes/external/template.js';
import { processPattern } from '../nodes/action/support.js';
import { restApiCallHandler, errorBody } from '../nodes/external/rest-api-call.js';
import { ruleHttp } from '../nodes/external/http.js';
import { targetNotAllowed, ruleTargetLookup } from '../nodes/external/target-guard.js';
import { blockedAddressReason } from '../../../lib/outbound-guard.js';
import { mqttHandler, mqttLifecycle, type MqttNodeConfig } from '../nodes/external/mqtt.js';
import { sendEmailHandler } from '../nodes/external/send-email.js';
import { sendSmsHandler } from '../nodes/external/send-sms.js';
import { sendNotificationHandler } from '../nodes/external/send-notification.js';
import { sendToSlackHandler } from '../nodes/external/send-to-slack.js';

/**
 * The six EXTERNAL rule nodes (rule chains Task 6; spec §6, §7 External, §12).
 * REST API call runs against a local Fastify stub through the REAL guarded
 * transport (`ruleHttp.send`, nodes/external/http.ts); MQTT through the REAL `services.mqtt` with `mqtt.connect`
 * mocked; email / SMS / notification / Slack against stubbed services.
 *
 * ThingsBoard references (v3.6.4 / master source): TbHttpClient, TbMqttNode,
 * TbSendEmailNode, TbSendSmsNode, TbNotificationNode, TbSlackNode.
 */

// ─── the mqtt module, mocked (the service imports `mqtt` and calls `mqtt.connect`) ───
const mqttMock = vi.hoisted(() => {
  interface FakeClient {
    opts: Record<string, unknown>;
    connected: boolean;
    failPublish: boolean;
    published: { topic: string; payload: string; opts: unknown }[];
    ended: boolean;
    on: (ev: string, fn: (...a: unknown[]) => void) => FakeClient;
    once: (ev: string, fn: (...a: unknown[]) => void) => FakeClient;
    publishAsync: (topic: string, payload: string, opts: unknown) => Promise<void>;
    endAsync: (force?: boolean) => Promise<void>;
  }
  const clients: FakeClient[] = [];
  const connect = (opts: Record<string, unknown>): FakeClient => {
    const c: FakeClient = {
      opts, connected: false, failPublish: false, published: [], ended: false,
      on: () => c,
      once: (ev, fn) => { if (ev === 'connect') queueMicrotask(() => { c.connected = true; fn(); }); return c; },
      publishAsync: async (topic, payload, o) => {
        if (c.failPublish) throw new Error('broker refused the publish');
        c.published.push({ topic, payload, opts: o });
      },
      endAsync: async () => { c.ended = true; },
    };
    clients.push(c);
    return c;
  };
  return { clients, connect };
});
vi.mock('mqtt', () => ({ default: { connect: mqttMock.connect }, connect: mqttMock.connect }));

const REST = 'tb:external:rest-api-call';
const MQTT = 'tb:external:mqtt';
const EMAIL = 'tb:external:send-email';
const SMS = 'tb:external:send-sms';
const NOTIFY = 'tb:external:send-notification';
const SLACK = 'tb:external:send-to-slack';

type Handler = RuleNodeHandler<any>;
async function run(handler: Handler, ctx: RuleContext<any>, msg: ReturnType<typeof testMessage>) {
  await handler(ctx, msg);
}

// ─── the local REST stub ─────────────────────────────────────────────────────
interface Seen { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string | undefined }
let stub: FastifyInstance;
let base = '';
let seen: Seen[] = [];
let inFlight = 0;
let maxInFlight = 0;

function record(req: FastifyRequest) {
  seen.push({ method: req.method, url: req.url, headers: req.headers, body: typeof req.body === 'string' ? req.body : undefined });
}

beforeAll(async () => {
  stub = Fastify();
  stub.removeAllContentTypeParsers();
  stub.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
  stub.route({
    method: [...methods], url: '/api/:code', exposeHeadRoute: false,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      record(req);
      reply.header('x-request-id', 'r-1').header('x-auth-token', 'secret-abc').header('set-cookie', 'sid=s3cr3t; HttpOnly').header('cookie', 'jar=j4r');
      return { ok: true, code: (req.params as { code: string }).code };
    },
  });
  stub.post('/missing', async (req, reply) => { record(req); reply.code(404).type('text/plain'); return 'no such thing'; });
  stub.post('/missing-big', async (req, reply) => { record(req); reply.code(500).type('text/plain'); return 'y'.repeat(5000); });
  stub.post('/drip', (req, reply) => {
    record(req);
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/plain' });
    reply.raw.write('part of it');
    setTimeout(() => reply.raw.end(' and the rest'), 600);
  });
  stub.get('/moved', async (req, reply) => { record(req); reply.code(302).header('location', '/api/elsewhere'); return ''; });
  stub.post('/slow', async (req) => { record(req); await new Promise((r) => setTimeout(r, 600)); return { late: true }; });
  stub.post('/big', async (req, reply) => { record(req); reply.type('text/plain'); return 'x'.repeat(2048); });
  stub.post('/text', async (req, reply) => { record(req); reply.type('text/plain'); return 'OK'; });
  stub.post('/empty', async (req, reply) => { record(req); reply.code(204); return undefined; });
  stub.post('/parallel', async (req) => {
    record(req);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 150));
    inFlight--;
    return { done: true };
  });
  await stub.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await stub.close();
});

beforeEach(() => {
  seen = [];
  inFlight = 0;
  maxInFlight = 0;
});

/** REST runs on the REAL guarded transport; a Slack test stands in for `ruleHttp.send` and it is put back here. Every spy too. */
const realSend = ruleHttp.send;
afterEach(() => {
  ruleHttp.send = realSend;
  vi.restoreAllMocks();
});

function restCtx(config: Record<string, unknown>, opts: { nodeId?: string; chainId?: string; httpTimeoutMs?: number } = {}) {
  const { httpTimeoutMs, ...ids } = opts;
  const services = fakeServices({}, httpTimeoutMs ? { httpTimeoutMs } : {});
  const { ctx, calls } = fakeContext({ type: REST, config, services, ...ids });
  return { ctx, calls };
}

const telemetry = () => testMessage({ temp: 21.5, nested: { v: 7 }, flag: true }, { metadata: { instrumentCode: 'CWH-001', unit: 'C' } });

// ─── registration ────────────────────────────────────────────────────────────
describe('registerExternalNodes', () => {
  it('registers exactly the BUILT external types of the catalogue, MQTT with an onDestroy', () => {
    clearRegistry();
    registerExternalNodes();
    const built = BUILT_RULE_NODE_TYPES.filter((s) => s.group === 'external').map((s) => s.id).sort();
    expect(built).toEqual([MQTT, REST, EMAIL, NOTIFY, SMS, SLACK].sort());
    for (const id of built) expect(getHandler(id), id).toBeDefined();
    expect(getHandler(MQTT)?.onDestroy).toBeTypeOf('function');
    // Registering twice is harmless (the engine registers on every start).
    registerExternalNodes();
    expect(getHandler(REST)).toBeDefined();
    clearRegistry();
  });
});

// ─── templates ───────────────────────────────────────────────────────────────
describe('processPattern (ThingsBoard TbNodeUtils.processPattern)', () => {
  const msg = { metadata: { instrumentCode: 'CWH/001', ts: '1700000000000' }, data: { temp: 21.5, n: 20, ok: false, none: null, nested: { v: 7, deep: { w: 'x' } }, list: [1, 2] } };

  it('${key} reads metadata, $[key] reads data, dotted paths walk objects', () => {
    expect(processPattern('i/${instrumentCode}/t=$[temp]/n=$[n]/b=$[ok]/z=$[none]/v=$[nested.v]/w=$[nested.deep.w]', msg))
      .toBe('i/CWH/001/t=21.5/n=20/b=false/z=null/v=7/w=x');
  });

  it('leaves a placeholder it cannot resolve as written — a missing key, an object, an array', () => {
    expect(processPattern('${missing}|$[missing]|$[nested]|$[list]|$[nested.]', msg)).toBe('${missing}|$[missing]|$[nested]|$[list]|$[nested.]');
  });

  it('substitutes in ONE pass: a substituted value is never expanded again', () => {
    const m = { metadata: { a: '${b}', b: 'B', c: '$[t]' }, data: { t: 5, s: '${b}' } };
    expect(processPattern('${a}|${c}|$[s]|${b}|$[t]', m)).toBe('${b}|$[t]|${b}|B|5');
  });

  it('reads OWN keys only: an inherited property is not a value', () => {
    const m = { metadata: { ts: '1' }, data: JSON.parse('{"a":{"b":2}}') as unknown };
    expect(processPattern('$[constructor]|$[a.toString]|$[a.b]|${constructor}|${hasOwnProperty}', m))
      .toBe('$[constructor]|$[a.toString]|2|${constructor}|${hasOwnProperty}');
  });

  it('data that is not an object resolves only metadata', () => {
    expect(processPattern('${ts}:$[temp]', { metadata: { ts: '1' }, data: 'hello' })).toBe('1:$[temp]');
  });

  it('toFlatMap flattens objects with dots and arrays with [i] (ThingsBoard JacksonUtil.toFlatMap)', () => {
    expect(toFlatMap({ a: 1, b: { c: 'x', d: [true, { e: null }] } })).toEqual({ a: '1', 'b.c': 'x', 'b.d[0]': 'true', 'b.d[1].e': 'null' });
    expect(toFlatMap('scalar')).toEqual({});
  });
});

// ─── REST API call ───────────────────────────────────────────────────────────
describe('REST API call', () => {
  it('POST: templated URL and headers, the message data as the body; the response becomes the message, its status the metadata', async () => {
    const { ctx, calls } = restCtx({
      restEndpointUrlPattern: `${base}/api/\${instrumentCode}?v=$[nested.v]`,
      requestMethod: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Unit-${unit}': 'temp=$[temp]' },
    });
    const msg = telemetry();
    await run(restApiCallHandler, ctx, msg);
    expect(calls.relations()).toEqual(['Success']);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/api/CWH-001?v=7');
    expect(seen[0].headers['x-unit-c']).toBe('temp=21.5');
    expect(JSON.parse(seen[0].body!)).toEqual(msg.data);
    const out = calls.next[0].msg;
    expect(out.id).toBe(msg.id);
    expect(out.data).toEqual({ ok: true, code: 'CWH-001' });
    expect(out.metadata).toMatchObject({ status: 'OK', statusCode: '200', statusReason: 'OK', 'x-request-id': 'r-1', instrumentCode: 'CWH-001' });
    // A response header named like a credential, and the cookies, are masked (spec §12: no credentials in debug events).
    expect(out.metadata['x-auth-token']).toBe('***');
    expect(out.metadata['set-cookie']).toBe('***');
    expect(out.metadata.cookie).toBe('***');
    expect(JSON.stringify(out.metadata)).not.toMatch(/secret-abc|s3cr3t|j4r/);
  });

  it('GET and HEAD send no body (fetch refuses one); ignoreRequestBody sends none on POST', async () => {
    for (const requestMethod of ['GET', 'HEAD', 'OPTIONS']) {
      const { ctx, calls } = restCtx({ restEndpointUrlPattern: `${base}/api/g`, requestMethod });
      await run(restApiCallHandler, ctx, telemetry());
      expect(calls.relations(), requestMethod).toEqual(['Success']);
    }
    const { ctx, calls } = restCtx({ restEndpointUrlPattern: `${base}/api/p`, requestMethod: 'POST', ignoreRequestBody: true });
    await run(restApiCallHandler, ctx, telemetry());
    expect(calls.relations()).toEqual(['Success']);
    // No body bytes on any of them (the stub reads an absent body as "" or nothing).
    expect(seen.map((s) => [s.method, s.body || null])).toEqual([['GET', null], ['HEAD', null], ['OPTIONS', null], ['POST', null]]);
    expect(seen[3].headers['content-length'] ?? '0').toBe('0');
  });

  it('PUT, PATCH and DELETE carry the body as ThingsBoard does', async () => {
    for (const requestMethod of ['PUT', 'PATCH', 'DELETE']) {
      const { ctx, calls } = restCtx({ restEndpointUrlPattern: `${base}/api/m`, requestMethod });
      await run(restApiCallHandler, ctx, testMessage({ a: 1 }));
      expect(calls.relations(), requestMethod).toEqual(['Success']);
    }
    expect(seen.map((s) => [s.method, s.body])).toEqual([['PUT', '{"a":1}'], ['PATCH', '{"a":1}'], ['DELETE', '{"a":1}']]);
  });

  it('parseToPlainText sends a STRING message as plain text; off, it is sent as JSON', async () => {
    const on = restCtx({ restEndpointUrlPattern: `${base}/api/s`, requestMethod: 'POST', headers: {}, parseToPlainText: true });
    await run(restApiCallHandler, on.ctx, testMessage('Hello, "world"'));
    const off = restCtx({ restEndpointUrlPattern: `${base}/api/s`, requestMethod: 'POST', headers: {} });
    await run(restApiCallHandler, off.ctx, testMessage('Hello, "world"'));
    expect(seen.map((s) => s.body)).toEqual(['Hello, "world"', '"Hello, \\"world\\""']);
  });

  it('a non-2xx response ends on Failure with status, statusCode and error_body (ThingsBoard\'s exception path)', async () => {
    const { ctx, calls } = restCtx({ restEndpointUrlPattern: `${base}/missing`, requestMethod: 'POST' });
    await run(restApiCallHandler, ctx, telemetry());
    expect(calls.relations()).toEqual(['Failure']);
    const failed = calls.failures[0].msg;
    expect(failed.metadata).toMatchObject({ status: 'Not Found', statusCode: '404', error_body: 'no such thing' });
    expect(failed.metadata.error).toBe('HTTP_ERROR: 404 Not Found');
    expect(failed.data).toEqual(telemetry().data);
  });

  it('a redirect is NOT followed (ThingsBoard\'s client does not): Failure with the 3xx status', async () => {
    const { ctx, calls } = restCtx({ restEndpointUrlPattern: `${base}/moved`, requestMethod: 'GET' });
    await run(restApiCallHandler, ctx, telemetry());
    expect(calls.relations()).toEqual(['Failure']);
    expect(calls.failures[0].msg.metadata).toMatchObject({ status: 'FOUND', statusCode: '302', statusReason: 'Found', location: '/api/elsewhere' });
    expect(seen.map((s) => s.url)).toEqual(['/moved']);
  });

  it('times out on the node\'s readTimeoutMs → Failure HTTP_TIMEOUT', async () => {
    const { ctx, calls } = restCtx({ restEndpointUrlPattern: `${base}/slow`, requestMethod: 'POST', readTimeoutMs: 100 });
    const started = Date.now();
    await run(restApiCallHandler, ctx, telemetry());
    expect(Date.now() - started).toBeLessThan(550);
    expect(calls.relations()).toEqual(['Failure']);
    expect(calls.failures[0].error).toBe('HTTP_TIMEOUT: no response within 100 ms');
  });

  it('readTimeoutMs 0 means the engine\'s httpTimeoutMs', async () => {
    const { ctx, calls } = restCtx({ restEndpointUrlPattern: `${base}/slow`, requestMethod: 'POST', readTimeoutMs: 0 }, { httpTimeoutMs: 120 });
    await run(restApiCallHandler, ctx, telemetry());
    expect(calls.failures[0].error).toBe('HTTP_TIMEOUT: no response within 120 ms');
  });

  it('a timeout while the BODY is still arriving is a timeout too', async () => {
    const { ctx, calls } = restCtx({ restEndpointUrlPattern: `${base}/drip`, requestMethod: 'POST', readTimeoutMs: 150 });
    await run(restApiCallHandler, ctx, telemetry());
    expect(calls.failures.map((f) => f.error)).toEqual(['HTTP_TIMEOUT: no response within 150 ms']);
  });

  it('error_body is cut at 4 KB', async () => {
    const { ctx, calls } = restCtx({ restEndpointUrlPattern: `${base}/missing-big`, requestMethod: 'POST' });
    await run(restApiCallHandler, ctx, telemetry());
    expect(calls.failures[0].msg.metadata).toMatchObject({ statusCode: '500', error_body: `${'y'.repeat(4096)}…[truncated]` });
    // A multi-byte character cut at the boundary is dropped, not half-printed.
    expect(errorBody(`a${'é'.repeat(3000)}`)).toBe(`a${'é'.repeat(2047)}…[truncated]`);
    expect(errorBody('short')).toBe('short');
  });

  it('a plain-text response stays text; an empty one is {} as in ThingsBoard', async () => {
    const t = restCtx({ restEndpointUrlPattern: `${base}/text`, requestMethod: 'POST' });
    await run(restApiCallHandler, t.ctx, telemetry());
    expect(t.calls.next[0].msg.data).toBe('OK');
    const e = restCtx({ restEndpointUrlPattern: `${base}/empty`, requestMethod: 'POST' });
    await run(restApiCallHandler, e.ctx, telemetry());
    expect(e.calls.next[0].msg.data).toEqual({});
    expect(e.calls.next[0].msg.metadata).toMatchObject({ status: 'NO_CONTENT', statusCode: '204', statusReason: 'No Content' });
  });

  it('a response larger than maxInMemoryBufferSizeInKb ends on Failure', async () => {
    const { ctx, calls } = restCtx({ restEndpointUrlPattern: `${base}/big`, requestMethod: 'POST', maxInMemoryBufferSizeInKb: 1 });
    await run(restApiCallHandler, ctx, telemetry());
    expect(calls.relations()).toEqual(['Failure']);
    expect(calls.failures[0].error).toBe('HTTP_RESPONSE_TOO_LARGE: the response is larger than 1 KB');
    const ok = restCtx({ restEndpointUrlPattern: `${base}/big`, requestMethod: 'POST', maxInMemoryBufferSizeInKb: 4 });
    await run(restApiCallHandler, ok.ctx, telemetry());
    expect(ok.calls.next[0].msg.data).toBe('x'.repeat(2048));
  });

  it('basic credentials send an Authorization header; a bearer token is a header', async () => {
    const b = restCtx({ restEndpointUrlPattern: `${base}/api/a`, requestMethod: 'POST', credentials: { type: 'basic', username: 'svc', password: 'p@ss' } });
    await run(restApiCallHandler, b.ctx, telemetry());
    const t = restCtx({ restEndpointUrlPattern: `${base}/api/b`, requestMethod: 'POST', headers: { Authorization: 'Bearer tok-1' } });
    await run(restApiCallHandler, t.ctx, telemetry());
    expect(seen.map((s) => s.headers.authorization)).toEqual([`Basic ${Buffer.from('svc:p@ss').toString('base64')}`, 'Bearer tok-1']);
    expect([...b.calls.relations(), ...t.calls.relations()]).toEqual(['Success', 'Success']);
    // Nothing the node logged carries the credential.
    expect(JSON.stringify([b.calls.logs, t.calls.logs])).not.toMatch(/p@ss|tok-1|c3ZjOnBAc3M/);
  });

  it('a credential masked on export ("***") is never sent: Failure CREDENTIAL_NOT_SET naming it', async () => {
    const p = restCtx({ restEndpointUrlPattern: `${base}/api/a`, requestMethod: 'POST', credentials: { type: 'basic', username: 'svc', password: '***' } });
    await run(restApiCallHandler, p.ctx, telemetry());
    const h = restCtx({ restEndpointUrlPattern: `${base}/api/a`, requestMethod: 'POST', headers: { Authorization: '***' } });
    await run(restApiCallHandler, h.ctx, telemetry());
    expect(p.calls.failures.map((f) => f.error)).toEqual(['CREDENTIAL_NOT_SET: credentials.password']);
    expect(h.calls.failures.map((f) => f.error)).toEqual(['CREDENTIAL_NOT_SET: headers.Authorization']);
    expect(seen).toHaveLength(0);
  });

  it('cert.PEM client certificates are refused plainly (not supported here)', async () => {
    const { ctx, calls } = restCtx({ restEndpointUrlPattern: `${base}/api/a`, requestMethod: 'POST', credentials: { type: 'cert.PEM', cert: 'C', privateKey: 'K' } });
    await run(restApiCallHandler, ctx, telemetry());
    expect(calls.failures[0].error).toMatch(/^CREDENTIALS_NOT_SUPPORTED: /);
    expect(seen).toHaveLength(0);
  });

  it('an unusable URL ends on Failure HTTP_URL_INVALID without a request', async () => {
    for (const restEndpointUrlPattern of ['not a url', 'ftp://example.com/x', '${missing}']) {
      const { ctx, calls } = restCtx({ restEndpointUrlPattern, requestMethod: 'POST' });
      await run(restApiCallHandler, ctx, telemetry());
      expect(calls.failures[0]?.error, restEndpointUrlPattern).toMatch(/^HTTP_URL_INVALID: /);
    }
  });

  it('a refused connection ends on Failure HTTP_REQUEST_FAILED', async () => {
    const closed = Fastify();
    await closed.listen({ host: '127.0.0.1', port: 0 });
    const port = (closed.server.address() as AddressInfo).port;
    await closed.close();
    const { ctx, calls } = restCtx({ restEndpointUrlPattern: `http://127.0.0.1:${port}/x`, requestMethod: 'POST', readTimeoutMs: 10_000 });
    await run(restApiCallHandler, ctx, telemetry());
    expect(calls.failures[0].error).toMatch(/^HTTP_REQUEST_FAILED: ECONNREFUSED/);
  });

  it('queryParams (ThingsBoard master) are templated and appended', async () => {
    const { ctx } = restCtx({
      restEndpointUrlPattern: `${base}/api/q?a=1`, requestMethod: 'GET',
      queryParams: [{ key: 'code', value: '${instrumentCode}' }, { key: 't', value: '$[temp]' }],
    });
    await run(restApiCallHandler, ctx, telemetry());
    expect(seen[0].url).toBe('/api/q?a=1&code=CWH-001&t=21.5');
  });

  it('maxParallelRequestsCount bounds the requests one node (ctx.nodeKey) has open at once', async () => {
    const nodeId = '7d1e0000-0000-4000-8000-000000000001';
    const chainId = '7d1e0000-0000-4000-8000-0000000000c1';
    const one = [restCtx({ restEndpointUrlPattern: `${base}/parallel`, requestMethod: 'POST', maxParallelRequestsCount: 1 }, { nodeId, chainId }),
      restCtx({ restEndpointUrlPattern: `${base}/parallel`, requestMethod: 'POST', maxParallelRequestsCount: 1 }, { nodeId, chainId })];
    await Promise.all(one.map((c) => run(restApiCallHandler, c.ctx, telemetry())));
    expect(maxInFlight).toBe(1);
    expect(one.flatMap((c) => c.calls.relations())).toEqual(['Success', 'Success']);
    maxInFlight = 0;
    const free = [restCtx({ restEndpointUrlPattern: `${base}/parallel`, requestMethod: 'POST' }, { nodeId, chainId }),
      restCtx({ restEndpointUrlPattern: `${base}/parallel`, requestMethod: 'POST' }, { nodeId, chainId })];
    await Promise.all(free.map((c) => run(restApiCallHandler, c.ctx, telemetry())));
    expect(maxInFlight).toBe(2);
    // The SAME node id in another chain is another node: its own lane.
    maxInFlight = 0;
    const twoChains = [restCtx({ restEndpointUrlPattern: `${base}/parallel`, requestMethod: 'POST', maxParallelRequestsCount: 1 }, { nodeId, chainId }),
      restCtx({ restEndpointUrlPattern: `${base}/parallel`, requestMethod: 'POST', maxParallelRequestsCount: 1 }, { nodeId })];
    await Promise.all(twoChains.map((c) => run(restApiCallHandler, c.ctx, telemetry())));
    expect(maxInFlight).toBe(2);
  });

  it('a full lane serves the requests waiting in it first come, first served', async () => {
    const nodeId = '7d1e0000-0000-4000-8000-000000000002';
    const chainId = '7d1e0000-0000-4000-8000-0000000000c2';
    const order = ['a', 'b', 'c', 'd'];
    const ctxs = order.map(() => restCtx({ restEndpointUrlPattern: `${base}/parallel?i=$[i]`, requestMethod: 'POST', maxParallelRequestsCount: 1 }, { nodeId, chainId }));
    await Promise.all(ctxs.map((c, i) => run(restApiCallHandler, c.ctx, testMessage({ i: order[i] }))));
    expect(seen.map((s) => s.url)).toEqual(order.map((i) => `/parallel?i=${i}`));
    expect(maxInFlight).toBe(1);
  });

  it('through the ENGINE with debug on: no debug event carries the credential the node sent', async () => {
    const restore = registerNode(REST, restApiCallHandler);
    try {
      const rest = nodeOf(REST, 'Call out', {
        debugMode: 'all',
        config: { restEndpointUrlPattern: `${base}/api/e`, requestMethod: 'POST', headers: { 'X-Api-Key': 'key-xyz' }, credentials: { type: 'basic', username: 'svc', password: 'p@ss' } },
      });
      const root = chainOf('Root', docOf([rest], []), { root: true });
      const mem = memoryDeps([root]);
      const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
      await engine.processNow(telemetry());
      expect(seen).toHaveLength(1);
      expect(seen[0].headers['x-api-key']).toBe('key-xyz');
      expect(mem.events.map((e) => [e.direction, e.relation ?? null])).toEqual([['IN', null], ['OUT', 'Success (unconnected)']]);
      const dump = JSON.stringify(mem.events);
      expect(dump).not.toMatch(/p@ss|key-xyz|secret-abc|c3ZjOnBAc3M/);
    } finally {
      restore();
    }
  });

  it('a chain exported (masked) and imported back refuses to send the masked password — and says so on import', async () => {
    const rest = nodeOf(REST, 'Call out', { config: { restEndpointUrlPattern: `${base}/api/x`, requestMethod: 'POST', credentials: { type: 'basic', username: 'svc', password: 'p@ss' } } });
    const doc: RuleChainDocument = docOf([rest], []);
    const exported = exportChain({ name: 'Out', root: false, debugMode: false, document: doc });
    expect(JSON.stringify(exported)).not.toContain('p@ss');
    const imported = importChain(JSON.parse(JSON.stringify(exported)));
    expect(imported.warnings).toEqual([expect.stringContaining('Node "Call out": credential must be entered (credentials.password)')]);
    const { ctx, calls } = restCtx(imported.document.nodes[0].config);
    await run(restApiCallHandler, ctx, telemetry());
    expect(calls.failures.map((f) => f.error)).toEqual(['CREDENTIAL_NOT_SET: credentials.password']);
    expect(seen).toHaveLength(0);
  });
});

// ─── the target guard (ruling S-6) ───────────────────────────────────────────
describe('target guard (ruling S-6): link-local / unspecified / metadata refused; loopback and private networks allowed', () => {
  const REFUSED = 'is a link-local / unspecified address';

  /** `dns.lookup` answering for the names a test lists — the real resolver for every other name. Returns the names asked. */
  function fakeDns(answers: Record<string, { address: string; family: number }[]>): string[] {
    const real = dns.lookup;
    const asked: string[] = [];
    vi.spyOn(dns, 'lookup').mockImplementation(((host: string, opts: unknown, cb: (...a: unknown[]) => void) => {
      asked.push(host);
      const answer = answers[host];
      if (!answer) return (real as unknown as (...a: unknown[]) => void)(host, opts, cb);
      if (opts && typeof opts === 'object' && (opts as { all?: boolean }).all) return cb(null, answer);
      return cb(null, answer[0].address, answer[0].family);
    }) as never);
    return asked;
  }

  /** A connect the test must never reach: it fails loudly instead of touching the network. */
  function noConnect() {
    const h = vi.spyOn(http, 'request').mockImplementation((() => { throw new Error('http.request must not be called'); }) as never);
    const s = vi.spyOn(https, 'request').mockImplementation((() => { throw new Error('https.request must not be called'); }) as never);
    return { h, s };
  }

  it('the address rule is outbound-guard\'s, with plain loopback put back', () => {
    for (const a of ['169.254.169.254', '169.254.0.1', '0.0.0.0', '0.1.2.3', 'fe80::1', '::', 'fd00:ec2::254',
      '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::169.254.169.254', '64:ff9b::169.254.169.254', '[fe80::1]']) {
      expect(targetNotAllowed(a), a).toBe(`TARGET_NOT_ALLOWED: ${a.replace(/^\[|\]$/g, '')} ${REFUSED}`);
    }
    for (const a of ['127.0.0.1', '127.8.9.10', '::1', '[::1]', '10.1.2.3', '172.16.0.9', '192.168.1.20', 'fc00::5', 'fd12::1',
      '93.184.216.34', '2606:4700::1111', 'not-an-ip']) {
      expect(targetNotAllowed(a), a).toBeNull();
    }
    // Stricter than S-6, never looser: loopback SPELLED as a mapped address stays refused.
    expect(targetNotAllowed('::ffff:127.0.0.1')).not.toBeNull();
    // Every verdict but plain loopback is outbound-guard's: one rule with the webhooks and the SMS gateway.
    for (const a of ['169.254.1.1', '0.0.0.0', 'fe80::9', '::', 'fd00:ec2::254', '::ffff:a9fe:1', '10.0.0.1', '8.8.8.8', '2001:db8::1']) {
      expect(targetNotAllowed(a) !== null, a).toBe(blockedAddressReason(a) !== null);
    }
  });

  it('refuses the cloud metadata endpoint, and every blocked IP literal, BEFORE any I/O', async () => {
    const asked = fakeDns({});
    const { h, s } = noConnect();
    const cases: [string, string][] = [
      ['http://169.254.169.254/latest/api/token', '169.254.169.254'],
      ['http://0.0.0.0:8080/x', '0.0.0.0'],
      ['http://[fe80::1]/x', 'fe80::1'],
      ['http://[::]/x', '::'],
      ['http://[fd00:ec2::254]/latest/meta-data/', 'fd00:ec2::254'],
      ['http://[::ffff:169.254.169.254]/x', '::ffff:a9fe:a9fe'],
      ['https://[64:ff9b::a9fe:a9fe]/x', '64:ff9b::a9fe:a9fe'],
    ];
    for (const [url, address] of cases) {
      const { ctx, calls } = restCtx({ restEndpointUrlPattern: url, requestMethod: 'PUT' });
      await run(restApiCallHandler, ctx, telemetry());
      expect(calls.failures.map((f) => f.error), url).toEqual([`TARGET_NOT_ALLOWED: ${address} ${REFUSED}`]);
    }
    expect(h).not.toHaveBeenCalled();
    expect(s).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it('refuses a NAME that resolves to the metadata address — even beside an allowed one — after its one lookup, without connecting', async () => {
    const asked = fakeDns({ 'imds.plant.test': [{ address: '127.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 }] });
    const port = new URL(base).port;
    const { ctx, calls } = restCtx({ restEndpointUrlPattern: `http://imds.plant.test:${port}/api/x`, requestMethod: 'GET' });
    await run(restApiCallHandler, ctx, telemetry());
    expect(calls.failures.map((f) => f.error)).toEqual([`TARGET_NOT_ALLOWED: 169.254.169.254 ${REFUSED}`]);
    expect(asked.filter((n) => n === 'imds.plant.test')).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });

  it('connects to the address it resolved — ONE lookup, the Host of the NAME kept — and loopback is allowed', async () => {
    const asked = fakeDns({ 'rule-stub.test': [{ address: '127.0.0.1', family: 4 }] });
    const port = new URL(base).port;
    const { ctx, calls } = restCtx({ restEndpointUrlPattern: `http://rule-stub.test:${port}/api/pinned`, requestMethod: 'POST' });
    await run(restApiCallHandler, ctx, telemetry());
    expect(calls.relations()).toEqual(['Success']);
    expect(seen.map((x) => [x.url, x.headers.host])).toEqual([['/api/pinned', `rule-stub.test:${port}`]]);
    expect(asked.filter((n) => n === 'rule-stub.test')).toHaveLength(1);
  });

  it('HTTPS keeps the NAME for SNI and connects through the guarded lookup on a fresh socket', async () => {
    let captured: Record<string, unknown> | undefined;
    vi.spyOn(https, 'request').mockImplementation(((_url: URL, opts: Record<string, unknown>) => {
      captured = opts;
      const fake = new EventEmitter() as EventEmitter & { end: () => void };
      fake.end = () => queueMicrotask(() => fake.emit('error', Object.assign(new Error('stopped by the test'), { code: 'ESTOPPED' })));
      return fake;
    }) as never);
    const { ctx, calls } = restCtx({ restEndpointUrlPattern: 'https://api.plant.test/v1/readings', requestMethod: 'POST' });
    await run(restApiCallHandler, ctx, telemetry());
    expect(calls.failures.map((f) => f.error)).toEqual(['HTTP_REQUEST_FAILED: ESTOPPED']);
    expect(captured).toMatchObject({ method: 'POST', servername: 'api.plant.test', agent: false });
    expect(captured!.lookup).toBe(ruleTargetLookup);
  });

  it('Send to Slack goes through the same guard: slack.com resolving to the metadata address is refused', async () => {
    fakeDns({ 'slack.com': [{ address: '169.254.169.254', family: 4 }] });
    const { ctx, calls } = fakeContext({ type: SLACK, config: { botToken: 'xoxb-1', conversation: 'C1', messageTemplate: 'hi' } });
    await run(sendToSlackHandler, ctx, telemetry());
    expect(calls.failures.map((f) => f.error)).toEqual([`TARGET_NOT_ALLOWED: 169.254.169.254 ${REFUSED}`]);
  });
});

// ─── MQTT ────────────────────────────────────────────────────────────────────
describe('MQTT', () => {
  let services: RuleServicesHandle;
  beforeEach(() => {
    mqttMock.clients.length = 0;
    services = createRuleServices({ config: () => ({ ...RULE_ENGINE_CONFIG_DEFAULTS }), inc: () => undefined });
  });

  function mqttCtx(config: Record<string, unknown>, nodeId = '5e1f0000-0000-4000-8000-0000000000a1') {
    return fakeContext<MqttNodeConfig>({ type: MQTT, config, nodeId, services });
  }

  it('publishes the message data as JSON to the templated topic at QoS 1, retain from retainedMessage, one client per node', async () => {
    const { ctx, calls } = mqttCtx({
      host: 'broker.local', port: 1884, topicPattern: 'plant/${instrumentCode}/$[nested.v]', clientId: 'rule', appendClientIdSuffix: true,
      retainedMessage: true, cleanSession: false, protocolVersion: 'MQTT_5', connectTimeoutSec: 3,
      credentials: { type: 'basic', username: 'u1', password: 'pw1' },
    });
    const msg = telemetry();
    await run(mqttHandler, ctx, msg);
    await run(mqttHandler, ctx, telemetry());
    expect(calls.relations()).toEqual(['Success', 'Success']);
    expect(mqttMock.clients).toHaveLength(1);
    const c = mqttMock.clients[0];
    expect(c.opts).toMatchObject({
      host: 'broker.local', port: 1884, protocol: 'mqtt', clientId: mqttClientIdFor(ctx.nodeKey, { clientId: 'rule', appendClientIdSuffix: true }), clean: false, connectTimeout: 3000,
      protocolVersion: 5, username: 'u1', password: 'pw1',
    });
    expect(String(c.opts.clientId)).toMatch(/^rule_[0-9a-f]{10}$/);
    expect(c.published[0]).toEqual({ topic: 'plant/CWH-001/7', payload: JSON.stringify(msg.data), opts: { qos: 1, retain: true } });
    expect(calls.next[0].msg).toBe(msg);
  });

  it('TLS → mqtts; cert.PEM maps ThingsBoard\'s password to the key passphrase; MQTT 3.1 asks for protocol 3', async () => {
    const { ctx, calls } = mqttCtx({
      host: 'broker.local', port: 8883, topicPattern: 't', ssl: true, protocolVersion: 'MQTT_3_1',
      credentials: { type: 'cert.PEM', caCert: 'CA', cert: 'CERT', privateKey: 'KEY', password: 'kp' },
    });
    await run(mqttHandler, ctx, telemetry());
    expect(calls.relations()).toEqual(['Success']);
    expect(mqttMock.clients[0].opts).toMatchObject({ protocol: 'mqtts', ca: 'CA', cert: 'CERT', key: 'KEY', passphrase: 'kp' });
    // MQTT 3.1 connects as 3.1: protocol level 3 under the protocol name MQIsdp (fix round 3).
    expect(mqttMock.clients[0].opts).toMatchObject({ protocolVersion: 3, protocolId: 'MQIsdp' });
    expect(mqttMock.clients[0].opts.username).toBeUndefined();
  });

  it('anonymous sends no credentials even when a stale username key is present; parseToPlainText publishes a string unquoted', async () => {
    const { ctx } = mqttCtx({ host: 'broker.local', port: 1883, topicPattern: 't', parseToPlainText: true, credentials: { type: 'anonymous', username: 'leftover' } });
    await run(mqttHandler, ctx, testMessage('plain words'));
    expect(mqttMock.clients[0].opts.username).toBeUndefined();
    expect(mqttMock.clients[0].published[0].payload).toBe('plain words');
  });

  it('a masked password ("***") ends on Failure CREDENTIAL_NOT_SET without connecting', async () => {
    const { ctx, calls } = mqttCtx({ host: 'broker.local', port: 1883, topicPattern: 't', credentials: { type: 'basic', username: 'u1', password: '***' } });
    await run(mqttHandler, ctx, telemetry());
    expect(calls.failures.map((f) => f.error)).toEqual(['CREDENTIAL_NOT_SET: credentials.password']);
    expect(mqttMock.clients).toHaveLength(0);
  });

  it('no host → Failure MQTT_HOST_REQUIRED; a refused publish → Failure with the broker\'s reason', async () => {
    const a = mqttCtx({ host: '', port: 1883, topicPattern: 't' });
    await run(mqttHandler, a.ctx, telemetry());
    expect(a.calls.failures[0].error).toMatch(/^MQTT_HOST_REQUIRED/);
    const b = mqttCtx({ host: 'broker.local', port: 1883, topicPattern: 't' }, '5e1f0000-0000-4000-8000-0000000000b2');
    await run(mqttHandler, b.ctx, telemetry());
    mqttMock.clients[0].failPublish = true;
    await run(mqttHandler, b.ctx, telemetry());
    expect(b.calls.relations()).toEqual(['Success', 'Failure']);
    expect(b.calls.failures[0].error).toBe('broker refused the publish');
  });

  it('onDestroy closes the node\'s client', async () => {
    const { ctx } = mqttCtx({ host: 'broker.local', port: 1883, topicPattern: 't' });
    await run(mqttHandler, ctx, telemetry());
    expect(mqttMock.clients[0].ended).toBe(false);
    await mqttLifecycle.onDestroy!(ctx);
    expect(mqttMock.clients[0].ended).toBe(true);
  });
});

// ─── Send email ──────────────────────────────────────────────────────────────
describe('Send email', () => {
  const sendEmail = (data: unknown, type = 'SEND_EMAIL') => testMessage(data, { type });
  function emailCtx(result = { sent: 1, failed: [] as { recipient: string; error: string }[] }) {
    const email = vi.fn(async () => result);
    const f = fakeContext({ type: EMAIL, services: { notifications: { email } } });
    return { ...f, email };
  }

  it('sends the SEND_EMAIL fields through the email service, with the node\'s origin; the message goes on unchanged', async () => {
    const { ctx, calls, email } = emailCtx();
    const msg = sendEmail({ from: 'plant@x', to: 'a@x, b@x', cc: 'c@x', bcc: 'd@x', subject: 'High', body: '<b>21</b>', isHtml: true });
    await run(sendEmailHandler, ctx, msg);
    expect(email).toHaveBeenCalledWith({ to: 'a@x, b@x', cc: 'c@x', bcc: 'd@x', subject: 'High', body: '<b>21</b>', isHtml: true, origin: ctx.origin });
    expect(calls.relations()).toEqual(['Success']);
    expect(calls.next[0].msg).toBe(msg);
  });

  it('reads ThingsBoard\'s own key "html", and data that arrives as JSON text', async () => {
    const { ctx, email } = emailCtx();
    await run(sendEmailHandler, ctx, sendEmail(JSON.stringify({ to: 'a@x', subject: 's', body: 'b', html: true })));
    expect(email).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@x', isHtml: true }));
  });

  it('a message that is not SEND_EMAIL ends on Failure, as ThingsBoard', async () => {
    const { ctx, calls, email } = emailCtx();
    await run(sendEmailHandler, ctx, sendEmail({ to: 'a@x' }, 'POST_TELEMETRY_REQUEST'));
    expect(calls.failures[0].error).toBe('Not expected msg type POST_TELEMETRY_REQUEST for SendEmail Node');
    expect(email).not.toHaveBeenCalled();
  });

  it('no destination ends on Failure; unreadable data ends on Failure', async () => {
    const a = emailCtx();
    await run(sendEmailHandler, a.ctx, sendEmail({ to: '  ', subject: 's' }));
    expect(a.calls.failures[0].error).toBe('Email destination can not be blank [  ]');
    const b = emailCtx();
    await run(sendEmailHandler, b.ctx, sendEmail('not json'));
    expect(b.calls.failures[0].error).toMatch(/^EMAIL_INVALID: /);
    expect(a.email).not.toHaveBeenCalled();
    expect(b.email).not.toHaveBeenCalled();
  });

  it('a recipient whose first attempt failed ends the message on Failure, naming it', async () => {
    const { ctx, calls } = emailCtx({ sent: 1, failed: [{ recipient: 'b@x', error: 'SMTP 550' }] });
    await run(sendEmailHandler, ctx, sendEmail({ to: 'a@x,b@x', subject: 's', body: 'b' }));
    expect(calls.failures[0].error).toBe('EMAIL_SEND_FAILED: 1 of 2 recipient(s) failed — b@x: SMTP 550');
  });

  it('a service error (no SMTP, no recipient) ends on Failure', async () => {
    const email = vi.fn(async () => { throw new Error('EMAIL_NO_RECIPIENT: the message names no recipient'); });
    const { ctx, calls } = fakeContext({ type: EMAIL, services: { notifications: { email } } });
    await run(sendEmailHandler, ctx, sendEmail({ to: 'a@x' }));
    expect(calls.failures[0].error).toBe('EMAIL_NO_RECIPIENT: the message names no recipient');
  });
});

// ─── Send SMS ────────────────────────────────────────────────────────────────
describe('Send SMS', () => {
  it('templates the numbers and the message, splits the numbers on commas', async () => {
    const sms = vi.fn(async () => ({ sent: 2, failed: [] }));
    const { ctx, calls } = fakeContext({
      type: SMS, services: { notifications: { sms } },
      config: { numbersToTemplate: '${phone}, +91 2222', smsMessageTemplate: '${instrumentCode} is $[temp] ${unit}' },
    });
    const msg = testMessage({ temp: 31 }, { metadata: { phone: '+91 1111', unit: 'C' } });
    await run(sendSmsHandler, ctx, msg);
    expect(sms).toHaveBeenCalledWith({ numbers: ['+91 1111', '+91 2222'], message: 'TEST-001 is 31 C', origin: ctx.origin });
    expect(calls.relations()).toEqual(['Success']);
    expect(calls.next[0].msg).toBe(msg);
  });

  it('a failed number ends on Failure; a service error ends on Failure', async () => {
    const a = fakeContext({ type: SMS, services: { notifications: { sms: async () => ({ sent: 0, failed: [{ recipient: '+1', error: 'provider down' }] }) } }, config: { numbersToTemplate: '+1', smsMessageTemplate: 'm' } });
    await run(sendSmsHandler, a.ctx, testMessage({}));
    expect(a.calls.failures[0].error).toBe('SMS_SEND_FAILED: 1 of 1 number(s) failed — +1: provider down');
    const b = fakeContext({ type: SMS, services: { notifications: { sms: async () => { throw new Error('SMS_NO_RECIPIENT: no phone number'); } } }, config: { numbersToTemplate: '${none}', smsMessageTemplate: 'm' } });
    await run(sendSmsHandler, b.ctx, testMessage({}));
    expect(b.calls.failures[0].error).toBe('SMS_NO_RECIPIENT: no phone number');
  });
});

// ─── Send notification ───────────────────────────────────────────────────────
describe('Send notification', () => {
  it('sends the template to the roles and users, with ThingsBoard\'s template data; the result goes in metadata', async () => {
    const byTemplate = vi.fn(async () => ({ sent: 2, failed: [{ recipient: 'Ravi', error: 'no email address' }] }));
    const { ctx, calls } = fakeContext({
      type: NOTIFY, services: { notifications: { byTemplate } },
      config: { templateId: 'tpl-1', targets: { roles: ['QA'], userIds: ['u-9'] } },
    });
    const msg = testMessage({ temp: 31, nested: { v: 7 } }, { metadata: { unit: 'C', temp: 'from-metadata' } });
    await run(sendNotificationHandler, ctx, msg);
    expect(byTemplate).toHaveBeenCalledWith('tpl-1', { roles: ['QA'], userIds: ['u-9'] }, {
      instrumentCode: 'TEST-001', unit: 'C', temp: '31', 'nested.v': '7',
      originatorType: 'Instrument', originatorId: 'instrument-1', msgType: 'POST_TELEMETRY_REQUEST',
    });
    expect(calls.relations()).toEqual(['Success']);
    expect(JSON.parse(calls.next[0].msg.metadata.notificationRequestResult)).toEqual({ sent: 2, failed: [{ recipient: 'Ravi', error: 'no email address' }] });
    expect(msg.metadata.notificationRequestResult).toBeUndefined();
  });

  it('no template, ThingsBoard target ids, no recipients, or a service error → Failure', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ templateId: null, targets: { roles: ['QA'], userIds: [] } }, /^NOTIFICATION_TEMPLATE_REQUIRED: /],
      [{ templateId: 'tpl-1', targets: ['3f2a…tb-target-id'] }, /^NOTIFICATION_TARGETS_UNSUPPORTED: /],
      [{ templateId: 'tpl-1', targets: { roles: [], userIds: [] } }, /^NOTIFICATION_NO_TARGETS: /],
    ];
    const byTemplate = vi.fn(async () => ({ sent: 0, failed: [] }));
    for (const [config, error] of cases) {
      const { ctx, calls } = fakeContext({ type: NOTIFY, services: { notifications: { byTemplate } }, config });
      await run(sendNotificationHandler, ctx, testMessage({}));
      expect(calls.failures[0]?.error, JSON.stringify(config)).toMatch(error);
    }
    expect(byTemplate).not.toHaveBeenCalled();
    const thrown = fakeContext({
      type: NOTIFY, config: { templateId: 'gone', targets: { roles: ['QA'], userIds: [] } },
      services: { notifications: { byTemplate: async () => { throw new Error('NOTIFICATION_TEMPLATE_NOT_FOUND: template gone does not exist'); } } },
    });
    await run(sendNotificationHandler, thrown.ctx, testMessage({}));
    expect(thrown.calls.failures[0].error).toBe('NOTIFICATION_TEMPLATE_NOT_FOUND: template gone does not exist');
  });
});

// ─── Send to Slack ───────────────────────────────────────────────────────────
describe('Send to Slack', () => {
  interface Sent { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number }
  /** slack.com is not reachable from a test: `ruleHttp.send` is stood in for (put back after each test). The guard itself is pinned above. */
  function slackCtx(config: Record<string, unknown>, reply: () => { status: number; statusText?: string; text: string }) {
    const sent: Sent[] = [];
    ruleHttp.send = async (req) => {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      sent.push({ url: req.url.toString(), method: req.method, headers, ...(req.body !== undefined ? { body: req.body } : {}), timeoutMs: req.timeoutMs });
      const r = reply();
      return { status: r.status, statusText: r.statusText ?? '', headers: new Headers(), text: r.text };
    };
    const f = fakeContext({ type: SLACK, config });
    return { ...f, sent };
  }
  const okReply = () => ({ status: 200, statusText: 'OK', text: JSON.stringify({ ok: true, ts: '1.2' }) });

  it('posts the templated message to the conversation with chat.postMessage and the bot token', async () => {
    const { ctx, calls, sent } = slackCtx(
      { botToken: 'xoxb-123', conversation: { id: 'C42', name: 'plant' }, messageTemplate: '${instrumentCode}: $[temp] ${unit}' },
      okReply,
    );
    const msg = telemetry();
    await run(sendToSlackHandler, ctx, msg);
    expect(calls.relations()).toEqual(['Success']);
    expect(calls.next[0].msg).toBe(msg);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: 'https://slack.com/api/chat.postMessage', method: 'POST', timeoutMs: RULE_ENGINE_CONFIG_DEFAULTS.httpTimeoutMs });
    expect(sent[0].headers.authorization).toBe('Bearer xoxb-123');
    expect(sent[0].headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(sent[0].body!)).toEqual({ channel: 'C42', text: 'CWH-001: 21.5 C' });
  });

  it('a plain conversation id is accepted', async () => {
    const { ctx, sent } = slackCtx({ botToken: 'xoxb-1', conversation: 'U7', messageTemplate: 'hi' }, okReply);
    await run(sendToSlackHandler, ctx, telemetry());
    expect(JSON.parse(sent[0].body!).channel).toBe('U7');
  });

  it('Slack\'s {ok:false} (HTTP 200), an HTTP error and a redirect (not followed) all end on Failure', async () => {
    const a = slackCtx({ botToken: 'xoxb-1', conversation: 'C1', messageTemplate: 'hi' },
      () => ({ status: 200, text: JSON.stringify({ ok: false, error: 'channel_not_found' }) }));
    await run(sendToSlackHandler, a.ctx, telemetry());
    expect(a.calls.failures[0].error).toBe('SLACK_ERROR: channel_not_found');
    const b = slackCtx({ botToken: 'xoxb-1', conversation: 'C1', messageTemplate: 'hi' }, () => ({ status: 503, statusText: 'Service Unavailable', text: 'down' }));
    await run(sendToSlackHandler, b.ctx, telemetry());
    expect(b.calls.failures[0].error).toBe('SLACK_HTTP_ERROR: 503 Service Unavailable');
    const c = slackCtx({ botToken: 'xoxb-1', conversation: 'C1', messageTemplate: 'hi' }, () => ({ status: 302, statusText: 'Found', text: '' }));
    await run(sendToSlackHandler, c.ctx, telemetry());
    expect(c.calls.failures[0].error).toBe('SLACK_HTTP_ERROR: 302 Found');
    expect(c.sent).toHaveLength(1);
  });

  it('system settings, a missing or masked token, or no conversation → Failure without a request', async () => {
    const cases: [Record<string, unknown>, string | RegExp][] = [
      [{ useSystemSettings: true, botToken: 'xoxb-1', conversation: 'C1', messageTemplate: 'hi' }, /^SLACK_SYSTEM_SETTINGS_UNSUPPORTED: /],
      [{ botToken: '', conversation: 'C1', messageTemplate: 'hi' }, 'Slack token is missing'],
      [{ botToken: '***', conversation: 'C1', messageTemplate: 'hi' }, 'CREDENTIAL_NOT_SET: botToken'],
      [{ botToken: 'xoxb-1', conversation: { id: ' ' }, messageTemplate: 'hi' }, /^SLACK_CONVERSATION_REQUIRED: /],
      [{ botToken: 'xoxb-1', messageTemplate: 'hi' }, /^SLACK_CONVERSATION_REQUIRED: /],
    ];
    for (const [config, error] of cases) {
      const { ctx, calls, sent } = slackCtx(config, okReply);
      await run(sendToSlackHandler, ctx, telemetry());
      expect(calls.failures[0]?.error, JSON.stringify(config)).toMatch(error);
      expect(sent).toHaveLength(0);
    }
  });

  it('a request that times out ends on Failure HTTP_TIMEOUT with the engine\'s timeout', async () => {
    ruleHttp.send = async () => { throw Object.assign(new Error('the request timed out'), { name: 'TimeoutError' }); };
    const { ctx, calls } = fakeContext({ type: SLACK, config: { botToken: 'xoxb-1', conversation: 'C1', messageTemplate: 'hi' } });
    await run(sendToSlackHandler, ctx, telemetry());
    expect(calls.failures[0].error).toBe(`HTTP_TIMEOUT: no response within ${RULE_ENGINE_CONFIG_DEFAULTS.httpTimeoutMs} ms`);
  });
});
