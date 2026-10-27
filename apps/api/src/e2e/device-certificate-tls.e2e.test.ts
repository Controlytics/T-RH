import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import Fastify, { type FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { buildHttpsOptions } from '../lib/https-options.js';
import ingestRoutes from '../modules/instruments/ingest-routes.js';
import { generateToken, hashToken, tokenPrefix } from '../modules/instruments/token.js';
import { invalidateIngestAuthCache } from '../modules/instruments/ingest-auth.js';
import { resetCertificateRefusalLimiter } from '../modules/instruments/device-certificate.js';
import {
  createDeviceCaFiles, issueDeviceCertificate, resetDeviceCaCache, type IssuedDeviceCertificate,
} from '../modules/instruments/device-ca.js';

/**
 * REAL TLS (device certificates, 2026-10-27). `app.inject` never goes through
 * a TLS handshake, so it cannot exercise `socket.authorized` — this suite runs
 * an https Fastify on a free port built by the SAME `buildHttpsOptions` the API
 * uses, and talks to it with Node's https client: with no client certificate,
 * with the instrument's current one, an older one, and one from another CA.
 */
const ENV_KEYS = ['DEVICE_CA_CERT_PATH', 'DEVICE_CA_KEY_PATH'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const S = Date.now();
let dir: string;
let app: FastifyInstance;
let port = 0;
let freeProfileId: string;
let requiredProfileId: string;
const ids: string[] = [];
const fx: Record<string, { id: string; code: string; token: string }> = {};
let current: IssuedDeviceCertificate;
let foreign: IssuedDeviceCertificate;

async function mk(key: string, profileId: string) {
  const code = `DCT-${key}-${S}`;
  const row = await prisma.instrument.create({ data: { name: code, code, profileId } });
  ids.push(row.id);
  const token = generateToken();
  await prisma.instrumentCredential.create({ data: { instrumentId: row.id, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) } });
  fx[key] = { id: row.id, code, token };
}

async function storeCertificate(instrumentId: string, issued: IssuedDeviceCertificate) {
  await prisma.instrument.update({ where: { id: instrumentId }, data: { deviceCertIssueId: issued.issueId } });
  invalidateIngestAuthCache(instrumentId);
}

function post(token: string, client?: IssuedDeviceCertificate): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port, path: '/api/ingest/v1/telemetry', method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      // The server's own identity is not what this suite tests.
      rejectUnauthorized: false,
      // A fresh TLS connection per request: no keep-alive, no resumed session
      // carrying a previous request's certificate.
      agent: false,
      ...(client ? { cert: client.certificatePem, key: client.privateKeyPem } : {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ t: 21.5 }));
  });
}

const refusals = (instrumentId: string, transport = 'http') =>
  prisma.deadLetter.count({ where: { instrumentId, transport, reason: { contains: 'device certificate' } } });

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devcert-tls-'));
  // The HTTPS server's own certificate: any key pair will do here.
  await createDeviceCaFiles(path.join(dir, 'server.crt'), path.join(dir, 'server.key'));
  // A second, unrelated CA, to mint a certificate the server must not accept.
  await createDeviceCaFiles(path.join(dir, 'other-ca.pem'), path.join(dir, 'other-ca.key'));
  process.env.DEVICE_CA_CERT_PATH = path.join(dir, 'other-ca.pem');
  process.env.DEVICE_CA_KEY_PATH = path.join(dir, 'other-ca.key');
  resetDeviceCaCache();
  foreign = await issueDeviceCertificate('foreign');
  // The real device CA.
  await createDeviceCaFiles(path.join(dir, 'device-ca.pem'), path.join(dir, 'device-ca.key'));
  process.env.DEVICE_CA_CERT_PATH = path.join(dir, 'device-ca.pem');
  process.env.DEVICE_CA_KEY_PATH = path.join(dir, 'device-ca.key');
  resetDeviceCaCache();

  const httpsOptions = buildHttpsOptions({
    API_HTTPS: 'true',
    TLS_KEY_PATH: path.join(dir, 'server.key'),
    TLS_CERT_PATH: path.join(dir, 'server.crt'),
    DEVICE_CA_CERT_PATH: path.join(dir, 'device-ca.pem'),
    DEVICE_CA_KEY_PATH: path.join(dir, 'device-ca.key'),
  }, dir);
  expect(httpsOptions?.requestCert).toBe(true);
  app = Fastify({ logger: false, https: httpsOptions! });
  await app.register(ingestRoutes, { prefix: '/api/ingest/v1' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  freeProfileId = (await prisma.instrumentProfile.create({ data: { name: `fixture:dct-free-${S}` } })).id;
  requiredProfileId = (await prisma.instrumentProfile.create({ data: { name: `fixture:dct-required-${S}`, requireDeviceCertificate: true } })).id;
  await mk('FREE', freeProfileId);
  await mk('REQ', requiredProfileId);
  current = await issueDeviceCertificate(fx.REQ.code);
  await storeCertificate(fx.REQ.id, current);
}, 120_000);

afterAll(async () => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  resetDeviceCaCache();
  await app?.close();
  await prisma.deadLetter.deleteMany({ where: { instrumentId: { in: ids } } }).catch(() => {});
  await prisma.instrumentCredential.deleteMany({ where: { instrumentId: { in: ids } } }).catch(() => {});
  await prisma.instrument.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.instrumentProfile.deleteMany({ where: { id: { in: [freeProfileId, requiredProfileId].filter(Boolean) } } }).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => { resetCertificateRefusalLimiter(); });

describe('HTTPS ingest with client certificates requested', () => {
  it('an instrument whose profile does not require one: no certificate is fine', async () => {
    const res = await post(fx.FREE.token);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
  });

  it('…and a certificate it happens to present changes nothing', async () => {
    expect((await post(fx.FREE.token, current)).status).toBe(200);
  });

  it('a required instrument with no certificate: 403 and a dead letter on http', async () => {
    const before = await refusals(fx.REQ.id);
    const res = await post(fx.REQ.token);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('DEVICE_CERTIFICATE_REQUIRED');
    expect(await refusals(fx.REQ.id)).toBe(before + 1);
  });

  it('a required instrument with its current certificate: accepted', async () => {
    const res = await post(fx.REQ.token, current);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
  });

  it('a certificate from another CA counts as none', async () => {
    const res = await post(fx.REQ.token, foreign);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('DEVICE_CERTIFICATE_REQUIRED');
  });

  it('after a re-issue the old certificate is refused at once and the new one accepted', async () => {
    const reissued = await issueDeviceCertificate(fx.REQ.code);
    await storeCertificate(fx.REQ.id, reissued);
    const old = await post(fx.REQ.token, current);
    expect(old.status).toBe(403);
    expect(old.body.error).toBe('DEVICE_CERTIFICATE_MISMATCH');
    expect((await post(fx.REQ.token, reissued)).status).toBe(200);
  });
});
