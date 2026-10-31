import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

/**
 * TCP/IP (Modbus) instruments, Task 3 — a profile is a Gateway ('PUSH') or a
 * TCP/IP ('MODBUS_TCP') profile. The rules live on the server: the browser
 * never decides what a connection change is allowed to do.
 */

let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

async function cleanup() {
  await prisma.instrument.deleteMany({ where: { code: { startsWith: 'TCP-' } } });
  await prisma.instrumentProfile.deleteMany({ where: { name: { startsWith: 'TCP ' } } });
}

const post = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/instrument-profiles', headers: auth(), payload });
const put = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/instrument-profiles/${id}`, headers: auth(), payload });

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: ADMIN_PASSWORD, force: true },
  });
  token = JSON.parse(res.body).token;
  await cleanup();
});
afterAll(async () => { await cleanup(); await app.close(); });
beforeEach(cleanup);

describe('POST /api/instrument-profiles — connection', () => {
  it('creates a TCP/IP profile with the default interval and unit', async () => {
    const res = await post({ name: 'TCP Default', connection: 'MODBUS_TCP' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ connection: 'MODBUS_TCP', modbusIntervalSec: 60, modbusUnitId: 1 });
  });

  it('keeps an interval and unit that were sent', async () => {
    const res = await post({ name: 'TCP Custom', connection: 'MODBUS_TCP', modbusIntervalSec: 10, modbusUnitId: 0 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ modbusIntervalSec: 10, modbusUnitId: 0 });
  });

  it('creates a Gateway profile with both fields null (and no connection means Gateway)', async () => {
    const a = await post({ name: 'TCP Push', connection: 'PUSH' });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ connection: 'PUSH', modbusIntervalSec: null, modbusUnitId: null });
    const b = await post({ name: 'TCP Bare' });
    expect(b.json()).toMatchObject({ connection: 'PUSH', modbusIntervalSec: null, modbusUnitId: null });
  });

  it.each([[9], [3601]])('refuses an interval of %i', async (n) => {
    const res = await post({ name: `TCP Bad ${n}`, connection: 'MODBUS_TCP', modbusIntervalSec: n });
    expect(res.statusCode).toBe(400);
    expect(await prisma.instrumentProfile.count({ where: { name: `TCP Bad ${n}` } })).toBe(0);
  });

  it('refuses a unit id of 256', async () => {
    const res = await post({ name: 'TCP Bad Unit', connection: 'MODBUS_TCP', modbusUnitId: 256 });
    expect(res.statusCode).toBe(400);
  });

  it('refuses the Modbus fields on a Gateway profile', async () => {
    const res = await post({ name: 'TCP Push Fields', connection: 'PUSH', modbusIntervalSec: 30 });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/instrument-profiles/:id — connection', () => {
  it('refuses to change the connection of a profile that has an instrument', async () => {
    const p = (await post({ name: 'TCP Populated' })).json();
    await prisma.instrument.create({ data: { name: 'TCP-A', code: 'TCP-A', profileId: p.id } });
    const res = await put(p.id, { connection: 'MODBUS_TCP' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('PROFILE_HAS_INSTRUMENTS');
    const row = await prisma.instrumentProfile.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({ connection: 'PUSH', modbusIntervalSec: null, modbusUnitId: null });
  });

  it('refuses it for an INACTIVE instrument too', async () => {
    const p = (await post({ name: 'TCP Inactive', connection: 'MODBUS_TCP' })).json();
    await prisma.instrument.create({ data: { name: 'TCP-B', code: 'TCP-B', profileId: p.id, isActive: false } });
    expect((await put(p.id, { connection: 'PUSH' })).json().error).toBe('PROFILE_HAS_INSTRUMENTS');
  });

  it('sets the defaults when an empty Gateway profile becomes TCP/IP, and clears them going back', async () => {
    const p = (await post({ name: 'TCP Switch' })).json();
    const to = await put(p.id, { connection: 'MODBUS_TCP' });
    expect(to.statusCode).toBe(200);
    expect(to.json()).toMatchObject({ connection: 'MODBUS_TCP', modbusIntervalSec: 60, modbusUnitId: 1 });
    const back = await put(p.id, { connection: 'PUSH' });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ connection: 'PUSH', modbusIntervalSec: null, modbusUnitId: null });
  });

  it('takes the interval and unit sent with the switch', async () => {
    const p = (await post({ name: 'TCP Switch Vals' })).json();
    const res = await put(p.id, { connection: 'MODBUS_TCP', modbusIntervalSec: 120, modbusUnitId: 7 });
    expect(res.json()).toMatchObject({ modbusIntervalSec: 120, modbusUnitId: 7 });
  });

  it('allows the SAME connection sent back on a populated profile (a page saving other fields)', async () => {
    const p = (await post({ name: 'TCP Same', connection: 'MODBUS_TCP' })).json();
    await prisma.instrument.create({ data: { name: 'TCP-C', code: 'TCP-C', profileId: p.id } });
    const res = await put(p.id, { connection: 'MODBUS_TCP', description: 'x' });
    expect(res.statusCode).toBe(200);
  });

  it('changes the interval and unit of a TCP/IP profile, even with instruments', async () => {
    const p = (await post({ name: 'TCP Tune', connection: 'MODBUS_TCP' })).json();
    await prisma.instrument.create({ data: { name: 'TCP-D', code: 'TCP-D', profileId: p.id } });
    const res = await put(p.id, { modbusIntervalSec: 300, modbusUnitId: 5 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connection: 'MODBUS_TCP', modbusIntervalSec: 300, modbusUnitId: 5 });
  });

  it('refuses an interval or unit on a Gateway profile, and a null or out-of-range one on a TCP/IP profile', async () => {
    const g = (await post({ name: 'TCP Gw' })).json();
    expect((await put(g.id, { modbusIntervalSec: 30 })).statusCode).toBe(400);
    expect((await put(g.id, { modbusUnitId: 3 })).statusCode).toBe(400);
    const m = (await post({ name: 'TCP Mb', connection: 'MODBUS_TCP' })).json();
    expect((await put(m.id, { modbusIntervalSec: null })).statusCode).toBe(400);
    expect((await put(m.id, { modbusIntervalSec: 9 })).statusCode).toBe(400);
    const row = await prisma.instrumentProfile.findUniqueOrThrow({ where: { id: m.id } });
    expect(row).toMatchObject({ modbusIntervalSec: 60, modbusUnitId: 1 });
  });

  it('refuses a device-certificate requirement on a TCP/IP profile', async () => {
    const m = (await post({ name: 'TCP NoCert', connection: 'MODBUS_TCP' })).json();
    const res = await put(m.id, { requireDeviceCertificate: true, reason: 'client requirement' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NOT_FOR_TCPIP');
  });

  it('refuses switching a certificate-requiring profile to TCP/IP', async () => {
    const p = await prisma.instrumentProfile.create({ data: { name: 'TCP CertReq', requireDeviceCertificate: true } });
    const res = await put(p.id, { connection: 'MODBUS_TCP' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NOT_FOR_TCPIP');
    expect((await prisma.instrumentProfile.findUniqueOrThrow({ where: { id: p.id } })).connection).toBe('PUSH');
  });

  it('allows the switch when the same request drops the certificate requirement', async () => {
    const p = await prisma.instrumentProfile.create({ data: { name: 'TCP CertDrop', requireDeviceCertificate: true } });
    const res = await put(p.id, { connection: 'MODBUS_TCP', requireDeviceCertificate: false, reason: 'moving to Modbus' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connection: 'MODBUS_TCP', requireDeviceCertificate: false });
  });

  it('writes the three fields into the INSTRUMENT_PROFILE_UPDATED audit before/after', async () => {
    const p = (await post({ name: 'TCP Audit' })).json();
    expect((await put(p.id, { connection: 'MODBUS_TCP', modbusIntervalSec: 45, modbusUnitId: 9 })).statusCode).toBe(200);
    const row = await prisma.auditTrail.findFirstOrThrow({
      where: { action: 'INSTRUMENT_PROFILE_UPDATED', targetId: p.id }, orderBy: { timestamp: 'desc' },
    });
    expect(row.beforeValue).toMatchObject({ connection: 'PUSH', modbusIntervalSec: null, modbusUnitId: null });
    expect(row.afterValue).toMatchObject({ connection: 'MODBUS_TCP', modbusIntervalSec: 45, modbusUnitId: 9 });
  });

  it('records the three fields in the INSTRUMENT_PROFILE_CREATED audit', async () => {
    const p = (await post({ name: 'TCP AuditNew', connection: 'MODBUS_TCP' })).json();
    const row = await prisma.auditTrail.findFirstOrThrow({ where: { action: 'INSTRUMENT_PROFILE_CREATED', targetId: p.id } });
    expect(row.afterValue).toMatchObject({ connection: 'MODBUS_TCP', modbusIntervalSec: 60, modbusUnitId: 1 });
  });

  it('GET returns the fields', async () => {
    const p = (await post({ name: 'TCP Get', connection: 'MODBUS_TCP' })).json();
    const res = await app.inject({ method: 'GET', url: '/api/instrument-profiles', headers: auth() });
    const row = res.json().data.find((x: { id: string }) => x.id === p.id);
    expect(row).toMatchObject({ connection: 'MODBUS_TCP', modbusIntervalSec: 60, modbusUnitId: 1 });
  });
});
