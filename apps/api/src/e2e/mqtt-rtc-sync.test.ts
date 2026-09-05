import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { setDownlinkPublisher } from '../modules/instruments/attribute-downlink.js';

/**
 * RTC sync over the real bridge (2026-09-05): a device publishes
 * `{"method":"getTime"}` on its request topic and the platform answers on the
 * GLOBAL time topic. Same fake wire as `mqtt-ingest.test.ts`.
 */
class FakeClient extends EventEmitter {
  subscriptions: { topic: string; qos: number }[] = [];
  options: { reconnectPeriod: number } = { reconnectPeriod: 1000 };
  subscribe(topic: string, opts: { qos: number }, cb?: (err: Error | null) => void) { this.subscriptions.push({ topic, qos: opts.qos }); cb?.(null); return this; }
  publish(_t: string, _p: string, _o: unknown, cb?: (err?: Error) => void) { cb?.(); return this; }
  end(_force?: boolean, _opts?: unknown, cb?: () => void) { cb?.(); return this; }
}
let lastClient: FakeClient;
vi.mock('mqtt', () => ({
  default: { connect: () => { lastClient = new FakeClient(); setTimeout(() => lastClient.emit('connect'), 0); return lastClient; } },
}));
const { startMqttBridge } = await import('../modules/instruments/listeners/mqtt-bridge.js');

const S = Date.now();
const GW = `RTC-${S}`;
const ids: string[] = [];
let bridge: { close(): Promise<void> };
const logs: Array<{ msg: string }> = [];
let sent: { topic: string; payload: string; retain: boolean }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > deadline) throw new Error('waitFor timed out'); await sleep(50); }
}
const publish = (topic: string, body: string) => lastClient.emit('message', topic, Buffer.from(body));

beforeAll(async () => {
  const inst = await prisma.instrument.create({ data: { name: GW, code: GW, isGateway: true, profileId: await fixtureProfileId('fixture:mqtt-rtc-sync') } });
  ids.push(inst.id);
  setDownlinkPublisher(async (topic, payload, options) => { sent.push({ topic, payload, retain: options.retain }); });
  bridge = await startMqttBridge('mqtt://127.0.0.1:1883', { maxMessageBytes: 4096, log: (msg) => { logs.push({ msg }); } });
});
afterAll(async () => {
  setDownlinkPublisher(null);
  await bridge?.close();
  await prisma.instrument.deleteMany({ where: { id: { in: ids } } });
});
beforeEach(() => { sent = []; logs.length = 0; });

describe('RTC sync', () => {
  it('answers {"method":"getTime"} with {"unix":<epoch-ms>} on the global topic, not retained', async () => {
    const before = Date.now();
    publish(`instruments/${GW}/rtc-request`, '{"method":"getTime"}');
    const msg = await waitFor(() => sent.find((s) => s.topic === 'digilog/rtc/time'));
    expect(msg.retain).toBe(false);
    // Exactly one key, `unix`, a 13-digit NUMBER of milliseconds (operator,
    // 2026-09-05: '{"unix":1792221233122}'). No method, no ISO string, no seconds.
    const body = JSON.parse(msg.payload);
    expect(Object.keys(body)).toEqual(['unix']);
    expect(typeof body.unix).toBe('number');
    expect(String(body.unix)).toMatch(/^\d{13}$/);
    expect(Math.abs(body.unix - before)).toBeLessThan(5000);
  });

  it('the bridge refuses to QUEUE an event while offline, but still queues retained state', async () => {
    // Seen live: a reconnecting bridge flushed two stale minute ticks at once.
    (lastClient as unknown as { connected: boolean }).connected = false;
    const handle = bridge as unknown as { publish(t: string, p: string, o: { qos: 1; retain: boolean }): Promise<void> };
    await expect(handle.publish('digilog/rtc/time', '{}', { qos: 1, retain: false })).rejects.toThrow(/offline/);
    await expect(handle.publish('instruments/X/attributes', '{}', { qos: 1, retain: true })).resolves.toBeUndefined();
    (lastClient as unknown as { connected: boolean }).connected = true;
    await expect(handle.publish('digilog/rtc/time', '{}', { qos: 1, retain: false })).resolves.toBeUndefined();
  });

  it('ignores a different method, and drops an unknown code', async () => {
    publish(`instruments/${GW}/rtc-request`, '{"method":"setTime"}');
    await waitFor(() => logs.some((l) => l.msg.includes('rtc request ignored')));
    expect(sent.find((s) => s.topic === 'digilog/rtc/time')).toBeUndefined();
    publish(`instruments/NOBODY-${S}/rtc-request`, '{"method":"getTime"}');
    await waitFor(() => logs.some((l) => l.msg.includes('rtc request dropped')));
    expect(sent.find((s) => s.topic === 'digilog/rtc/time')).toBeUndefined();
  });
});
