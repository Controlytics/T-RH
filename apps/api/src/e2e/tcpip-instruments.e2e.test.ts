import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { DEVICE_NETWORKS_DEFAULT, MODBUS_UNIT_ID_MESSAGE, MODBUS_INTERVAL_MESSAGE } from '@digilog/shared';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { loadModbusReaderConfig } from '../modules/modbus/config.js';
import { checkModbusAddress } from '../modules/modbus/address.js';

/**
 * TCP/IP (Modbus) instruments, Task 4 — an instrument in a TCP/IP profile has
 * its own IP address, port and register map, no access token, and the server
 * decides every rule: which addresses are allowed (Configuration → TCP/IP
 * Reading), which are in use (named only to a caller who can see the holder),
 * who may change a map, and that a change carries a reason.
 *
 * Owns its fixtures: its own super admin, its own role (instrument rights,
 * scoped to one Block), its own profiles and Blocks. The `modbus-reader` row is
 * restored FIRST in `afterAll`.
 */

const s = Date.now();
const SA_NAME = `tcpisa${s}`;
const OP_NAME = `tcpiop${s}`;
const SA_PW = 'Tcpi@SuperAdmin1';
const OP_PW = 'Tcpi@Operator1';
const ROLE = `TCPI_${s}`;
const C = (n: string) => `TCPI-${s}-${n}`;

let app: FastifyInstance;
let sa: Record<string, string>;
let op: Record<string, string>;
let pushProfileId = '';
let tcpProfileId = '';
let tcpProfile2Id = '';
let blockIn = '';
let blockOut = '';
const userIds: string[] = [];
const extraProfileIds: string[] = [];
let readerRowBefore: { configValue: unknown; configType: string; requiresReauth: boolean } | null = null;

const MAP = [
  { key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Humidity', register: '40003', dataType: 'UINT16', scale: 0.1 },
];
const MAP2 = [
  { key: 'Temperature', register: '40011', dataType: 'FLOAT32', byteOrder: 'CDAB', scale: 1 },
];

const create = (headers: Record<string, string>, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/instruments', headers, payload });
const put = (headers: Record<string, string>, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers, payload });
const putReader = (payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: '/api/config/dynamic/modbus-reader', headers: sa, payload });

/** A TCP/IP instrument created by the super admin (Block "out" unless placed). */
async function tcp(name: string, host: string, port: number, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await create(sa, {
    name: C(name), code: C(name), profileId: tcpProfileId,
    modbusHost: host, modbusPort: port, modbusRegisters: MAP,
    functionalLocationId: blockOut, ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function pushInstrument(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await create(sa, { name: C(name), code: C(name), profileId: pushProfileId, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function setNetworks(deviceNetworks: string) {
  const res = await putReader({ serverReadingEnabled: false, deviceNetworks });
  expect(res.statusCode, res.body).toBe(200);
}

beforeAll(async () => {
  app = await buildApp();
  // The def's row exists from here on (`seedDefaults` ran in buildApp) — this is
  // what afterAll puts back.
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'modbus-reader' } });
  readerRowBefore = row ? { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth } : null;

  const saUser = await prisma.user.create({
    data: { username: SA_NAME, fullName: SA_NAME, role: 'SUPER_ADMIN', status: 'ENABLED', passwordHash: await hashPassword(SA_PW), passwordChangedAt: new Date() },
  });
  userIds.push(saUser.id);
  await prisma.role.create({
    data: { name: ROLE, displayName: `TCPI ${s}`, hierarchyLevel: 3, isSystem: false, permissions: ['INSTRUMENT_READ', 'INSTRUMENT_CREATE', 'INSTRUMENT_UPDATE'] },
  });
  invalidateRolePermsCache(ROLE);
  const opUser = await prisma.user.create({
    data: { username: OP_NAME, fullName: OP_NAME, role: ROLE, status: 'ENABLED', passwordHash: await hashPassword(OP_PW), passwordChangedAt: new Date() },
  });
  userIds.push(opUser.id);

  blockIn = (await prisma.functionalLocation.create({ data: { name: `TCPI-block-in-${s}`, type: 'BLOCK' } })).id;
  blockOut = (await prisma.functionalLocation.create({ data: { name: `TCPI-block-out-${s}`, type: 'BLOCK' } })).id;
  await prisma.roleConfig.create({ data: { role: ROLE, instrumentScope: { locationIds: [blockIn], instrumentIds: [] } as never } });

  pushProfileId = (await prisma.instrumentProfile.create({ data: { name: `TCPI Push ${s}` } })).id;
  tcpProfileId = (await prisma.instrumentProfile.create({ data: { name: `TCPI Modbus ${s}`, connection: 'MODBUS_TCP' } })).id;
  tcpProfile2Id = (await prisma.instrumentProfile.create({ data: { name: `TCPI Modbus2 ${s}`, connection: 'MODBUS_TCP' } })).id;

  sa = { authorization: `Bearer ${await loginAs(app, SA_NAME, SA_PW)}`, 'x-reauth-password': SA_PW };
  op = { authorization: `Bearer ${await loginAs(app, OP_NAME, OP_PW)}`, 'x-reauth-password': OP_PW };
});

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { failures.push(e); } };
  // The configuration this file changes goes back FIRST, whatever else fails.
  await step(async () => {
    if (readerRowBefore) await prisma.systemConfig.update({ where: { configKey: 'modbus-reader' }, data: readerRowBefore as never });
    else await prisma.systemConfig.deleteMany({ where: { configKey: 'modbus-reader' } });
  });
  await step(() => prisma.instrument.deleteMany({ where: { code: { startsWith: `TCPI-${s}-` } } }));
  await step(() => prisma.instrumentProfile.deleteMany({ where: { id: { in: [pushProfileId, tcpProfileId, tcpProfile2Id, ...extraProfileIds].filter(Boolean) } } }));
  await step(() => prisma.functionalLocation.deleteMany({ where: { id: { in: [blockIn, blockOut].filter(Boolean) } } }));
  await step(() => prisma.roleConfig.deleteMany({ where: { role: ROLE } }));
  await step(() => prisma.session.deleteMany({ where: { userId: { in: userIds } } }));
  await step(() => prisma.passwordHistory.deleteMany({ where: { userId: { in: userIds } } }));
  await step(() => prisma.user.deleteMany({ where: { id: { in: userIds } } }));
  await step(() => prisma.role.deleteMany({ where: { name: ROLE } }));
  invalidateRolePermsCache(ROLE);
  await step(() => app.close());
  if (failures.length > 0) throw new AggregateError(failures, 'tcpip-instruments teardown failed');
});

