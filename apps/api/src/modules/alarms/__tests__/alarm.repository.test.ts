import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import {
  loadThresholdCache, loadOpenAlarms, raiseAlarm, rebreachAlarm, resolveAlarm, touchLiveness,
  alarmKey,
} from '../alarm.repository.js';

const TAG = `p3repo-${Date.now()}`;
let instrumentId = '';
let thresholdId = '';
let communicationProfileId = '';

beforeAll(async () => {
  const node = await prisma.hierarchyNode.create({
    data: { level: 'COMPANY', name: TAG, slug: TAG },
  });
  // `instruments_reachable_chk` requires gateway_id OR communication_profile_id
  // to be non-null (an instrument must be reachable some way) — the brief's
  // fixture set both to null, which the DB rejects. Scratch profile, cleaned
  // up in afterAll alongside everything else.
  const profile = await prisma.communicationProfile.create({
    data: { name: TAG, protocolKey: 'mqtt', config: {} },
  });
  communicationProfileId = profile.id;
  const inst = await prisma.instrument.create({
    data: {
      name: TAG, code: TAG, slug: TAG, instrumentType: 'sensor',
      hierarchyNodeId: node.id, communicationProfileId: profile.id, gatewayId: null,
    },
  });
  instrumentId = inst.id;
  const t = await prisma.alarmThreshold.create({
    data: { instrumentId, key: 'temp', operator: 'GT', limit: 100, severity: 'MAJOR' },
  });
  thresholdId = t.id;
});

afterAll(async () => {
  await prisma.instrumentLiveness.deleteMany({ where: { instrumentId } });
  await prisma.alarm.deleteMany({ where: { instrumentId } });
  await prisma.alarmThreshold.deleteMany({ where: { instrumentId } });
  const inst = await prisma.instrument.findUnique({ where: { id: instrumentId } });
  await prisma.instrument.delete({ where: { id: instrumentId } });
  if (inst) await prisma.hierarchyNode.delete({ where: { id: inst.hierarchyNodeId } });
  await prisma.communicationProfile.delete({ where: { id: communicationProfileId } });
});

describe('threshold cache', () => {
  it('keys thresholds by instrument and key', async () => {
    const cache = await loadThresholdCache();
    const specs = cache.get(`${instrumentId}|temp`);
    expect(specs?.[0]).toMatchObject({ id: thresholdId, operator: 'GT', limit: 100 });
  });

  it('carries the instrument NAME, which notifications render', async () => {
    // Against the real database, so a broken join is caught here. The service
    // test mocks loadThresholdCache and therefore cannot prove this: it would
    // keep passing while every alarm email showed a blank instrument.
    const cache = await loadThresholdCache();
    const specs = cache.get(`${instrumentId}|temp`);
    expect(specs?.[0].instrumentName).toBe(TAG);
  });
});

describe('raise / rebreach / resolve', () => {
  it('raises once and refuses a concurrent duplicate', async () => {
    const ts = new Date();
    const first = await raiseAlarm({ instrumentId, key: 'temp', thresholdId, severity: 'MAJOR', value: 101, ts });
    expect(first).not.toBeNull();

    // The partial unique index is the real guard. A second raise for the same
    // open series must return null, not throw and not create a second row.
    const second = await raiseAlarm({ instrumentId, key: 'temp', thresholdId, severity: 'MAJOR', value: 102, ts });
    expect(second).toBeNull();

    const rows = await prisma.alarm.findMany({ where: { instrumentId, key: 'temp' } });
    expect(rows).toHaveLength(1);
  });

  it('rebreach bumps the counter and tracks the peak', async () => {
    const openBefore = (await loadOpenAlarms()).get(alarmKey(instrumentId, 'temp', thresholdId))!;
    await rebreachAlarm(openBefore.id, 150, new Date(), false);
    const row = await prisma.alarm.findUnique({ where: { id: openBefore.id } });
    expect(row?.breachCount).toBe(2);
    expect(row?.peakValue).toBe(150);
  });

  it('rebreach with backToActive returns a resolved alarm to ACTIVE', async () => {
    const open = (await loadOpenAlarms()).get(alarmKey(instrumentId, 'temp', thresholdId))!;
    await resolveAlarm(open.id, new Date(), false);
    expect((await prisma.alarm.findUnique({ where: { id: open.id } }))?.state).toBe('RESOLVED_UNACKED');
    await rebreachAlarm(open.id, 160, new Date(), true);
    expect((await prisma.alarm.findUnique({ where: { id: open.id } }))?.state).toBe('ACTIVE');
  });

  it('loadOpenAlarms excludes CLOSED rows', async () => {
    const open = (await loadOpenAlarms()).get(alarmKey(instrumentId, 'temp', thresholdId))!;
    await prisma.alarm.update({ where: { id: open.id }, data: { state: 'CLOSED', closedAt: new Date() } });
    expect((await loadOpenAlarms()).get(alarmKey(instrumentId, 'temp', thresholdId))).toBeUndefined();
  });
});

describe('touchLiveness', () => {
  it('creates a row on first sight and updates it thereafter', async () => {
    const t1 = new Date('2026-08-03T09:00:00.000Z');
    await touchLiveness([instrumentId], t1);
    expect((await prisma.instrumentLiveness.findUnique({ where: { instrumentId } }))?.lastSeenAt)
      .toEqual(t1);

    const t2 = new Date('2026-08-03T09:05:00.000Z');
    await touchLiveness([instrumentId], t2);
    expect((await prisma.instrumentLiveness.findUnique({ where: { instrumentId } }))?.lastSeenAt)
      .toEqual(t2);
  });

  it('recovers an OFFLINE instrument to ONLINE and closes its offline alarm', async () => {
    const offlineAlarm = await prisma.alarm.create({
      data: {
        instrumentId, key: '__liveness__', thresholdId: null,
        severity: 'MAJOR', state: 'ACTIVE',
        firstBreachAt: new Date('2026-08-03T08:00:00.000Z'),
        lastBreachAt: new Date('2026-08-03T08:00:00.000Z'),
        breachCount: 1,
      },
      select: { id: true },
    });
    await prisma.instrumentLiveness.update({
      where: { instrumentId },
      data: { state: 'OFFLINE', stateChangedAt: new Date('2026-08-03T08:00:00.000Z'), offlineAlarmId: offlineAlarm.id },
    });

    const recoveredAt = new Date('2026-08-03T09:10:00.000Z');
    await touchLiveness([instrumentId], recoveredAt);

    const liveness = await prisma.instrumentLiveness.findUnique({ where: { instrumentId } });
    expect(liveness?.state).toBe('ONLINE');
    expect(liveness?.offlineAlarmId).toBeNull();

    const alarm = await prisma.alarm.findUnique({ where: { id: offlineAlarm.id } });
    expect(alarm?.state).toBe('CLOSED');
    expect(alarm?.closedAt).toEqual(recoveredAt);
  });
});
