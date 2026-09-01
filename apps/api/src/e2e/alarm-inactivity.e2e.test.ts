import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { evaluateAlarms } from '../workers/alarm-evaluation.worker.js';

/**
 * Inactivity alarms, driven through the REAL evaluation pass against the real
 * database — not through `decideInactivity` alone, which is unit-tested next door.
 *
 * What this file exists to catch is the WIRING, and there are two specific
 * failures it is written against:
 *
 *  1. **The clear path.** Inactivity inverts the instrument-limit rule: there, a
 *     missing reading HOLDS an alarm open because absence cannot prove recovery;
 *     here absence IS the alarm and presence is the proof. A pass written by
 *     copying the limit pass's shape inherits its `continue`-on-null and strands
 *     every inactivity alarm ACTIVE for good — which looks like working software
 *     until someone asks why nothing ever clears.
 *  2. **The switch.** It ships OFF, and enabling it raises one alarm per silent
 *     instrument at once. A default that flipped to ON would be discovered in
 *     production as a hundred simultaneous notifications.
 *
 * `alarm-limits` is turned OFF for the duration so the limit pass cannot add
 * alarms this file would then have to explain, and `instrument-activity` is
 * PINNED. That second one is not tidiness: an instrument only becomes "offline"
 * after the activity window, and the grace is measured from `lastSeenAt` — so the
 * effective raise threshold is the LATER of the two. Left unpinned, this file
 * would be testing whatever window the test database happens to carry (1440
 * minutes by default, 3 on the live install) rather than testing the code, and
 * the first version of it silently passed every "does not raise" case for that
 * reason.
 */

const STAMP = Date.now();
const CODE = `INACT-E2E-${STAMP}`;

let instrumentId = '';
const KEY = 'inactivity-alarms';
const LIMITS_KEY = 'alarm-limits';
const ACTIVITY_KEY = 'instrument-activity';
/** Pinned so "offline" means the same thing on every machine this runs on. */
const ACTIVITY_WINDOW_MIN = 3;
let cfgBefore: { value: unknown; existed: boolean } = { value: null, existed: false };
let limitsBefore: { value: unknown; existed: boolean } = { value: null, existed: false };
let activityBefore: { value: unknown; existed: boolean } = { value: null, existed: false };

async function setConfig(key: string, value: Record<string, unknown>) {
  await prisma.systemConfig.upsert({
    where: { configKey: key },
    create: { configKey: key, configValue: value, configType: 'object' },
    update: { configValue: value },
  });
}

/** Move the instrument's last-seen, which is the only input that decides silence. */
async function lastSeen(minutesAgo: number | null) {
  await prisma.instrument.update({
    where: { id: instrumentId },
    data: { lastSeenAt: minutesAgo === null ? null : new Date(Date.now() - minutesAgo * 60_000) },
  });
}

const openAlarm = () => prisma.alarm.findFirst({
  where: { instrumentId, source: 'INACTIVITY', state: 'ACTIVE' },
});

const allAlarms = () => prisma.alarm.findMany({
  where: { instrumentId, source: 'INACTIVITY' },
  orderBy: { raisedAt: 'asc' },
});

beforeAll(async () => {
  const existing = await prisma.systemConfig.findUnique({ where: { configKey: KEY } });
  cfgBefore = { value: existing?.configValue ?? null, existed: Boolean(existing) };
  const limits = await prisma.systemConfig.findUnique({ where: { configKey: LIMITS_KEY } });
  limitsBefore = { value: limits?.configValue ?? null, existed: Boolean(limits) };
  const activity = await prisma.systemConfig.findUnique({ where: { configKey: ACTIVITY_KEY } });
  activityBefore = { value: activity?.configValue ?? null, existed: Boolean(activity) };
  // This suite shares compliance_core_db_test; both restored verbatim in afterAll.
  await setConfig(LIMITS_KEY, { ...(limits?.configValue as object ?? {}), enabled: false });
  await setConfig(ACTIVITY_KEY, { activeWindowMinutes: ACTIVITY_WINDOW_MIN });

  const inst = await prisma.instrument.create({
    data: {
      name: `inactivity ${CODE}`,
      code: CODE,
      profileId: await fixtureProfileId('fixture:alarm-inactivity'),
    },
  });
  instrumentId = inst.id;
});