describe('Configuration → TCP/IP Reading (modbus-reader)', () => {
  it('reads OFF with the three private ranges by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/dynamic/modbus-reader', headers: sa });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ serverReadingEnabled: false, deviceNetworks: DEVICE_NETWORKS_DEFAULT });
  });

  it('refuses an invalid network, naming it, and stores nothing', async () => {
    const before = await prisma.systemConfig.findUniqueOrThrow({ where: { configKey: 'modbus-reader' } });
    const res = await putReader({ serverReadingEnabled: false, deviceNetworks: '192.168.1.0/24, 192.168.1.0/33' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('192.168.1.0/33');
    const after = await prisma.systemConfig.findUniqueOrThrow({ where: { configKey: 'modbus-reader' } });
    expect(after.configValue).toEqual(before.configValue);
  });

  it('refuses a body without the device networks (a whole-row write would erase a narrowed list)', async () => {
    const res = await putReader({ serverReadingEnabled: false });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a valid list (positive control for the two refusals above)', async () => {
    await setNetworks('192.168.1.0/24\n10.20.0.0/16');
    expect(await loadModbusReaderConfig()).toEqual({ serverReadingEnabled: false, deviceNetworks: ['192.168.1.0/24', '10.20.0.0/16'] });
    await setNetworks(DEVICE_NETWORKS_DEFAULT);
  });

  it('the loader: an absent row is OFF with the defaults; a bad stored entry never widens the list; only `true` is ON', async () => {
    const row = await prisma.systemConfig.findUniqueOrThrow({ where: { configKey: 'modbus-reader' } });
    try {
      await prisma.systemConfig.delete({ where: { configKey: 'modbus-reader' } });
      expect(await loadModbusReaderConfig()).toEqual({
        serverReadingEnabled: false,
        deviceNetworks: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
      });
      await prisma.systemConfig.create({
        data: { configKey: 'modbus-reader', configType: row.configType, requiresReauth: row.requiresReauth, configValue: { serverReadingEnabled: 'true', deviceNetworks: '192.168.1.0/24, banana, 0.0.0.0/99' } },
      });
      expect(await loadModbusReaderConfig()).toEqual({ serverReadingEnabled: false, deviceNetworks: ['192.168.1.0/24'] });
      await prisma.systemConfig.update({ where: { configKey: 'modbus-reader' }, data: { configValue: { serverReadingEnabled: true, deviceNetworks: ['10.0.0.0/8'] } } });
      // Not text at all: nothing is allowed, rather than the defaults.
      expect(await loadModbusReaderConfig()).toEqual({ serverReadingEnabled: true, deviceNetworks: [] });
    } finally {
      await prisma.systemConfig.upsert({
        where: { configKey: 'modbus-reader' },
        create: { configKey: 'modbus-reader', configType: row.configType, requiresReauth: row.requiresReauth, configValue: row.configValue as never },
        update: { configValue: row.configValue as never },
      });
    }
  });
});

