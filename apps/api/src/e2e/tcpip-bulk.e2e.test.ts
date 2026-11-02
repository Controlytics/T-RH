import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';

/**
 * Bulk upload for TCP/IP (Modbus) profiles (Task 11). A file for a TCP/IP
 * profile carries "IP address" and "Port"; the server plans it ONCE for the
 * preview and again for the upload, so both say the same thing about every row:
 * a missing address, an address repeated in the file, an address another
 * instrument holds (named only to a caller who can see it), an address not in
 * the device networks. `copyRegisterMapFrom` copies a visible TCP/IP
 * instrument's map onto every CREATED row and never onto an existing one; an
 * existing row's address may change with the upload's one remark.
 *
 * `STALE` makes the address check blind to ONE host - the race the unique index
 * exists for: another instrument takes the address after the check and before
 * the insert. Everything else passes straight through to the real check.
 * `STALE.onCheck` runs ONCE, at the first check of its host — which is the
 * file's check, before the write: a change someone makes in between.
 */
const STALE = vi.hoisted(() => ({ hosts: new Set<string>(), onCheck: new Map<string, () => Promise<unknown>>() }));
vi.mock('../modules/modbus/address.js', async (importActual) => {
  const actual = await importActual<typeof import('../modules/modbus/address.js')>();
  return {
    ...actual,
    checkModbusAddress: async (host: string, ...rest: unknown[]) => {
      const hook = STALE.onCheck.get(host);
      if (hook) { STALE.onCheck.delete(host); await hook(); }
      return STALE.hosts.has(host) ? { ok: true } : (actual.checkModbusAddress as (...a: unknown[]) => unknown)(host, ...rest);
    },
  };
});

const s = Date.now();
const SA_NAME = `tbsa${s}`;
const OP_NAME = `tbop${s}`;
const SA_PW = 'Tbulk@SuperAdmin1';
const OP_PW = 'Tbulk@Operator1';
const ROLE = `TBULK_${s}`;
const C = (n: string) => `TBULK-${s}-${n}`;
/** A /24 of the 10.0.0.0/8 device network no other test file uses. */
const NET = `10.${(s % 200) + 30}.${Math.floor(s / 1000) % 250}`;
const ip = (n: number) => `${NET}.${n}`;

let app: FastifyInstance;
let sa: Record<string, string>;
let op: Record<string, string>;
let pushProfileId = '';
let tcpProfileId = '';
let blockIn = '';
let blockOut = '';
const userIds: string[] = [];

