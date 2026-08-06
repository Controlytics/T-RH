import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { prisma } from '../lib/prisma.js';

/**
 * The MQTT bridge against the REAL ingest core and the REAL database, with only
 * the wire faked.
 *
 * Faking `mqtt.connect` (and nothing else) is deliberate. What this file has to
 * prove is what the bridge does with a delivered message — topic routing, the
 * byte cap, the unknown-code drop, gateway fan-out, `transport: 'mqtt'` on a
 * dead-letter — and none of that becomes more true for having travelled over a
 * socket. The parts a fake broker CANNOT prove (that EMQX consults the auth
 * hook, and that a device is refused another instrument's topic) are verified
 * against the real EMQX and recorded in the report; no fake could stand in for
 * them, because they are broker behaviour, not ours.
 */

class FakeClient extends EventEmitter {
  options: { reconnectPeriod: number } = { reconnectPeriod: 1000 };
  subscriptions: Array<{ topic: string; qos: number }> = [];
  ended = false;
  subscribe(
    topic: string,
    opts: { qos: number },
    cb: (err: Error | null) => void,
  ): void {
    this.subscriptions.push({ topic, qos: opts.qos });
    cb(null);
  }
  end(_force: boolean, _o: unknown, cb: () => void): void {
    this.ended = true;
    cb();
  }
}

let lastClient: FakeClient;

vi.mock('mqtt', () => ({
  default: {
    connect: () => {
      lastClient = new FakeClient();
      setTimeout(() => lastClient.emit('connect'), 0);
      return lastClient;
    },
  },
}));

const { startMqttBridge, TELEMETRY_TOPIC_FILTER } = await import(
  '../modules/instruments/listeners/mqtt-bridge.js'
);

const S = Date.now();
const PLAIN_CODE = `MQP-${S}`;
const GW_CODE = `MQG-${S}`;
const CHILD_CODE = `MQC-${S}`;
const OFF_CODE = `MQX-${S}`;

const instrumentIds: string[] = [];
let plainId: string;
let gwId: string;
let childId: string;
let offId: string;

let bridge: { close(): Promise<void> };
const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];