describe('checkModbusAddress — on its own, without zod in front of it', () => {
  const vis = { scope: null, where: undefined, placeable: null };
  it('refuses a hostname, loopback, link-local, multicast and a bad port', async () => {
    for (const host of ['plc.local', '127.0.0.1', '169.254.169.254', '224.0.0.1', '255.255.255.255', '0.1.2.3']) {
      const r = await checkModbusAddress(host, 502, { visibility: vis });
      expect(r, host).toMatchObject({ ok: false, status: 400, code: 'ADDRESS_NOT_ALLOWED' });
    }
    expect(await checkModbusAddress('192.168.77.9', 0, { visibility: vis })).toMatchObject({ ok: false, code: 'ADDRESS_NOT_ALLOWED' });
    expect(await checkModbusAddress('192.168.77.9', 70000, { visibility: vis })).toMatchObject({ ok: false, code: 'ADDRESS_NOT_ALLOWED' });
    expect(await checkModbusAddress('192.168.77.9', 502, { visibility: vis })).toEqual({ ok: true });
  });

  it('allowLoopbackForTests admits 127.0.0.1 ONLY, and nothing else of the refused ranges', async () => {
    expect(await checkModbusAddress('127.0.0.1', 1502, { visibility: vis, allowLoopbackForTests: true })).toEqual({ ok: true });
    expect(await checkModbusAddress('127.0.0.2', 1502, { visibility: vis, allowLoopbackForTests: true })).toMatchObject({ ok: false, code: 'ADDRESS_NOT_ALLOWED' });
    expect(await checkModbusAddress('169.254.169.254', 80, { visibility: vis, allowLoopbackForTests: true })).toMatchObject({ ok: false, code: 'ADDRESS_NOT_ALLOWED' });
  });
});