const MAP = [
  { key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Humidity', register: '40003', dataType: 'UINT16', scale: 0.1 },
];

const preview = (csv: string, extra: Record<string, unknown> = {}, headers = sa, profileId = tcpProfileId) =>
  app.inject({ method: 'POST', url: '/api/instruments/bulk/preview', headers, payload: { csv, profileId, ...extra } });
const upload = (csv: string, extra: Record<string, unknown> = {}, headers = sa, profileId = tcpProfileId) =>
  app.inject({ method: 'POST', url: '/api/instruments/bulk', headers, payload: { csv, profileId, ...extra } });

async function tcp(name: string, host: string, port: number, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: sa,
    payload: { name: C(name), code: C(name), profileId: tcpProfileId, modbusHost: host, modbusPort: port, modbusRegisters: MAP, functionalLocationId: blockOut, ...extra },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

beforeAll(async () => {
  app = await buildApp();
  userIds.push((await prisma.user.create({
    data: { username: SA_NAME, fullName: SA_NAME, role: 'SUPER_ADMIN', status: 'ENABLED', passwordHash: await hashPassword(SA_PW), passwordChangedAt: new Date() },
  })).id);
  await prisma.role.create({
    data: { name: ROLE, displayName: `TBULK ${s}`, hierarchyLevel: 3, isSystem: false, permissions: ['INSTRUMENT_READ', 'INSTRUMENT_CREATE', 'INSTRUMENT_UPDATE'] },
  });
  invalidateRolePermsCache(ROLE);
  userIds.push((await prisma.user.create({
    data: { username: OP_NAME, fullName: OP_NAME, role: ROLE, status: 'ENABLED', passwordHash: await hashPassword(OP_PW), passwordChangedAt: new Date() },
  })).id);
  blockIn = (await prisma.functionalLocation.create({ data: { name: `TBULK-block-in-${s}`, type: 'BLOCK' } })).id;
  blockOut = (await prisma.functionalLocation.create({ data: { name: `TBULK-block-out-${s}`, type: 'BLOCK' } })).id;
  await prisma.roleConfig.create({ data: { role: ROLE, instrumentScope: { locationIds: [blockIn], instrumentIds: [] } as never } });
  pushProfileId = (await prisma.instrumentProfile.create({ data: { name: `TBULK Push ${s}`, attributeKeys: 'Room' } })).id;
  tcpProfileId = (await prisma.instrumentProfile.create({
    data: { name: `TBULK Modbus ${s}`, connection: 'MODBUS_TCP', attributeKeys: 'Room' },
  })).id;
  sa = { authorization: `Bearer ${await loginAs(app, SA_NAME, SA_PW)}`, 'x-reauth-password': SA_PW };
  op = { authorization: `Bearer ${await loginAs(app, OP_NAME, OP_PW)}`, 'x-reauth-password': OP_PW };
});

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { failures.push(e); } };
  STALE.hosts.clear();
  await step(() => prisma.instrument.deleteMany({ where: { code: { startsWith: `TBULK-${s}-` } } }));
  await step(() => prisma.instrumentProfile.deleteMany({ where: { id: { in: [pushProfileId, tcpProfileId].filter(Boolean) } } }));
  await step(() => prisma.functionalLocation.deleteMany({ where: { id: { in: [blockIn, blockOut].filter(Boolean) } } }));
  await step(() => prisma.roleConfig.deleteMany({ where: { role: ROLE } }));
  await step(() => prisma.session.deleteMany({ where: { userId: { in: userIds } } }));
  await step(() => prisma.passwordHistory.deleteMany({ where: { userId: { in: userIds } } }));
  await step(() => prisma.user.deleteMany({ where: { id: { in: userIds } } }));
  await step(() => prisma.role.deleteMany({ where: { name: ROLE } }));
  invalidateRolePermsCache(ROLE);
  await step(() => app.close());
  if (failures.length > 0) throw new AggregateError(failures, 'tcpip-bulk teardown failed');
});

