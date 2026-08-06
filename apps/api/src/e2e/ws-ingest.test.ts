import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { generateToken, hashToken, tokenPrefix } from '../modules/instruments/token.js';
import { invalidateIngestAuthCache } from '../modules/instruments/ingest-auth.js';

/**
 * Drives the real WebSocket ingest route over a real socket against a real
 * listening Fastify instance (`app.inject()` cannot perform an HTTP upgrade).
 *
 * The app is the shared `buildApp()` on purpose: the route must be registered
 * there AND be reachable without a user JWT. If `/api/ingest/v1/ws` ever leaves
 * the auth-hook allowlist, the handshake itself fails and every test in this
 * file goes red — that is the intended coupling, not an accident.
 *
 * Three apps, not one. As in `tcp-ingest.test.ts`: the main app's auth deadline
 * and rate cap are deliberately far past anything a test waits for, so that a
 * "closes the socket" assertion cannot be satisfied by a second closer sitting
 * behind the defence under test. Each short-fused app is used by exactly the
 * test whose subject IS that fuse.
 */

const S = Date.now();

let mainApp: FastifyInstance;      // long auth deadline, high rate cap, 4 KB frame cap
let fastAuthApp: FastifyInstance;  // 300 ms auth deadline — the timeout test only
let rateApp: FastifyInstance;      // 3 messages per window — the rate-cap test only

const instrumentIds: string[] = [];
let plainToken: string;
let plainId: string;
let gwToken: string;
let gwId: string;
let childId: string;
const CHILD_CODE = `WSC-${S}`;

async function mkInstrument(
  code: string,
  extra: { isGateway?: boolean; gatewayId?: string } = {},
): Promise<{ id: string; token: string }> {
  const inst = await prisma.instrument.create({ data: { name: code, code, ...extra } });
  instrumentIds.push(inst.id);
  const token = generateToken();
  await prisma.instrumentCredential.create({
    data: { instrumentId: inst.id, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) },
  });
  return { id: inst.id, token };
}

function wsUrl(app: FastifyInstance): string {
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return `ws://127.0.0.1:${port}/api/ingest/v1/ws`;
}

/** Open a connection, optionally presenting the token on the upgrade request. */
function open(app: FastifyInstance, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(app), { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolves with the close code once the server shuts the connection. */
function closedCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.on('error', () => {});   // a reset can precede 'close' on Windows
    ws.once('close', (code: number) => resolve(code));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(50);
  }
}

const latestKeys = (instrumentId: string) =>
  prisma.$queryRaw<Array<{ key: string }>>`
    SELECT key FROM instrument_telemetry_latest WHERE instrument_id = ${instrumentId} ORDER BY key`;

beforeAll(async () => {
  const plain = await mkInstrument(`WSP-${S}`);
  plainId = plain.id; plainToken = plain.token;

  const gw = await mkInstrument(`WSG-${S}`, { isGateway: true });
  gwId = gw.id; gwToken = gw.token;

  const child = await mkInstrument(CHILD_CODE, { gatewayId: gwId });
  childId = child.id;

  mainApp = await buildApp({
    wsIngest: {
      authTimeoutMs: 30_000, maxFrameBytes: 4096,
      maxMessagesPerWindow: 5000, rateWindowMs: 60_000,
      log: () => {},
    },
  });
  fastAuthApp = await buildApp({
    wsIngest: { authTimeoutMs: 300, log: () => {} },
  });
  rateApp = await buildApp({
    // Long auth deadline and a large frame cap so the ONLY thing that can shut
    // this connection is the message-rate cap under test.
    wsIngest: {
      authTimeoutMs: 30_000, maxFrameBytes: 65_536,
      maxMessagesPerWindow: 3, rateWindowMs: 60_000,
      log: () => {},
    },
  });

  for (const a of [mainApp, fastAuthApp, rateApp]) {
    await a.listen({ port: 0, host: '127.0.0.1' });
  }
});

afterAll(async () => {
  for (const a of [mainApp, fastAuthApp, rateApp]) await a?.close();
  await prisma.deadLetter.deleteMany({ where: { instrumentId: { in: instrumentIds } } });
  await prisma.$executeRaw`DELETE FROM instrument_telemetry_latest WHERE instrument_id = ANY(${instrumentIds}::text[])`;
  await prisma.instrument.deleteMany({ where: { gatewayId: { in: instrumentIds } } });
  await prisma.instrument.deleteMany({ where: { id: { in: instrumentIds } } });
  invalidateIngestAuthCache();
});

