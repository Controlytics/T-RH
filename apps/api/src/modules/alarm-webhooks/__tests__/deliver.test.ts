import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { attemptDelivery, decideSuccess } from '../deliver.js';
import { allowLoopbackForTests } from '../../../lib/outbound-guard.js';

let server: Server;
let base = '';
let hits = 0;

beforeAll(async () => {
  // The mechanics tests below talk to a real server on 127.0.0.1, which the
  // outbound guard blocks in production (audit 2026-10-12 #1). The guard's own
  // describe block switches this back OFF to prove the block.
  allowLoopbackForTests(true);
  server = createServer((req, res) => {
    hits++;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '/';
      if (url === '/ok') { res.writeHead(200); res.end('{"result":"ok"}'); return; }
      if (url === '/fail-200') { res.writeHead(200); res.end('{"status":"error"}'); return; }
      if (url === '/500') { res.writeHead(500); res.end('boom'); return; }
      if (url === '/slow') { setTimeout(() => { res.writeHead(200); res.end('late'); }, 500); return; }
      if (url === '/echo') { res.writeHead(200); res.end(Buffer.concat(chunks).toString()); return; }
      if (url === '/redirect') { res.writeHead(302, { Location: '/ok' }); res.end(); return; }
      if (url === '/big') { res.writeHead(200); res.end('x'.repeat(5000)); return; }
      res.writeHead(404); res.end('nope');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  allowLoopbackForTests(false);
  await new Promise<void>((r) => server.close(() => r()));
});

const req = (over: Partial<Parameters<typeof attemptDelivery>[0]>) => ({
  url: `${base}/ok`,
  method: 'POST',
  headers: {} as Record<string, string>,
  contentType: 'application/json',
  body: '{"event":"RAISED"}',
  timeoutMs: 2000,
  successRegex: null as string | null,
  ...over,
});

describe('decideSuccess', () => {
  it('accepts 2xx with no regex', () => {
    expect(decideSuccess(200, 'anything', null)).toBe(true);
    expect(decideSuccess(204, '', null)).toBe(true);
  });

  it('rejects non-2xx', () => {
    expect(decideSuccess(500, 'ok', null)).toBe(false);
    expect(decideSuccess(404, '', null)).toBe(false);
  });

  // The #sms-2xx lesson: cheap hardware returns HTTP 200 on failure.
  it('lets the regex override a 200', () => {
    expect(decideSuccess(200, '{"status":"error"}', '"status"\\s*:\\s*"success"')).toBe(false);
    expect(decideSuccess(200, '{"status":"success"}', '"status"\\s*:\\s*"success"')).toBe(true);
  });

  it('still requires 2xx when a regex matches a non-2xx body', () => {
    expect(decideSuccess(500, '{"status":"success"}', '"status"\\s*:\\s*"success"')).toBe(false);
  });

  // An unparseable regex must not throw inside the worker.
  it('treats an invalid regex as a failure rather than throwing', () => {
    expect(() => decideSuccess(200, 'ok', '([')).not.toThrow();
    expect(decideSuccess(200, 'ok', '([')).toBe(false);
  });

  // Audit 2026-10-03, INGEST-15: judged against the stored snippet, under a budget.
  it('judges the first 1000 characters — what the delivery row stores — and nothing beyond', () => {
    expect(decideSuccess(200, `OK${'x'.repeat(1500)}`, '^OK')).toBe(true);
    expect(decideSuccess(200, `${'x'.repeat(1500)}OK`, 'OK$')).toBe(false);
  });

  it('fails closed within its budget on a catastrophically backtracking pattern', () => {
    const started = Date.now();
    expect(decideSuccess(200, `${'a'.repeat(40)}b`, '(a+)+$')).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('attemptDelivery', () => {
  it('succeeds on 200', async () => {
    const r = await attemptDelivery(req({}));
    expect(r.ok).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(r.responseSnippet).toContain('ok');
    expect(r.error).toBeNull();
  });

  it('fails on 500 and records the status', async () => {
    const r = await attemptDelivery(req({ url: `${base}/500` }));
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(500);
  });

  it('fails a 200 whose body does not match the success regex', async () => {
    const r = await attemptDelivery(req({ url: `${base}/fail-200`, successRegex: '"status"\\s*:\\s*"success"' }));
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(200);
  });

  it('times out with no status and an error', async () => {
    const r = await attemptDelivery(req({ url: `${base}/slow`, timeoutMs: 100 }));
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBeNull();
    expect(r.error).toBeTruthy();
  });

  it('reports a connection refusal as an error, not a throw', async () => {
    const r = await attemptDelivery(req({ url: 'http://127.0.0.1:1/none', timeoutMs: 500 }));
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBeNull();
    expect(r.error).toBeTruthy();
  });

  it('sends the body and the content type', async () => {
    const r = await attemptDelivery(req({ url: `${base}/echo`, body: '{"a":1}' }));
    expect(r.responseSnippet).toBe('{"a":1}');
  });

  it('sends no body on GET', async () => {
    const r = await attemptDelivery(req({ url: `${base}/echo`, method: 'GET' }));
    expect(r.ok).toBe(true);
    expect(r.responseSnippet).toBe('');
  });

  it('truncates the response snippet to 1000 chars for the VARCHAR(1000) column', async () => {
    const r = await attemptDelivery(req({ url: `${base}/big` }));
    expect(r.responseSnippet!.length).toBeLessThanOrEqual(1000);
  });

  it('does not follow a redirect — a 3xx is a failure', async () => {
    const r = await attemptDelivery(req({ url: `${base}/redirect` }));
    expect(r.ok).toBe(false);
  });
});

/**
 * Audit 2026-10-12 #1 — SSRF. A target pointed at the cloud metadata service, or
 * at the host itself, must be refused at SEND time, after DNS, with nothing sent.
 */
describe('attemptDelivery — outbound guard', () => {
  beforeEach(() => allowLoopbackForTests(false));
  afterEach(() => allowLoopbackForTests(true));

  it('refuses the EC2 metadata service (IMDSv2 token PUT) without connecting', async () => {
    const r = await attemptDelivery(req({
      url: 'http://169.254.169.254/latest/api/token', method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' }, timeoutMs: 3000,
    }));
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBeNull();
    expect(r.responseSnippet).toBeNull();
    expect(r.error).toMatch(/Refused/);
  });

  it('refuses a loopback IP literal — and the server on it is never hit', async () => {
    const before = hits;
    const r = await attemptDelivery(req({}));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Refused/);
    expect(hits).toBe(before);
  });

  it('refuses an IPv4-mapped IPv6 spelling of loopback', async () => {
    const port = new URL(base).port;
    const before = hits;
    const r = await attemptDelivery(req({ url: `http://[::ffff:127.0.0.1]:${port}/ok` }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Refused/);
    expect(hits).toBe(before);
  });

  it('refuses a NAME that resolves to loopback (judged after DNS, at connect)', async () => {
    const port = new URL(base).port;
    const before = hits;
    const r = await attemptDelivery(req({ url: `http://localhost:${port}/ok` }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Refused/);
    expect(hits).toBe(before);
  });
});
