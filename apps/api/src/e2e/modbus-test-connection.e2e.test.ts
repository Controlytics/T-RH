import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { startFakeSlave, type FakeSlave } from '../test-support/fake-modbus-slave.js';
import { resolvedSlotFor } from '../modules/instruments/data-keys.js';
import { slotConfigForProfile } from '../modules/instruments/profile-measurements.js';

/**
 * TCP/IP instruments, Task 5 — POST /api/instruments/modbus/test reads a device
 * once with the form's own address and map. Nothing is stored, nothing audited.
 * Fixtures are this file's own; the `modbus-reader` row is restored FIRST in
 * afterAll. Each caller stays under the 10/min limit; the limit case has its
 * own users and runs last.
 */

const s = Date.now();
const ROLE = `MBT_${s}`;
const ROLE_RO = `MBTRO_${s}`;
const PW = 'Mbt@Operator1';
const SA_PW = 'Mbt@SuperAdmin1';
const U = (n: string) => `mbt${n}${s}`;
const C = (n: string) => `MBT-${s}-${n}`;

let app: FastifyInstance;
let sa: Record<string, string>;
const userIds: string[] = [];
let blockIn = '';
let blockOut = '';
let tcpProfileId = '';
let pushProfileId = '';
let readerRowBefore: { configValue: unknown; configType: string; requiresReauth: boolean } | null = null;
const slaves: FakeSlave[] = [];
const t0 = new Date();

