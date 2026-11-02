import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { PROFILE_READING_MOVED_MESSAGE } from '@digilog/shared';

/**
 * TCP/IP (Modbus) instruments, Task 3 — a profile is a Gateway ('PUSH') or a
 * TCP/IP ('MODBUS_TCP') profile. The rules live on the server: the browser
 * never decides what a connection change is allowed to do.
 *
 * CR-1 (2026-11-02): the profile ONLY chooses the kind. The Slave ID and the
 * read interval are each instrument's — pinned in tcpip-instruments.e2e.test.ts
 * (create / PUT / refusals), modbus/__tests__/reader.e2e.test.ts (the read and
 * the schedule), modbus-test-connection.e2e.test.ts (Test connection and the
 * status route) and tcpip-bulk.e2e.test.ts (the bulk columns); a profile body
 * still carrying them is a 400 on the field, never ignored.
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
  it('creates a TCP/IP profile that carries no Slave ID and no read interval', async () => {
    const res = await post({ name: 'TCP Default', connection: 'MODBUS_TCP' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ connection: 'MODBUS_TCP' });
    expect(res.json()).not.toHaveProperty('modbusIntervalSec');
    expect(res.json()).not.toHaveProperty('modbusUnitId');
  });

  it('creates a Gateway profile (and no connection means Gateway)', async () => {
    const a = await post({ name: 'TCP Push', connection: 'PUSH' });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ connection: 'PUSH' });
    const b = await post({ name: 'TCP Bare' });
    expect(b.json()).toMatchObject({ connection: 'PUSH' });
  });

  it.each([
    ['MODBUS_TCP', 'modbusIntervalSec', 60], ['MODBUS_TCP', 'modbusUnitId', 1],
    ['MODBUS_TCP', 'modbusIntervalSec', null], ['PUSH', 'modbusUnitId', 3], [undefined, 'modbusIntervalSec', 30],
  ] as const)('refuses a %s body carrying %s = %s — by name, nothing created', async (connection, field, value) => {
    const name = `TCP Old ${connection}-${field}-${value}`;
    const res = await post({ name, ...(connection ? { connection } : {}), [field]: value });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(res.json().details.fieldErrors[field]).toEqual([PROFILE_READING_MOVED_MESSAGE]);
    expect(await prisma.instrumentProfile.count({ where: { name } })).toBe(0);
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
    expect(row.connection).toBe('PUSH');
  });

  it('refuses it for an INACTIVE instrument too', async () => {
    const p = (await post({ name: 'TCP Inactive', connection: 'MODBUS_TCP' })).json();
    await prisma.instrument.create({ data: { name: 'TCP-B', code: 'TCP-B', profileId: p.id, isActive: false } });
    expect((await put(p.id, { connection: 'PUSH' })).json().error).toBe('PROFILE_HAS_INSTRUMENTS');
  });

  it('an empty Gateway profile becomes TCP/IP and back — the connection is all that changes', async () => {
    const p = (await post({ name: 'TCP Switch' })).json();
    const to = await put(p.id, { connection: 'MODBUS_TCP' });
    expect(to.statusCode).toBe(200);
    expect(to.json()).toMatchObject({ connection: 'MODBUS_TCP' });
    expect(to.json()).not.toHaveProperty('modbusIntervalSec');
    const back = await put(p.id, { connection: 'PUSH' });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ connection: 'PUSH' });
  });

  it('allows the SAME connection sent back on a populated profile (a page saving other fields)', async () => {
    const p = (await post({ name: 'TCP Same', connection: 'MODBUS_TCP' })).json();
    await prisma.instrument.create({ data: { name: 'TCP-C', code: 'TCP-C', profileId: p.id } });
    const res = await put(p.id, { connection: 'MODBUS_TCP', description: 'x' });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['modbusIntervalSec', 300], ['modbusUnitId', 5], ['modbusIntervalSec', null], ['modbusUnitId', null],
  ] as const)('refuses %s = %s on a PUT — Gateway or TCP/IP — and writes nothing', async (field, value) => {
    for (const connection of ['PUSH', 'MODBUS_TCP'] as const) {
      const p = (await post({ name: `TCP Put ${connection} ${field} ${value}`, connection })).json();
      const res = await put(p.id, { [field]: value, description: 'changed' });
      expect(res.statusCode, connection).toBe(400);
      expect(res.json().details.fieldErrors[field]).toEqual([PROFILE_READING_MOVED_MESSAGE]);
      const row = await prisma.instrumentProfile.findUniqueOrThrow({ where: { id: p.id } });
      expect(row.description).toBeNull();
    }
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

  it('the INSTRUMENT_PROFILE_UPDATED audit carries the connection, and no Slave ID or read interval', async () => {
    const p = (await post({ name: 'TCP Audit' })).json();
    expect((await put(p.id, { connection: 'MODBUS_TCP' })).statusCode).toBe(200);
    const row = await prisma.auditTrail.findFirstOrThrow({
      where: { action: 'INSTRUMENT_PROFILE_UPDATED', targetId: p.id }, orderBy: { timestamp: 'desc' },
    });
    expect(row.beforeValue).toMatchObject({ connection: 'PUSH' });
    expect(row.afterValue).toMatchObject({ connection: 'MODBUS_TCP' });
    expect(row.afterValue).not.toHaveProperty('modbusIntervalSec');
    expect(row.afterValue).not.toHaveProperty('modbusUnitId');
  });

  it('records the connection in the INSTRUMENT_PROFILE_CREATED audit', async () => {
    const p = (await post({ name: 'TCP AuditNew', connection: 'MODBUS_TCP' })).json();
    const row = await prisma.auditTrail.findFirstOrThrow({ where: { action: 'INSTRUMENT_PROFILE_CREATED', targetId: p.id } });
    expect(row.afterValue).toMatchObject({ connection: 'MODBUS_TCP' });
    expect(row.afterValue).not.toHaveProperty('modbusUnitId');
  });

  it('GET returns the connection', async () => {
    const p = (await post({ name: 'TCP Get', connection: 'MODBUS_TCP' })).json();
    const res = await app.inject({ method: 'GET', url: '/api/instrument-profiles', headers: auth() });
    const row = res.json().data.find((x: { id: string }) => x.id === p.id);
    expect(row).toMatchObject({ connection: 'MODBUS_TCP' });
    expect(row).not.toHaveProperty('modbusIntervalSec');
  });
});