describe('bulk upload — TCP/IP profile, preview', () => {
  it('plans a create for every row with an address; a row without one, a repeated address and a bad port are row errors', async () => {
    const res = await preview([
      'Instrument ID,IP address,Port',
      `${C('p1')},${ip(1)},502`,
      `${C('p2')},${ip(2)},`,
      `${C('p3')},,502`,
      `${C('p4')},${ip(4)},502`,
      `${C('p5')},${ip(4)},502`,
      `${C('p6')},${ip(6)},70000`,
    ].join('\n'));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.create.map((r: { code: string }) => r.code)).toEqual([C('p1'), C('p2')]);
    expect(body.errors.map((e: { row: number; column: string }) => [e.row, e.column])).toEqual([
      [4, 'IP address'], [5, 'IP address'], [6, 'IP address'], [7, 'Port'],
    ]);
    expect(body.errors[0].message).toMatch(/IP address is required/i);
    expect(body.errors[1].message).toMatch(/repeated in this file/i);
    expect(await prisma.instrument.count({ where: { code: C('p1') } })).toBe(0);
  });

  it('an address another instrument holds is "already in use" and names the holder to a caller who can see it', async () => {
    await tcp('held', ip(10), 502);
    const res = await preview(`Instrument ID,IP address\n${C('q1')},${ip(10)}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().create).toEqual([]);
    expect(res.json().errors).toEqual([{ row: 2, column: 'IP address', message: `${ip(10)} : 502 is already used by instrument "${C('held')}".` }]);
  });

  it('...and does NOT name a holder outside the caller\'s view', async () => {
    // The holder sits in Block "out"; the operator is scoped to Block "in".
    const res = await preview(`Instrument ID,IP address\n${C('q2')},${ip(10)}`, { functionalLocationId: blockIn }, op);
    expect(res.statusCode, res.body).toBe(200);
    const [err] = res.json().errors;
    expect(err.message).toBe(`${ip(10)} : 502 is already in use.`);
    expect(JSON.stringify(res.json())).not.toContain(C('held'));
  });

  it('an address outside the device networks is refused on its row', async () => {
    const res = await preview(`Instrument ID,IP address\n${C('q3')},8.8.8.8`);
    expect(res.json().errors[0]).toMatchObject({ row: 2, column: 'IP address', message: expect.stringMatching(/device networks/i) });
  });

  it('a Gateway profile\'s upload refuses an IP address cell: not a TCP/IP profile', async () => {
    const res = await preview(`Instrument ID,IP address,Port\n${C('g1')},${ip(20)},502\n${C('g2')},,`, {}, sa, pushProfileId);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.create.map((r: { code: string }) => r.code)).toEqual([C('g2')]);
    expect(body.errors.map((e: { row: number; column: string }) => [e.row, e.column])).toEqual([[2, 'IP address'], [2, 'Port']]);
    expect(body.errors[0].message).toMatch(/not a TCP\/IP profile/i);
  });

  it('copyRegisterMapFrom must be a TCP/IP instrument the caller can see - the same 400 as the upload', async () => {
    const holder = await tcp('src-out', ip(30), 502);
    const push = await app.inject({ method: 'POST', url: '/api/instruments', headers: sa, payload: { name: C('push1'), code: C('push1'), profileId: pushProfileId } });
    expect(push.statusCode, push.body).toBe(201);
    const csv = `Instrument ID,IP address\n${C('r1')},${ip(31)}`;
    // Outside the operator's view.
    const outside = await preview(csv, { copyRegisterMapFrom: holder, functionalLocationId: blockIn }, op);
    expect(outside.statusCode).toBe(400);
    const outsideUp = await upload(csv, { copyRegisterMapFrom: holder, functionalLocationId: blockIn }, op);
    expect(outsideUp.statusCode).toBe(400);
    // Not a TCP/IP instrument.
    const pushId = push.json().id as string;
    expect((await preview(csv, { copyRegisterMapFrom: pushId })).statusCode).toBe(400);
    expect((await upload(csv, { copyRegisterMapFrom: pushId })).statusCode).toBe(400);
    // No such instrument.
    expect((await upload(csv, { copyRegisterMapFrom: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(400);
    // A Gateway profile takes no register map.
    const gw = await upload(`Instrument ID\n${C('r2')}`, { copyRegisterMapFrom: holder }, sa, pushProfileId);
    expect(gw.statusCode).toBe(400);
    expect(gw.json().error).toBe('NOT_A_TCPIP_PROFILE');
    expect(await prisma.instrument.count({ where: { code: { in: [C('r1'), C('r2')] } } })).toBe(0);
  });
});

describe('bulk upload — TCP/IP profile, upload', () => {
  it('creates each row with its address, no access token, and an audit row carrying the address', async () => {
    const res = await upload(`Instrument ID,IP address,Port,Room\n${C('u1')},${ip(40)},1502,R1\n${C('u2')},${ip(41)},,R2`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.errors).toEqual([]);
    expect(body.created.map((c: { code: string; token: unknown }) => [c.code, c.token])).toEqual([[C('u1'), null], [C('u2'), null]]);
    const rows = await prisma.instrument.findMany({ where: { code: { in: [C('u1'), C('u2')] } }, orderBy: { code: 'asc' }, include: { credentials: true, attributes: true } });
    expect(rows.map((r) => [r.modbusHost, r.modbusPort, r.credentials.length, r.attributes.map((a) => a.value)])).toEqual([
      [ip(40), 1502, 0, ['R1']],
      [ip(41), 502, 0, ['R2']],
    ]);
    expect(rows.map((r) => r.modbusRegisters)).toEqual([[], []]);
    const audit = await prisma.auditTrail.findFirst({ where: { action: 'INSTRUMENT_CREATED', targetId: rows[0].id } });
    expect(audit?.afterValue).toMatchObject({ modbusHost: ip(40), modbusPort: 1502 });
  });

  it('a bad row fails only itself: the rest are created, and the repeated address creates neither of its rows', async () => {
    const res = await upload([
      'Instrument ID,IP address',
      `${C('v1')},${ip(50)}`, `${C('v2')},${ip(51)}`, `${C('v3')},${ip(51)}`, `${C('v4')},`,
    ].join('\n'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().created.map((c: { code: string }) => c.code)).toEqual([C('v1')]);
    expect(res.json().errors.map((e: { row: number }) => e.row)).toEqual([3, 4, 5]);
    expect(await prisma.instrument.count({ where: { code: { in: [C('v2'), C('v3'), C('v4')] } } })).toBe(0);
  });

  it('copyRegisterMapFrom copies the map to EVERY created row, and the address stays each row\'s own', async () => {
    const src = await tcp('src', ip(60), 502);
    const res = await upload(`Instrument ID,IP address\n${C('w1')},${ip(61)}\n${C('w2')},${ip(62)}\n${C('w3')},${ip(63)}`, { copyRegisterMapFrom: src });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().errors).toEqual([]);
    const rows = await prisma.instrument.findMany({ where: { code: { in: [C('w1'), C('w2'), C('w3')] } }, orderBy: { code: 'asc' } });
    expect(rows.map((r) => r.modbusRegisters)).toEqual([MAP, MAP, MAP]);
    expect(rows.map((r) => r.modbusHost)).toEqual([ip(61), ip(62), ip(63)]);
    const audit = await prisma.auditTrail.findFirst({ where: { action: 'INSTRUMENT_CREATED', targetId: rows[1].id } });
    expect((audit?.afterValue as { modbusRegisters: unknown }).modbusRegisters).toEqual(MAP);
  });

  it('copyRegisterMapFrom is applied to created rows ONLY: an existing row keeps its own map', async () => {
    const own = [{ key: 'Temperature', register: '40011', dataType: 'UINT16', scale: 1 }];
    const src = await tcp('src2', ip(70), 502);
    const existing = await tcp('keep', ip(71), 502, { modbusRegisters: own });
    const res = await upload(`Instrument ID,IP address\n${C('keep')},${ip(72)}\n${C('x1')},${ip(73)}`, { copyRegisterMapFrom: src, reason: 'Device moved to the new switch, SOP-9' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().errors).toEqual([]);
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id: existing } })).modbusRegisters).toEqual(own);
    expect((await prisma.instrument.findUniqueOrThrow({ where: { code: C('x1') } })).modbusRegisters).toEqual(MAP);
  });

  it('an address taken between the check and the insert is "already in use", never the database\'s message', async () => {
    await tcp('racer', ip(80), 502);
    STALE.hosts.add(ip(80));
    try {
      const res = await upload(`Instrument ID,IP address\n${C('y1')},${ip(80)}\n${C('y2')},${ip(81)}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().created.map((c: { code: string }) => c.code)).toEqual([C('y2')]);
      const [err] = res.json().errors;
      expect(err).toMatchObject({ row: 2, column: 'IP address' });
      expect(err.message).toMatch(/already in use/i);
      expect(err.message).not.toMatch(/Not created|Unique constraint|modbus_address/i);
    } finally {
      STALE.hosts.clear();
    }
    expect(await prisma.instrument.count({ where: { code: C('y1') } })).toBe(0);
  });
});