afterAll(async () => {
  await prisma.alarm.deleteMany({ where: { instrumentId } });
  if (instrumentId) await prisma.instrument.delete({ where: { id: instrumentId } }).catch(() => {});
  for (const [key, before] of [
    [KEY, cfgBefore], [LIMITS_KEY, limitsBefore], [ACTIVITY_KEY, activityBefore],
  ] as const) {
    if (before.existed) {
      await prisma.systemConfig.update({
        where: { configKey: key },
        data: { configValue: before.value as never },
      });
    } else {
      await prisma.systemConfig.deleteMany({ where: { configKey: key } });
    }
  }
});

beforeEach(async () => {
  await prisma.alarm.deleteMany({ where: { instrumentId } });
});

describe('the switch', () => {
  it('raises NOTHING while the feature is off, however long the instrument has been silent', async () => {
    // It ships off. Enabling it raises one alarm per silent instrument at once —
    // on the installation this was written for, 101 in a single pass, each with a
    // notification and a webhook fire.
    await setConfig(KEY, { enabled: false, graceMinutes: 15, severity: 'MAJOR' });
    await lastSeen(600);
    const result = await evaluateAlarms();
    expect(await openAlarm()).toBeNull();
    expect(result.inactivityEvaluated).toBe(0);
  });

  it('treats a config row that has never been written as OFF', async () => {
    // The opposite of `alarm-limits`, which reads `enabled !== false` and ships
    // ON. Failing open here means a plant-wide alarm storm from an unseeded row.
    await prisma.systemConfig.deleteMany({ where: { configKey: KEY } });
    await lastSeen(600);
    await evaluateAlarms();
    expect(await openAlarm()).toBeNull();
  });
});

describe('raising', () => {
  beforeEach(async () => {
    await setConfig(KEY, { enabled: true, graceMinutes: 15, severity: 'MAJOR' });
  });

  it('raises once an instrument has been silent past the grace period', async () => {
    await lastSeen(120);
    const result = await evaluateAlarms();

    const a = await openAlarm();
    expect(a).toBeTruthy();
    expect(a!.source).toBe('INACTIVITY');
    expect(a!.metric).toBe('OFFLINE');
    expect(a!.severity).toBe('MAJOR');
    // No reading. It was raised by the ABSENCE of one, so a number would be an
    // invention.
    expect(a!.triggeredValue).toBeNull();
    expect(a!.limitKind).toBeNull();
    expect(result.inactivityEvaluated).toBeGreaterThan(0);
  });

  it('does not raise inside the grace period', async () => {
    // 5 minutes is OUTSIDE the 3-minute activity window — the instrument already
    // counts as offline — but INSIDE the 15-minute grace. That gap is the whole
    // point of the grace: it is what stops a blip becoming two permanent §11 rows.
    await lastSeen(5);
    await evaluateAlarms();
    expect(await openAlarm()).toBeNull();
  });

  it('raises at the LATER of the activity window and the grace', async () => {
    // The pass needs BOTH `!reporting` and quiet >= grace. With a grace shorter
    // than the window, the window is what decides — so a 1-minute grace does NOT
    // raise at 2 minutes of silence, because nothing is offline yet.
    await setConfig(KEY, { enabled: true, graceMinutes: 1, severity: 'MAJOR' });
    await lastSeen(2);
    await evaluateAlarms();
    expect(await openAlarm()).toBeNull();

    await lastSeen(4);
    await evaluateAlarms();
    expect(await openAlarm()).toBeTruthy();
  });

  it('freezes the thresholds it fired against onto the snapshot', async () => {
    // `activeWindowMinutes` is administered live. An inspector asking why this
    // fired must get the threshold as it stood, not as it stands.
    await lastSeen(120);
    await evaluateAlarms();
    const snap = (await openAlarm())!.ruleSnapshot as Record<string, unknown>;
    expect(snap.kind).toBe('INACTIVITY');
    expect(snap.graceMinutes).toBe(15);
    expect(typeof snap.activeWindowMinutes).toBe('number');
    expect(typeof snap.lastSeenAt).toBe('string');
    expect(snap.description).toContain('15');
  });

  it('raises only ONE alarm however many passes run', async () => {
    await lastSeen(120);
    await evaluateAlarms();
    await evaluateAlarms();
    await evaluateAlarms();
    expect(await allAlarms()).toHaveLength(1);
  });

  it('never raises for an instrument that has NEVER reported', async () => {
    // It has not gone inactive; it was never active. And no telemetry is coming
    // to clear it, so the alarm would be permanent.
    await lastSeen(null);
    await evaluateAlarms();
    expect(await openAlarm()).toBeNull();
  });

  it('never raises for a decommissioned instrument', async () => {
    await lastSeen(600);
    await prisma.instrument.update({ where: { id: instrumentId }, data: { isActive: false } });
    await evaluateAlarms();
    expect(await openAlarm()).toBeNull();
    await prisma.instrument.update({ where: { id: instrumentId }, data: { isActive: true } });
  });
});

