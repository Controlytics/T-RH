import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

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
// The plant's real shape — three levels. `+` could never have matched it.
const SLASH_CODE = `CWH/MQP/${S}`;
const GW_CODE = `MQG-${S}`;
const CHILD_CODE = `MQC-${S}`;
const OFF_CODE = `MQX-${S}`;

const instrumentIds: string[] = [];
let plainId: string;
let slashId: string;
let gwId: string;
let childId: string;
let offId: string;

let bridge: { close(): Promise<void> };
const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];

async function mkInstrument(
  code: string,
  extra: { isGateway?: boolean; gatewayId?: string; isActive?: boolean } = {},
): Promise<string> {
  const inst = await prisma.instrument.create({
    data: { name: code, code, profileId: await fixtureProfileId('fixture:mqtt-ingest'), ...extra },
  });
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
  slashId = await mkInstrument(SLASH_CODE);
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
  it('subscribes to instruments/# at QoS 1 on connect', () => {
    // `#`, not `+`: a code carries slashes, and `+` is exactly one level.
    expect(TELEMETRY_TOPIC_FILTER).toBe('instruments/#');
    expect(lastClient.subscriptions).toEqual([{ topic: TELEMETRY_TOPIC_FILTER, qos: 1 }]);
  });

  it('routes a message to the instrument whose CODE is in the topic', async () => {
    publish(`instruments/${PLAIN_CODE}/telemetry`, { mqtttemp: 21.5 });
    await waitFor(async () => (await latestKeys(plainId)).some((r) => r.key === 'mqtttemp'));
  });

  it('routes a slash-separated code — instruments/CWH/MQP/…/telemetry — to that one instrument', async () => {
    publish(`instruments/${SLASH_CODE}/telemetry`, { slashtemp: 22.5 });
    await waitFor(async () => (await latestKeys(slashId)).some((r) => r.key === 'slashtemp'));
    // And not, by a prefix accident, to anything else.
    expect((await latestKeys(plainId)).some((r) => r.key === 'slashtemp')).toBe(false);
  });

  it('drops a message addressed by the instrument UUID — the pre-2026-09-04 contract', async () => {
    publish(`instruments/${plainId}/telemetry`, { uuidkey: 1 });
    await sleep(300);
    expect((await latestKeys(plainId)).some((r) => r.key === 'uuidkey')).toBe(false);
    expect(logs.some((l) => l.msg.includes('no active instrument') && l.meta?.code === plainId)).toBe(true);
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
    // The `…/attributes` one is the bridge's OWN retained slot echoed back under
    // `instruments/#`, and is dropped SILENTLY — a log line per retained slot
    // per reconnect would bury a real drop. The `…/telemetry/extra` one is a
    // genuine mismatch and IS logged.
    const dropped = logs.filter((l) => l.msg.includes('does not match'));
    expect(dropped.some((l) => l.meta?.topic === `instruments/${PLAIN_CODE}/attributes`)).toBe(false);
    expect(dropped.some((l) => l.meta?.topic === `instruments/${PLAIN_CODE}/telemetry/extra`)).toBe(true);
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
    const reconnecting = logs.filter((l) => l.msg.includes('reconnecting'));
    expect(reconnecting).toHaveLength(1);
    // The period mqtt.js actually retries at, stated truthfully (audit
    // 2026-10-03, INGEST-18). Until then this test asserted that the bridge
    // had DOUBLED `options.reconnectPeriod` — a mutation mqtt.js never reads,
    // so the "backoff" it pinned had never once happened.
    expect(reconnecting[0].meta).toMatchObject({ attempt: 1, periodMs: 1000 });
    expect(lastClient.options.reconnectPeriod).toBe(1000);
    // And the line is throttled, not the attempts: 59 more reconnects, one more line.
    for (let i = 0; i < 59; i++) lastClient.emit('reconnect');
    expect(logs.filter((l) => l.msg.includes('reconnecting'))).toHaveLength(2);
    lastClient.emit('connect');
  });

  /**
   * Audit 2026-10-03, INGEST-7: the bridge's own retained downlinks come back
   * under `instruments/#` on every reconnect — ~200 on this plant — and used to
   * take a queue slot each, so a reconnect's burst pushed real readings past
   * `maxQueued` and LOST them (the broker had already acked). With a cap of ONE:
   * one reading in flight, one echo, one more reading — the reading must land.
   */
  it('a retained echo takes no queue slot, so it cannot push a real reading past the cap', async () => {
    const main = lastClient;
    const tight: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const bridge2 = await startMqttBridge('mqtt://127.0.0.1:1883', {
      maxQueued: 1,
      log: (msg, meta) => { tight.push({ msg, meta }); },
    });
    const client2 = lastClient;
    try {
      const msg = (topic: string, body: unknown) => client2.emit('message', topic, Buffer.from(JSON.stringify(body)));
      msg(`instruments/${PLAIN_CODE}/telemetry`, { echofirst: 1 });   // in flight
      msg(`instruments/${PLAIN_CODE}/attributes`, { stale: 'slot' });  // the bridge's own echo
      msg(`instruments/${GW_CODE}/children`, { children: [] });        // and another
      msg(`instruments/${PLAIN_CODE}/telemetry`, { echosecond: 1 });  // must take the one slot
      await waitFor(async () => (await latestKeys(plainId)).some((r) => r.key === 'echosecond'));
      expect(tight.some((l) => l.msg.includes('LOST'))).toBe(false);
    } finally {
      await bridge2.close();
      lastClient = main;
    }
  });
});
