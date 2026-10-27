import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { generateToken, hashToken, tokenPrefix } from '../modules/instruments/token.js';
import { invalidateIngestAuthCache } from '../modules/instruments/ingest-auth.js';
import { invalidateChildMapCache } from '../modules/instruments/gateway-children.js';
import { resetCertificateRefusalLimiter } from '../modules/instruments/device-certificate.js';
import { startTcpListener } from '../modules/instruments/listeners/tcp-listener.js';

/**
 * Device certificates (2026-10-27) on the channels that can NOT carry one in
 * these tests: `app.inject` (no TLS socket), plain `ws://` and raw TCP. Every
 * required instrument is therefore refused there — the HTTPS path WITH a
 * certificate is device-certificate-tls.e2e.test.ts. A gateway batch drops a
 * required child unless the gateway's connection carried the gateway's own
 * certificate; its free siblings still land.
 */
const S = Date.now();
let app: FastifyInstance;
let tcp: Awaited<ReturnType<typeof startTcpListener>>;
let freeProfileId: string;
let requiredProfileId: string;
const ids: string[] = [];
const fx: Record<string, { id: string; code: string; token: string }> = {};

async function mk(key: string, profileId: string, extra: Record<string, unknown> = {}) {
  const code = `DCC-${key}-${S}`;
  const row = await prisma.instrument.create({ data: { name: code, code, profileId, ...extra } });
  ids.push(row.id);
  const token = generateToken();
  await prisma.instrumentCredential.create({ data: { instrumentId: row.id, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) } });
  fx[key] = { id: row.id, code, token };
}

const refusals = (instrumentId: string, transport: string) =>
  prisma.deadLetter.count({ where: { instrumentId, transport, reason: { contains: 'device certificate' } } });
const readings = (instrumentId: string) =>
  prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM instrument_telemetry_history WHERE instrument_id = ${instrumentId}`
    .then((r) => Number(r[0].n));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wsOpen(headers: Record<string, string>): Promise<WebSocket> {
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ingest/v1/ws`, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function wsClosed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.on('error', () => {});
    ws.once('close', (code: number) => resolve(code));
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  tcp = await startTcpListener(0, { authTimeoutMs: 30_000, idleTimeoutMs: 30_000 });
  freeProfileId = (await prisma.instrumentProfile.create({ data: { name: `fixture:dcc-free-${S}` } })).id;
  requiredProfileId = (await prisma.instrumentProfile.create({ data: { name: `fixture:dcc-required-${S}`, requireDeviceCertificate: true } })).id;
  await mk('FREE', freeProfileId);
  await mk('REQ', requiredProfileId, { deviceCertIssueId: 'ab'.repeat(16) });
  await mk('GW', freeProfileId, { isGateway: true });
  await mk('KIDREQ', requiredProfileId, { gatewayId: fx.GW.id });
  await mk('KIDFREE', freeProfileId, { gatewayId: fx.GW.id });
}, 60_000);

afterAll(async () => {
  await tcp?.close();
  await app?.close();
  await prisma.deadLetter.deleteMany({ where: { instrumentId: { in: ids } } }).catch(() => {});
  await prisma.instrumentCredential.deleteMany({ where: { instrumentId: { in: ids } } }).catch(() => {});
  await prisma.instrument.updateMany({ where: { id: { in: ids } }, data: { gatewayId: null } }).catch(() => {});
  await prisma.instrument.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.instrumentProfile.deleteMany({ where: { id: { in: [freeProfileId, requiredProfileId].filter(Boolean) } } }).catch(() => {});
});

beforeEach(() => {
  invalidateIngestAuthCache();
  invalidateChildMapCache();
  resetCertificateRefusalLimiter();
});

describe('HTTP without TLS (app.inject)', () => {
  it('a required instrument is refused 403 with a dead letter', async () => {
    const before = await refusals(fx.REQ.id, 'http');
    const res = await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${fx.REQ.token}` }, payload: { t: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('DEVICE_CERTIFICATE_REQUIRED');
    expect(await refusals(fx.REQ.id, 'http')).toBe(before + 1);
  });

  it('a free instrument is accepted as before', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${fx.FREE.token}` }, payload: { t: 1 },
    });
    expect(res.statusCode).toBe(200);
  });

  it('a gateway batch drops the required child and stores its free sibling', async () => {
    const kidReqBefore = await readings(fx.KIDREQ.id);
    const kidFreeBefore = await readings(fx.KIDFREE.id);
    const res = await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${fx.GW.token}` },
      payload: { devices: { [fx.KIDREQ.code]: { t: 2 }, [fx.KIDFREE.code]: { t: 3 } } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1, rejected: 1 });
    expect(await readings(fx.KIDREQ.id)).toBe(kidReqBefore);
    expect(await readings(fx.KIDFREE.id)).toBe(kidFreeBefore + 1);
    const dl = await prisma.deadLetter.findFirst({
      where: { instrumentId: fx.GW.id, reason: { contains: 'device certificate' } }, orderBy: { receivedAt: 'desc' },
    });
    expect(dl?.reason).toContain(fx.KIDREQ.code);
  });
});

describe('raw TCP (never TLS)', () => {
  function connect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ port: tcp.port, host: '127.0.0.1' });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
  }

  it('a required instrument is closed after its token line, with a dead letter on tcp', async () => {
    const before = await refusals(fx.REQ.id, 'tcp');
    const s = await connect();
    const closed = new Promise<void>((resolve) => s.once('close', () => resolve()));
    s.on('error', () => {});
    s.write(`${JSON.stringify({ token: fx.REQ.token })}\n`);
    await closed;
    expect(await refusals(fx.REQ.id, 'tcp')).toBe(before + 1);
  });

  it('a free instrument still reports', async () => {
    const before = await readings(fx.FREE.id);
    const s = await connect();
    s.write(`${JSON.stringify({ token: fx.FREE.token })}\n${JSON.stringify({ t: 4 })}\n`);
    for (let i = 0; i < 50 && (await readings(fx.FREE.id)) === before; i++) await sleep(100);
    expect(await readings(fx.FREE.id)).toBe(before + 1);
    s.destroy();
  });
});

describe('WebSocket (plain ws://)', () => {
  it('a required instrument is closed 4403 with a dead letter on ws', async () => {
    const before = await refusals(fx.REQ.id, 'ws');
    const ws = await wsOpen({ authorization: `Bearer ${fx.REQ.token}` });
    expect(await wsClosed(ws)).toBe(4403);
    expect(await refusals(fx.REQ.id, 'ws')).toBe(before + 1);
  });

  it('a free instrument that becomes required mid-connection is closed on its next frame', async () => {
    const ws = await wsOpen({ authorization: `Bearer ${fx.FREE.token}` });
    const closed = wsClosed(ws);
    const before = await readings(fx.FREE.id);
    ws.send(JSON.stringify({ t: 5 }));
    for (let i = 0; i < 50 && (await readings(fx.FREE.id)) === before; i++) await sleep(100);
    expect(await readings(fx.FREE.id)).toBe(before + 1);

    await prisma.instrumentProfile.update({ where: { id: freeProfileId }, data: { requireDeviceCertificate: true } });
    invalidateIngestAuthCache();
    try {
      ws.send(JSON.stringify({ t: 6 }));
      expect(await closed).toBe(4403);
      expect(await readings(fx.FREE.id)).toBe(before + 1);
    } finally {
      await prisma.instrumentProfile.update({ where: { id: freeProfileId }, data: { requireDeviceCertificate: false } });
      invalidateIngestAuthCache();
    }
  });
});
