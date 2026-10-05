/**
 * Audit 2026-10-03, SEC-7.
 *
 * `POST /api/instruments`, `PUT /api/instruments/:id`, `DELETE
 * /api/instruments/:id`, `PUT /api/instrument-profiles/:id` and `DELETE
 * /api/instrument-profiles/:id` carried no e-signature while the
 * functional-location routes did, and no reauth action existed to configure
 * one. Five configurable actions now exist (`CREATE_INSTRUMENT`,
 * `UPDATE_INSTRUMENT`, `DELETE_INSTRUMENT`, `UPDATE_INSTRUMENT_PROFILE`,
 * `DELETE_INSTRUMENT_PROFILE`) and each route is gated with `enforceReauth`.
 *
 * Driven with the policy switched ON for SUPER_ADMIN, because the seeded
 * policy is `{}` (reauth OFF for everything) and against it the gates would
 * pass vacuously. The row is restored in `afterAll` FIRST, before anything
 * that can throw — a suite must hand back the config it touched even while
 * failing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, ADMIN_PASSWORD } from './test-helper.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { prisma } from '../lib/prisma.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';

let app: FastifyInstance;
let auth: Record<string, string>;
const reauth = { 'x-reauth-password': ADMIN_PASSWORD };
const s = Date.now();
const made: string[] = [];
let profileId = '';
let originalReauthRow: { configValue: unknown; configType: string; requiresReauth: boolean } | null = null;

const POLICY = {
  CREATE_INSTRUMENT: ['SUPER_ADMIN'],
  UPDATE_INSTRUMENT: ['SUPER_ADMIN'],
  DELETE_INSTRUMENT: ['SUPER_ADMIN'],
  UPDATE_INSTRUMENT_PROFILE: ['SUPER_ADMIN'],
  DELETE_INSTRUMENT_PROFILE: ['SUPER_ADMIN'],
};

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  profileId = await fixtureProfileId('fixture:reauth-gates');

  const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
  if (existing) {
    originalReauthRow = { configValue: existing.configValue, configType: existing.configType, requiresReauth: existing.requiresReauth };
  }
  await prisma.systemConfig.upsert({
    where: { configKey: 'action-reauth' },
    update: { configValue: POLICY as never, configType: 'security', requiresReauth: false },
    create: { configKey: 'action-reauth', configValue: POLICY as never, configType: 'security', requiresReauth: false },
  });
  invalidateReauthCache();
});

afterAll(async () => {
  // Config restore FIRST, guarded on its own.
  try {
    if (originalReauthRow) {
      await prisma.systemConfig.update({ where: { configKey: 'action-reauth' }, data: originalReauthRow as never });
    } else {
      await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
    }
  } finally {
    invalidateReauthCache();
  }
  await prisma.instrument.deleteMany({ where: { id: { in: made } } });
  await prisma.instrument.deleteMany({ where: { code: { startsWith: `RG-${s}-BULK` } } });
  await prisma.instrumentProfile.deleteMany({ where: { name: { startsWith: `RG-${s}` } } });
  await app.close();
});

const payload = (code: string) => ({ name: code, code, profileId });

describe('instrument registry mutations carry a configurable e-signature', () => {
  it('POST /api/instruments: 401 REAUTH_REQUIRED without a password, 201 with one', async () => {
    const refused = await app.inject({ method: 'POST', url: '/api/instruments', headers: auth, payload: payload(`RG-${s}-A`) });
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ error: 'REAUTH_REQUIRED', action: 'CREATE_INSTRUMENT' });
    expect(await prisma.instrument.findFirst({ where: { code: `RG-${s}-A` } })).toBeNull();

    const ok = await app.inject({ method: 'POST', url: '/api/instruments', headers: { ...auth, ...reauth }, payload: payload(`RG-${s}-A`) });
    expect(ok.statusCode).toBe(201);
    made.push(ok.json().id);
  });

  it('POST /api/instruments/bulk: gated under CREATE_INSTRUMENT like the single create', async () => {
    const csv = `Instrument ID
RG-${s}-BULK-1`;
    const refused = await app.inject({ method: 'POST', url: '/api/instruments/bulk', headers: auth, payload: { csv, profileId } });
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ error: 'REAUTH_REQUIRED', action: 'CREATE_INSTRUMENT' });
    expect(await prisma.instrument.count({ where: { code: `RG-${s}-BULK-1` } })).toBe(0);

    const ok = await app.inject({ method: 'POST', url: '/api/instruments/bulk', headers: { ...auth, ...reauth }, payload: { csv, profileId } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await prisma.instrument.count({ where: { code: `RG-${s}-BULK-1` } })).toBe(1);
  });

  it('a wrong password is refused and nothing is created', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: { ...auth, 'x-reauth-password': 'not-the-password' }, payload: payload(`RG-${s}-W`),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('REAUTH_FAILED');
    expect(await prisma.instrument.findFirst({ where: { code: `RG-${s}-W` } })).toBeNull();
  });

  it('PUT /api/instruments/:id: gated, and the body password is stripped before the update', async () => {
    const id = made[0];
    const refused = await app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers: auth, payload: { name: 'renamed' } });
    expect(refused.statusCode).toBe(401);
    expect(refused.json().action).toBe('UPDATE_INSTRUMENT');
    expect(await prisma.instrument.findUnique({ where: { id }, select: { name: true } })).toMatchObject({ name: `RG-${s}-A` });

    // `_currentPassword` in the BODY is the web client's form; it must be
    // consumed by the gate, not reach the zod schema as an unknown key.
    const ok = await app.inject({
      method: 'PUT', url: `/api/instruments/${id}`, headers: auth, payload: { name: 'renamed', _currentPassword: ADMIN_PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().name).toBe('renamed');
  });

  it('DELETE /api/instruments/:id: gated; the instrument survives a refused call', async () => {
    const id = made[0];
    const refused = await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
    expect(refused.statusCode).toBe(401);
    expect(refused.json().action).toBe('DELETE_INSTRUMENT');
    expect(await prisma.instrument.findUnique({ where: { id } })).not.toBeNull();

    const ok = await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: { ...auth, ...reauth } });
    expect(ok.statusCode).toBe(200);
    expect(await prisma.instrument.findUnique({ where: { id } })).toBeNull();
    made.length = 0;
  });

  it('PUT and DELETE /api/instrument-profiles/:id: gated the same way', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/instrument-profiles', headers: auth, payload: { name: `RG-${s} profile` } });
    expect(created.statusCode).toBe(201);
    const pid = created.json().id as string;

    const put = await app.inject({ method: 'PUT', url: `/api/instrument-profiles/${pid}`, headers: auth, payload: { description: 'x' } });
    expect(put.statusCode).toBe(401);
    expect(put.json().action).toBe('UPDATE_INSTRUMENT_PROFILE');
    expect(await prisma.instrumentProfile.findUnique({ where: { id: pid }, select: { description: true } })).toMatchObject({ description: null });

    const putOk = await app.inject({ method: 'PUT', url: `/api/instrument-profiles/${pid}`, headers: { ...auth, ...reauth }, payload: { description: 'x' } });
    expect(putOk.statusCode).toBe(200);

    const del = await app.inject({ method: 'DELETE', url: `/api/instrument-profiles/${pid}`, headers: auth });
    expect(del.statusCode).toBe(401);
    expect(del.json().action).toBe('DELETE_INSTRUMENT_PROFILE');
    expect(await prisma.instrumentProfile.findUnique({ where: { id: pid } })).not.toBeNull();

    const delOk = await app.inject({ method: 'DELETE', url: `/api/instrument-profiles/${pid}`, headers: { ...auth, ...reauth } });
    expect(delOk.statusCode).toBe(200);
  });

  // The precedent these gates copy: nothing changes for a role the policy
  // does not name. The seeded policy names nobody, which is what every other
  // e2e in this suite relies on.
  it('a role the policy does not name is not challenged', async () => {
    await prisma.systemConfig.update({ where: { configKey: 'action-reauth' }, data: { configValue: {} as never } });
    invalidateReauthCache();
    const ok = await app.inject({ method: 'POST', url: '/api/instruments', headers: auth, payload: payload(`RG-${s}-N`) });
    expect(ok.statusCode).toBe(201);
    made.push(ok.json().id);
  });
});