describe('clearing', () => {
  beforeEach(async () => {
    await setConfig(KEY, { enabled: true, graceMinutes: 15, severity: 'MAJOR' });
  });

  it('clears when the instrument reports again', async () => {
    // THE test of this file. If the pass had inherited the limit pass's
    // "absence holds the alarm open" rule, this alarm would stay ACTIVE for good.
    await lastSeen(120);
    await evaluateAlarms();
    expect(await openAlarm()).toBeTruthy();

    await lastSeen(0);
    await evaluateAlarms();

    expect(await openAlarm()).toBeNull();
    const rows = await allAlarms();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('CLEARED');
    expect(rows[0].clearedAt).toBeTruthy();
  });

  it('clears without waiting out the grace period a second time', async () => {
    // The grace delays RAISING only. An instrument that is back must not stay
    // alarmed for another fifteen minutes.
    await lastSeen(120);
    await evaluateAlarms();
    await setConfig(KEY, { enabled: true, graceMinutes: 600, severity: 'MAJOR' });
    await lastSeen(0);
    await evaluateAlarms();
    expect(await openAlarm()).toBeNull();
  });

  it('leaves acknowledgement alone when it clears', async () => {
    // A cleared-but-unacknowledged outage is still owed an answer, exactly like
    // a cleared-but-unacknowledged excursion.
    await lastSeen(120);
    await evaluateAlarms();
    const raised = (await openAlarm())!;
    await prisma.alarm.update({
      where: { id: raised.id },
      data: { acknowledgedAt: new Date(), acknowledgedBy: 'admin', acknowledgeReason: 'Network switch replaced' },
    });

    await lastSeen(0);
    await evaluateAlarms();

    const after = (await prisma.alarm.findUnique({ where: { id: raised.id } }))!;
    expect(after.state).toBe('CLEARED');
    expect(after.acknowledgeReason).toBe('Network switch replaced');
  });

  it('opens a NEW alarm for a second outage rather than reopening the first', async () => {
    // Each outage is its own record. Reopening a closed one would erase the
    // duration of the first.
    await lastSeen(120);
    await evaluateAlarms();
    await lastSeen(0);
    await evaluateAlarms();
    await lastSeen(120);
    await evaluateAlarms();

    const rows = await allAlarms();
    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe('CLEARED');
    expect(rows[1].state).toBe('ACTIVE');
  });

  it('does not clear a decommissioned instrument out from under an open alarm', async () => {
    // Retiring an instrument suppresses RAISING. It must not silently close an
    // outage that was already open and unanswered — but if the thing starts
    // reporting again, that IS recovery and it clears.
    await lastSeen(120);
    await evaluateAlarms();
    await prisma.instrument.update({ where: { id: instrumentId }, data: { isActive: false } });
    await evaluateAlarms();
    expect(await openAlarm()).toBeTruthy();

    await lastSeen(0);
    await evaluateAlarms();
    expect(await openAlarm()).toBeNull();
    await prisma.instrument.update({ where: { id: instrumentId }, data: { isActive: true } });
  });
});