describe('POST /api/instruments — a TCP/IP profile', () => {
  it('creates the instrument with its address and map, and NO token and NO credential', async () => {
    const res = await create(sa, {
      name: C('new'), code: C('new'), profileId: tcpProfileId,
      modbusHost: '192.168.77.10', modbusPort: 502, modbusRegisters: MAP,
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body).not.toHaveProperty('token');
    expect(body).toMatchObject({ modbusHost: '192.168.77.10', modbusPort: 502, connection: 'MODBUS_TCP', tokenPrefix: null });
    // Every inner key of the map survives the response filter.
    expect(body.modbusRegisters).toEqual(MAP);
    expect(await prisma.instrumentCredential.count({ where: { instrumentId: body.id } })).toBe(0);
    const audit = await prisma.auditTrail.findFirstOrThrow({ where: { targetId: body.id, action: 'INSTRUMENT_CREATED' } });
    expect(audit.afterValue).toMatchObject({ code: C('new'), modbusHost: '192.168.77.10', modbusPort: 502, modbusRegisters: MAP });
    expect(audit.signatureMeaning).not.toContain('token');
  });

  it('an omitted Slave ID and read interval are stored as 1 and 60 s — on the row, the response and the record (CR-1)', async () => {
    const res = await create(sa, { name: C('dflt'), code: C('dflt'), profileId: tcpProfileId, modbusHost: '192.168.77.15', modbusPort: 502 });
    expect(res.statusCode, res.body).toBe(201);
    // Both DECLARED on the response, or Fastify strips them.
    expect(res.json()).toMatchObject({ modbusUnitId: 1, modbusIntervalSec: 60 });
    const row = await prisma.instrument.findUniqueOrThrow({ where: { id: res.json().id } });
    expect([row.modbusUnitId, row.modbusIntervalSec]).toEqual([1, 60]);
    const audit = await prisma.auditTrail.findFirstOrThrow({ where: { targetId: row.id, action: 'INSTRUMENT_CREATED' } });
    expect(audit.afterValue).toMatchObject({ modbusUnitId: 1, modbusIntervalSec: 60 });
    // null is "not given" too.
    const nul = await create(sa, { name: C('dflt-null'), code: C('dflt-null'), profileId: tcpProfileId, modbusHost: '192.168.77.16', modbusPort: 502, modbusUnitId: null, modbusIntervalSec: null });
    expect(nul.statusCode, nul.body).toBe(201);
    expect(nul.json()).toMatchObject({ modbusUnitId: 1, modbusIntervalSec: 60 });
  });

  it('a Slave ID and read interval that were sent are the instrument\'s own — two instruments of ONE profile differ (CR-1)', async () => {
    const a = await create(sa, { name: C('own-a'), code: C('own-a'), profileId: tcpProfileId, modbusHost: '192.168.77.17', modbusPort: 502, modbusUnitId: 7, modbusIntervalSec: 45 });
    const b = await create(sa, { name: C('own-b'), code: C('own-b'), profileId: tcpProfileId, modbusHost: '192.168.77.18', modbusPort: 502, modbusUnitId: 0, modbusIntervalSec: 3600 });
    expect(a.statusCode, a.body).toBe(201);
    expect(b.statusCode, b.body).toBe(201);
    expect(a.json()).toMatchObject({ modbusUnitId: 7, modbusIntervalSec: 45 });
    expect(b.json()).toMatchObject({ modbusUnitId: 0, modbusIntervalSec: 3600 });
    expect(await prisma.instrument.findUniqueOrThrow({ where: { id: a.json().id }, select: { modbusUnitId: true, modbusIntervalSec: true } }))
      .toEqual({ modbusUnitId: 7, modbusIntervalSec: 45 });
  });

  it.each([
    ['modbusUnitId', 256, MODBUS_UNIT_ID_MESSAGE], ['modbusUnitId', -1, MODBUS_UNIT_ID_MESSAGE],
    ['modbusIntervalSec', 9, MODBUS_INTERVAL_MESSAGE], ['modbusIntervalSec', 3601, MODBUS_INTERVAL_MESSAGE],
  ] as const)('refuses %s = %s with the field\'s one sentence, and creates nothing', async (field, value, message) => {
    const res = await create(sa, { name: C('range'), code: C('range'), profileId: tcpProfileId, modbusHost: '192.168.77.19', modbusPort: 502, [field]: value });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.fieldErrors[field]).toEqual([message]);
    expect(await prisma.instrument.count({ where: { code: C('range') } })).toBe(0);
  });

  it('an omitted map is stored as an empty map (an instrument not read until it has one)', async () => {
    const res = await create(sa, { name: C('nomap'), code: C('nomap'), profileId: tcpProfileId, modbusHost: '192.168.77.11', modbusPort: 502 });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().modbusRegisters).toEqual([]);
  });

  it('refuses gateway mode and a gateway link (NOT_FOR_TCPIP), and creates nothing', async () => {
    const gw = await pushInstrument('gw', { isGateway: true });
    const a = await create(sa, { name: C('isgw'), code: C('isgw'), profileId: tcpProfileId, modbusHost: '192.168.77.12', modbusPort: 502, isGateway: true });
    expect(a.statusCode, a.body).toBe(400);
    expect(a.json().error).toBe('NOT_FOR_TCPIP');
    const b = await create(sa, { name: C('child'), code: C('child'), profileId: tcpProfileId, modbusHost: '192.168.77.13', modbusPort: 502, gatewayId: gw });
    expect(b.statusCode, b.body).toBe(400);
    expect(b.json().error).toBe('NOT_FOR_TCPIP');
    expect(await prisma.instrument.count({ where: { code: { in: [C('isgw'), C('child')] } } })).toBe(0);
  });

  it('refuses a missing IP address or port with the validation shape', async () => {
    const noHost = await create(sa, { name: C('nohost'), code: C('nohost'), profileId: tcpProfileId, modbusPort: 502 });
    expect(noHost.statusCode).toBe(400);
    expect(noHost.json().error).toBe('VALIDATION_ERROR');
    expect(noHost.json().details.fieldErrors.modbusHost[0]).toBeTruthy();
    const noPort = await create(sa, { name: C('noport'), code: C('noport'), profileId: tcpProfileId, modbusHost: '192.168.77.14' });
    expect(noPort.statusCode).toBe(400);
    expect(noPort.json().details.fieldErrors.modbusPort[0]).toBeTruthy();
  });

  it('refuses 127.0.0.1 and a hostname as ADDRESS_NOT_ALLOWED', async () => {
    for (const host of ['127.0.0.1', 'plc.local']) {
      const res = await create(sa, { name: C('lo'), code: C('lo'), profileId: tcpProfileId, modbusHost: host, modbusPort: 502 });
      expect(res.statusCode, host).toBe(400);
      expect(res.json().error, host).toBe('ADDRESS_NOT_ALLOWED');
    }
  });

  it('refuses an address outside the configured device networks', async () => {
    await setNetworks('192.168.1.0/24');
    try {
      const out = await create(sa, { name: C('net-out'), code: C('net-out'), profileId: tcpProfileId, modbusHost: '10.0.0.5', modbusPort: 502 });
      expect(out.statusCode).toBe(400);
      expect(out.json().error).toBe('ADDRESS_NOT_ALLOWED');
      expect(out.json().message).toContain('192.168.1.0/24');
      // Positive control: inside the narrowed list.
      const inside = await create(sa, { name: C('net-in'), code: C('net-in'), profileId: tcpProfileId, modbusHost: '192.168.1.50', modbusPort: 502 });
      expect(inside.statusCode, inside.body).toBe(201);
    } finally {
      await setNetworks(DEVICE_NETWORKS_DEFAULT);
    }
  });

  it('refuses an address in use, naming the instrument that holds it', async () => {
    await tcp('holder', '192.168.77.20', 502);
    const res = await create(sa, { name: C('clash'), code: C('clash'), profileId: tcpProfileId, modbusHost: '192.168.77.20', modbusPort: 502 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('ADDRESS_IN_USE');
    expect(res.json().message).toContain(C('holder'));
    // Another port on the same device is another address.
    const other = await create(sa, { name: C('port2'), code: C('port2'), profileId: tcpProfileId, modbusHost: '192.168.77.20', modbusPort: 503 });
    expect(other.statusCode, other.body).toBe(201);
  });

  it('names the holder only to a caller who can see it', async () => {
    await tcp('hidden', '192.168.77.21', 502); // in Block "out", outside the role's scope
    const hidden = await create(op, { name: C('op1'), code: C('op1'), profileId: tcpProfileId, modbusHost: '192.168.77.21', modbusPort: 502, functionalLocationId: blockIn });
    expect(hidden.statusCode).toBe(409);
    expect(hidden.json().error).toBe('ADDRESS_IN_USE');
    expect(hidden.json().message).not.toContain(C('hidden'));
    expect(hidden.json().message).toMatch(/already in use/);
    // Positive control: a holder inside the scope is named.
    await tcp('visible', '192.168.77.22', 502, { functionalLocationId: blockIn });
    const named = await create(op, { name: C('op2'), code: C('op2'), profileId: tcpProfileId, modbusHost: '192.168.77.22', modbusPort: 502, functionalLocationId: blockIn });
    expect(named.statusCode).toBe(409);
    expect(named.json().message).toContain(C('visible'));
  });
});

describe('POST /api/instruments — a Gateway (PUSH) profile', () => {
  it.each([
    ['modbusHost', { modbusHost: '192.168.77.30' }],
    ['modbusPort', { modbusPort: 502 }],
    ['modbusRegisters', { modbusRegisters: [] }],
    // CR-1 (2026-11-02): the Slave ID and read interval are TCP/IP-only too.
    ['modbusUnitId', { modbusUnitId: 1 }],
    ['modbusIntervalSec', { modbusIntervalSec: 60 }],
  ])('refuses %s (NOT_A_TCPIP_PROFILE)', async (_f, extra) => {
    const res = await create(sa, { name: C('push-x'), code: C('push-x'), profileId: pushProfileId, ...extra });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('NOT_A_TCPIP_PROFILE');
    expect(await prisma.instrument.count({ where: { code: C('push-x') } })).toBe(0);
  });

  it('still issues a token for a Gateway-profile instrument (positive control)', async () => {
    const res = await create(sa, { name: C('push-ok'), code: C('push-ok'), profileId: pushProfileId });
    expect(res.statusCode, res.body).toBe(201);
    expect(typeof res.json().token).toBe('string');
    expect(res.json()).toMatchObject({ connection: 'PUSH', modbusHost: null, modbusPort: null, modbusRegisters: null, modbusUnitId: null, modbusIntervalSec: null });
  });
});

describe('token routes refuse a TCP/IP instrument', () => {
  it('regenerate, reveal and set → 400 NO_TOKEN_FOR_TCPIP; a Gateway instrument still regenerates', async () => {
    const id = await tcp('tok', '192.168.77.40', 502);
    const regen = await app.inject({ method: 'POST', url: `/api/instruments/${id}/regenerate-token`, headers: sa });
    const reveal = await app.inject({ method: 'GET', url: `/api/instruments/${id}/token`, headers: sa });
    const set = await app.inject({ method: 'PUT', url: `/api/instruments/${id}/token`, headers: sa, payload: { token: 'abcdefghijklmnop' } });
    for (const r of [regen, reveal, set]) {
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error).toBe('NO_TOKEN_FOR_TCPIP');
    }
    expect(await prisma.instrumentCredential.count({ where: { instrumentId: id } })).toBe(0);
    const pushId = await pushInstrument('tok-push');
    expect((await app.inject({ method: 'POST', url: `/api/instruments/${pushId}/regenerate-token`, headers: sa })).statusCode).toBe(200);
  });
});

