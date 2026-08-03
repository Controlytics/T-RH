import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import { sweepLiveness } from '../liveness-sweep.worker.js';

const TAG = `p3sweep-${Date.now()}`;
let instrumentId = '';
let nodeId = '';
let communicationProfileId = '';

beforeAll(async () => {
  const node = await prisma.hierarchyNode.create({ data: { level: 'COMPANY', name: TAG, slug: TAG } });
  nodeId = node.id;
  // `instruments_reachable_chk` requires gateway_id OR communication_profile_id
  // to be non-null. An instrument with no gateway must carry its own profile.
  const profile = await prisma.communicationProfile.create({
    data: { name: TAG, protocolKey: 'mqtt', config: {} },
  });
  communicationProfileId = profile.id;
  const inst = await prisma.instrument.create({
    data: {
      name: TAG, code: TAG, slug: TAG, instrumentType: 'sensor',
      hierarchyNodeId: nodeId, communicationProfileId: profile.id, expectedIntervalSec: 60,
    },
  });
  instrumentId = inst.id;
});

afterAll(async () => {
  await prisma.instrumentLiveness.deleteMany({ where: { instrumentId } });
  await prisma.alarm.deleteMany({ where: { instrumentId } });
  await prisma.instrument.delete({ where: { id: instrumentId } });
  await prisma.hierarchyNode.delete({ where: { id: nodeId } });
  await prisma.communicationProfile.delete({ where: { id: communicationProfileId } });
});

beforeEach(async () => {
  await prisma.instrumentLiveness.deleteMany({ where: { instrumentId } });
  await prisma.alarm.deleteMany({ where: { instrumentId } });
});

const NOW = new Date('2026-08-03T12:00:00.000Z');
const minutesBefore = (n: number) => new Date(NOW.getTime() - n * 60_000);

describe('sweepLiveness', () => {
  it('marks an instrument offline past the grace window', async () => {
    // 60s interval x2 grace = 120s. Last seen 10 minutes ago is well past.
    await prisma.instrumentLiveness.create({
      data: { instrumentId, lastSeenAt: minutesBefore(10), state: 'ONLINE' },
    });
    const res = await sweepLiveness(NOW);
    expect(res.wentOffline).toContain(instrumentId);
    const row = await prisma.instrumentLiveness.findUnique({ where: { instrumentId } });
    expect(row?.state).toBe('OFFLINE');
    expect(row?.offlineAlarmId).toBeTruthy();
  });

  it('does NOT re-fire on a second sweep', async () => {
    // The whole reason liveness state is persisted. Without it a device dark
    // for a week produces one signed-ack-required excursion every 5 minutes,
    // forever. NotificationRule.cooldownMinutes cannot help — it is an
    // in-memory Map wiped on every restart.
    await prisma.instrumentLiveness.create({
      data: { instrumentId, lastSeenAt: minutesBefore(10), state: 'ONLINE' },
    });
    await sweepLiveness(NOW);
    const second = await sweepLiveness(new Date(NOW.getTime() + 5 * 60_000));
    expect(second.wentOffline).not.toContain(instrumentId);
    expect(await prisma.alarm.count({ where: { instrumentId } })).toBe(1);
  });

  it('leaves an instrument inside the grace window alone', async () => {
    await prisma.instrumentLiveness.create({
      data: { instrumentId, lastSeenAt: minutesBefore(1), state: 'ONLINE' },
    });
    const res = await sweepLiveness(NOW);
    expect(res.wentOffline).not.toContain(instrumentId);
  });

  it('ignores instruments with no expectedIntervalSec', async () => {
    await prisma.instrument.update({ where: { id: instrumentId }, data: { expectedIntervalSec: null } });
    await prisma.instrumentLiveness.create({
      data: { instrumentId, lastSeenAt: minutesBefore(600), state: 'ONLINE' },
    });
    const res = await sweepLiveness(NOW);
    expect(res.wentOffline).not.toContain(instrumentId);
    await prisma.instrument.update({ where: { id: instrumentId }, data: { expectedIntervalSec: 60 } });
  });
});
