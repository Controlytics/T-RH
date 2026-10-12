/**
 * Audit 2026-10-12 #8 — the instrument-limit pass judges only a CURRENT reading
 * from an instrument that is in service, against the real database.
 *
 * The other three passes gate on `isActive`, and the overview's `reporting` is the
 * ONE definition of "this instrument is talking". The limit pass had neither, and
 * the overview keeps the LAST value of a slot however old it is, so a decommissioned
 * instrument's three-day-old reading raised — or cleared — an alarm the moment
 * someone edited its limit.
 *
 * `expectedIntervalSec` is set on each fixture so `reporting` is decided by the
 * instrument's own interval, independent of the shared `instrument-activity` config.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import { evaluateAlarms } from '../alarm-evaluation.worker.js';

const STAMP = Date.now();
const created: string[] = [];
const THREE_DAYS_AGO = () => new Date(Date.now() - 3 * 24 * 3600_000);

async function fixture(opts: { isActive: boolean; seenAt: Date; value: number; tag: string }) {
  const profile = await prisma.instrumentProfile.findFirst({ select: { id: true } })
    ?? await prisma.instrumentProfile.create({ data: { name: `LimitGate-${STAMP}` } });
  const inst = await prisma.instrument.create({
    data: {
      code: `LIMIT-GATE-${opts.tag}-${STAMP}`,
      name: `limit gate ${opts.tag}`,
      profileId: profile.id,
      isActive: opts.isActive,
      lastSeenAt: opts.seenAt,
      expectedIntervalSec: 60,
      attributes: { create: [{ key: 'High Temperature Limit', value: '25' }] },
    },
  });
  created.push(inst.id);
  await prisma.instrumentTelemetryLatest.create({
    data: { instrumentId: inst.id, key: 'temperature', value: opts.value, valueType: 'number', ts: opts.seenAt },
  });
  return inst.id;
}

const limitAlarms = (instrumentId: string) => prisma.alarm.findMany({
  where: { instrumentId, source: 'INSTRUMENT_LIMIT' },
});

async function openAlarmOn(instrumentId: string) {
  return prisma.alarm.create({
    data: {
      source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH', metric: 'TEMPERATURE', instrumentId,
      triggeredValue: 30, severity: 'MAJOR', state: 'ACTIVE', raisedAt: new Date(Date.now() - 4 * 24 * 3600_000),
      ruleSnapshot: { description: 'gate fixture' },
    },
  });
}

describe('instrument-limit pass gating', () => {
  beforeEach(() => undefined);

  afterAll(async () => {
    await prisma.alarm.deleteMany({ where: { instrumentId: { in: created } } });
    await prisma.instrumentTelemetryLatest.deleteMany({ where: { instrumentId: { in: created } } });
    await prisma.instrumentAttribute.deleteMany({ where: { instrumentId: { in: created } } });
    await prisma.instrument.deleteMany({ where: { id: { in: created } } });
  });

  it('positive control: an active, reporting instrument breaching its limit raises', async () => {
    const id = await fixture({ isActive: true, seenAt: new Date(), value: 30, tag: 'LIVE' });
    await evaluateAlarms();
    const rows = await limitAlarms(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('ACTIVE');
  });

  it('a DEACTIVATED instrument does not raise, even on a current breaching reading', async () => {
    const id = await fixture({ isActive: false, seenAt: new Date(), value: 30, tag: 'OFF' });
    await evaluateAlarms();
    expect(await limitAlarms(id)).toHaveLength(0);
  });

  it('a STALE reading (instrument not reporting) does not raise', async () => {
    const id = await fixture({ isActive: true, seenAt: THREE_DAYS_AGO(), value: 30, tag: 'STALE' });
    await evaluateAlarms();
    expect(await limitAlarms(id)).toHaveLength(0);
  });

  it('a STALE in-spec reading does not clear an open alarm (silence is not recovery)', async () => {
    const id = await fixture({ isActive: true, seenAt: THREE_DAYS_AGO(), value: 20, tag: 'STALECLR' });
    const open = await openAlarmOn(id);
    await evaluateAlarms();
    const after = await prisma.alarm.findUniqueOrThrow({ where: { id: open.id } });
    expect(after.state).toBe('ACTIVE');
    expect(after.clearedAt).toBeNull();
  });

  it('a deactivated but REPORTING instrument still clears on a current in-spec reading', async () => {
    // Mirrors decideRs485: retiring an instrument must not strand an open alarm.
    const id = await fixture({ isActive: false, seenAt: new Date(), value: 20, tag: 'OFFCLR' });
    const open = await openAlarmOn(id);
    await evaluateAlarms();
    const after = await prisma.alarm.findUniqueOrThrow({ where: { id: open.id } });
    expect(after.state).toBe('CLEARED');
    expect(after.clearedValue).toBe(20);
  });
});
