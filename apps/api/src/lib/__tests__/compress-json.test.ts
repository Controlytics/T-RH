import { describe, it, expect, afterAll } from 'vitest';
import Fastify from 'fastify';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { registerJsonCompression, acceptsGzip, COMPRESS_MIN_BYTES } from '../compress-json.js';

/** Performance audit 2026-11-17, P-02: large JSON responses are gzipped for a client that accepts it. */
const big = { data: Array.from({ length: 2_000 }, (_, i) => ({ instrumentId: `i-${i}`, code: `CWH/RDU/${i}`, temperature: 22.5 })) };

const app = Fastify({ logger: false });
registerJsonCompression(app);
app.get('/big', async () => big);
app.get('/small', async () => ({ ok: true }));
app.get('/stream', async (_req, reply) => reply.type('application/json').send(Readable.from([JSON.stringify(big)])));
app.get('/already', async (_req, reply) => reply.header('content-encoding', 'br').type('application/json').send(JSON.stringify(big)));
afterAll(async () => { await app.close(); });

describe('JSON compression', () => {
  it('gzips a large JSON body for a client that accepts gzip — and it decodes to the same JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/big', headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(String(res.headers.vary)).toMatch(/Accept-Encoding/);
    expect(JSON.parse(gunzipSync(res.rawPayload).toString('utf8'))).toEqual(big);
    expect(res.rawPayload.length).toBeLessThan(JSON.stringify(big).length / 4);
  });

  it('leaves the body plain for a client that did not ask', async () => {
    const res = await app.inject({ method: 'GET', url: '/big' });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.json()).toEqual(big);
  });

  it('leaves a small body, a stream and an already-encoded body alone', async () => {
    const h = { 'accept-encoding': 'gzip' };
    expect(JSON.stringify({ ok: true }).length).toBeLessThan(COMPRESS_MIN_BYTES);
    expect((await app.inject({ method: 'GET', url: '/small', headers: h })).headers['content-encoding']).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/stream', headers: h })).headers['content-encoding']).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/already', headers: h })).headers['content-encoding']).toBe('br');
  });

  it.each([
    ['gzip', true], ['gzip;q=0', false], ['deflate, br', false], ['*', true], ['identity', false], ['GZIP;q=0.5', true],
  ])('Accept-Encoding "%s" → %s', (header, expected) => {
    expect(acceptsGzip(header)).toBe(expected);
  });
});
