/**
 * The alarm evaluator reads each instrument through ITS PROFILE (2026-10-26),
 * against the real database:
 *  - the profile's device keys decide which reading is the temperature;
 *  - the profile's NMT switch off clears a limit alarm open on that bound;
 *  - a measurement REMOVED from the profile clears every alarm open on it
 *    (otherwise it can never clear — nothing will ever judge it again).
 *
 * Each case owns its fixture profile, so a switch set here touches nothing else.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DEFAULT_PROFILE_MEASUREMENTS as DEFAULTS } from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { evaluateAlarms } from '../alarm-evaluation.worker.js';
import { fixtureProfileId } from '../../test-support/fixture-profile.js';
import { setFixtureMeasurements, patchFixtureMeasurement } from '../../test-support/fixture-measurements.js';

const STAMP = Date.now();
const created: string[] = [];
const PINNED = { 'alarm-limits': { enabled: true }, 'rs485-alarms': { enabled: true }, 'inactivity-alarms': { enabled: false } };
const before = new Map<string, { value: unknown; existed: boolean }>();

async function fixture(tag: string, profileName: string, readings: Record<string, unknown>, attrs: Record<string, string>) {
  const inst = await prisma.instrument.create({
    data: {
      code: `PM-ALARM-${tag}-${STAMP}`, name: `profile alarm ${tag}`,
      profileId: await fixtureProfileId(profileName),
      isActive: true, lastSeenAt: new Date(), expectedIntervalSec: 60,
      attributes: { create: Object.entries(attrs).map(([key, value]) => ({ key, value })) },
    },
  });
  created.push(inst.id);
  for (const [key, value] of Object.entries(readings)) {
    await prisma.instrumentTelemetryLatest.create({
      data: { instrumentId: inst.id, key, value: value as never, valueType: typeof value === 'number' ? 'float' : 'string', ts: new Date() },
    });
  }
  return inst.id;
}

const alarmsOf = (instrumentId: string, source: 'INSTRUMENT_LIMIT' | 'RS485_FAILURE') =>
  prisma.alarm.findMany({ where: { instrumentId, source }, orderBy: { raisedAt: 'asc' } });

beforeAll(async () => {
  for (const [key, value] of Object.entries(PINNED)) {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: key } });
    before.set(key, { value: row?.configValue ?? null, existed: Boolean(row) });
    await prisma.systemConfig.upsert({
      where: { configKey: key },
      create: { configKey: key, configValue: value, configType: 'object' },
      update: { configValue: { ...((row?.configValue as object) ?? {}), ...value } },
    });
  }
});

afterAll(async () => {
  // Config FIRST, each step guarded: a failing suite must still hand the shared
  // test database back (apps/api/CLAUDE.md, the rs485 incident).
  for (const [key, prev] of before) {
    try {
      if (prev.existed) await prisma.systemConfig.update({ where: { configKey: key }, data: { configValue: prev.value as never } });
      else await prisma.systemConfig.deleteMany({ where: { configKey: key } });
    } catch { /* keep restoring */ }
  }
  await prisma.alarm.deleteMany({ where: { instrumentId: { in: created } } });
  await prisma.instrumentTelemetryLatest.deleteMany({ where: { instrumentId: { in: created } } });
  await prisma.instrumentAttribute.deleteMany({ where: { instrumentId: { in: created } } });
  await prisma.instrument.deleteMany({ where: { id: { in: created } } });
});

describe('alarm evaluation reads the instrument\'s profile', () => {
  it('the profile\'s device key decides which reading is the temperature', async () => {
    const profile = 'fixture:alarm-pm-keys';
    await patchFixtureMeasurement(await fixtureProfileId(profile), 'TEMPERATURE', (m) => ({ ...m, deviceKeys: ['tx'] }));
    const id = await fixture('KEYS', profile, { tx: 30 }, { 'High Temperature Limit': '25' });
    await evaluateAlarms();
    const rows = await alarmsOf(id, 'INSTRUMENT_LIMIT');
    expect(rows.map((r) => [r.metric, r.limitKind, r.state])).toEqual([['TEMPERATURE', 'HIGH', 'ACTIVE']]);
  });

  it('switching the profile\'s temperature NMT off clears the high-limit alarm open on it', async () => {
    const profile = 'fixture:alarm-pm-nmt';
    const profileId = await fixtureProfileId(profile);
    await patchFixtureMeasurement(profileId, 'TEMPERATURE', (m) => ({ ...m, high: { ...m.high, enabled: true } }));
    const id = await fixture('NMT', profile, { temperature: 30 }, { 'High Temperature Limit': '25' });
    await evaluateAlarms();
    expect((await alarmsOf(id, 'INSTRUMENT_LIMIT')).map((r) => r.state)).toEqual(['ACTIVE']);

    await patchFixtureMeasurement(profileId, 'TEMPERATURE', (m) => ({ ...m, high: { ...m.high, enabled: false } }));
    await evaluateAlarms();
    expect((await alarmsOf(id, 'INSTRUMENT_LIMIT')).map((r) => r.state)).toEqual(['CLEARED']);
  });

  it('removing humidity from the profile clears the humidity alarm open on it, and says why', async () => {
    const profile = 'fixture:alarm-pm-removed';
    const profileId = await fixtureProfileId(profile);
    // Start from the defaults (temperature + humidity), whatever an earlier run left.
    await setFixtureMeasurements(profileId, () => structuredClone(DEFAULTS));
    const id = await fixture('REMOVED', profile, { temperature: 21, humidity: 'NA' }, {});
    await evaluateAlarms();
    const raised = await alarmsOf(id, 'RS485_FAILURE');
    expect(raised.map((r) => [r.metric, r.state])).toEqual([['HUMIDITY', 'ACTIVE']]);

    await setFixtureMeasurements(profileId, (ms) => ms.filter((m) => m.code !== 'HUMIDITY'));
    await evaluateAlarms();
    const after = await alarmsOf(id, 'RS485_FAILURE');
    expect(after.map((r) => r.state)).toEqual(['CLEARED']);
    expect((after[0].ruleSnapshot as Record<string, unknown>).clearedReason).toBe('MEASUREMENT_REMOVED');
  });
});
