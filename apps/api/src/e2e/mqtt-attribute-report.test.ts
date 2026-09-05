import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { setDownlinkPublisher } from '../modules/instruments/attribute-downlink.js';

/**
 * The device → platform ATTRIBUTE path (2026-09-05): a device publishes
 * `instruments/<code>/attributes/report`, the bridge writes the attributes,
 * audits each as `INSTRUMENT_ATTRIBUTE_REPORTED`, and republishes the
 * downlink slots. Same fake wire as `mqtt-ingest.test.ts`; the core and the
 * database are real.
 */

class FakeClient extends EventEmitter {
  subscriptions: { topic: string; qos: number }[] = [];
  subscribe(topic: string, opts: { qos: number }, cb?: (err: Error | null) => void) {
    this.subscriptions.push({ topic, qos: opts.qos }); cb?.(null); return this;
  }
  publish(_t: string, _p: string, _o: unknown, cb?: (err?: Error) => void) { cb?.(); return this; }
  end(_force?: boolean, _opts?: unknown, cb?: () => void) { cb?.(); return this; }
  removeAllListeners() { return super.removeAllListeners(); }
}
let lastClient: FakeClient;
vi.mock('mqtt', () => ({
  default: { connect: () => { lastClient = new FakeClient(); setTimeout(() => lastClient.emit('connect'), 0); return lastClient; } },
}));

const { startMqttBridge, parseAttributeReportTopic } = await import('../modules/instruments/listeners/mqtt-bridge.js');

const S = Date.now();
const GW = `ARG-${S}`;
const CHILD = `ARC-${S}`;
const SOLO = `ARS-${S}`;
const ids: string[] = [];
let gwId: string; let childId: string; let soloId: string;
let bridge: { close(): Promise<void> };
const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
let sent: { topic: string; payload: string }[] = [];
let configBefore: { existed: boolean; value: unknown } = { existed: false, value: null };

async function mk(code: string, extra: Record<string, unknown> = {}) {
  const inst = await prisma.instrument.create({
    data: { name: code, code, profileId: await fixtureProfileId('fixture:mqtt-attribute-report'), ...extra },
  });
  ids.push(inst.id);
  return inst.id;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > deadline) throw new Error('waitFor timed out'); await sleep(50); }
}
const attr = (instrumentId: string, key: string) =>
  prisma.instrumentAttribute.findUnique({ where: { instrumentId_key: { instrumentId, key } } });
const audits = (targetId: string) =>
  prisma.auditTrail.count({ where: { targetId, action: 'INSTRUMENT_ATTRIBUTE_REPORTED' } });
function publish(topic: string, body: unknown) {
  lastClient.emit('message', topic, Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
}
async function setWritable(text: string | null) {
  if (text === null) {
    if (configBefore.existed) {
      await prisma.systemConfig.update({ where: { configKey: 'instrument-attributes' }, data: { configValue: configBefore.value as never } });
    } else {
      await prisma.systemConfig.deleteMany({ where: { configKey: 'instrument-attributes' } });
    }
    return;
  }
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'instrument-attributes' } });
  const value = { ...((row?.configValue as Record<string, unknown>) ?? {}), deviceWritableKeys: text };
  if (row) await prisma.systemConfig.update({ where: { configKey: 'instrument-attributes' }, data: { configValue: value as never } });
  else await prisma.systemConfig.create({ data: { configKey: 'instrument-attributes', configValue: value as never } });
}

beforeAll(async () => {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'instrument-attributes' } });
  configBefore = { existed: !!row, value: row?.configValue ?? null };
  gwId = await mk(GW, { isGateway: true });
  childId = await mk(CHILD, { gatewayId: gwId });
  soloId = await mk(SOLO);
  setDownlinkPublisher(async (topic, payload) => { sent.push({ topic, payload }); });
  bridge = await startMqttBridge('mqtt://127.0.0.1:1883', { maxMessageBytes: 4096, log: (msg, meta) => { logs.push({ msg, meta }); } });
});
afterAll(async () => {
  await setWritable(null);
  setDownlinkPublisher(null);
  await bridge?.close();
  await prisma.deadLetter.deleteMany({ where: { instrumentId: { in: ids } } });
  await prisma.instrument.deleteMany({ where: { gatewayId: { in: ids } } });
  await prisma.instrument.deleteMany({ where: { id: { in: ids } } });
});
beforeEach(() => { sent = []; logs.length = 0; });