describe('bulk upload — an existing TCP/IP instrument\'s address', () => {
  it('a new address needs the upload\'s remark, is recorded as INSTRUMENT_UPDATED with it, and leaves the map alone', async () => {
    const id = await tcp('mv', ip(90), 502);
    const csv = `Instrument ID,IP address,Port\n${C('mv')},${ip(91)},1502`;
    const pv = await preview(csv);
    expect(pv.statusCode, pv.body).toBe(200);
    expect(pv.json().remarkRequired).toBe(true);
    expect(pv.json().update).toEqual([{
      id, code: C('mv'), row: 2, changes: [],
      address: { from: { host: ip(90), port: 502 }, to: { host: ip(91), port: 1502 } },
    }]);
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id } })).modbusHost).toBe(ip(90));

    const without = await upload(csv);
    expect(without.statusCode).toBe(400);
    expect(without.json().error).toBe('REMARK_REQUIRED');
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id } })).modbusHost).toBe(ip(90));

    const REMARK = 'Device moved to the process VLAN per CC-2214';
    const done = await upload(csv, { reason: REMARK });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().errors).toEqual([]);
    expect(done.json().updated).toEqual([{
      id, code: C('mv'), row: 2, changes: [],
      address: { from: { host: ip(90), port: 502 }, to: { host: ip(91), port: 1502 } },
    }]);
    const row = await prisma.instrument.findUniqueOrThrow({ where: { id } });
    expect([row.modbusHost, row.modbusPort, row.modbusRegisters]).toEqual([ip(91), 1502, MAP]);
    const audit = await prisma.auditTrail.findFirstOrThrow({ where: { action: 'INSTRUMENT_UPDATED', targetId: id }, orderBy: { timestamp: 'desc' } });
    expect(audit.reason).toBe(REMARK);
    expect(audit.beforeValue).toMatchObject({ modbusHost: ip(90), modbusPort: 502 });
    expect(audit.afterValue).toMatchObject({ modbusHost: ip(91), modbusPort: 1502 });
  });

  it('the same address again is unchanged and asks for no remark; moving onto another instrument\'s address is a row error', async () => {
    await tcp('same', ip(100), 502);
    await tcp('other', ip(101), 502);
    const res = await preview(`Instrument ID,IP address\n${C('same')},${ip(100)}\n${C('other')},${ip(100)}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.unchanged).toEqual([{ row: 2, code: C('same') }]);
    expect(body.update).toEqual([]);
    expect(body.remarkRequired).toBe(false);
    expect(body.errors).toEqual([{ row: 3, column: 'IP address', message: `${ip(100)} : 502 is already used by instrument "${C('same')}".` }]);
  });
});

/**
 * CR-1 (2026-11-02): "Slave ID" and "Read every" (seconds) are each TCP/IP
 * instrument's own, so they are optional columns of a TCP/IP upload: blank on a
 * create = 1 and 60 s; on an existing instrument a change is the address's
 * governance (the upload's remark, one INSTRUMENT_UPDATED row, the row's one
 * transaction); refused in a Gateway upload.
 */
describe('bulk upload — Slave ID and Read every', () => {
  it('creates each row with its own Slave ID and read interval; blank cells are 1 and 60 s', async () => {
    const csv = `Instrument ID,IP address,Slave ID,Read every\n${C('rd1')},${ip(130)},7,45\n${C('rd2')},${ip(131)},,`;
    const pv = await preview(csv);
    expect(pv.statusCode, pv.body).toBe(200);
    expect(pv.json().create.map((r: { code: string }) => r.code)).toEqual([C('rd1'), C('rd2')]);
    const res = await upload(csv);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().errors).toEqual([]);
    const rows = await prisma.instrument.findMany({ where: { code: { in: [C('rd1'), C('rd2')] } }, orderBy: { code: 'asc' } });
    expect(rows.map((r) => [r.modbusUnitId, r.modbusIntervalSec])).toEqual([[7, 45], [1, 60]]);
    const audit = await prisma.auditTrail.findFirstOrThrow({ where: { action: 'INSTRUMENT_CREATED', targetId: rows[0].id } });
    expect(audit.afterValue).toMatchObject({ modbusUnitId: 7, modbusIntervalSec: 45 });
  });

  it('a value outside its range is a row error saying the range — in the preview and the upload — and only that row fails', async () => {
    const csv = `Instrument ID,IP address,Slave ID,Read every\n${C('rdx1')},${ip(132)},300,60\n${C('rdx2')},${ip(133)},1,5\n${C('rdx3')},${ip(134)},2,20`;
    const pv = await preview(csv);
    expect(pv.json().errors).toEqual([
      { row: 2, column: 'Slave ID', message: 'Slave ID must be a whole number from 0 to 255.' },
      { row: 3, column: 'Read every', message: 'Read every must be a whole number of seconds from 10 to 3600.' },
    ]);
    const res = await upload(csv);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().errors).toEqual(pv.json().errors);
    expect(res.json().created.map((c: { code: string }) => c.code)).toEqual([C('rdx3')]);
    expect(await prisma.instrument.count({ where: { code: { in: [C('rdx1'), C('rdx2')] } } })).toBe(0);
  });

  it("a Gateway profile's upload refuses a filled Slave ID or Read every cell: not a TCP/IP profile", async () => {
    const res = await preview(`Instrument ID,Slave ID,Read every\n${C('rdp1')},7,\n${C('rdp2')},,`, {}, sa, pushProfileId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().create.map((r: { code: string }) => r.code)).toEqual([C('rdp2')]);
    expect(res.json().errors).toEqual([
      { row: 2, column: 'Slave ID', message: 'This is not a TCP/IP profile, so "Slave ID" has no meaning here - remove the column from the file.' },
    ]);
  });

  it("an existing instrument's change needs the upload's remark and is ONE INSTRUMENT_UPDATED row with it", async () => {
    const id = await tcp('rdmv', ip(135), 502, { modbusUnitId: 3, modbusIntervalSec: 30 });
    const csv = `Instrument ID,Slave ID,Read every\n${C('rdmv')},7,45`;
    const pv = await preview(csv);
    expect(pv.statusCode, pv.body).toBe(200);
    expect(pv.json().remarkRequired).toBe(true);
    // Every inner key DECLARED, or Fastify strips it and the review shows nothing.
    expect(pv.json().update).toEqual([{
      id, code: C('rdmv'), row: 2, changes: [],
      reading: { from: { unitId: 3, intervalSec: 30 }, to: { unitId: 7, intervalSec: 45 } },
    }]);

    const without = await upload(csv);
    expect(without.statusCode).toBe(400);
    expect(without.json().error).toBe('REMARK_REQUIRED');
    const kept = await prisma.instrument.findUniqueOrThrow({ where: { id } });
    expect([kept.modbusUnitId, kept.modbusIntervalSec]).toEqual([3, 30]);

    const REMARK = 'Gateway replaced; new slave address per CC-2301';
    const auditsBefore = await prisma.auditTrail.count({ where: { action: 'INSTRUMENT_UPDATED', targetId: id } });
    const done = await upload(csv, { reason: REMARK });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().errors).toEqual([]);
    expect(done.json().updated).toEqual([{
      id, code: C('rdmv'), row: 2, changes: [],
      reading: { from: { unitId: 3, intervalSec: 30 }, to: { unitId: 7, intervalSec: 45 } },
    }]);
    const row = await prisma.instrument.findUniqueOrThrow({ where: { id } });
    expect([row.modbusUnitId, row.modbusIntervalSec, row.modbusHost]).toEqual([7, 45, ip(135)]);
    expect(await prisma.auditTrail.count({ where: { action: 'INSTRUMENT_UPDATED', targetId: id } })).toBe(auditsBefore + 1);
    const audit = await prisma.auditTrail.findFirstOrThrow({ where: { action: 'INSTRUMENT_UPDATED', targetId: id }, orderBy: { timestamp: 'desc' } });
    expect(audit.reason).toBe(REMARK);
    expect(audit.beforeValue).toMatchObject({ modbusUnitId: 3, modbusIntervalSec: 30 });
    expect(audit.afterValue).toMatchObject({ modbusUnitId: 7, modbusIntervalSec: 45 });
    expect(audit.signatureMeaning).toBe(`Instrument "${C('rdmv')}" Slave ID and read interval changed`);
  });

  it('a blank cell never undoes a change made after the file was checked: only what the file changes is written', async () => {
    // The file moves the address and sets Slave ID 9, Read every BLANK. Between
    // its check and its write someone sets Read every to 77 — the blank cell was
    // planned as the 30 s stored then, and must not write that back.
    const id = await tcp('race-rd', ip(138), 502, { modbusUnitId: 3, modbusIntervalSec: 30 });
    STALE.onCheck.set(ip(139), () => prisma.instrument.update({ where: { id }, data: { modbusIntervalSec: 77 } }));
    try {
      const res = await upload(`Instrument ID,IP address,Slave ID,Read every
${C('race-rd')},${ip(139)},9,`, { reason: 'Panel rewired, CC-2303' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().updated[0].reading).toEqual({ from: { unitId: 3, intervalSec: 77 }, to: { unitId: 9, intervalSec: 77 } });
    } finally {
      STALE.onCheck.clear();
    }
    const row = await prisma.instrument.findUniqueOrThrow({ where: { id } });
    expect([row.modbusHost, row.modbusUnitId, row.modbusIntervalSec]).toEqual([ip(139), 9, 77]);
  });

  it('...and a blank Port never undoes a port changed meanwhile (the same rule for the address)', async () => {
    const id = await tcp('race-port', ip(140), 502);
    STALE.onCheck.set(ip(141), () => prisma.instrument.update({ where: { id }, data: { modbusPort: 1502 } }));
    try {
      const res = await upload(`Instrument ID,IP address,Port
${C('race-port')},${ip(141)},`, { reason: 'Moved to the new switch, CC-2304' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().updated[0].address).toEqual({ from: { host: ip(140), port: 1502 }, to: { host: ip(141), port: 1502 } });
    } finally {
      STALE.onCheck.clear();
    }
    const row = await prisma.instrument.findUniqueOrThrow({ where: { id } });
    expect([row.modbusHost, row.modbusPort]).toEqual([ip(141), 1502]);
  });

  it('address and Slave ID on one existing row: one record names both; matching cells are unchanged', async () => {
    const id = await tcp('rdboth', ip(136), 502);
    const res = await upload(`Instrument ID,IP address,Slave ID,Read every\n${C('rdboth')},${ip(137)},9,60`, { reason: 'Panel rewired, CC-2302' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().updated).toEqual([{
      id, code: C('rdboth'), row: 2, changes: [],
      address: { from: { host: ip(136), port: 502 }, to: { host: ip(137), port: 502 } },
      reading: { from: { unitId: 1, intervalSec: 60 }, to: { unitId: 9, intervalSec: 60 } },
    }]);
    const audit = await prisma.auditTrail.findFirstOrThrow({ where: { action: 'INSTRUMENT_UPDATED', targetId: id }, orderBy: { timestamp: 'desc' } });
    expect(audit.signatureMeaning).toBe(`Instrument "${C('rdboth')}" TCP/IP address and Slave ID changed`);
    const again = await preview(`Instrument ID,Slave ID,Read every\n${C('rdboth')},9,60`);
    expect(again.json().unchanged).toEqual([{ row: 2, code: C('rdboth') }]);
    expect(again.json().remarkRequired).toBe(false);
  });
});

describe('bulk upload - an existing row is all or nothing', () => {
  it('an address change whose attribute step fails is rolled back with it: the row is only an error', async () => {
    const id = await tcp('half', ip(110), 502);
    const put = await app.inject({ method: 'POST', url: `/api/instruments/${id}/attributes`, headers: sa, payload: { key: 'Room', value: 'R-old' } });
    expect(put.statusCode, put.body).toBe(201);
    const csv = `Instrument ID,IP address,Room\n${C('half')},${ip(111)},TBULK-BOOM`;
    const pv = await preview(csv);
    expect(pv.json().update).toHaveLength(1);
    expect(pv.json().update[0].address.to.host).toBe(ip(111));
    expect(pv.json().update[0].changes).toHaveLength(1);

    const updates = () => prisma.auditTrail.count({ where: { action: 'INSTRUMENT_UPDATED', targetId: id } });
    const attrAudits = () => prisma.auditTrail.count({ where: { action: 'INSTRUMENT_ATTRIBUTE_SET', targetId: id } });
    const [u0, a0] = [await updates(), await attrAudits()];
    // A real database refusal of ONE attribute value, after the address write.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION tbulk_boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'tbulk boom'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER tbulk_boom_trg BEFORE INSERT OR UPDATE ON instrument_attributes FOR EACH ROW WHEN (NEW.value = 'TBULK-BOOM') EXECUTE FUNCTION tbulk_boom()`);
    try {
      const res = await upload(csv, { reason: 'Moved with its room label, CC-77' });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.updated).toEqual([]);
      expect(body.created).toEqual([]);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].row).toBe(2);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS tbulk_boom_trg ON instrument_attributes');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS tbulk_boom()');
    }
    const row = await prisma.instrument.findUniqueOrThrow({ where: { id }, include: { attributes: true } });
    expect([row.modbusHost, row.modbusPort]).toEqual([ip(110), 502]);
    expect(row.attributes.map((a) => a.value)).toEqual(['R-old']);
    expect(await updates()).toBe(u0);
    expect(await attrAudits()).toBe(a0);
  });
});

