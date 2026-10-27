import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mqtt from 'mqtt';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { generateToken, hashToken, tokenPrefix } from '../modules/instruments/token.js';
import { invalidateIngestAuthCache } from '../modules/instruments/ingest-auth.js';
import {
  createDeviceCaFiles, issueDeviceCertificate, resetDeviceCaCache, type IssuedDeviceCertificate,
} from '../modules/instruments/device-ca.js';

/**
 * Device certificates through the REAL broker (2026-10-27): EMQX 5.3.2 → the
 * real auth hook → the real decision, with a real client certificate. The
 * hook tests drive `cert_subject` by hand; this proves EMQX actually sends what
 * they assume.
 *
 * It adds a TEMPORARY listener `ssl:dcerte2e` (verify_peer against a throwaway
 * device CA, its OWN listener-level authenticator pointing at this test's API)
 * and deletes it afterwards, so the broker's real listeners and global auth
 * chain are untouched. Skipped when no broker REST API is configured
 * (EMQX_API_URL / _KEY / _SECRET from apps/api/.env).
 */
const EMQX_URL = process.env.EMQX_API_URL;
const EMQX_KEY = process.env.EMQX_API_KEY;
const EMQX_SECRET = process.env.EMQX_API_SECRET;
const LISTENER = 'ssl:dcerte2e';
const PORT = 18884;
const ENV_KEYS = ['DEVICE_CA_CERT_PATH', 'DEVICE_CA_KEY_PATH'] as const;

async function brokerReachable(): Promise<boolean> {
  if (!EMQX_URL || !EMQX_KEY || !EMQX_SECRET) return false;
  try { return (await emqx('GET', '/api/v5/status')).status < 500; } catch { return false; }
}
async function emqx(method: string, p: string, body?: unknown): Promise<Response> {
  return fetch(`${EMQX_URL}${p}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${EMQX_KEY}:${EMQX_SECRET}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const reachable = await brokerReachable();
const S = Date.now();
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let app: FastifyInstance;
let dir: string;
let profileId = '';
let instrumentId = '';
let code = '';
let token = '';
let current: IssuedDeviceCertificate;
let stale: IssuedDeviceCertificate;

function connect(opts: { cert?: IssuedDeviceCertificate } = {}): Promise<'connected' | string> {
  return new Promise((resolve) => {
    const c = mqtt.connect(`mqtts://127.0.0.1:${PORT}`, {
      clientId: code, username: token, password: 'x',
      rejectUnauthorized: false, reconnectPeriod: 0, connectTimeout: 8000,
      ...(opts.cert ? { cert: opts.cert.certificatePem, key: opts.cert.privateKeyPem } : {}),
    });
    const done = (r: string) => { c.end(true); resolve(r); };
    c.on('connect', () => done('connected'));
    c.on('error', (e) => done(e.message));
    setTimeout(() => done('timeout'), 9000);
  });
}

describe.skipIf(!reachable)('device certificates through the real EMQX broker', () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devcert-emqx-'));
    await createDeviceCaFiles(path.join(dir, 'server.crt'), path.join(dir, 'server.key'));
    await createDeviceCaFiles(path.join(dir, 'device-ca.pem'), path.join(dir, 'device-ca.key'));
    process.env.DEVICE_CA_CERT_PATH = path.join(dir, 'device-ca.pem');
    process.env.DEVICE_CA_KEY_PATH = path.join(dir, 'device-ca.key');
    resetDeviceCaCache();

    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const apiPort = typeof addr === 'object' && addr ? addr.port : 0;

    profileId = (await prisma.instrumentProfile.create({ data: { name: `fixture:devcert-emqx-${S}`, requireDeviceCertificate: true } })).id;
    code = `DCE-${S}`;
    instrumentId = (await prisma.instrument.create({ data: { name: code, code, profileId } })).id;
    token = generateToken();
    await prisma.instrumentCredential.create({ data: { instrumentId, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) } });
    stale = await issueDeviceCertificate(code);
    current = await issueDeviceCertificate(code);
    await prisma.instrument.update({ where: { id: instrumentId }, data: { deviceCertIssueId: current.issueId } });
    invalidateIngestAuthCache();

    const fwd = (p: string) => p.replace(/\\/g, '/');
    await emqx('DELETE', `/api/v5/listeners/${LISTENER}`);
    const res = await emqx('POST', '/api/v5/listeners', {
      type: 'ssl', name: 'dcerte2e', bind: `127.0.0.1:${PORT}`, enable: true,
      ssl_options: {
        certfile: fwd(path.join(dir, 'server.crt')), keyfile: fwd(path.join(dir, 'server.key')),
        cacertfile: fwd(path.join(dir, 'device-ca.pem')), verify: 'verify_peer', fail_if_no_peer_cert: false,
      },
      authentication: [{
        mechanism: 'password_based', backend: 'http', enable: true, method: 'post',
        url: `http://127.0.0.1:${apiPort}/api/ingest/v1/mqtt-auth`,
        headers: { 'content-type': 'application/json' },
        body: {
          clientid: '${clientid}', username: '${username}', password: '${password}',
          cert_subject: '${cert_subject}', cert_common_name: '${cert_common_name}',
        },
      }],
    });
    expect(res.status, await res.text()).toBe(200);
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    resetDeviceCaCache();
    await emqx('DELETE', `/api/v5/listeners/${LISTENER}`).catch(() => undefined);
    await app?.close();
    if (instrumentId) {
      await prisma.deadLetter.deleteMany({ where: { instrumentId } }).catch(() => {});
      await prisma.instrumentCredential.deleteMany({ where: { instrumentId } }).catch(() => {});
      await prisma.instrument.deleteMany({ where: { id: instrumentId } }).catch(() => {});
    }
    if (profileId) await prisma.instrumentProfile.deleteMany({ where: { id: profileId } }).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the instrument\'s current certificate: CONNACK', async () => {
    expect(await connect({ cert: current })).toBe('connected');
  });

  it('no certificate: refused by the hook, with a dead letter on mqtt', async () => {
    const result = await connect();
    expect(result).not.toBe('connected');
    expect(await prisma.deadLetter.count({ where: { instrumentId, transport: 'mqtt', reason: { contains: 'device certificate' } } })).toBeGreaterThan(0);
  });

  it('an older (re-issued) certificate: refused', async () => {
    expect(await connect({ cert: stale })).not.toBe('connected');
  });
});
