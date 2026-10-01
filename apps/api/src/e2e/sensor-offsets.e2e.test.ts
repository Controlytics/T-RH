import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { invalidateOffsetConfigCache } from '../modules/instruments/load-offsets.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { ensurePartitions } from '../workers/telemetry-partition.worker.js';

/**
 * SENSOR OFFSETS (2026-10-01): an instrument's `Temp Off set` / `Humid Off set`
 * corrects each reading AS IT ARRIVES (+ adds, - subtracts); the corrected value
 * is what is stored — so every screen, report and alarm reads it — and the
 * device's own value is kept in history's `raw_value`, never shown. The
 * attributes are SUPER_ADMIN-only and must be signed numbers.
 *
 * The two config rows this reads are pinned and restored FIRST in afterAll.
 */
const STAMP = String(Date.now()).slice(-6);
const PASSWORD = 'SensorOffset@Test1';
const ROLE = `SO_ENG_${STAMP}`;
const USER = `soe${STAMP}`;
const KEYS = ['sensor-offsets', 'telemetry-slots'];

let app: FastifyInstance;
let admin: Record<string, string>;
let engineer: Record<string, string>;
const created: string[] = [];
const originals = new Map<string, { configValue: unknown; configType: string; requiresReauth: boolean } | null>();

async function setConfig(key: string, value: unknown) {
  await prisma.systemConfig.upsert({
    where: { configKey: key },
    update: { configValue: value as never },
    create: { configKey: key, configValue: value as never, configType: 'system', requiresReauth: false },
  });
  invalidateOffsetConfigCache();
}

async function mk(payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/api/instruments', headers: admin, payload: { profileId: await fixtureProfileId('fixture:sensor-offsets'), ...payload } });
  expect(res.statusCode).toBe(201);
  created.push(res.json().id);
  return res.json() as { id: string; code: string; token: string };
}
const ingest = (token: string, body: unknown) => app.inject({ method: 'POST', url: '/api/ingest/v1/telemetry', headers: { authorization: `Bearer ${token}` }, payload: body as never });
const setAttr = (id: string, headers: Record<string, string>, key: string, value: string) =>
  app.inject({ method: 'POST', url: `/api/instruments/${id}/attributes`, headers, payload: { key, value, reason: 'calibration' } });
async function history(id: string, key: string) {
  return prisma.$queryRaw<{ value: unknown; raw_value: unknown }[]>`
    SELECT value, raw_value FROM instrument_telemetry_history WHERE instrument_id = ${id} AND key = ${key} ORDER BY ts DESC LIMIT 1`;
}

beforeAll(async () => {
  app = await buildApp();
  // The readings land NOW; the test database only gets this month's partition
  // when the maintenance task has run there, which it may not have.
  await ensurePartitions(1);
  for (const k of KEYS) {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: k } });
    originals.set(k, row ? { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth } : null);
  }
  await setConfig('telemetry-slots', { temperatureKeys: 'temperature\nt', humidityKeys: 'humidity\nh' });
  await setConfig('sensor-offsets', { enabled: true, temperatureKeys: 'Temp Off set', humidityKeys: 'Humid Off set' });

  admin = { authorization: `Bearer ${await loginAs(app)}` };
  await prisma.role.create({ data: { name: ROLE, displayName: 'SO Engineer', hierarchyLevel: 2, permissions: ['INSTRUMENT_READ', 'INSTRUMENT_UPDATE', 'INSTRUMENT_CREATE'] } });
  invalidateRolePermsCache();
  const { hashPassword } = await import('../lib/password.js');
  await prisma.user.create({ data: { username: USER, passwordHash: await hashPassword(PASSWORD), fullName: USER, email: `${USER}@test.example`, role: ROLE, status: 'ENABLED', forcePasswordChange: false, isTemporaryPassword: false } });
  engineer = { authorization: `Bearer ${await loginAs(app, USER, PASSWORD)}` };
});

beforeEach(() => invalidateOffsetConfigCache());