async function mkInstrument(
  code: string,
  extra: { isGateway?: boolean; gatewayId?: string; isActive?: boolean } = {},
): Promise<string> {
  const inst = await prisma.instrument.create({ data: { name: code, code, ...extra } });
  instrumentIds.push(inst.id);
  return inst.id;
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

/** Deliver one message exactly as the client would. */
function publish(topic: string, body: unknown): void {
  const payload = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  lastClient.emit('message', topic, payload);
}

beforeAll(async () => {
  plainId = await mkInstrument(PLAIN_CODE);
  gwId = await mkInstrument(GW_CODE, { isGateway: true });
  childId = await mkInstrument(CHILD_CODE, { gatewayId: gwId });
  offId = await mkInstrument(OFF_CODE, { isActive: false });

  bridge = await startMqttBridge('mqtt://127.0.0.1:1883', {
    maxMessageBytes: 4096,
    log: (msg, meta) => { logs.push({ msg, meta }); },
  });
});

afterAll(async () => {
  await bridge?.close();
  await prisma.deadLetter.deleteMany({ where: { instrumentId: { in: instrumentIds } } });
  await prisma.$executeRaw`DELETE FROM instrument_telemetry_latest WHERE instrument_id = ANY(${instrumentIds}::text[])`;
  await prisma.instrument.deleteMany({ where: { gatewayId: { in: instrumentIds } } });
  await prisma.instrument.deleteMany({ where: { id: { in: instrumentIds } } });
});

describe('MQTT ingest bridge', () => {
  it('subscribes to instruments/+/telemetry at QoS 1 on connect', () => {
    expect(lastClient.subscriptions).toEqual([{ topic: TELEMETRY_TOPIC_FILTER, qos: 1 }]);
  });

  it('routes a message to the instrument named in the topic', async () => {
    publish(`instruments/${PLAIN_CODE}/telemetry`, { mqtttemp: 21.5 });
    await waitFor(async () => (await latestKeys(plainId)).some((r) => r.key === 'mqtttemp'));
  });

  it('records transport "mqtt" on a dead-letter', async () => {
    publish(`instruments/${PLAIN_CODE}/telemetry`, '{not json');
    const row = await waitFor(async () =>
      (await prisma.deadLetter.findMany({
        where: { instrumentId: plainId }, orderBy: { receivedAt: 'desc' }, take: 1,
      }))[0] ?? null);
    expect(row.transport).toBe('mqtt');
    expect(row.reason).toContain('Invalid JSON');
  });

  it('keeps working after a bad message — one device must not stall the shared subscription', async () => {
    publish(`instruments/${PLAIN_CODE}/telemetry`, { mqttafterbad: 1 });
    await waitFor(async () => (await latestKeys(plainId)).some((r) => r.key === 'mqttafterbad'));
  });

  it('fans a gateway batch out to its children', async () => {
    publish(`instruments/${GW_CODE}/telemetry`, { devices: { [CHILD_CODE]: { pressure: 4 } } });
    await waitFor(async () => (await latestKeys(childId)).some((r) => r.key === 'pressure'));
    const row = await prisma.instrument.findUnique({ where: { id: childId } });
    expect(row?.lastSeenVia).toBe('gateway');
  });

  it('drops a message whose payload exceeds the byte cap, BEFORE parsing it', async () => {
    // Otherwise perfect: valid JSON, a resolvable code, a well-formed topic —
    // over-cap ONLY by padding. If the cap were deleted this payload would be
    // ingested happily, which is what makes the assertion below meaningful.
    publish(`instruments/${PLAIN_CODE}/telemetry`, { overcapkey: 1, pad: 'x'.repeat(8000) });
    await sleep(400);
    expect((await latestKeys(plainId)).some((r) => r.key === 'overcapkey')).toBe(false);
    expect(logs.some((l) => l.msg.includes('byte cap'))).toBe(true);
  });

  it('drops a message on a topic that does not match the pattern', async () => {
    const before = await prisma.deadLetter.count();
    publish(`instruments/${PLAIN_CODE}/attributes`, { wrongtopickey: 1 });
    publish(`instruments/${PLAIN_CODE}/telemetry/extra`, { wrongtopickey2: 1 });
    await sleep(300);
    const keys = await latestKeys(plainId);
    expect(keys.some((r) => r.key.startsWith('wrongtopickey'))).toBe(false);
    // Nothing invented to hang a record on, so nothing recorded either.
    expect(await prisma.deadLetter.count()).toBe(before);
  });

  it('drops a message for a code that resolves to no ACTIVE instrument', async () => {
    const before = await prisma.deadLetter.count();
    publish(`instruments/NO-SUCH-${S}/telemetry`, { ghostkey: 1 });
    publish(`instruments/${OFF_CODE}/telemetry`, { ghostkey: 1 });
    await sleep(300);
    // Never auto-created from a payload, on any transport.
    expect(await prisma.instrument.findUnique({ where: { code: `NO-SUCH-${S}` } })).toBeNull();
    expect(await prisma.deadLetter.count()).toBe(before);
    expect(logs.some((l) => l.msg.includes('no active instrument'))).toBe(true);
    // Asserted separately from the log line: a DEACTIVATED instrument exists and
    // resolves by code, so only the isActive half of the lookup stops its
    // reading being written. Without this the whole test passes on the
    // unknown-code half alone.
    expect(await latestKeys(offId)).toEqual([]);
  });

  it('logs loudly when the connection drops — a silent dead bridge is the worst failure', async () => {
    logs.length = 0;
    lastClient.emit('offline');
    lastClient.emit('reconnect');
    expect(logs.some((l) => l.msg.includes('OFFLINE'))).toBe(true);
    expect(logs.some((l) => l.msg.includes('reconnecting'))).toBe(true);
    // Backoff, not a hot loop.
    expect(lastClient.options.reconnectPeriod).toBeGreaterThan(1000);
  });
});
