import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { prisma } from '../lib/prisma.js';
import { generateToken, hashToken, tokenPrefix } from '../modules/instruments/token.js';
import { startTcpListener } from '../modules/instruments/listeners/tcp-listener.js';
import { invalidateIngestAuthCache } from '../modules/instruments/ingest-auth.js';

/**
 * Drives the real TCP listener over a real socket on an ephemeral port.
 *
 * No Fastify app and no `loginAs()` here on purpose: this listener is not an
 * HTTP route, and provisioning the instrument straight through Prisma keeps the
 * file clear of the shared-`admin` session race that `apps/api/CLAUDE.md`
 * warns about when several agents share `compliance_core_db_test`.
 */

const S = Date.now();
/**
 * The main listener's timeouts are deliberately LONG (30 s), far past anything
 * a test waits for. Otherwise every "closes the socket" assertion below would
 * pass vacuously: a short auth deadline or idle timeout is a second closer
 * sitting behind the defence under test, so deleting the defence would still
 * leave the test green. Only the dribble test — the one whose subject IS the
 * deadline — uses a short-deadline listener, and it has its own.
 */
let listener: Awaited<ReturnType<typeof startTcpListener>>;
let fastAuthListener: Awaited<ReturnType<typeof startTcpListener>>;
let fastIdleListener: Awaited<ReturnType<typeof startTcpListener>>;
const instrumentIds: string[] = [];

let plainToken: string;
let plainId: string;
let gwToken: string;
let gwId: string;
let childId: string;
const CHILD_CODE = `TCPC-${S}`;

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