const f32 = (v: number): [number, number] => {
  const b = Buffer.alloc(4);
  b.writeFloatBE(v);
  return [b.readUInt16BE(0), b.readUInt16BE(2)];
};
const [tHi, tLo] = f32(22.4);
const HOLDING = { 0: tHi, 1: tLo, 2: 553, 3: 1013, 4: 0, 5: 1500, 6: 1, 9: 77 };
const INPUT = { 0: 2301 };
const SIX = [
  { key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Humidity', register: '40003', dataType: 'UINT16', scale: 0.1 },
  { key: 'Pressure', register: '40004', dataType: 'INT16', scale: 1 },
  { key: 'Voltage', register: '30001', dataType: 'UINT16', scale: 0.1 },
  { key: 'Power', register: '40005', dataType: 'UINT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Switch', register: '40007', dataType: 'UINT16', scale: 1 },
];
const ONE = [{ key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 }];

async function user(name: string, role: string): Promise<Record<string, string>> {
  const u = await prisma.user.create({
    data: { username: name, fullName: name, role, status: 'ENABLED', passwordHash: await hashPassword(PW), passwordChangedAt: new Date() },
  });
  userIds.push(u.id);
  return { authorization: `Bearer ${await loginAs(app, name, PW)}`, 'x-reauth-password': PW };
}

const test = (headers: Record<string, string>, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/instruments/modbus/test', headers, payload });
const body = (slave: FakeSlave, extra: Record<string, unknown> = {}) => ({
  profileId: tcpProfileId, modbusHost: slave.host, modbusPort: slave.port, modbusRegisters: SIX, ...extra,
});
async function setReading(on: boolean) {
  const res = await app.inject({
    method: 'PUT', url: '/api/config/dynamic/modbus-reader', headers: sa,
    payload: { serverReadingEnabled: on, deviceNetworks: '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16' },
  });
  expect(res.statusCode, res.body).toBe(200);
}
async function slave(opts: Parameters<typeof startFakeSlave>[0] = { holding: HOLDING, input: INPUT }) {
  const sl = await startFakeSlave(opts);
  slaves.push(sl);
  return sl;
}

beforeAll(async () => {
  app = await buildApp();
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'modbus-reader' } });
  readerRowBefore = row ? { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth } : null;

  const saUser = await prisma.user.create({
    data: { username: U('sa'), fullName: U('sa'), role: 'SUPER_ADMIN', status: 'ENABLED', passwordHash: await hashPassword(SA_PW), passwordChangedAt: new Date() },
  });
  userIds.push(saUser.id);
  sa = { authorization: `Bearer ${await loginAs(app, U('sa'), SA_PW)}`, 'x-reauth-password': SA_PW };

  await prisma.role.create({ data: { name: ROLE, displayName: ROLE, hierarchyLevel: 3, isSystem: false, permissions: ['INSTRUMENT_READ', 'INSTRUMENT_CREATE', 'INSTRUMENT_UPDATE'] } });
  await prisma.role.create({ data: { name: ROLE_RO, displayName: ROLE_RO, hierarchyLevel: 3, isSystem: false, permissions: ['INSTRUMENT_READ'] } });
  invalidateRolePermsCache(ROLE);
  invalidateRolePermsCache(ROLE_RO);

  blockIn = (await prisma.functionalLocation.create({ data: { name: `MBT-in-${s}`, type: 'BLOCK' } })).id;
  blockOut = (await prisma.functionalLocation.create({ data: { name: `MBT-out-${s}`, type: 'BLOCK' } })).id;
  await prisma.roleConfig.create({ data: { role: ROLE, instrumentScope: { locationIds: [blockIn], instrumentIds: [] } as never } });

  tcpProfileId = (await prisma.instrumentProfile.create({ data: { name: `MBT Modbus ${s}`, connection: 'MODBUS_TCP', modbusIntervalSec: 60, modbusUnitId: 1 } })).id;
  pushProfileId = (await prisma.instrumentProfile.create({ data: { name: `MBT Push ${s}` } })).id;
});

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { failures.push(e); } };
  await step(async () => {
    if (readerRowBefore) await prisma.systemConfig.update({ where: { configKey: 'modbus-reader' }, data: readerRowBefore as never });
    else await prisma.systemConfig.deleteMany({ where: { configKey: 'modbus-reader' } });
  });
  for (const sl of slaves) await step(() => sl.close());
  await step(() => prisma.instrument.deleteMany({ where: { code: { startsWith: `MBT-${s}-` } } }));
  await step(() => prisma.instrumentProfile.deleteMany({ where: { id: { in: [tcpProfileId, pushProfileId].filter(Boolean) } } }));
  await step(() => prisma.functionalLocation.deleteMany({ where: { id: { in: [blockIn, blockOut].filter(Boolean) } } }));
  await step(() => prisma.roleConfig.deleteMany({ where: { role: ROLE } }));
  await step(() => prisma.session.deleteMany({ where: { userId: { in: userIds } } }));
  await step(() => prisma.passwordHistory.deleteMany({ where: { userId: { in: userIds } } }));
  await step(() => prisma.user.deleteMany({ where: { id: { in: userIds } } }));
  await step(() => prisma.role.deleteMany({ where: { name: { in: [ROLE, ROLE_RO] } } }));
  invalidateRolePermsCache(ROLE);
  invalidateRolePermsCache(ROLE_RO);
  await step(() => app.close());
  if (failures.length > 0) throw new AggregateError(failures, 'modbus-test-connection teardown failed');
});

