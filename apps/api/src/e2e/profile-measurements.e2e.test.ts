/**
 * PROFILE MEASUREMENTS over HTTP (2026-10-26) — what a profile measures and
 * which keys carry it, its NMT / NLT / MKT switches, and who may change them.
 * Design: docs/superpowers/specs/2026-10-26-profile-measurements-design.md (D2–D4).
 *
 * Asserted through `app.inject`, so a field the response schema forgets to
 * declare fails here (Fastify strips it) — inner keys included.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_PROFILE_MEASUREMENTS, type ProfileMeasurement } from '@digilog/shared';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

const STAMP = String(Date.now()).slice(-6);
const PASSWORD = 'ProfMeas@Test1';
const ROLE = `PM_ENG_${STAMP}`;
const USER = `pme${STAMP}`;

let app: FastifyInstance;
let admin: Record<string, string>;
let engineer: Record<string, string>;
const profiles: string[] = [];
const instruments: string[] = [];

const clone = (ms: ProfileMeasurement[]) => structuredClone(ms);
const withTemp = (ms: ProfileMeasurement[], patch: (m: ProfileMeasurement) => ProfileMeasurement) =>
  ms.map((m) => (m.code === 'TEMPERATURE' ? patch(structuredClone(m)) : m));

async function newProfile(name: string, measurements?: ProfileMeasurement[]) {
  const res = await app.inject({
    method: 'POST', url: '/api/instrument-profiles', headers: admin,
    payload: { name: `PMX ${name} ${STAMP}`, ...(measurements ? { measurements } : {}) },
  });
  expect(res.statusCode).toBe(201);
  profiles.push(res.json().id);
  return res.json() as { id: string; measurements: ProfileMeasurement[] };
}

async function newInstrument(profileId: string, tag: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: admin,
    payload: { name: `PMX-${tag}-${STAMP}`, code: `PMX-${tag}-${STAMP}`, profileId },
  });
  expect(res.statusCode).toBe(201);
  instruments.push(res.json().id);
  return res.json() as { id: string; code: string };
}

const put = (id: string, headers: Record<string, string>, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/instrument-profiles/${id}`, headers, payload });

beforeAll(async () => {
  app = await buildApp();
  admin = { authorization: `Bearer ${await loginAs(app)}` };
  await prisma.role.create({ data: { name: ROLE, displayName: 'PM Engineer', hierarchyLevel: 2, permissions: ['INSTRUMENT_READ', 'INSTRUMENT_UPDATE', 'INSTRUMENT_CREATE'] } });
  invalidateRolePermsCache();
  const { hashPassword } = await import('../lib/password.js');
  await prisma.user.create({ data: { username: USER, passwordHash: await hashPassword(PASSWORD), fullName: USER, email: `${USER}@test.example`, role: ROLE, status: 'ENABLED', forcePasswordChange: false, isTemporaryPassword: false } });
  engineer = { authorization: `Bearer ${await loginAs(app, USER, PASSWORD)}` };
});

afterAll(async () => {
  await prisma.alarm.deleteMany({ where: { instrumentId: { in: instruments } } });
  for (const id of instruments) await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: admin });
  await prisma.instrument.deleteMany({ where: { id: { in: instruments } } });
  await prisma.instrumentProfile.deleteMany({ where: { id: { in: profiles } } });
  try { await prisma.session.deleteMany({ where: { user: { username: USER } } }); } catch { /* cascade */ }
  try { await prisma.user.deleteMany({ where: { username: USER } }); } catch (e) { console.error(e); }
  try { await prisma.role.deleteMany({ where: { name: ROLE } }); } catch (e) { console.error(e); }
  invalidateRolePermsCache();
  await app.close();
});