afterAll(async () => {
  for (const k of KEYS) {
    try {
      const o = originals.get(k);
      if (o) await prisma.systemConfig.update({ where: { configKey: k }, data: o as never });
      else await prisma.systemConfig.deleteMany({ where: { configKey: k } });
    } catch (e) { console.error(`${k} restore failed`, e); }
  }
  invalidateOffsetConfigCache();
  for (const id of created) await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: admin });
  try { await prisma.session.deleteMany({ where: { user: { username: USER } } }); } catch { /* cascade */ }
  try { await prisma.user.deleteMany({ where: { username: USER } }); } catch (e) { console.error(e); }
  try { await prisma.role.deleteMany({ where: { name: ROLE } }); } catch (e) { console.error(e); }
  invalidateRolePermsCache();
  await app.close();
});

describe('the reading is corrected as it arrives', () => {
  it('+ adds and - subtracts; the corrected value is stored, the device value kept in raw_value', async () => {
    const i = await mk({ name: 'OFS', code: `OFS-${STAMP}` });
    expect((await setAttr(i.id, admin, 'Temp Off set', '+2')).statusCode).toBe(201);
    expect((await setAttr(i.id, admin, 'Humid Off set', '-1.5')).statusCode).toBe(201);
    expect((await ingest(i.token, { t: 23.4, h: '45.0', battery: 3.3 })).statusCode).toBe(200);
    expect(await history(i.id, 't')).toEqual([{ value: 25.4, raw_value: 23.4 }]);
    expect(await history(i.id, 'h')).toEqual([{ value: 43.5, raw_value: '45.0' }]);
    // A key that is neither slot is untouched, and has no raw value.
    expect(await history(i.id, 'battery')).toEqual([{ value: 3.3, raw_value: null }]);
    const latest = await prisma.instrumentTelemetryLatest.findMany({ where: { instrumentId: i.id, key: { in: ['t', 'h'] } }, orderBy: { key: 'asc' } });
    expect(latest.map((l) => l.value)).toEqual([43.5, 25.4]);
  });

  it('a sensor-failure word is stored exactly as sent — RS485 detection still sees it', async () => {
    const i = await mk({ name: 'OFS-NA', code: `OFSNA-${STAMP}` });
    await setAttr(i.id, admin, 'Temp Off set', '+2');
    await ingest(i.token, { t: 'NA' });
    expect(await history(i.id, 't')).toEqual([{ value: 'NA', raw_value: null }]);
  });

  it('each gateway CHILD gets its own offset', async () => {
    const gw = await mk({ name: 'OFS-GW', code: `OFSGW-${STAMP}`, isGateway: true });
    const a = await mk({ name: 'A', code: `OFSA-${STAMP}`, gatewayId: gw.id });
    const b = await mk({ name: 'B', code: `OFSB-${STAMP}`, gatewayId: gw.id });
    await setAttr(a.id, admin, 'Temp Off set', '-1');
    await ingest(gw.token, { devices: { [a.code]: { t: 20 }, [b.code]: { t: 20 } } });
    expect((await history(a.id, 't'))[0].value).toBe(19);
    expect((await history(b.id, 't'))[0]).toEqual({ value: 20, raw_value: null });
  });

  it('switched OFF in configuration, new readings are stored as sent', async () => {
    const i = await mk({ name: 'OFS-OFF', code: `OFSOFF-${STAMP}` });
    await setAttr(i.id, admin, 'Temp Off set', '+5');
    await setConfig('sensor-offsets', { enabled: false, temperatureKeys: 'Temp Off set', humidityKeys: 'Humid Off set' });
    try {
      await ingest(i.token, { t: 21 });
      expect(await history(i.id, 't')).toEqual([{ value: 21, raw_value: null }]);
    } finally {
      await setConfig('sensor-offsets', { enabled: true, temperatureKeys: 'Temp Off set', humidityKeys: 'Humid Off set' });
    }
  });
});