describe('PUT /api/instruments/:id — a TCP/IP instrument', () => {
  it('an address change needs a reason, and is audited with it', async () => {
    const id = await tcp('addr', '192.168.77.50', 502);
    const bare = await put(sa, id, { modbusHost: '192.168.77.51' });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error).toBe('REASON_REQUIRED');
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id } })).modbusHost).toBe('192.168.77.50');

    const ok = await put(sa, id, { modbusHost: '192.168.77.51', modbusPort: 5020, reason: 'device moved to panel B' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ modbusHost: '192.168.77.51', modbusPort: 5020 });
    const audit = await prisma.auditTrail.findFirstOrThrow({ where: { targetId: id, action: 'INSTRUMENT_UPDATED' }, orderBy: { timestamp: 'desc' } });
    expect(audit.beforeValue).toMatchObject({ modbusHost: '192.168.77.50', modbusPort: 502 });
    expect(audit.afterValue).toMatchObject({ modbusHost: '192.168.77.51', modbusPort: 5020 });
    expect(audit.reason).toBe('device moved to panel B');
    // `reason` is the change's reason, never a field of the instrument.
    expect(audit.afterValue).not.toHaveProperty('reason');
  });

  it('the same address and map sent back are no change: no reason needed, nothing refused', async () => {
    const id = await tcp('same', '192.168.77.52', 502);
    // A whole-form save: every field as stored, plus the two gateway fields at
    // their "off" values, and no reason.
    const same = await put(sa, id, { modbusHost: '192.168.77.52', modbusPort: 502, modbusRegisters: MAP, isGateway: false, gatewayId: null, description: 'x' });
    expect(same.statusCode, same.body).toBe(200);
    const audit = await prisma.auditTrail.findFirstOrThrow({ where: { targetId: id, action: 'INSTRUMENT_UPDATED' }, orderBy: { timestamp: 'desc' } });
    expect(audit.reason).toBeNull();
  });

  it('a map edit is super admin only (403 REGISTER_MAP_SA_ONLY, even with a reason), and needs a reason', async () => {
    const id = await tcp('map', '192.168.77.53', 502, { functionalLocationId: blockIn });
    const notSa = await put(op, id, { modbusRegisters: MAP2, reason: 'rescaled' });
    expect(notSa.statusCode, notSa.body).toBe(403);
    expect(notSa.json().error).toBe('REGISTER_MAP_SA_ONLY');
    // The same map sent back by the same role is no change, so not refused.
    expect((await put(op, id, { modbusRegisters: MAP, description: 'same map' })).statusCode).toBe(200);
    // ...and an address change by that role is INSTRUMENT_UPDATE + reason.
    expect((await put(op, id, { modbusPort: 5021, reason: 'port moved' })).statusCode).toBe(200);

    const noReason = await put(sa, id, { modbusRegisters: MAP2 });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error).toBe('REASON_REQUIRED');
    const ok = await put(sa, id, { modbusRegisters: MAP2, reason: 'register map from the vendor sheet' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().modbusRegisters).toEqual(MAP2);
    const audit = await prisma.auditTrail.findFirstOrThrow({ where: { targetId: id, action: 'INSTRUMENT_UPDATED' }, orderBy: { timestamp: 'desc' } });
    expect(audit.beforeValue).toMatchObject({ modbusRegisters: MAP });
    expect(audit.afterValue).toMatchObject({ modbusRegisters: MAP2 });
    expect(audit.reason).toBe('register map from the vendor sheet');
  });

  it('a Slave ID or read interval change needs a reason, by any Instrument Update role, and is audited with it (CR-1)', async () => {
    const id = await tcp('rd', '192.168.77.58', 502, { functionalLocationId: blockIn, modbusUnitId: 3, modbusIntervalSec: 30 });
    for (const [field, to] of [['modbusUnitId', 7], ['modbusIntervalSec', 45]] as const) {
      const bare = await put(op, id, { [field]: to });
      expect(bare.statusCode, field).toBe(400);
      expect(bare.json().error).toBe('REASON_REQUIRED');
      expect(bare.json().message).toContain(field === 'modbusUnitId' ? 'Slave ID' : 'read interval');
    }
    expect(await prisma.instrument.findUniqueOrThrow({ where: { id }, select: { modbusUnitId: true, modbusIntervalSec: true } }))
      .toEqual({ modbusUnitId: 3, modbusIntervalSec: 30 });

    // Not super-admin only (ruling CR1-3: the address's governance) — the role holds INSTRUMENT_UPDATE.
    const ok = await put(op, id, { modbusUnitId: 7, modbusIntervalSec: 45, reason: 'slave moved to unit 7, read faster' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ modbusUnitId: 7, modbusIntervalSec: 45, effectiveExpectedIntervalSec: 45 });
    const audit = await prisma.auditTrail.findFirstOrThrow({ where: { targetId: id, action: 'INSTRUMENT_UPDATED' }, orderBy: { timestamp: 'desc' } });
    expect(audit.beforeValue).toMatchObject({ modbusUnitId: 3, modbusIntervalSec: 30 });
    expect(audit.afterValue).toMatchObject({ modbusUnitId: 7, modbusIntervalSec: 45 });
    expect(audit.reason).toBe('slave moved to unit 7, read faster');
    expect(audit.signatureMeaning).toBe(`Instrument "${C('rd')}" Slave ID and read interval changed`);
  });

  it('one PUT changing the address, map, Slave ID and read interval names all four in one record', async () => {
    const id = await tcp('all4', '192.168.77.59', 502);
    const res = await put(sa, id, { modbusHost: '192.168.77.61', modbusRegisters: MAP2, modbusUnitId: 9, modbusIntervalSec: 120, reason: 'panel rebuilt' });
    expect(res.statusCode, res.body).toBe(200);
    const audit = await prisma.auditTrail.findFirstOrThrow({ where: { targetId: id, action: 'INSTRUMENT_UPDATED' }, orderBy: { timestamp: 'desc' } });
    expect(audit.signatureMeaning).toBe(`Instrument "${C('all4')}" TCP/IP address, register map, Slave ID and read interval changed`);
  });

  it('the stored Slave ID and read interval sent back are no change; null is refused and nothing is written', async () => {
    const id = await tcp('rd-same', '192.168.77.62', 502, { modbusUnitId: 4, modbusIntervalSec: 20 });
    const same = await put(sa, id, { modbusUnitId: 4, modbusIntervalSec: 20, description: 'whole-form save' });
    expect(same.statusCode, same.body).toBe(200);
    const audit = await prisma.auditTrail.findFirstOrThrow({ where: { targetId: id, action: 'INSTRUMENT_UPDATED' }, orderBy: { timestamp: 'desc' } });
    expect(audit.reason).toBeNull();
    expect(audit.signatureMeaning).toBe(`Instrument "${C('rd-same')}" updated`);
    for (const field of ['modbusUnitId', 'modbusIntervalSec'] as const) {
      const cleared = await put(sa, id, { [field]: null, reason: 'clearing' });
      expect(cleared.statusCode, field).toBe(400);
      expect(cleared.json().error).toBe('VALIDATION_ERROR');
      expect(cleared.json().details.fieldErrors[field][0]).toBeTruthy();
    }
    const out = await put(sa, id, { modbusIntervalSec: 5, reason: 'too fast' });
    expect(out.statusCode).toBe(400);
    expect(out.json().details.fieldErrors.modbusIntervalSec).toEqual([MODBUS_INTERVAL_MESSAGE]);
    expect(await prisma.instrument.findUniqueOrThrow({ where: { id }, select: { modbusUnitId: true, modbusIntervalSec: true } }))
      .toEqual({ modbusUnitId: 4, modbusIntervalSec: 20 });
  });

  it('refuses an address in use, a refused address, and clearing the address', async () => {
    await tcp('busy', '192.168.77.54', 502);
    const id = await tcp('mover', '192.168.77.55', 502);
    const inUse = await put(sa, id, { modbusHost: '192.168.77.54', reason: 'moving the device' });
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().error).toBe('ADDRESS_IN_USE');
    const lo = await put(sa, id, { modbusHost: '127.0.0.1', reason: 'moving the device' });
    expect(lo.statusCode).toBe(400);
    expect(lo.json().error).toBe('ADDRESS_NOT_ALLOWED');
    const cleared = await put(sa, id, { modbusHost: null, reason: 'moving the device' });
    expect(cleared.statusCode).toBe(400);
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id } })).modbusHost).toBe('192.168.77.55');
  });

  it('refuses gateway mode and a gateway link (NOT_FOR_TCPIP)', async () => {
    const gw = await pushInstrument('gw2', { isGateway: true });
    const id = await tcp('nogw', '192.168.77.56', 502);
    const a = await put(sa, id, { isGateway: true });
    expect(a.statusCode).toBe(400);
    expect(a.json().error).toBe('NOT_FOR_TCPIP');
    const b = await put(sa, id, { gatewayId: gw });
    expect(b.statusCode).toBe(400);
    expect(b.json().error).toBe('NOT_FOR_TCPIP');
  });

  it('a move between a Gateway and a TCP/IP profile is refused either way (CONNECTION_DIFFERS); TCP/IP → TCP/IP is not', async () => {
    const t = await tcp('move-t', '192.168.77.57', 502);
    const p = await pushInstrument('move-p');
    const toPush = await put(sa, t, { profileId: pushProfileId });
    expect(toPush.statusCode).toBe(409);
    expect(toPush.json().error).toBe('CONNECTION_DIFFERS');
    const toTcp = await put(sa, p, { profileId: tcpProfileId });
    expect(toTcp.statusCode).toBe(409);
    expect(toTcp.json().error).toBe('CONNECTION_DIFFERS');
    const sideways = await put(sa, t, { profileId: tcpProfile2Id });
    expect(sideways.statusCode, sideways.body).toBe(200);
  });
});