describe('POST /api/instruments/modbus/test', () => {
  let a: Record<string, string>; // caller A (under 10 calls)
  let b: Record<string, string>; // caller B (under 10 calls)
  beforeAll(async () => {
    a = await user(U('a'), ROLE);
    b = await user(U('b'), ROLE);
  });

  it('reading OFF -> ok:false READING_OFF and the device sees NO connection', async () => {
    await setReading(false);
    const sl = await slave();
    const res = await test(a, body(sl));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: false, code: 'READING_OFF', message: 'Reading devices from this server is off (Configuration → TCP/IP Reading).' });
    expect(sl.connections()).toBe(0);
  });

  it('reading ON: six keys decoded, Temperature judged TEMPERATURE, Pressure not judged', async () => {
    await setReading(true);
    const sl = await slave();
    const res = await test(a, body(sl));
    expect(res.statusCode, res.body).toBe(200);
    const j = res.json();
    expect(j.ok).toBe(true);
    expect(j.rejected).toEqual([]);
    expect(j.requests).toBeGreaterThan(0);
    expect(typeof j.elapsedMs).toBe('number');
    const by = Object.fromEntries(j.values.map((v: { key: string; value: number; judgedAs: string | null }) => [v.key, v]));
    expect(Object.keys(by).sort()).toEqual(['Humidity', 'Power', 'Pressure', 'Switch', 'Temperature', 'Voltage']);
    expect(by.Temperature.value).toBeCloseTo(22.4, 5);
    expect(by.Temperature.judgedAs).toBe('TEMPERATURE');
    expect(by.Humidity.value).toBeCloseTo(55.3, 5);
    expect(by.Pressure.value).toBe(1013);
    expect(by.Pressure.judgedAs).toBeNull();
    expect(by.Voltage.value).toBeCloseTo(230.1, 5);
    expect(by.Power.value).toBe(1500);
    expect(sl.connections()).toBeGreaterThan(0);
  });

  it('two keys for one measurement: only the key resolvedSlotFor picks is judged', async () => {
    const sl = await slave();
    const map = [
      ONE[0],
      { key: 't', register: '40010', dataType: 'UINT16', scale: 1 },
    ];
    const res = await test(a, body(sl, { modbusRegisters: map }));
    expect(res.statusCode, res.body).toBe(200);
    const cfg = await slotConfigForProfile(tcpProfileId);
    const keys = map.map((m) => m.key);
    const expected = keys.filter((k) => resolvedSlotFor(cfg, k, keys) === 'temperature');
    expect(expected).toHaveLength(1);
    const values = res.json().values as Array<{ key: string; judgedAs: string | null }>;
    expect(values.filter((v) => v.judgedAs === 'TEMPERATURE').map((v) => v.key)).toEqual(expected);
    expect(values.find((v) => v.key !== expected[0])?.judgedAs).toBeNull();
  });

  it('a device exception is a 200 DEVICE_EXCEPTION with the exact sentence', async () => {
    const sl = await slave({ holding: HOLDING, input: INPUT, behaviour: 'exception02' });
    const res = await test(a, body(sl, { modbusRegisters: ONE }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: false, code: 'DEVICE_EXCEPTION',
      message: 'The device refused registers 40001–40002 (exception 02, illegal address) — the register map does not match it.',
    });
  });

  it('a silent device is a 200 BAD_RESPONSE', async () => {
    const sl = await slave({ holding: HOLDING, input: INPUT, behaviour: 'silent' });
    const res = await test(a, body(sl, { modbusRegisters: ONE }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: false, code: 'BAD_RESPONSE',
      message: `${sl.host} : ${sl.port} accepted the connection but did not answer the read within 1 s.`,
    });
  });

  it('a refused address is a 400 ADDRESS_NOT_ALLOWED', async () => {
    const res = await test(a, { profileId: tcpProfileId, modbusHost: '8.8.8.8', modbusPort: 502, modbusRegisters: ONE });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('ADDRESS_NOT_ALLOWED');
  });

  it('a malformed map is a 400, never a 500', async () => {
    const sl = await slave();
    const bad = await test(a, body(sl, { modbusRegisters: [{ key: 'x', register: '12345', dataType: 'UINT16' }] }));
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error).toBe('VALIDATION_ERROR');
    const empty = await test(a, body(sl, { modbusRegisters: [] }));
    expect(empty.statusCode).toBe(400);
  });

  it('a Gateway (PUSH) profile is a 400 NOT_A_TCPIP_PROFILE', async () => {
    const sl = await slave();
    const res = await test(a, body(sl, { profileId: pushProfileId }));
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('NOT_A_TCPIP_PROFILE');
  });

  describe('an address another instrument holds', () => {
    let instrumentId = '';
    let hiddenId = '';
    beforeAll(async () => {
      await setReading(false);
      const mk = async (name: string, host: string, loc: string) => {
        const r = await app.inject({
          method: 'POST', url: '/api/instruments', headers: sa,
          payload: { name: C(name), code: C(name), profileId: tcpProfileId, modbusHost: host, modbusPort: 502, modbusRegisters: ONE, functionalLocationId: loc },
        });
        expect(r.statusCode, r.body).toBe(201);
        return r.json().id as string;
      };
      instrumentId = await mk('held', '10.99.0.5', blockIn);
      hiddenId = await mk('hidden', '10.99.0.6', blockOut);
    });
    const at = (host: string, extra: Record<string, unknown> = {}) =>
      test(b, { profileId: tcpProfileId, modbusHost: host, modbusPort: 502, modbusRegisters: ONE, ...extra });

    it('is ADDRESS_IN_USE (200, ok:false) for a new instrument', async () => {
      const res = await at('10.99.0.5');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ ok: false, code: 'ADDRESS_IN_USE' });
    });

    it('is NOT in use against itself when testing the stored instrument', async () => {
      const res = await at('10.99.0.5', { instrumentId });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().code).toBe('READING_OFF'); // passed the address check
    });

    it('a stored instrument the caller cannot see is a 404', async () => {
      const res = await at('10.99.0.6', { instrumentId: hiddenId });
      expect(res.statusCode, res.body).toBe(404);
    });

    it('does not collide with the instrument routes (:id still answers)', async () => {
      const get = await app.inject({ method: 'GET', url: `/api/instruments/${instrumentId}`, headers: sa });
      expect(get.statusCode, get.body).toBe(200);
      expect(get.json().id).toBe(instrumentId);
    });
  });

  it('a user without INSTRUMENT_CREATE / INSTRUMENT_UPDATE is 403', async () => {
    const ro = await user(U('ro'), ROLE_RO);
    const sl = await slave();
    const res = await test(ro, body(sl));
    expect(res.statusCode, res.body).toBe(403);
    expect(sl.connections()).toBe(0);
  });

  it('writes no audit row and no telemetry row, whatever the answer', async () => {
    const stored = await prisma.instrument.findFirstOrThrow({ where: { code: C('held') }, select: { id: true } });
    const audits = () => prisma.auditTrail.count({
      where: { timestamp: { gte: t0 }, OR: [{ action: { startsWith: 'MODBUS' } }, { action: { startsWith: 'TELEMETRY' } }, { action: { startsWith: 'INSTRUMENT_ATTRIBUTE' } }] },
    });
    const latest = () => prisma.instrumentTelemetryLatest.count({ where: { instrumentId: stored.id } });
    const history = async () => Number((await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM instrument_telemetry_history WHERE instrument_id = ${stored.id}`)[0].n);
    const deadLetters = () => prisma.deadLetter.count({ where: { receivedAt: { gte: t0 } } });
    const before = [await audits(), await latest(), await history(), await deadLetters()];
    await setReading(true);
    const ok = await slave();
    const exc = await slave({ holding: HOLDING, input: INPUT, behaviour: 'exception02' });
    expect((await test(b, body(ok))).json().ok).toBe(true);
    expect((await test(b, body(exc, { modbusRegisters: ONE }))).json().ok).toBe(false);
    expect((await test(b, body(ok, { instrumentId: stored.id }))).statusCode).toBe(200);
    expect([await audits(), await latest(), await history(), await deadLetters()]).toEqual(before);
    const ids = (await prisma.instrument.findMany({ where: { profileId: tcpProfileId }, select: { id: true } })).map((i) => i.id);
    expect(await prisma.instrumentTelemetryLatest.count({ where: { instrumentId: { in: ids } } })).toBe(0);
  });

  it('the 11th call within a minute by one user is a 429 (runs last, own user)', async () => {
    await setReading(false);
    const rl = await user(U('rl'), ROLE);
    const sl = await slave();
    for (let i = 0; i < 10; i++) {
      const res = await test(rl, body(sl));
      expect(res.statusCode, `call ${i + 1}: ${res.body}`).toBe(200);
    }
    const eleventh = await test(rl, body(sl));
    expect(eleventh.statusCode, eleventh.body).toBe(429);
    // another user is unaffected: the limit is per user
    const other = await user(U('rl2'), ROLE);
    expect((await test(other, body(sl))).statusCode).toBe(200);
  });
});
