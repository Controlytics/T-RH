import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, ADMIN_PASSWORD } from './test-helper.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { generateToken } from '../modules/instruments/token.js';
import { resetBrokerKickWarning } from '../modules/instruments/broker-kick.js';

/**
 * Audit 2026-10-12 follow-up: every revocation drops the device's OPEN MQTT
 * session at the broker — EMQX asks the auth hook only at CONNECT, so without
 * this a revoked device kept publishing, and after a code was reassigned the
 * old device's messages were attributed to the new owner. Driven through the
 * REAL routes against a STUB of EMQX's REST API (no broker is touched).
 */
let app: FastifyInstance;
let auth: Record<string, string>;
let server: http.Server;
let kicks: { url: string; auth?: string }[] = [];
let failWith: number | null = null;
const created: string[] = [];
const saved: Record<string, string | undefined> = {};
const KEYS = ['EMQX_API_URL', 'EMQX_API_KEY', 'EMQX_API_SECRET'] as const;
const S = Date.now();
const reauth = { 'x-reauth-password': ADMIN_PASSWORD };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'DELETE') kicks.push({ url: req.url ?? '', auth: req.headers.authorization });
    res.statusCode = failWith ?? 204;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.EMQX_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.EMQX_API_KEY = 'digilogkick';
  process.env.EMQX_API_SECRET = 'stubsecret';
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});

afterAll(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const id of created) await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  await app.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => { kicks = []; failWith = null; resetBrokerKickWarning(); });

async function mk(code: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { name: code, code, profileId: await fixtureProfileId('fixture:broker-kick') },
  });
  expect(res.statusCode).toBe(201);
  created.push(res.json().id);
  return res.json().id as string;
}
const enc = (code: string) => `/api/v5/clients/${encodeURIComponent(code)}`;

describe('revocation drops the open MQTT session at the broker', () => {
  it('regenerate-token kicks the instrument\'s client id, URL-encoded, with the API key', async () => {
    const code = `KICK/A/${S}`;
    const id = await mk(code);
    const res = await app.inject({ method: 'POST', url: `/api/instruments/${id}/regenerate-token`, headers: { ...auth, ...reauth } });
    expect(res.statusCode).toBe(200);
    expect(kicks.map((k) => k.url)).toEqual([enc(code)]);
    expect(kicks[0].auth).toBe(`Basic ${Buffer.from('digilogkick:stubsecret').toString('base64')}`);
  });

  it('setting a token kicks it', async () => {
    const code = `KICK-B-${S}`;
    const id = await mk(code);
    const res = await app.inject({
      method: 'PUT', url: `/api/instruments/${id}/token`, headers: { ...auth, ...reauth }, payload: { token: generateToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(kicks.map((k) => k.url)).toEqual([enc(code)]);
  });

  it('deactivating kicks it; an edit that revokes nothing does not', async () => {
    const code = `KICK-C-${S}`;
    const id = await mk(code);
    const plain = await app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers: auth, payload: { description: 'no revocation' } });
    expect(plain.statusCode).toBe(200);
    expect(kicks).toEqual([]);
    const off = await app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers: auth, payload: { isActive: false } });
    expect(off.statusCode).toBe(200);
    expect(kicks.map((k) => k.url)).toEqual([enc(code)]);
  });

  it('a code change kicks the OLD client id, so a later owner of that code is not fed the old device', async () => {
    const code = `KICK-D-${S}`;
    const id = await mk(code);
    const res = await app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers: auth, payload: { code: `${code}-NEW` } });
    expect(res.statusCode).toBe(200);
    expect(kicks.map((k) => k.url)).toEqual([enc(code)]);
  });

  it('delete kicks it', async () => {
    const code = `KICK-E-${S}`;
    const id = await mk(code);
    const res = await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(kicks.map((k) => k.url)).toEqual([enc(code)]);
  });

  it('a broker that refuses the kick never fails the committed revocation', async () => {
    failWith = 500;
    const code = `KICK-F-${S}`;
    const id = await mk(code);
    const res = await app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers: auth, payload: { isActive: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
    expect(kicks).toHaveLength(1);
  });
});