describe('a profile carries its measurements', () => {
  it('a new profile starts with temperature and humidity at the defaults', async () => {
    const p = await newProfile('defaults');
    expect(p.measurements).toEqual(DEFAULT_PROFILE_MEASUREMENTS);
    const stored = await prisma.instrumentProfile.findUniqueOrThrow({ where: { id: p.id } });
    expect(stored.measurements).toEqual(DEFAULT_PROFILE_MEASUREMENTS);
  });

  it('a super admin switches temperature NMT off — with a reason — and it reads back, inner keys and all', async () => {
    const p = await newProfile('nmt');
    const next = withTemp(p.measurements, (m) => ({ ...m, high: { ...m.high, enabled: false } }));
    const res = await put(p.id, admin, { measurements: next, reason: 'NMT not judged for this device type' });
    expect(res.statusCode).toBe(200);
    const got = await app.inject({ method: 'GET', url: `/api/instrument-profiles/${p.id}`, headers: admin });
    const temp = (got.json().measurements as ProfileMeasurement[]).find((m) => m.code === 'TEMPERATURE')!;
    expect(temp.high.enabled).toBe(false);
    expect(temp.mkt.attributeKeys).toEqual(['isMktCalculationEnabled']);
    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'INSTRUMENT_PROFILE_UPDATED', targetId: p.id }, orderBy: { timestamp: 'desc' },
    });
    expect((audit?.afterValue as { measurements?: ProfileMeasurement[] })?.measurements?.[0].high.enabled).toBe(false);
    expect(audit?.reason).toBe('NMT not judged for this device type');
  });

  it('a measurement change without a reason is refused', async () => {
    const p = await newProfile('noreason');
    const res = await put(p.id, admin, { measurements: withTemp(p.measurements, (m) => ({ ...m, deviceKeys: ['tx'] })) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('REASON_REQUIRED');
  });

  it('phase 1 refuses a measurement the app cannot show yet, and MKT on a non-°C measurement', async () => {
    const p = await newProfile('refused');
    const pressure = { ...clone(p.measurements)[0], code: 'PRESSURE', deviceKeys: ['p'], offsetKeys: [], decimals: { attributeKeys: [], fallback: 1 }, high: { enabled: true, limitKeys: ['p_hl'], enableKeys: [] }, low: { enabled: true, limitKeys: ['p_ll'], enableKeys: [] }, range: { highKeys: [], lowKeys: [] }, mkt: { enabled: false, attributeKeys: [] } };
    const r1 = await put(p.id, admin, { measurements: [...p.measurements, pressure], reason: 'add pressure' });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error).toBe('MEASUREMENT_NOT_SUPPORTED');
    const humidMkt = p.measurements.map((m) => (m.code === 'HUMIDITY' ? { ...m, mkt: { enabled: true, attributeKeys: [] } } : m));
    const r2 = await put(p.id, admin, { measurements: humidMkt, reason: 'mkt' });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error).toBe('MKT_NOT_TEMPERATURE');
  });

  it('a device-key change is on the dashboard at the very next poll', async () => {
    const p = await newProfile('poll');
    const inst = await newInstrument(p.id, 'POLL');
    await prisma.instrumentTelemetryLatest.create({ data: { instrumentId: inst.id, key: 'tx', value: 21.5, valueType: 'float', ts: new Date() } });
    const before = await app.inject({ method: 'GET', url: '/api/instruments/telemetry-overview', headers: admin });
    expect(before.json().data.find((r: { instrumentId: string }) => r.instrumentId === inst.id).temperature).toBeNull();
    const res = await put(p.id, admin, { measurements: withTemp(p.measurements, (m) => ({ ...m, deviceKeys: ['tx'] })), reason: 'new firmware key' });
    expect(res.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/instruments/telemetry-overview', headers: admin });
    expect(after.json().data.find((r: { instrumentId: string }) => r.instrumentId === inst.id).temperature).toMatchObject({ key: 'tx', value: 21.5 });
  });

  it('lists the measurement types, temperature first', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instrument-profiles/measurement-types', headers: engineer });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.slice(0, 2)).toEqual([
      { code: 'TEMPERATURE', name: 'Temperature', unit: '°C', sortOrder: 1 },
      { code: 'HUMIDITY', name: 'Humidity', unit: '%RH', sortOrder: 2 },
    ]);
  });
});

describe('only a super admin changes what a profile measures', () => {
  it('another role is refused a measurement change', async () => {
    const p = await newProfile('eng-refused');
    const res = await put(p.id, engineer, { measurements: withTemp(p.measurements, (m) => ({ ...m, high: { ...m.high, enabled: false } })), reason: 'try' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('SUPER_ADMIN_ONLY');
  });

  it('another role saving the attribute keys and sending the measurements back as they read them is fine — offsets kept', async () => {
    const p = await newProfile('eng-roundtrip');
    const asEng = await app.inject({ method: 'GET', url: `/api/instrument-profiles/${p.id}`, headers: engineer });
    const seen = asEng.json().measurements as ProfileMeasurement[];
    expect(seen.every((m) => m.offsetKeys.length === 0)).toBe(true);
    const res = await put(p.id, engineer, { attributeKeys: 'Location\nBuilding', measurements: seen });
    expect(res.statusCode).toBe(200);
    const stored = await prisma.instrumentProfile.findUniqueOrThrow({ where: { id: p.id } });
    expect((stored.measurements as ProfileMeasurement[]).find((m) => m.code === 'TEMPERATURE')!.offsetKeys).toEqual(['Temp Off set']);
  });

  it('another role may not create a profile with its own measurements', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instrument-profiles', headers: engineer,
      payload: { name: `PMX eng-create ${STAMP}`, measurements: withTemp(DEFAULT_PROFILE_MEASUREMENTS, (m) => ({ ...m, deviceKeys: ['tx'] })) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('SUPER_ADMIN_ONLY');
  });
});

describe('the alarm impact of a proposed change', () => {
  it('names the open alarm a switched-off bound would clear', async () => {
    const p = await newProfile('impact');
    const inst = await newInstrument(p.id, 'IMPACT');
    await prisma.alarm.create({ data: {
      source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH', metric: 'TEMPERATURE', instrumentId: inst.id,
      triggeredValue: 30, severity: 'MAJOR', state: 'ACTIVE', raisedAt: new Date(), ruleSnapshot: { description: 'impact fixture' },
    } });
    const res = await app.inject({
      method: 'POST', url: `/api/instrument-profiles/${p.id}/measurement-impact`, headers: admin,
      payload: { measurements: withTemp(p.measurements, (m) => ({ ...m, high: { ...m.high, enabled: false } })) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().clears).toEqual([{ metric: 'TEMPERATURE', source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH', count: 1 }]);
    const none = await app.inject({
      method: 'POST', url: `/api/instrument-profiles/${p.id}/measurement-impact`, headers: admin,
      payload: { measurements: p.measurements },
    });
    expect(none.json().clears).toEqual([]);
  });
});

describe('moving an instrument to another profile', () => {
  it('another role may not move it into a profile that measures differently; a super admin may', async () => {
    const from = await newProfile('move-from');
    const fewer = await newProfile('move-fewer', DEFAULT_PROFILE_MEASUREMENTS.filter((m) => m.code !== 'HUMIDITY'));
    const same = await newProfile('move-same');
    const inst = await newInstrument(from.id, 'MOVE');
    const move = (headers: Record<string, string>, profileId: string) =>
      app.inject({ method: 'PUT', url: `/api/instruments/${inst.id}`, headers, payload: { profileId } });

    const refused = await move(engineer, fewer.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('MEASUREMENTS_DIFFER');
    expect((await move(engineer, same.id)).statusCode).toBe(200);
    expect((await move(admin, fewer.id)).statusCode).toBe(200);
  });
});