describe('the attributes are SUPER_ADMIN-only and must be signed numbers', () => {
  it('stores the value with its sign written, refuses anything not a number', async () => {
    const i = await mk({ name: 'OFS-V', code: `OFSV-${STAMP}` });
    for (const v of ['2', '1.0', '-0.5', '+3']) expect((await setAttr(i.id, admin, 'Temp Off set', v)).statusCode).toBeLessThan(300);
    const stored = await prisma.instrumentAttribute.findFirst({ where: { instrumentId: i.id, key: 'Temp Off set' } });
    expect(stored?.value).toBe('+3');
    await setAttr(i.id, admin, 'Humid Off set', '2');
    expect((await prisma.instrumentAttribute.findFirst({ where: { instrumentId: i.id, key: 'Humid Off set' } }))?.value).toBe('+2');
    for (const v of ['two', '2 C', '1,5', '']) {
      const res = await setAttr(i.id, admin, 'Temp Off set', v);
      expect(res.statusCode, v).toBe(400);
    }
    const res = await setAttr(i.id, admin, 'Temp Off set', 'two');
    expect(res.json().error).toBe('INVALID_OFFSET');
  });

  it('another role does not see them, cannot set, edit or delete them — but sees every other attribute', async () => {
    const i = await mk({ name: 'OFS-H', code: `OFSH-${STAMP}` });
    await setAttr(i.id, admin, 'Temp Off set', '+2');
    await setAttr(i.id, admin, 'Location', 'Lab 1');
    const asEng = await app.inject({ method: 'GET', url: `/api/instruments/${i.id}/attributes`, headers: engineer });
    expect(asEng.statusCode).toBe(200);
    expect(asEng.json().data.map((a: any) => a.key)).toEqual(['Location']);
    const asAdmin = await app.inject({ method: 'GET', url: `/api/instruments/${i.id}/attributes`, headers: admin });
    expect(asAdmin.json().data.map((a: any) => a.key).sort()).toEqual(['Location', 'Temp Off set']);
    expect((await setAttr(i.id, engineer, 'Humid Off set', '1')).statusCode).toBe(403);
    const put = await app.inject({ method: 'PUT', url: `/api/instruments/${i.id}/attributes/${encodeURIComponent('Temp Off set')}`, headers: engineer, payload: { value: '+9', reason: 'x' } });
    expect(put.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/api/instruments/${i.id}/attributes/${encodeURIComponent('Temp Off set')}`, headers: engineer, payload: { reason: 'x' } });
    expect(del.statusCode).toBe(404);
    expect((await prisma.instrumentAttribute.findFirst({ where: { instrumentId: i.id, key: 'Temp Off set' } }))?.value).toBe('+2');
  });

  it('a profile\'s offset keys are hidden from another role, and their save can neither drop nor add one', async () => {
    const profileId = await fixtureProfileId('fixture:sensor-offsets');
    const before = await prisma.instrumentProfile.findUnique({ where: { id: profileId }, select: { attributeKeys: true } });
    await prisma.instrumentProfile.update({ where: { id: profileId }, data: { attributeKeys: 'Location\nTemp Off set\nHumid Off set' } });
    try {
      const asEng = await app.inject({ method: 'GET', url: `/api/instrument-profiles/${profileId}`, headers: engineer });
      expect(asEng.json().attributeKeys).toBe('Location');
      const asAdmin = await app.inject({ method: 'GET', url: `/api/instrument-profiles/${profileId}`, headers: admin });
      expect(asAdmin.json().attributeKeys).toBe('Location\nTemp Off set\nHumid Off set');
      // The engineer saves what they can see, plus an attempt to add an offset key.
      const put = await app.inject({ method: 'PUT', url: `/api/instrument-profiles/${profileId}`, headers: engineer, payload: { attributeKeys: 'Location\nBuilding\nTEMP OFF SET' } });
      expect(put.statusCode).toBe(200);
      const after = await prisma.instrumentProfile.findUnique({ where: { id: profileId }, select: { attributeKeys: true } });
      expect(after?.attributeKeys).toBe('Location\nBuilding\nTemp Off set\nHumid Off set');
    } finally {
      await prisma.instrumentProfile.update({ where: { id: profileId }, data: { attributeKeys: before?.attributeKeys ?? '' } });
    }
  });

  it('the configuration editor stays SUPER_ADMIN-only', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/config/dynamic/sensor-offsets', headers: engineer })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/config/dynamic/sensor-offsets', headers: admin })).statusCode).toBe(200);
  });
});
