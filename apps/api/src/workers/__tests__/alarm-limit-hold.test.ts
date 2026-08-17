/**
 * The clear path of the instrument-limit pass, against the real database.
 *
 * Not a unit test because the branch it covers is inline I/O in the worker: the
 * decision "hold the alarm open" is expressed as a Prisma update that does NOT
 * happen, and a pure function cannot show the absence of a write.
 *
 * What it protects: a probe that goes quiet mid-excursion must NOT be recorded as
 * having returned to spec. checkLimits() reports `breaching: false` for a null
 * reading — correct for the raise path, catastrophic if the clear path acts on it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import { evaluateAlarms } from '../alarm-evaluation.worker.js';

const CODE = `LIMIT-HOLD-${Date.now()}`;
let instrumentId = '';
let startedAt = new Date();

async function setTemperature(value: number) {
  await prisma.instrumentTelemetryLatest.upsert({
    where: { instrumentId_key: { instrumentId, key: 'temperature' } },
    create: { instrumentId, key: 'temperature', value, valueType: 'number', ts: new Date() },
    update: { value, ts: new Date() },
  });
  await prisma.instrument.update({ where: { id: instrumentId }, data: { lastSeenAt: new Date() } });
}

async function openAlarm() {
  return prisma.alarm.findFirst({
    where: { instrumentId, source: 'INSTRUMENT_LIMIT', metric: 'TEMPERATURE' },
    orderBy: { raisedAt: 'desc' },
  });
}

describe('instrument-limit clear path', () => {
  beforeAll(async () => {
    startedAt = new Date();
    const profile = await prisma.instrumentProfile.findFirst({ select: { id: true } })
      ?? await prisma.instrumentProfile.create({ data: { name: `LimitHold-${Date.now()}` } });
    const inst = await prisma.instrument.create({
      data: {
        code: CODE,
        name: 'limit clear-path fixture',
        profileId: profile.id,
        lastSeenAt: new Date(),
        attributes: { create: [{ key: 'High Temperature Limit', value: '25' }] },
      },
    });
    instrumentId = inst.id;
  });

  afterAll(async () => {
    await prisma.alarm.deleteMany({ where: { instrumentId } });
    await prisma.instrumentTelemetryLatest.deleteMany({ where: { instrumentId } });
    await prisma.instrumentAttribute.deleteMany({ where: { instrumentId } });
    await prisma.instrument.deleteMany({ where: { id: instrumentId } });
    // Evaluation is estate-wide, so it may have raised limit alarms on OTHER fixture
    // instruments left by other suites. Those are this run's debris, not theirs.
    await prisma.alarm.deleteMany({ where: { source: 'INSTRUMENT_LIMIT', raisedAt: { gte: startedAt } } });
  });

  it('raises on a breaching reading', async () => {
    await setTemperature(30);
    const res = await evaluateAlarms();
    expect(res.instrumentsEvaluated).toBeGreaterThan(0);
    const alarm = await openAlarm();
    expect(alarm?.state).toBe('ACTIVE');
    expect(alarm?.triggeredValue).toBe(30);
  });

  it('HOLDS the alarm open when the reading goes missing', async () => {
    // The probe goes quiet: no telemetry row at all, which is what buildTelemetryOverview
    // reports as `temperature: null`.
    await prisma.instrumentTelemetryLatest.deleteMany({ where: { instrumentId } });
    await evaluateAlarms();
    const alarm = await openAlarm();
    expect(alarm?.state).toBe('ACTIVE');
    expect(alarm?.clearedAt).toBeNull();
    expect(alarm?.clearedValue).toBeNull();
  });

  it('still clears on a real in-spec reading, without touching acknowledgement', async () => {
    // The discriminating half: if the hold above were implemented as "never clear",
    // this would fail. A clear needs data, and here there is data.
    await setTemperature(21.5);
    const res = await evaluateAlarms();
    const alarm = await openAlarm();
    expect(alarm?.state).toBe('CLEARED');
    expect(alarm?.clearedValue).toBe(21.5);
    expect(alarm?.acknowledgedAt).toBeNull();
    // >= 1 rather than exactly 1: evaluation is estate-wide and another fixture in the
    // shared test database could clear in the same pass.
    expect(res.cleared).toBeGreaterThanOrEqual(1);
  });
});