describe('PUT /api/instruments/:id — a Gateway (PUSH) instrument', () => {
  it('refuses a Modbus field (NOT_A_TCPIP_PROFILE) and takes a stray `reason` without a 500', async () => {
    const id = await pushInstrument('push-put');
    const res = await put(sa, id, { modbusHost: '192.168.77.60' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NOT_A_TCPIP_PROFILE');
    // `reason` is not a column: it must never reach the update.
    const withReason = await put(sa, id, { description: 'note', reason: 'housekeeping', modbusHost: null });
    expect(withReason.statusCode, withReason.body).toBe(200);
  });

  it('refuses a Slave ID or read interval (NOT_A_TCPIP_PROFILE); their "off" value null is accepted (CR-1)', async () => {
    const id = await pushInstrument('push-rd');
    for (const extra of [{ modbusUnitId: 1 }, { modbusIntervalSec: 60 }]) {
      const res = await put(sa, id, extra);
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect(res.json().error).toBe('NOT_A_TCPIP_PROFILE');
    }
    const off = await put(sa, id, { modbusUnitId: null, modbusIntervalSec: null, description: 'whole-form save' });
    expect(off.statusCode, off.body).toBe(200);
    expect(await prisma.instrument.findUniqueOrThrow({ where: { id }, select: { modbusUnitId: true, modbusIntervalSec: true } }))
      .toEqual({ modbusUnitId: null, modbusIntervalSec: null });
  });
});

describe('reading TCP/IP instruments back', () => {
  it('GET ?connection=MODBUS_TCP lists only TCP/IP instruments in view; PUSH the others', async () => {
    const inView = await tcp('list-in', '192.168.77.70', 502, { functionalLocationId: blockIn });
    const outView = await tcp('list-out', '192.168.77.71', 502);
    const push = await pushInstrument('list-push', { functionalLocationId: blockIn });

    const q = (h: Record<string, string>, connection: string) =>
      app.inject({ method: 'GET', url: `/api/instruments?connection=${connection}&search=TCPI-${s}-list&limit=200`, headers: h });

    const saTcp = (await q(sa, 'MODBUS_TCP')).json().data.map((r: { id: string }) => r.id);
    expect(saTcp).toEqual(expect.arrayContaining([inView, outView]));
    expect(saTcp).not.toContain(push);
    const opTcp = await q(op, 'MODBUS_TCP');
    expect(opTcp.statusCode).toBe(200);
    expect(opTcp.json().data.map((r: { id: string }) => r.id)).toEqual([inView]);
    expect(opTcp.json().total).toBe(1);
    const saPush = (await q(sa, 'PUSH')).json().data.map((r: { id: string }) => r.id);
    expect(saPush).toContain(push);
    expect(saPush).not.toContain(inView);
    expect((await q(sa, 'SERIAL')).statusCode).toBe(400);
  });

  it('GET /eligible-children offers a Gateway-profile instrument and never a TCP/IP one (final review F-9)', async () => {
    // A TCP/IP instrument cannot report through a gateway (PUT /:id refuses the
    // link NOT_FOR_TCPIP), so the gateway picker must not offer it.
    const tcpId = await tcp('elig-tcp', '192.168.77.80', 502);
    const pushId = await pushInstrument('elig-push');
    const res = await app.inject({ method: 'GET', url: '/api/instruments/eligible-children', headers: sa });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((r: { id: string }) => r.id);
    expect(ids).toContain(pushId);
    expect(ids).not.toContain(tcpId);
    // ...and the refusal the picker no longer leads to:
    const gw = await pushInstrument('elig-gw', { isGateway: true });
    const link = await put(sa, tcpId, { gatewayId: gw });
    expect(link.statusCode).toBe(400);
    expect(link.json().error).toBe('NOT_FOR_TCPIP');
  });

  it('GET /:id returns the address, the port, the Slave ID, the read interval and the whole map', async () => {
    const id = await tcp('detail', '192.168.77.72', 1502, { modbusUnitId: 12, modbusIntervalSec: 90 });
    const res = await app.inject({ method: 'GET', url: `/api/instruments/${id}`, headers: sa });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ modbusHost: '192.168.77.72', modbusPort: 1502, connection: 'MODBUS_TCP', modbusUnitId: 12, modbusIntervalSec: 90 });
    // The server's reporting verdict judges a TCP/IP instrument by ITS OWN interval.
    expect(res.json().effectiveExpectedIntervalSec).toBe(90);
    expect(res.json().modbusRegisters).toEqual(MAP);
  });
});

