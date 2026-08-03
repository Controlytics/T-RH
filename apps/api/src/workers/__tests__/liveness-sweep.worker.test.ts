import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import { sweepLiveness } from '../liveness-sweep.worker.js';

const TAG = `p3sweep-${Date.now()}`;
let instrumentId = '';
let instrumentBId = '';
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
  // Second scratch instrument for the concurrent-race test — proves a later
  // row in the same sweep batch is unaffected by an earlier row's unique
  // violation.
  const instB = await prisma.instrument.create({
    data: {
      name: `${TAG}-b`, code: `${TAG}-b`, slug: `${TAG}-b`, instrumentType: 'sensor',
      hierarchyNodeId: nodeId, communicationProfileId: profile.id, expectedIntervalSec: 60,
    },
  });
  instrumentBId = instB.id;
});

afterAll(async () => {
  await prisma.instrumentLiveness.deleteMany({ where: { instrumentId: { in: [instrumentId, instrumentBId] } } });
  await prisma.alarm.deleteMany({ where: { instrumentId: { in: [instrumentId, instrumentBId] } } });
  await prisma.instrument.delete({ where: { id: instrumentId } });
  await prisma.instrument.delete({ where: { id: instrumentBId } });
  await prisma.hierarchyNode.delete({ where: { id: nodeId } });
  await prisma.communicationProfile.delete({ where: { id: communicationProfileId } });
});

beforeEach(async () => {
  await prisma.instrumentLiveness.deleteMany({ where: { instrumentId: { in: [instrumentId, instrumentBId] } } });
  await prisma.alarm.deleteMany({ where: { instrumentId: { in: [instrumentId, instrumentBId] } } });
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

  it('survives a concurrent unique-violation race: a later instrument in the batch still gets its offline alarm', async () => {
    // Simulate a concurrent sweep that already WON the alarms_one_open_liveness_key
    // race for `instrumentId` — its alarm row exists, exactly what the other
    // process's raiseAlarm() would have inserted — but instrument_liveness has
    // not been flipped to OFFLINE yet (the worst-case interleaving: our sweep
    // still sees this row as a live candidate).
    await prisma.instrumentLiveness.create({
      data: { instrumentId, lastSeenAt: minutesBefore(20), state: 'ONLINE' },
    });
    const winnerAlarm = await prisma.alarm.create({
      data: {
        instrumentId, key: '__liveness__', thresholdId: null,
        severity: 'MAJOR', state: 'ACTIVE',
        firstBreachAt: minutesBefore(20), lastBreachAt: minutesBefore(20), breachCount: 1,
      },
      select: { id: true },
    });

    // A second, unraced instrument — also overdue, but sorts AFTER `instrumentId`
    // (less stale, so later in the `last_seen_at ASC` sweep order). This is the
    // row that must not be collateral damage from the first row's P2002.
    await prisma.instrumentLiveness.create({
      data: { instrumentId: instrumentBId, lastSeenAt: minutesBefore(10), state: 'ONLINE' },
    });

    // Baseline BEFORE the sweep: instrumentId is reused across earlier `it`
    // blocks in this file (created once in beforeAll), so it may already carry
    // DEVICE_WENT_OFFLINE rows from prior tests — assert no NEW one is added,
    // not an absolute zero.
    const auditBefore = await prisma.auditTrail.count({
      where: { action: 'DEVICE_WENT_OFFLINE', targetId: instrumentId },
    });

    const res = await sweepLiveness(NOW);

    // The raced instrument is quietly skipped: not crashed on, not marked
    // OFFLINE pointing at a phantom/duplicate alarm, no NEW audit row of its own.
    expect(res.wentOffline).not.toContain(instrumentId);
    const raced = await prisma.instrumentLiveness.findUnique({ where: { instrumentId } });
    expect(raced?.state).toBe('ONLINE');
    expect(raced?.offlineAlarmId).toBeNull();
    expect(await prisma.auditTrail.count({
      where: { action: 'DEVICE_WENT_OFFLINE', targetId: instrumentId },
    })).toBe(auditBefore);

    // THE ACTUAL DAMAGE BEING PREVENTED: the LATER instrument in the same
    // batch must still be processed, not silently dropped because an earlier
    // row's insert threw.
    expect(res.wentOffline).toContain(instrumentBId);
    const later = await prisma.instrumentLiveness.findUnique({ where: { instrumentId: instrumentBId } });
    expect(later?.state).toBe('OFFLINE');
    expect(later?.offlineAlarmId).toBeTruthy();

    await prisma.alarm.delete({ where: { id: winnerAlarm.id } });
  });
});
