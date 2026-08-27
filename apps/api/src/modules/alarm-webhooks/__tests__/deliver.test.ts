import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { attemptDelivery, decideSuccess } from '../deliver.js';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '/';
      if (url === '/ok') { res.writeHead(200); res.end('{"result":"ok"}'); return; }
      if (url === '/fail-200') { res.writeHead(200); res.end('{"status":"error"}'); return; }
      if (url === '/500') { res.writeHead(500); res.end('boom'); return; }
      if (url === '/slow') { setTimeout(() => { res.writeHead(200); res.end('late'); }, 500); return; }
      if (url === '/echo') { res.writeHead(200); res.end(Buffer.concat(chunks).toString()); return; }
      if (url === '/big') { res.writeHead(200); res.end('x'.repeat(5000)); return; }
      res.writeHead(404); res.end('nope');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

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
});