// Kept beside the fixtures it would otherwise leak: a JSON null written raw is a
// Prisma error, so nothing here may write one for a Gateway instrument.
it('a Gateway instrument stores SQL NULL for the map, not a JSON null', async () => {
  const id = await pushInstrument('dbnull');
  const rows = await prisma.$queryRaw<{ isnull: boolean }[]>(Prisma.sql`SELECT modbus_registers IS NULL AS isnull FROM instruments WHERE id = ${id}`);
  expect(rows[0]?.isnull).toBe(true);
});

/**
 * A profile's connection may change only while it has no instruments, and an
 * instrument's rules follow its profile's connection. Under READ COMMITTED a
 * bare read on either side races the other, so the profile PUT takes the
 * profile row FOR UPDATE before counting and instrument create takes it FOR
 * SHARE before inserting. Each case holds one side's lock open in a transaction
 * of its own and drives the other side through the API.
 */
describe('a connection change and an instrument create serialise on the profile row', () => {
  const holdOpen = async (body: (t: Prisma.TransactionClient) => Promise<void>) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const readyP = new Promise<void>((r) => { ready = r; });
    const tx = prisma.$transaction(async (t) => { await body(t); ready(); await gate; }, { timeout: 30_000 });
    await readyP;
    return { release, tx };
  };
  const settle = () => new Promise((r) => setTimeout(r, 400));

  it('a create waits for a connection change in flight, then follows the NEW connection', async () => {
    const p = (await prisma.instrumentProfile.create({ data: { name: `TCPI Race ${s}` } })).id;
    extraProfileIds.push(p);
    // A profile PUT mid-flight: row locked, switched to TCP/IP, not committed.
    const held = await holdOpen(async (t) => {
      await t.$queryRaw`SELECT id FROM instrument_profiles WHERE id = ${p} FOR UPDATE`;
      await t.instrumentProfile.update({ where: { id: p }, data: { connection: 'MODBUS_TCP' } });
    });
    const pending = create(sa, { name: C('race'), code: C('race'), profileId: p });
    await settle();
    held.release();
    await held.tx;
    const res = await pending;
    // Read under the lock, the connection is TCP/IP — and this body has no address.
    expect(res.statusCode, res.body).toBe(400);
    expect(await prisma.instrument.count({ where: { code: C('race') } })).toBe(0);
  });

  it('a connection change waits for a create in flight, then counts it', async () => {
    const p = (await prisma.instrumentProfile.create({ data: { name: `TCPI Race2 ${s}` } })).id;
    extraProfileIds.push(p);
    // An instrument create mid-flight: profile row FOR SHARE, instrument inserted, not committed.
    const held = await holdOpen(async (t) => {
      await t.$queryRaw`SELECT connection FROM instrument_profiles WHERE id = ${p} FOR SHARE`;
      await t.instrument.create({ data: { name: C('race2'), code: C('race2'), profileId: p } });
    });
    const pending = app.inject({ method: 'PUT', url: `/api/instrument-profiles/${p}`, headers: sa, payload: { connection: 'MODBUS_TCP' } });
    await settle();
    held.release();
    await held.tx;
    const res = await pending;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe('PROFILE_HAS_INSTRUMENTS');
    expect((await prisma.instrumentProfile.findUniqueOrThrow({ where: { id: p } })).connection).toBe('PUSH');
  });
});