describe('WebSocket ingest listener', () => {
  it('ingests readings when the token is on the upgrade request header', async () => {
    const ws = await open(mainApp, { authorization: `Bearer ${plainToken}` });
    ws.send(JSON.stringify({ hdrtemp: 21.5 }));

    await waitFor(async () => (await latestKeys(plainId)).some((r) => r.key === 'hdrtemp'));
    ws.close();
  });

  it('ingests readings when the token arrives in the FIRST frame instead', async () => {
    // Some WebSocket clients (browsers, several embedded stacks) cannot set a
    // handshake header at all, so in-band auth is the only option they have.
    const ws = await open(mainApp);
    ws.send(JSON.stringify({ token: plainToken }));
    ws.send(JSON.stringify({ frametemp: 22.5 }));

    await waitFor(async () => (await latestKeys(plainId)).some((r) => r.key === 'frametemp'));
    ws.close();
  });

  it('closes a connection that never authenticates', async () => {
    const ws = await open(fastAuthApp);
    await expect(closedCode(ws)).resolves.toBe(4401);
  });

  it('closes immediately on a bad token in the upgrade header', async () => {
    const ws = await open(mainApp, { authorization: `Bearer ${generateToken()}` });
    await expect(closedCode(ws)).resolves.toBe(4401);
  });

  it('closes on a bad token in the first frame', async () => {
    const ws = await open(mainApp);
    const shut = closedCode(ws);
    ws.send(JSON.stringify({ token: generateToken() }));
    await expect(shut).resolves.toBe(4401);
  });

  it('dead-letters malformed JSON after auth and KEEPS the connection open', async () => {
    const before = await prisma.deadLetter.count({ where: { instrumentId: plainId } });

    const ws = await open(mainApp, { authorization: `Bearer ${plainToken}` });
    ws.send('{not json');

    const rows = await waitFor(async () => {
      const r = await prisma.deadLetter.findMany({
        where: { instrumentId: plainId }, orderBy: { receivedAt: 'desc' }, take: 1,
      });
      return (await prisma.deadLetter.count({ where: { instrumentId: plainId } })) > before ? r : null;
    });
    expect(rows[0].transport).toBe('ws');
    expect(rows[0].reason).toContain('Invalid JSON');

    // The point of the test: one bad reading must not disconnect a device that
    // is otherwise reporting fine.
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.send(JSON.stringify({ wsafterbad: 1 }));
    await waitFor(async () => (await latestKeys(plainId)).some((r) => r.key === 'wsafterbad'));
    ws.close();
  });

  it('refuses a frame larger than the per-frame byte cap', async () => {
    // 8 KB against this app's 4 KB cap, and well under the `ws` library's own
    // 1 MB maxPayload — so it is the handler's own check that must reject it,
    // not the library closing with 1009 behind its back.
    const ws = await open(mainApp, { authorization: `Bearer ${plainToken}` });
    const shut = closedCode(ws);
    await sleep(80);
    ws.send(JSON.stringify({ blob: 'x'.repeat(8000) }));
    await expect(shut).resolves.toBe(4413);
  });

  it('does not write anything from an over-cap frame — the cap precedes the parse', async () => {
    const ws = await open(mainApp, { authorization: `Bearer ${plainToken}` });
    const shut = closedCode(ws);
    await sleep(80);
    ws.send(JSON.stringify({ overcapkey: 1, pad: 'x'.repeat(8000) }));
    await shut;
    await sleep(200);
    expect((await latestKeys(plainId)).some((r) => r.key === 'overcapkey')).toBe(false);
  });

  it('closes a connection that exceeds the per-connection message rate cap', async () => {
    const ws = await open(rateApp, { authorization: `Bearer ${plainToken}` });
    const shut = closedCode(ws);
    await sleep(80);
    for (let i = 0; i < 10; i++) ws.send(JSON.stringify({ [`rate${i}`]: i }));
    await expect(shut).resolves.toBe(4429);
  });

  it('fans a gateway batch frame out to its children', async () => {
    const ws = await open(mainApp, { authorization: `Bearer ${gwToken}` });
    ws.send(JSON.stringify({ devices: { [CHILD_CODE]: { pressure: 3 } } }));

    await waitFor(async () => (await latestKeys(childId)).some((r) => r.key === 'pressure'));
    const row = await prisma.instrument.findUnique({ where: { id: childId } });
    expect(row?.lastSeenVia).toBe('gateway');
    ws.close();
  });
});