/**
 * Final review F-1: an existing TCP/IP instrument's ADDRESS changed by CSV is
 * signed exactly as `PUT /:id` signs it — the configurable UPDATE_INSTRUMENT
 * re-auth policy. Driven on this file's own ROLE (the `op` user), with the
 * `action-reauth` row put back FIRST in afterAll and the 10 s reauth cache
 * dropped after every write to it. `sa` / `op` carry `x-reauth-password` on
 * every request, so the unsigned calls here build their headers without it.
 */
describe('bulk upload - an address change is signed like the single edit (UPDATE_INSTRUMENT)', () => {
  const POLICY_KEY = 'action-reauth';
  const REMARK = 'Device moved to the new switch, CC-901';
  let policyBefore: { configValue: unknown; configType: string; requiresReauth: boolean } | null = null;
  const setPolicy = async (policy: Record<string, string[]>) => {
    await prisma.systemConfig.upsert({
      where: { configKey: POLICY_KEY },
      update: { configValue: policy as never },
      create: { configKey: POLICY_KEY, configValue: policy as never, configType: 'security', requiresReauth: false },
    });
    invalidateReauthCache();
  };
  const unsigned = () => ({ authorization: op.authorization });
  const hostOf = async (id: string) => (await prisma.instrument.findUniqueOrThrow({ where: { id } })).modbusHost;

  beforeAll(async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: POLICY_KEY } });
    policyBefore = row ? { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth } : null;
  });
  afterAll(async () => {
    try {
      if (policyBefore) await prisma.systemConfig.update({ where: { configKey: POLICY_KEY }, data: policyBefore as never });
      else await prisma.systemConfig.deleteMany({ where: { configKey: POLICY_KEY } });
    } finally {
      invalidateReauthCache();
    }
  });

  it('a role whose policy asks only UPDATE_INSTRUMENT cannot move an existing device by CSV without its password; with it, it can', async () => {
    const id = await tcp('sig', ip(120), 502, { functionalLocationId: blockIn });
    await setPolicy({ UPDATE_INSTRUMENT: [ROLE] });
    const csv = `Instrument ID,IP address\n${C('sig')},${ip(121)}`;

    const refused = await upload(csv, { reason: REMARK, functionalLocationId: blockIn }, unsigned());
    expect(refused.statusCode, refused.body).toBe(401);
    expect(refused.json()).toMatchObject({ error: 'REAUTH_REQUIRED', action: 'UPDATE_INSTRUMENT' });
    expect(await hostOf(id)).toBe(ip(120));

    // The password sent ONCE, in the body - the web client's form.
    const signed = await upload(csv, { reason: REMARK, functionalLocationId: blockIn, _currentPassword: OP_PW }, unsigned());
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json().updated.map((u: { id: string }) => u.id)).toEqual([id]);
    expect(await hostOf(id)).toBe(ip(121));
  });

  it('a Slave ID or Read every change alone is signed like an address change (CR-1)', async () => {
    const id = await tcp('sig-rd', ip(128), 502, { functionalLocationId: blockIn });
    await setPolicy({ UPDATE_INSTRUMENT: [ROLE] });
    const csv = `Instrument ID,Read every\n${C('sig-rd')},45`;
    const refused = await upload(csv, { reason: REMARK, functionalLocationId: blockIn }, unsigned());
    expect(refused.statusCode, refused.body).toBe(401);
    expect(refused.json()).toMatchObject({ error: 'REAUTH_REQUIRED', action: 'UPDATE_INSTRUMENT' });
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id } })).modbusIntervalSec).toBe(60);
    const signed = await upload(csv, { reason: REMARK, functionalLocationId: blockIn, _currentPassword: OP_PW }, unsigned());
    expect(signed.statusCode, signed.body).toBe(200);
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id } })).modbusIntervalSec).toBe(45);
  });

  it('...is asked only when an address changes: a file that only creates is not', async () => {
    await setPolicy({ UPDATE_INSTRUMENT: [ROLE] });
    const res = await upload(`Instrument ID,IP address\n${C('sig-new')},${ip(122)}`, { functionalLocationId: blockIn }, unsigned());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().created.map((c: { code: string }) => c.code)).toEqual([C('sig-new')]);
  });

  it('with CREATE_INSTRUMENT on as well, ONE password signs the whole upload', async () => {
    const id = await tcp('sig2', ip(123), 502, { functionalLocationId: blockIn });
    await setPolicy({ CREATE_INSTRUMENT: [ROLE], UPDATE_INSTRUMENT: [ROLE] });
    const csv = `Instrument ID,IP address\n${C('sig2')},${ip(124)}\n${C('sig2-new')},${ip(125)}`;
    const refused = await upload(csv, { reason: REMARK, functionalLocationId: blockIn }, unsigned());
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error).toBe('REAUTH_REQUIRED');
    const res = await upload(csv, { reason: REMARK, functionalLocationId: blockIn, _currentPassword: OP_PW }, unsigned());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().updated.map((u: { id: string }) => u.id)).toEqual([id]);
    expect(res.json().created.map((c: { code: string }) => c.code)).toEqual([C('sig2-new')]);
    expect(await hostOf(id)).toBe(ip(124));
  });

  it('a role outside the policy moves a device with no password - never stricter than the single edit', async () => {
    const id = await tcp('sig3', ip(126), 502, { functionalLocationId: blockIn });
    await setPolicy({ UPDATE_INSTRUMENT: ['SUPER_ADMIN'] });
    const res = await upload(`Instrument ID,IP address\n${C('sig3')},${ip(127)}`, { reason: REMARK, functionalLocationId: blockIn }, unsigned());
    expect(res.statusCode, res.body).toBe(200);
    expect(await hostOf(id)).toBe(ip(127));
  });
});
