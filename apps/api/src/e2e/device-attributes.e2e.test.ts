/**
 * Device attributes on EVERY protocol (2026-10-28, operator: "why attributes
 * topic was not there for http and https" → "add for all protocals").
 *
 *   HTTP / HTTPS   POST + GET /api/ingest/v1/attributes
 *   WS, TCP        {"attributes": {...}} reports; {"subscribe": "attributes"}
 *                  answers the current set and pushes every later change
 *
 * Over the real routes and real listeners (`app.inject` cannot upgrade a
 * WebSocket), with NO MQTT publisher installed — the pushes must not need a
 * broker. `app.inject` performs no TLS handshake, so on HTTP a gateway is never
 * certificate-verified: exactly the refusal case for a child whose profile
 * requires a certificate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { generateToken, hashToken, tokenPrefix } from '../modules/instruments/token.js';
import { invalidateIngestAuthCache } from '../modules/instruments/ingest-auth.js';
import { invalidateChildMapCache } from '../modules/instruments/gateway-children.js';
import { startTcpListener } from '../modules/instruments/listeners/tcp-listener.js';
import { setDownlinkPublisher } from '../modules/instruments/attribute-downlink.js';
import { attributeSubscriberCount } from '../modules/instruments/attribute-sessions.js';

const S = Date.now();
let app: FastifyInstance;
let tcp: Awaited<ReturnType<typeof startTcpListener>>;
let admin: Record<string, string>;
const ids: string[] = [];
let writableBefore: { existed: boolean; value: unknown } = { existed: false, value: null };

type Inst = { id: string; code: string; token: string };
let plain: Inst; let wsDev: Inst; let tcpDev: Inst; let revoked: Inst;
let gw: Inst; let child: Inst; let certChild: Inst;

async function mk(code: string, extra: { isGateway?: boolean; gatewayId?: string; profileId?: string } = {}): Promise<Inst> {
  const { profileId, ...rest } = extra;
  const inst = await prisma.instrument.create({
    data: { name: code, code, profileId: profileId ?? await fixtureProfileId('fixture:device-attributes'), ...rest },
  });
  ids.push(inst.id);
  const token = generateToken();
  await prisma.instrumentCredential.create({ data: { instrumentId: inst.id, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) } });
  return { id: inst.id, code, token };
}

const attrs = async (id: string) => Object.fromEntries(
  (await prisma.instrumentAttribute.findMany({ where: { instrumentId: id } })).map((r) => [r.key, r.value]),
);
const reported = (id: string) => prisma.auditTrail.findMany({
  where: { action: 'INSTRUMENT_ATTRIBUTE_REPORTED', targetId: id }, select: { afterValue: true, reason: true }, orderBy: { timestamp: 'asc' },
});
const setFromApp = (id: string, key: string, value: string) =>
  app.inject({ method: 'POST', url: `/api/instruments/${id}/attributes`, headers: admin, payload: { key, value, reason: 'Changed from the app for the e2e' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T> | T, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('waitFor timed out'); await sleep(40); }
}

/** Messages a client received, in order, and a way to wait for the next. */
function inbox() {
  const got: Record<string, unknown>[] = [];
  return {
    got,
    push: (text: string) => { for (const l of text.split('\n').filter(Boolean)) got.push(JSON.parse(l)); },
    next: async (n: number) => waitFor(() => (got.length >= n ? got[n - 1] : null)),
  };
}

