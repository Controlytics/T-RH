import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import { enqueue, flushNow, getQueueStats, resetQueueForTest } from '../ingestion.service.js';
import { getLatest } from '../telemetry.repository.js';
import type { InboundMessage } from '../adapters/protocol-adapter.js';

const buf = (o: unknown) => Buffer.from(JSON.stringify(o));

// Derived by buildBaseTopic: prefix '' + ancestry ['ingtest'] + gateway 'ing-gw'.
const BASE = 'ingtest/ing-gw';

let hierarchyId = '', gatewayId = '', instA = '', instB = '';

/** Only topic/payload vary per test; the anchors come from the subscription. */
const msg = (topic: string, payload: Buffer, over: Partial<InboundMessage> = {}): InboundMessage => ({
  protocolKey: 'mqtt', profileId: 'p', topic, payload, receivedAt: new Date(),
  gatewaySlug: 'ing-gw', gatewayId, baseTopic: BASE, ...over,
});

beforeEach(async () => {
  resetQueueForTest();
  await prisma.$executeRawUnsafe(`DELETE FROM dead_letters WHERE topic LIKE 'ingtest/%'`);

  // Root nodes cannot use ON CONFLICT (parent_id, slug): Postgres treats NULLs as
  // distinct, so the clause never fires and every run would add another node.
  const found = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM hierarchy_nodes WHERE slug = 'ingtest' AND parent_id IS NULL LIMIT 1`;
  if (found.length > 0) {
    hierarchyId = found[0].id;
  } else {
    const created = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO hierarchy_nodes
        (id, parent_id, level, name, slug, path, sort_order, is_active, created_at, updated_at)
      VALUES (gen_random_uuid(), NULL, 'COMPANY'::"HierarchyLevel", 'IngTest', 'ingtest',
              'ingtest'::ltree, 0, true, now(), now())
      RETURNING id`;
    hierarchyId = created[0].id;
  }

  const prof = await prisma.communicationProfile.upsert({
    where: { name: 'ing-profile' }, update: {},
    create: { name: 'ing-profile', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://x' } },
  });
  const gw = await prisma.gateway.upsert({
    where: { code: 'INGGW' }, update: {},
    create: {
      name: 'Ing GW', code: 'INGGW', slug: 'ing-gw', gatewayType: 'edge', externalId: 'ing-gw',
      hierarchyNodeId: hierarchyId, communicationProfileId: prof.id,
    },
  });
  gatewayId = gw.id;
  const a = await prisma.instrument.upsert({
    where: { code: 'INGA' }, update: {},
    create: {
      name: 'Ing A', code: 'INGA', slug: 'ing-a', instrumentType: 'sensor',
      hierarchyNodeId: hierarchyId, gatewayId, deviceKey: 'inga',
    },
  });
  const b = await prisma.instrument.upsert({
    where: { code: 'INGB' }, update: {},
    create: {
      name: 'Ing B', code: 'INGB', slug: 'ing-b', instrumentType: 'sensor',
      hierarchyNodeId: hierarchyId, gatewayId, deviceKey: 'ingb',
    },
  });
  instA = a.id; instB = b.id;

  await prisma.$executeRawUnsafe(
    `DELETE FROM instrument_telemetry_latest WHERE instrument_id IN ('${instA}','${instB}')`);
  await prisma.$executeRawUnsafe(
    `DELETE FROM instrument_telemetry_history WHERE instrument_id IN ('${instA}','${instB}')`);
});
afterEach(async () => { resetQueueForTest(); });

describe('ingestion service', () => {
  it('lands a topic-addressed message as telemetry', async () => {
    await enqueue(msg(`${BASE}/ing-a/telemetry`, buf({ temp: 21.5 })));
    await flushNow();
    const latest = await getLatest(instA);
    expect(latest.find(r => r.key === 'temp')?.value).toBe(21.5);
  });

  it('splits a batch across two instruments', async () => {
    await enqueue(msg(`${BASE}/telemetry`, buf({ devices: { inga: { t: 1 }, ingb: { t: 2 } } })));
    await flushNow();
    expect((await getLatest(instA)).find(r => r.key === 't')?.value).toBe(1);
    expect((await getLatest(instB)).find(r => r.key === 't')?.value).toBe(2);
  });

  it('dead-letters one unknown key while still writing the good one', async () => {
    await enqueue(msg(`${BASE}/telemetry`, buf({ devices: { inga: { t: 5 }, ghost: { t: 9 } } })));
    await flushNow();
    expect((await getLatest(instA)).find(r => r.key === 't')?.value).toBe(5);
    const dl = await prisma.deadLetter.findMany({
      where: { reason: 'UNKNOWN_DEVICE_KEY', topic: { startsWith: 'ingtest/' } },
    });
    expect(dl.length).toBeGreaterThanOrEqual(1);
  });

  it('dead-letters an unroutable topic', async () => {
    await enqueue(msg('ingtest/nonsense', buf({ t: 1 })));
    await flushNow();
    const dl = await prisma.deadLetter.findFirst({
      where: { reason: 'UNROUTABLE_TOPIC', topic: 'ingtest/nonsense' },
    });
    expect(dl).not.toBeNull();
  });

  it('dead-letters a message that matched no subscription (empty anchors)', async () => {
    await enqueue(msg('ingtest/elsewhere/x/telemetry', buf({ t: 1 }), {
      gatewaySlug: '', gatewayId: '', baseTopic: '',
    }));
    await flushNow();
    const dl = await prisma.deadLetter.findFirst({
      where: { reason: 'UNROUTABLE_TOPIC', topic: 'ingtest/elsewhere/x/telemetry' },
    });
    expect(dl).not.toBeNull();
  });

  it('dead-letters a non-telemetry category rather than storing it', async () => {
    await enqueue(msg(`${BASE}/ing-a/alarm`, buf({ code: 'HIGH' })));
    await flushNow();
    const dl = await prisma.deadLetter.findFirst({
      where: { reason: 'UNSUPPORTED_CATEGORY', topic: `${BASE}/ing-a/alarm` },
    });
    expect(dl).not.toBeNull();
    expect((await getLatest(instA)).find(r => r.key === 'code')).toBeUndefined();
  });

  it('dead-letters on queue overflow rather than silently dropping', async () => {
    resetQueueForTest(2);   // tiny queue
    for (let i = 0; i < 5; i++) {
      await enqueue(msg(`${BASE}/ing-a/telemetry`, buf({ t: i })));
    }
    expect(getQueueStats().dropped).toBeGreaterThan(0);
    await flushNow();
    const dl = await prisma.deadLetter.findFirst({ where: { reason: 'QUEUE_OVERFLOW' } });
    expect(dl).not.toBeNull();
  });

  it('reports queue depth and flushed count', async () => {
    await enqueue(msg(`${BASE}/ing-a/telemetry`, buf({ t: 1 })));
    expect(getQueueStats().depth).toBe(1);
    await flushNow();
    expect(getQueueStats().depth).toBe(0);
    expect(getQueueStats().flushed).toBeGreaterThan(0);
  });
});