describe('parseAttributeReportTopic', () => {
  it('reads the code, slashes included, and nothing else', () => {
    expect(parseAttributeReportTopic('instruments/CWH/RDU/001-00/attributes/report')).toBe('CWH/RDU/001-00');
    expect(parseAttributeReportTopic('instruments/X/attributes')).toBeNull();
    expect(parseAttributeReportTopic('instruments/X/telemetry')).toBeNull();
    expect(parseAttributeReportTopic('instruments/+/attributes/report')).toBeNull();
  });
});

describe('a device reporting attributes', () => {
  it('a gateway writes its CHILD\'s attributes from a devices list, audited against the device, and the slots republish', async () => {
    publish(`instruments/${GW}/attributes/report`, { devices: [{ devN: CHILD, Location: 'HPLC Room', 'High Temperature Limit': 27 }] });
    const row = await waitFor(() => attr(childId, 'Location'));
    expect(row!.value).toBe('HPLC Room');
    expect((await attr(childId, 'High Temperature Limit'))!.value).toBe('27');
    expect(await audits(childId)).toBe(2);
    const a = await prisma.auditTrail.findFirst({ where: { targetId: childId, action: 'INSTRUMENT_ATTRIBUTE_REPORTED' } });
    expect(a!.userId).toBeNull();
    expect((a!.afterValue as Record<string, unknown>).reportedBy).toBe(GW);
    expect(a!.reason).toContain(GW);
    // `devN` is not an attribute.
    expect(await attr(childId, 'devN')).toBeNull();
    // The per-child slot and the bundle were republished.
    await waitFor(async () => sent.some((s) => s.topic === `instruments/${GW}/attributes/${CHILD}`));
    expect(sent.some((s) => s.topic === `instruments/${GW}/children/attributes`)).toBe(true);
  });

  it('a standalone instrument writes its OWN attributes from a flat payload', async () => {
    publish(`instruments/${SOLO}/attributes/report`, { Location: 'Stability', Make: 'Global' });
    const row = await waitFor(() => attr(soloId, 'Make'));
    expect(row!.value).toBe('Global');
    await waitFor(async () => sent.some((s) => s.topic === `instruments/${SOLO}/attributes`));
  });

  it('an UNCHANGED value is neither written nor audited again', async () => {
    const before = await audits(soloId);
    publish(`instruments/${SOLO}/attributes/report`, { Make: 'Global' });
    await sleep(400);
    expect(await audits(soloId)).toBe(before);
  });

  it('a gateway\'s flat message naming a child under devN writes that child', async () => {
    publish(`instruments/${GW}/attributes/report`, { devN: CHILD, Model: 'CR120' });
    const row = await waitFor(() => attr(childId, 'Model'));
    expect(row!.value).toBe('CR120');
    expect(await attr(gwId, 'Model')).toBeNull();
  });

  it('refuses a key outside the administered device-writable list, into the dead-letter log', async () => {
    await setWritable('Location\nMake');
    try {
      publish(`instruments/${SOLO}/attributes/report`, { Location: 'QC 3', 'High Temperature Limit': 99 });
      await waitFor(async () => (await attr(soloId, 'Location'))?.value === 'QC 3');
      expect(await attr(soloId, 'High Temperature Limit')).toBeNull();
      const dl = await waitFor(() => prisma.deadLetter.findFirst({ where: { instrumentId: soloId, reason: { contains: 'not a device-writable' } } }));
      expect(dl!.reason).toContain('High Temperature Limit');
    } finally {
      await setWritable(null);
    }
  });

  it('a non-gateway sending a devices list is refused', async () => {
    publish(`instruments/${SOLO}/attributes/report`, { devices: [{ devN: CHILD, Location: 'nope' }] });
    await waitFor(() => prisma.deadLetter.findFirst({ where: { instrumentId: soloId, reason: { contains: 'not a gateway' } } }));
    expect((await attr(childId, 'Location'))!.value).toBe('HPLC Room');
  });

  it('drops a report for an unknown code, without touching anything', async () => {
    publish(`instruments/NOBODY-${S}/attributes/report`, { Location: 'x' });
    await waitFor(async () => logs.some((l) => l.msg.includes('attribute report dropped')));
  });
});