function wsOpen(token: string) {
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const box = inbox();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ingest/v1/ws`, { headers: { authorization: `Bearer ${token}` } });
  ws.on('message', (d) => box.push(d.toString()));
  ws.on('error', () => {});
  const closed = new Promise<number>((r) => ws.once('close', (c: number) => r(c)));
  return { ws, box, closed, opened: new Promise<void>((r) => ws.once('open', () => r())) };
}

function tcpOpen(token: string) {
  const box = inbox();
  let buf = '';
  const sock = net.createConnection({ port: tcp.port, host: '127.0.0.1' });
  sock.on('data', (c) => {
    buf += c.toString('utf8');
    const i = buf.lastIndexOf('\n');
    if (i >= 0) { box.push(buf.slice(0, i + 1)); buf = buf.slice(i + 1); }
  });
  sock.on('error', () => {});
  const ready = new Promise<void>((r) => sock.once('connect', () => { sock.write(`${JSON.stringify({ token })}\n`); r(); }));
  return { sock, box, ready, send: (o: unknown) => sock.write(`${JSON.stringify(o)}\n`) };
}

beforeAll(async () => {
  setDownlinkPublisher(null);
  // Pinned: which keys a device may write is administered, and the test
  // database is not the live one. Restored FIRST in afterAll.
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'instrument-attributes' } });
  writableBefore = { existed: Boolean(row), value: row?.configValue ?? null };
  const base = (row?.configValue as Record<string, unknown> | null) ?? {};
  await prisma.systemConfig.upsert({
    where: { configKey: 'instrument-attributes' },
    create: { configKey: 'instrument-attributes', configType: 'instruments', configValue: { ...base, deviceWritableKeys: 'Location\nBuilding' } as never },
    update: { configValue: { ...base, deviceWritableKeys: 'Location\nBuilding' } as never },
  });

  const certProfile = await fixtureProfileId('fixture:device-attributes-cert');
  await prisma.instrumentProfile.update({ where: { id: certProfile }, data: { requireDeviceCertificate: true } });
  plain = await mk(`DA-P-${S}`);
  wsDev = await mk(`DA-W-${S}`);
  tcpDev = await mk(`DA-T-${S}`);
  revoked = await mk(`DA-R-${S}`);
  gw = await mk(`DA-G-${S}`, { isGateway: true });
  child = await mk(`DA-C-${S}`, { gatewayId: gw.id });
  certChild = await mk(`DA-K-${S}`, { gatewayId: gw.id, profileId: certProfile });
  invalidateChildMapCache();

  app = await buildApp({ wsIngest: { authTimeoutMs: 30_000, maxMessagesPerWindow: 5000, log: () => {} } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  tcp = await startTcpListener(0, { log: () => {} });
  admin = { authorization: `Bearer ${await loginAs(app)}` };
});

afterAll(async () => {
  try {
    if (writableBefore.existed) {
      await prisma.systemConfig.update({ where: { configKey: 'instrument-attributes' }, data: { configValue: writableBefore.value as never } });
    } else {
      await prisma.systemConfig.deleteMany({ where: { configKey: 'instrument-attributes' } });
    }
  } finally {
    await tcp?.close();
    await app?.close();
    await prisma.deadLetter.deleteMany({ where: { instrumentId: { in: ids } } });
    await prisma.$executeRaw`DELETE FROM instrument_telemetry_latest WHERE instrument_id = ANY(${ids}::text[])`;
    await prisma.instrumentAttribute.deleteMany({ where: { instrumentId: { in: ids } } });
    await prisma.instrument.deleteMany({ where: { gatewayId: { in: ids } } });
    await prisma.instrument.deleteMany({ where: { id: { in: ids } } });
    invalidateIngestAuthCache();
  }
});

describe('HTTP / HTTPS — POST and GET /api/ingest/v1/attributes', () => {
  const post = (token: string, payload: unknown) => app.inject({
    method: 'POST', url: '/api/ingest/v1/attributes', headers: { authorization: `Bearer ${token}` }, payload: payload as object,
  });
  const get = (token: string) => app.inject({ method: 'GET', url: '/api/ingest/v1/attributes', headers: { authorization: `Bearer ${token}` } });

  it('a report is stored, audited as HTTP; a key devices may not write is refused and dead-lettered', async () => {
    const res = await post(plain.token, { Location: 'Room A', Room: '101' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ written: 1, unchanged: 0, refused: 1 });
    expect(await attrs(plain.id)).toEqual({ Location: 'Room A' });
    const audit = await reported(plain.id);
    expect(audit.at(-1)?.afterValue).toMatchObject({ attribute: 'Location', value: 'Room A', transport: 'http' });
    expect(audit.at(-1)?.reason).toBe(`Reported by device "${plain.code}" over HTTP`);
    const dead = await prisma.deadLetter.findFirst({ where: { instrumentId: plain.id }, orderBy: { receivedAt: 'desc' } });
    expect(dead?.transport).toBe('http');
    expect(dead?.reason).toMatch(/"Room" is not a device-writable/);
  });

  it('the same report again writes and audits nothing', async () => {
    const before = (await reported(plain.id)).length;
    const res = await post(plain.token, { Location: 'Room A' });
    expect(res.json()).toEqual({ written: 0, unchanged: 1, refused: 0 });
    expect((await reported(plain.id)).length).toBe(before);
  });

  it('GET answers the complete set', async () => {
    const res = await get(plain.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ device: plain.code, attributes: { Location: 'Room A' }, children: [] });
    expect(typeof res.json().ts).toBe('string');
  });

  it('a gateway reports for its child; a child that requires a certificate is refused on an unverified connection, and left out of its GET', async () => {
    const res = await post(gw.token, { devices: [{ devN: child.code, Location: 'Bay 1' }, { devN: certChild.code, Location: 'Bay 2' }] });
    expect(res.statusCode).toBe(200);
    expect(await attrs(child.id)).toEqual({ Location: 'Bay 1' });
    expect(await attrs(certChild.id)).toEqual({});
    await setFromApp(certChild.id, 'Location', 'Secret bay');
    const got = await get(gw.token);
    expect(got.json().children).toEqual([{ device: child.code, attributes: { Location: 'Bay 1' } }]);
  });

  it('a bad token is a 401 on both', async () => {
    expect((await post('nope', { Location: 'x' })).statusCode).toBe(401);
    expect((await get('nope')).statusCode).toBe(401);
  });
});

describe('WebSocket — {"attributes":...} and {"subscribe":"attributes"}', () => {
  it('a report frame is stored and audited as WebSocket; a telemetry frame carrying an `attributes` reading stays telemetry', async () => {
    const c = wsOpen(wsDev.token);
    await c.opened;
    c.ws.send(JSON.stringify({ attributes: { Building: 'B1' } }));
    await waitFor(async () => (await attrs(wsDev.id)).Building === 'B1');
    expect((await reported(wsDev.id)).at(-1)?.afterValue).toMatchObject({ attribute: 'Building', transport: 'ws' });
    c.ws.send(JSON.stringify({ attributes: { Location: 'not me' }, wst: 21.5 }));
    await waitFor(async () => (await prisma.$queryRaw<{ key: string }[]>`
      SELECT key FROM instrument_telemetry_latest WHERE instrument_id = ${wsDev.id} AND key = 'wst'`).length > 0);
    expect((await attrs(wsDev.id)).Location).toBeUndefined();
    c.ws.close();
  });

  it('subscribe answers the current set, then pushes an app-side change — with no broker', async () => {
    const c = wsOpen(wsDev.token);
    await c.opened;
    c.ws.send(JSON.stringify({ subscribe: 'attributes' }));
    expect(await c.box.next(1)).toMatchObject({ device: wsDev.code, attributes: { Building: 'B1' }, changed: {} });
    expect((await setFromApp(wsDev.id, 'Building', 'B2')).statusCode).toBe(200);
    expect(await c.box.next(2)).toMatchObject({ device: wsDev.code, attributes: { Building: 'B2' }, changed: { Building: 'B2' } });
    c.ws.close();
    await c.closed;
    await waitFor(() => attributeSubscriberCount(wsDev.id) === 0);
  });

  it('a gateway receives its child\'s changes naming the child — never a certificate child\'s on an unverified connection', async () => {
    const c = wsOpen(gw.token);
    await c.opened;
    c.ws.send(JSON.stringify({ subscribe: 'attributes' }));
    const own = await c.box.next(1);
    const kid = await c.box.next(2);
    expect(own).toMatchObject({ device: gw.code });
    expect(kid).toMatchObject({ device: child.code, attributes: { Location: 'Bay 1' } });
    await setFromApp(certChild.id, 'Location', 'Hidden');
    await setFromApp(child.id, 'Location', 'Bay 9');
    expect(await c.box.next(3)).toMatchObject({ device: child.code, changed: { Location: 'Bay 9' } });
    await sleep(300);
    expect(c.box.got.map((m) => m.device)).not.toContain(certChild.code);
    c.ws.close();
  });

  it('a deactivated instrument stops receiving: the next push closes the connection instead', async () => {
    const c = wsOpen(revoked.token);
    await c.opened;
    c.ws.send(JSON.stringify({ subscribe: 'attributes' }));
    await c.box.next(1);
    await prisma.instrument.update({ where: { id: revoked.id }, data: { isActive: false } });
    invalidateIngestAuthCache(revoked.id);
    await setFromApp(revoked.id, 'Location', 'after revocation');
    expect(await c.closed).toBe(4403);
    expect(c.box.got).toHaveLength(1);
    expect(attributeSubscriberCount(revoked.id)).toBe(0);
  });
});

describe('TCP — the same frames, one JSON object per line', () => {
  it('a report line is audited as TCP, and subscribe answers then pushes', async () => {
    const c = tcpOpen(tcpDev.token);
    await c.ready;
    c.send({ attributes: { Building: 'T1' } });
    await waitFor(async () => (await attrs(tcpDev.id)).Building === 'T1');
    expect((await reported(tcpDev.id)).at(-1)?.afterValue).toMatchObject({ transport: 'tcp' });
    c.send({ subscribe: 'attributes' });
    expect(await c.box.next(1)).toMatchObject({ device: tcpDev.code, attributes: { Building: 'T1' }, changed: {} });
    await setFromApp(tcpDev.id, 'Building', 'T2');
    expect(await c.box.next(2)).toMatchObject({ device: tcpDev.code, changed: { Building: 'T2' } });
    c.sock.destroy();
    await waitFor(() => attributeSubscriberCount(tcpDev.id) === 0);
  });
});
