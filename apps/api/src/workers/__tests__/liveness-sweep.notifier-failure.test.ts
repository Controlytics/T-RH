/**
 * The notifier is the least trustworthy thing the sweep touches — it does
 * network I/O to email/SMS/Telegram/Slack. This file exists SEPARATELY from
 * `liveness-sweep.worker.test.ts` because `vi.mock` is hoisted to the top of a
 * file and applies to every test in it; a rejecting dispatcher stub belongs in
 * its own file rather than perturbing the five behavioural tests next door.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import { sweepLiveness } from '../liveness-sweep.worker.js';

// Rejects on EVERY call. The failure mode under test is a notifier that is
// broken outright (SMTP down, bad credentials) — not a one-off blip — because
// that is the case that starves an entire sweep tick. `vi.mock` is hoisted
// above the imports above, so the worker binds this stub, not the real module.
vi.mock('../../modules/notification-delivery/notification-dispatcher.js', () => ({
  dispatchNotification: vi.fn(async () => {
    throw new Error('notifier is down');
  }),
}));

const TAG = `p3notif-${Date.now()}`;
let firstId = '';
let laterId = '';
let nodeId = '';
let communicationProfileId = '';

beforeAll(async () => {
  const node = await prisma.hierarchyNode.create({ data: { level: 'COMPANY', name: TAG, slug: TAG } });
  nodeId = node.id;
  // `instruments_reachable_chk` requires gateway_id OR communication_profile_id.
  const profile = await prisma.communicationProfile.create({
    data: { name: TAG, protocolKey: 'mqtt', config: {} },
  });
  communicationProfileId = profile.id;
  const a = await prisma.instrument.create({
    data: {
      name: `${TAG}-a`, code: `${TAG}-a`, slug: `${TAG}-a`, instrumentType: 'sensor',
      hierarchyNodeId: nodeId, communicationProfileId: profile.id, expectedIntervalSec: 60,
    },
  });
  firstId = a.id;
  const b = await prisma.instrument.create({
    data: {
      name: `${TAG}-b`, code: `${TAG}-b`, slug: `${TAG}-b`, instrumentType: 'sensor',
      hierarchyNodeId: nodeId, communicationProfileId: profile.id, expectedIntervalSec: 60,
    },
  });
  laterId = b.id;
});

afterAll(async () => {
  await prisma.instrumentLiveness.deleteMany({ where: { instrumentId: { in: [firstId, laterId] } } });
  // alarms.instrument_id is onDelete: Restrict — alarms must go first.
  await prisma.alarm.deleteMany({ where: { instrumentId: { in: [firstId, laterId] } } });
  await prisma.instrument.delete({ where: { id: firstId } });
  await prisma.instrument.delete({ where: { id: laterId } });
  await prisma.hierarchyNode.delete({ where: { id: nodeId } });
  await prisma.communicationProfile.delete({ where: { id: communicationProfileId } });
});

beforeEach(async () => {
  await prisma.instrumentLiveness.deleteMany({ where: { instrumentId: { in: [firstId, laterId] } } });
  await prisma.alarm.deleteMany({ where: { instrumentId: { in: [firstId, laterId] } } });
});

const NOW = new Date('2026-08-03T12:00:00.000Z');
const minutesBefore = (n: number) => new Date(NOW.getTime() - n * 60_000);

describe('sweepLiveness with a broken notifier', () => {
  it('still marks a LATER instrument offline after an earlier one fails to notify', async () => {
    // Both overdue (60s interval x2 grace = 120s). `firstId` is the more stale,
    // so `ORDER BY last_seen_at ASC` guarantees it is processed FIRST and its
    // notifier rejection is what would abort the loop.
    await prisma.instrumentLiveness.create({
      data: { instrumentId: firstId, lastSeenAt: minutesBefore(30), state: 'ONLINE' },
    });
    await prisma.instrumentLiveness.create({
      data: { instrumentId: laterId, lastSeenAt: minutesBefore(10), state: 'ONLINE' },
    });

    // Asserted on DB state rather than only on the return value: BEFORE the fix
    // the bare `await dispatchNotification(...)` makes sweepLiveness REJECT, so
    // there is no return value to inspect at all. Catching here keeps the
    // meaningful assertion — did the later instrument get its detection? —
    // reachable in both the broken and the fixed world.
    let threw: Error | null = null;
    try {
      await sweepLiveness(NOW);
    } catch (err) {
      threw = err as Error;
    }

    // The fix: a rejecting notifier is not the sweep's problem to propagate.
    expect(threw).toBeNull();

    // THE ACTUAL DAMAGE: the later instrument must still be OFFLINE + alarmed.
    const later = await prisma.instrumentLiveness.findUnique({ where: { instrumentId: laterId } });
    expect(later?.state).toBe('OFFLINE');
    expect(later?.offlineAlarmId).toBeTruthy();
    expect(await prisma.alarm.count({ where: { instrumentId: laterId, key: '__liveness__' } })).toBe(1);

    // And the first instrument — whose notification failed — is still fully
    // recorded. The regulated record does not depend on the notifier.
    const first = await prisma.instrumentLiveness.findUnique({ where: { instrumentId: firstId } });
    expect(first?.state).toBe('OFFLINE');
    expect(await prisma.auditTrail.count({
      where: { action: 'DEVICE_WENT_OFFLINE', targetId: firstId },
    })).toBe(1);
  });
});
