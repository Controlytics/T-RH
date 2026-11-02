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
 * afterAll. Each caller stays under the 30/min limit; the limit case has its
 * own users and runs last.
 */

const s = Date.now();
const ROLE = `MBT_${s}`;
const ROLE_RO = `MBTRO_${s}`;
const ROLE_NONE = `MBTNO_${s}`;
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
let inactivityBefore: { configValue: unknown; configType: string; requiresReauth: boolean } | null = null;
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
/** The form's body: its address, map and Slave ID (CR-1 — the instrument's, sent with the address). */
const body = (slave: FakeSlave, extra: Record<string, unknown> = {}) => ({
  profileId: tcpProfileId, modbusHost: slave.host, modbusPort: slave.port, modbusRegisters: SIX, modbusUnitId: 1, ...extra,
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
  const inact = await prisma.systemConfig.findUnique({ where: { configKey: 'inactivity-alarms' } });
  inactivityBefore = inact ? { configValue: inact.configValue, configType: inact.configType, requiresReauth: inact.requiresReauth } : null;

  const saUser = await prisma.user.create({
    data: { username: U('sa'), fullName: U('sa'), role: 'SUPER_ADMIN', status: 'ENABLED', passwordHash: await hashPassword(SA_PW), passwordChangedAt: new Date() },
  });
  userIds.push(saUser.id);
  sa = { authorization: `Bearer ${await loginAs(app, U('sa'), SA_PW)}`, 'x-reauth-password': SA_PW };

  await prisma.role.create({ data: { name: ROLE, displayName: ROLE, hierarchyLevel: 3, isSystem: false, permissions: ['INSTRUMENT_READ', 'INSTRUMENT_CREATE', 'INSTRUMENT_UPDATE'] } });
  await prisma.role.create({ data: { name: ROLE_RO, displayName: ROLE_RO, hierarchyLevel: 3, isSystem: false, permissions: ['INSTRUMENT_READ'] } });
  await prisma.role.create({ data: { name: ROLE_NONE, displayName: ROLE_NONE, hierarchyLevel: 3, isSystem: false, permissions: [] } });
  invalidateRolePermsCache(ROLE);
  invalidateRolePermsCache(ROLE_RO);

  blockIn = (await prisma.functionalLocation.create({ data: { name: `MBT-in-${s}`, type: 'BLOCK' } })).id;
  blockOut = (await prisma.functionalLocation.create({ data: { name: `MBT-out-${s}`, type: 'BLOCK' } })).id;
  await prisma.roleConfig.create({ data: { role: ROLE, instrumentScope: { locationIds: [blockIn], instrumentIds: [] } as never } });

  tcpProfileId = (await prisma.instrumentProfile.create({ data: { name: `MBT Modbus ${s}`, connection: 'MODBUS_TCP' } })).id;
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
  await step(async () => {
    const ids = (await prisma.instrument.findMany({ where: { code: { startsWith: `MBT-${s}-` } }, select: { id: true } })).map((i) => i.id);
    await prisma.$executeRaw`DELETE FROM instrument_telemetry_history WHERE instrument_id = ANY(${ids}::text[])`;
  });
  await step(async () => {
    if (inactivityBefore) await prisma.systemConfig.update({ where: { configKey: 'inactivity-alarms' }, data: inactivityBefore as never });
    else await prisma.systemConfig.deleteMany({ where: { configKey: 'inactivity-alarms' } });
  });
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
  let a: Record<string, string>; // caller A (under 30 calls)
  let b: Record<string, string>; // caller B (under 30 calls)
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
    const res = await test(a, { profileId: tcpProfileId, modbusHost: '8.8.8.8', modbusPort: 502, modbusRegisters: ONE, modbusUnitId: 1 });
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

  it('reads with the Slave ID it is SENT: a slave answering only unit 7 answers 7 and not 1 (CR-1)', async () => {
    await setReading(true);
    const own = await user(U('u7'), ROLE); // its own user: the 30-a-minute limit
    const sl = await slave({ holding: HOLDING, input: INPUT, unitId: 7 });
    const seven = await test(own, body(sl, { modbusRegisters: ONE, modbusUnitId: 7 }));
    expect(seven.statusCode, seven.body).toBe(200);
    expect(seven.json()).toMatchObject({ ok: true, values: [{ key: 'Temperature', value: 22.4 }] });
    const one = await test(own, body(sl, { modbusRegisters: ONE, modbusUnitId: 1 }));
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json()).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
  });

  it('a Slave ID outside 0..255 is a 400 with the field\'s sentence, a missing one a 400, and the device sees no connection (final review F-6)', async () => {
    // It used to come from the profile; a hand-edited 300 reached the socket and
    // threw inside its 'connect' listener — an uncaught exception.
    await setReading(true);
    const sl = await slave();
    const own = await user(U('unit'), ROLE); // its own user: the 30-a-minute limit
    // null and true too (review M3): with a typed schema Ajv coerced them to
    // 0 and 1 and the device was read; a string is not a Slave ID either.
    // Every value's answer is collected, so a failure names each one let through.
    const values = [300, -1, 1.5, null, true, '7'];
    const answers: unknown[] = [];
    for (const modbusUnitId of values) {
      const res = await test(own, body(sl, { modbusRegisters: ONE, modbusUnitId }));
      answers.push([JSON.stringify(modbusUnitId), res.statusCode, res.json().error, res.json().message]);
    }
    const SENTENCE = 'Slave ID must be a whole number from 0 to 255.';
    expect(answers).toEqual(values.map((v) => [JSON.stringify(v), 400, 'VALIDATION_ERROR', SENTENCE]));
    const { modbusUnitId: _omit, ...withoutUnit } = body(sl, { modbusRegisters: ONE });
    expect((await test(own, withoutUnit)).statusCode).toBe(400);
    await new Promise((r) => setTimeout(r, 100));
    expect(sl.connections()).toBe(0);
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
      test(b, { profileId: tcpProfileId, modbusHost: host, modbusPort: 502, modbusRegisters: ONE, modbusUnitId: 1, ...extra });

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

  it('30 calls a minute per user; the 31st is a 429 whose sentence names the wait (ruling CR1-7; runs last, own user)', async () => {
    await setReading(false);
    const rl = await user(U('rl'), ROLE);
    const sl = await slave();
    // 30, not 10 (2026-11-02): a Test button per key — "add a key, test it" on
    // a 12-key device must not run out inside a minute.
    for (let i = 0; i < 30; i++) {
      const res = await test(rl, body(sl));
      expect(res.statusCode, `call ${i + 1}: ${res.body}`).toBe(200);
    }
    const over = await test(rl, body(sl));
    expect(over.statusCode, over.body).toBe(429);
    // The words the page prints verbatim: the plugin's sentence, the time LEFT
    // in the window in words (`@lukeed/ms` long form), behind the app's code.
    expect(over.json()).toEqual({ error: 'TOO_MANY_REQUESTS', message: expect.stringMatching(/^Rate limit exceeded, retry in \d+ (seconds?|minute)$/) });
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    // another user is unaffected: the limit is per user
    const other = await user(U('rl2'), ROLE);
    expect((await test(other, body(sl))).statusCode).toBe(200);
  });
});

describe('GET /api/instruments/:id/modbus-status', () => {
  let a: Record<string, string>; // ROLE: scope = blockIn
  let ro: Record<string, string>;
  let n = 0;
  const status = (headers: Record<string, string>, id: string) =>
    app.inject({ method: 'GET', url: `/api/instruments/${id}/modbus-status`, headers });
  /** A TCP/IP instrument on its own address (each test gets a free one), Slave ID 1 and read every 60 s unless `extra` says otherwise. */
  async function inst(tag: string, extra: Record<string, unknown> = {}, location: string | null = blockIn) {
    n += 1;
    return prisma.instrument.create({
      data: {
        name: C(tag), code: C(tag), profileId: tcpProfileId, modbusHost: `10.201.${n}.1`, modbusPort: 502,
        modbusRegisters: SIX as never, modbusUnitId: 1, modbusIntervalSec: 60,
        ...(location ? { functionalLocationId: location } : {}), ...extra,
      },
    });
  }
  const setInactivity = (value: Record<string, unknown>) => prisma.systemConfig.upsert({
    where: { configKey: 'inactivity-alarms' },
    create: { configKey: 'inactivity-alarms', configValue: value as never, configType: 'system', requiresReauth: false, updatedAt: new Date() },
    update: { configValue: value as never, updatedAt: new Date() },
  });

  beforeAll(async () => {
    a = await user(U('sa2'), ROLE);
    ro = await user(U('ro2'), ROLE_RO);
  });

  it('a readable instrument with no status row: reading, interval 60, nothing stored', async () => {
    await setReading(true);
    const i = await inst('reading');
    const res = await status(a, i.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      state: 'reading', readBy: 'server', intervalSec: 60, lastSuccessAt: null, failingSince: null,
      stored24h: 0, expected24h: 1440,
    });
    expect(res.json().notReadReason).toBeUndefined();
    expect(res.json().lastError).toBeUndefined();
  });

  it('the interval and the expected count are the INSTRUMENT\'s own (CR-1): 30 s -> 2880 a day', async () => {
    await setReading(true);
    const i = await inst('own-interval', { modbusIntervalSec: 30 });
    const res = await status(a, i.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ state: 'reading', intervalSec: 30, expected24h: 2880 });
  });

  it('a stored interval the Reader does not read at (hand-edited 5 s, or none) is not-read INVALID_CONFIG, nothing expected — never NaN', async () => {
    await setReading(true);
    for (const modbusIntervalSec of [5, null]) {
      const i = await inst(`bad-interval-${modbusIntervalSec}`, { modbusIntervalSec });
      const res = await status(a, i.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ state: 'not-read', notReadReason: 'INVALID_CONFIG', intervalSec: null, expected24h: null });
    }
  });

  it('stored24h counts distinct instants, not rows, and only the last 24 h', async () => {
    const i = await inst('count');
    const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000);
    for (const t of [at(10), at(20), at(30)]) {
      for (const key of ['Temperature', 'Humidity']) {
        await prisma.$executeRaw`INSERT INTO instrument_telemetry_history (instrument_id, key, value, value_type, ts, raw_value)
          VALUES (${i.id}, ${key}, '1'::jsonb, 'number', ${t}, '1'::jsonb)`;
      }
    }
    await prisma.$executeRaw`INSERT INTO instrument_telemetry_history (instrument_id, key, value, value_type, ts, raw_value)
      VALUES (${i.id}, 'Temperature', '1'::jsonb, 'number', ${at(25 * 60)}, '1'::jsonb)`;
    const res = await status(a, i.id);
    expect(res.json().stored24h).toBe(3);
  });

  it('failing only from failingSince; the error is printed with its code, message and time', async () => {
    const i = await inst('failing');
    const since = new Date(Date.now() - 600_000);
    const at = new Date(Date.now() - 5_000);
    await prisma.modbusPollStatus.create({
      data: {
        instrumentId: i.id, lastAttemptAt: at, lastSuccessAt: new Date(Date.now() - 900_000), failingSince: since,
        failureRunStartedAt: since, consecutiveFailures: 9, lastErrorCode: 'NO_ANSWER', lastErrorMessage: 'did not answer', lastErrorAt: at,
      },
    });
    const j = (await status(a, i.id)).json();
    expect(j.state).toBe('failing');
    expect(j.failingSince).toBe(since.toISOString());
    expect(j.lastSuccessAt).not.toBeNull();
    expect(j.lastError).toEqual({ code: 'NO_ANSWER', message: 'did not answer', at: at.toISOString() });
  });

  it('a storage-only error (no failingSince) is NOT failing: reading, with the error shown', async () => {
    const i = await inst('storage');
    const at = new Date(Date.now() - 5_000);
    await prisma.modbusPollStatus.create({
      data: { instrumentId: i.id, lastAttemptAt: at, lastErrorCode: 'STORAGE_FAILED', lastErrorMessage: 'The reading could not be saved.', lastErrorAt: at },
    });
    const j = (await status(a, i.id)).json();
    expect(j.state).toBe('reading');
    expect(j.failingSince).toBeNull();
    expect(j.lastError.code).toBe('STORAGE_FAILED');
  });

  it('not-read, one reason each: disabled, no map, no address, outside the networks, reading off', async () => {
    await setReading(true);
    const disabled = await inst('off', { isActive: false });
    const noMap = await inst('nomap', { modbusRegisters: [] as never });
    const noAddr = await inst('noaddr', { modbusHost: null, modbusPort: null });
    const outside = await inst('outside', { modbusHost: '8.8.8.8' });
    const cases: Array<[string, string]> = [
      [disabled.id, 'INSTRUMENT_DISABLED'], [noMap.id, 'NO_REGISTER_MAP'], [noAddr.id, 'NO_ADDRESS'], [outside.id, 'ADDRESS_NOT_ALLOWED'],
    ];
    for (const [id, reason] of cases) {
      const j = (await status(a, id)).json();
      expect(j.state, reason).toBe('not-read');
      expect(j.notReadReason).toBe(reason);
      expect(typeof j.notReadDetail).toBe('string');
    }
    await setReading(false);
    const fine = await inst('fine');
    expect((await status(a, fine.id)).json()).toMatchObject({ state: 'not-read', notReadReason: 'SERVER_READING_OFF' });
    await setReading(true);
  });

  it('a device the server stopped asking is not-read with its reason, not "failing", whatever a stale failingSince says (final review F-2)', async () => {
    await setReading(true);
    const since = new Date(Date.now() - 3_600_000);
    const at = new Date(Date.now() - 1_800_000);
    // The Reader clears failingSince only on a stored read; a skipped read writes nothing.
    const stale = (instrumentId: string) => prisma.modbusPollStatus.create({
      data: {
        instrumentId, lastAttemptAt: at, lastSuccessAt: new Date(Date.now() - 7_200_000), failingSince: since,
        failureRunStartedAt: since, consecutiveFailures: 12, lastErrorCode: 'NO_ANSWER', lastErrorMessage: 'did not answer', lastErrorAt: at,
      },
    });

    const disabled = await inst('stale-disabled', { isActive: false });
    await stale(disabled.id);
    const d = (await status(a, disabled.id)).json();
    expect(d).toMatchObject({ state: 'not-read', notReadReason: 'INSTRUMENT_DISABLED', notReadDetail: 'The instrument is disabled.' });
    // Still returned, so the card can say when the device last stopped answering.
    expect(d.failingSince).toBe(since.toISOString());
    expect(d.lastError.code).toBe('NO_ANSWER');

    const off = await inst('stale-reading-off');
    await stale(off.id);
    await setReading(false);
    try {
      expect((await status(a, off.id)).json()).toMatchObject({ state: 'not-read', notReadReason: 'SERVER_READING_OFF', failingSince: since.toISOString() });
    } finally {
      await setReading(true);
    }
    // Positive control: the same stale row on an instrument the server reads IS failing.
    expect((await status(a, off.id)).json()).toMatchObject({ state: 'failing', failingSince: since.toISOString() });
  });

  it('inactivityAlarmsOff follows the Inactivity Alarms setting', async () => {
    const i = await inst('inact');
    await setInactivity({ enabled: false, graceMinutes: 15 });
    expect((await status(a, i.id)).json().inactivityAlarmsOff).toBe(true);
    await setInactivity({ enabled: true, graceMinutes: 15 });
    expect((await status(a, i.id)).json().inactivityAlarmsOff).toBe(false);
  });

  it('a PUSH instrument is 400; outside the caller scope or unknown is 404', async () => {
    const push = await prisma.instrument.create({ data: { name: C('push'), code: C('push'), profileId: pushProfileId, functionalLocationId: blockIn } });
    expect((await status(a, push.id)).statusCode).toBe(400);
    const out = await inst('outscope', {}, blockOut);
    expect((await status(a, out.id)).statusCode).toBe(404);
    expect((await status(sa, out.id)).statusCode).toBe(200);
    expect((await status(a, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('a caller without INSTRUMENT_READ is 403', async () => {
    const none = await user(U('none'), ROLE_NONE);
    const i = await inst('noperm');
    expect((await status(none, i.id)).statusCode).toBe(403);
    expect((await status(ro, i.id)).statusCode).not.toBe(403); // INSTRUMENT_READ is enough to ask
  });
});