/** Connect to the listener under test. */
function connect(port = listener.port): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/** Resolves when the peer closes (or resets) the connection. */
function closed(s: net.Socket): Promise<'close'> {
  return new Promise((resolve) => {
    // A destroy() on the server side can surface as ECONNRESET on Windows
    // before 'close' — swallow it, the assertion is only about being shut.
    s.on('error', () => {});
    s.once('close', () => resolve('close'));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` returns truthy, or fail after `timeoutMs`. */
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
  const plain = await mkInstrument(`TCPP-${S}`);
  plainId = plain.id; plainToken = plain.token;

  const gw = await mkInstrument(`TCPG-${S}`, { isGateway: true });
  gwId = gw.id; gwToken = gw.token;

  const child = await mkInstrument(CHILD_CODE, { gatewayId: gwId });
  childId = child.id;

  // Long timeouts on purpose — see the note at the top. The caps are small so
  // they are cheap to trip; the production defaults these override are 5 s /
  // 15 min / 64 KB / 200.
  listener = await startTcpListener(0, {
    authTimeoutMs: 30_000,
    idleTimeoutMs: 30_000,
    maxLineBytes: 4096,
    maxConnections: 3,
  });

  // Used by exactly one test, so that test is not sitting out a real 5 s
  // deadline next to vitest's own timeout.
  fastAuthListener = await startTcpListener(0, { authTimeoutMs: 300 });
  // Separate again: a short idle timeout on the main listener is precisely the
  // second closer that made the cap tests vacuous, so the only test allowed to
  // have one is the test about it.
  fastIdleListener = await startTcpListener(0, { authTimeoutMs: 30_000, idleTimeoutMs: 400 });
});

afterAll(async () => {
  await listener?.close();
  await fastAuthListener?.close();
  await fastIdleListener?.close();
  await prisma.deadLetter.deleteMany({ where: { instrumentId: { in: instrumentIds } } });
  await prisma.$executeRaw`DELETE FROM instrument_telemetry_latest WHERE instrument_id = ANY(${instrumentIds}::text[])`;
  // Children first — the FK is SetNull, but deleting the parent while a child
  // row points at it would leave a stray instrument behind.
  await prisma.instrument.deleteMany({ where: { gatewayId: { in: instrumentIds } } });
  await prisma.instrument.deleteMany({ where: { id: { in: instrumentIds } } });
  invalidateIngestAuthCache();
});

describe('TCP ingest listener', () => {
  it('authenticates on the first line and ingests every line after it', async () => {
    const s = await connect();
    s.write(`${JSON.stringify({ token: plainToken })}\n`);
    s.write(`${JSON.stringify({ temp: 21.5 })}\n`);

    await waitFor(async () => (await latestKeys(plainId)).some((r) => r.key === 'temp'));
    s.destroy();
  });

  it('reassembles a reading split across two writes — the split-packet case', async () => {
    const s = await connect();
    s.write(`${JSON.stringify({ token: plainToken })}\n`);

    const line = `${JSON.stringify({ splitkey: 7 })}\n`;
    const half = Math.floor(line.length / 2);
    s.write(line.slice(0, half));
    await sleep(60);            // force two distinct TCP segments
    s.write(line.slice(half));

    await waitFor(async () => (await latestKeys(plainId)).some((r) => r.key === 'splitkey'));
    s.destroy();
  });

  it('closes the socket on a bad token', async () => {
    const s = await connect();
    const shut = closed(s);
    s.write(`${JSON.stringify({ token: generateToken() })}\n`);
    await expect(shut).resolves.toBe('close');
  });

  it('closes the socket when the first line is not a token envelope', async () => {
    const s = await connect();
    const shut = closed(s);
    s.write('hello there\n');
    await expect(shut).resolves.toBe('close');
  });

  it('closes a socket that never authenticates, even one dribbling bytes', async () => {
    const s = await connect(fastAuthListener.port);
    const shut = closed(s);
    // A byte every 100 ms would defeat an inactivity-based timer; the deadline
    // is absolute precisely so a scanner cannot hold the slot for free.
    const dribble = setInterval(() => { if (!s.destroyed) s.write('x'); }, 100);
    await expect(shut).resolves.toBe('close');
    clearInterval(dribble);
  });

  it('closes an AUTHENTICATED socket that goes idle past the post-auth timeout', async () => {
    // Distinct from the unauthenticated deadline: this socket presented a valid
    // token, so it is only the idle timer that can reclaim its slot when the
    // device unplugs its ethernet and the OS has not noticed yet.
    const s = await connect(fastIdleListener.port);
    const shut = closed(s);
    s.write(`${JSON.stringify({ token: plainToken })}\n`);
    await expect(shut).resolves.toBe('close');
  });

  it('closes a socket whose line exceeds the byte cap, newline and all', async () => {
    // Terminated in ONE write: `framer.buffered` is 0 by the time push()
    // returns, so a cap that only watches the buffer would let this through.
    const s = await connect();
    const shut = closed(s);
    s.write(`${JSON.stringify({ token: plainToken })}\n`);
    await sleep(80);
    s.write(`${JSON.stringify({ blob: 'x'.repeat(8000) })}\n`);
    await expect(shut).resolves.toBe('close');
  });

  it('closes a socket that streams an unterminated line past the cap', async () => {
    const s = await connect();
    const shut = closed(s);
    s.write(`${JSON.stringify({ token: plainToken })}\n`);
    await sleep(80);
    s.write('x'.repeat(9000));   // no newline — pure buffer growth
    await expect(shut).resolves.toBe('close');
  });

  it('dead-letters malformed JSON after auth and KEEPS the socket open', async () => {
    const before = await prisma.deadLetter.count({ where: { instrumentId: plainId } });

    const s = await connect();
    s.write(`${JSON.stringify({ token: plainToken })}\n`);
    s.write('{not json\n');

    const rows = await waitFor(async () => {
      const r = await prisma.deadLetter.findMany({
        where: { instrumentId: plainId }, orderBy: { receivedAt: 'desc' }, take: 1,
      });
      return (await prisma.deadLetter.count({ where: { instrumentId: plainId } })) > before ? r : null;
    });
    expect(rows[0].transport).toBe('tcp');
    expect(rows[0].reason).toContain('Invalid JSON');

    // The point of the test: one bad reading must not disconnect a device that
    // is otherwise working.
    expect(s.destroyed).toBe(false);
    s.write(`${JSON.stringify({ afterbad: 1 })}\n`);
    await waitFor(async () => (await latestKeys(plainId)).some((r) => r.key === 'afterbad'));
    s.destroy();
  });

  it('fans a gateway batch line out to its children', async () => {
    const s = await connect();
    s.write(`${JSON.stringify({ token: gwToken })}\n`);
    s.write(`${JSON.stringify({ devices: { [CHILD_CODE]: { pressure: 3 } } })}\n`);

    await waitFor(async () => (await latestKeys(childId)).some((r) => r.key === 'pressure'));

    const row = await prisma.instrument.findUnique({ where: { id: childId } });
    expect(row?.lastSeenVia).toBe('gateway');
    s.destroy();
  });

  it('refuses connections past the concurrent-connection cap', async () => {
    await sleep(150);   // let the previous tests' closures be observed server-side
    const held: net.Socket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await connect();
      s.write(`${JSON.stringify({ token: plainToken })}\n`);
      held.push(s);
    }
    await sleep(120);

    // The 4th socket sends a VALID token: under a working cap it is destroyed
    // at accept, before the line is ever read; under a broken one it
    // authenticates and lives. Asserting `destroyed` rather than waiting for a
    // close event keeps the test from being satisfied by any timeout.
    const extra = await connect();
    extra.on('error', () => {});
    extra.write(`${JSON.stringify({ token: plainToken })}\n`);
    await sleep(200);
    expect(extra.destroyed).toBe(true);

    for (const s of held) s.destroy();
  });
});
