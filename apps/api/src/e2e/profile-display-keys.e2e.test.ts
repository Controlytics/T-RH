/**
 * The trend page's extra keys, per instrument profile (widget data keys phase 3).
 *
 * Pins, over HTTP: the keys round-trip through the profile GET with every inner
 * key (Fastify strips undeclared fields); the PUT is strict and SUPER_ADMIN-only;
 * an unchanged list writes no audit row and a change writes one with before and
 * after; a corrupted stored value reads as none rather than breaking the page.
 *
 * Owns its profile, role and user; the profile's display keys are put back FIRST
 * in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

const S = Date.now().toString(36).toUpperCase();
const EDITOR = `PDK_EDIT_${S}`;
const PW = 'Pdk3ys@Passw0rd';
const users: string[] = [];
const reauth = { 'x-reauth-password': 'Admin@123' };

let app: FastifyInstance;
let sa: Record<string, string>;
let editor: Record<string, string>;
let profileId = '';

const KEYS = [
  { source: 'telemetry', key: 'pressure_kpa', label: 'Differential pressure', unit: 'kPa', decimals: 2, color: 3 },
  { source: 'telemetry', key: 'state' },
];

const put = (headers: Record<string, string>, displayKeys: unknown, reason?: string) =>
  app.inject({
    method: 'PUT', url: `/api/instrument-profiles/${profileId}/display-keys`,
    headers: { ...headers, ...reauth }, payload: { displayKeys, ...(reason ? { reason } : {}) } as never,
  });
const get = async () => {
  const res = await app.inject({ method: 'GET', url: `/api/instrument-profiles/${profileId}`, headers: sa });
  expect(res.statusCode).toBe(200);
  return res.json() as { displayKeys: unknown[] };
};
const audits = () => prisma.auditTrail.count({
  where: { action: 'INSTRUMENT_PROFILE_UPDATED', targetId: profileId },
});

beforeAll(async () => {
  app = await buildApp();
  profileId = await fixtureProfileId('fixture:profile-display-keys');
  await prisma.instrumentProfile.update({ where: { id: profileId }, data: { displayKeys: Prisma.DbNull } });
  await prisma.role.create({ data: { name: EDITOR, displayName: EDITOR, hierarchyLevel: 2, permissions: ['INSTRUMENT_READ', 'INSTRUMENT_UPDATE'] } });
  invalidateRolePermsCache();
  const u = await prisma.user.create({
    data: {
      username: `pdk_edit_${S}`.toLowerCase(), fullName: 'pdk', role: EDITOR, status: 'ENABLED',
      passwordHash: await hashPassword(PW), passwordChangedAt: new Date(), isTemporaryPassword: false, forcePasswordChange: false,
    },
  });
  users.push(u.id);
  sa = { authorization: `Bearer ${await loginAs(app)}` };
  editor = { authorization: `Bearer ${await loginAs(app, `pdk_edit_${S}`.toLowerCase(), PW)}` };
});

afterAll(async () => {
  try {
    await prisma.instrumentProfile.update({ where: { id: profileId }, data: { displayKeys: Prisma.DbNull } });
  } catch { /* best effort — the rest must still run */ }
  try {
    await prisma.session.deleteMany({ where: { userId: { in: users } } });
    await prisma.userConfig.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.role.deleteMany({ where: { name: EDITOR } });
    invalidateRolePermsCache();
  } catch { /* best effort */ }
  await app.close();
});

describe('PUT /api/instrument-profiles/:id/display-keys', () => {
  it("a super admin's keys round-trip through the profile GET, inner keys included", async () => {
    const res = await put(sa, KEYS);
    expect(res.statusCode).toBe(200);
    expect((await get()).displayKeys).toEqual(KEYS);
  });

  it('an attribute key or 13 keys is a 400, and nothing is stored', async () => {
    const attr = await put(sa, [{ source: 'attribute', key: 'Firmware' }]);
    expect(attr.statusCode).toBe(400);
    expect((attr.json() as { message: string }).message).toContain('an attribute has no history');
    const many = await put(sa, Array.from({ length: 13 }, (_, n) => ({ source: 'telemetry', key: `k${n}` })));
    expect(many.statusCode).toBe(400);
    expect((await get()).displayKeys).toEqual(KEYS);
  });

  it('a non-super-admin with Instrument Update gets 403', async () => {
    const res = await put(editor, [{ source: 'telemetry', key: 'p' }]);
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('SUPER_ADMIN_ONLY');
    expect((await get()).displayKeys).toEqual(KEYS);
  });

  it('saving the same keys writes no audit row; a change writes one with before and after', async () => {
    const before = await audits();
    expect((await put(sa, KEYS)).statusCode).toBe(200);
    expect(await audits()).toBe(before);

    const next = [{ source: 'telemetry', key: 'state', label: 'Run state' }];
    expect((await put(sa, next, 'Trend page shows run state')).statusCode).toBe(200);
    expect(await audits()).toBe(before + 1);
    const row = await prisma.auditTrail.findFirstOrThrow({
      where: { action: 'INSTRUMENT_PROFILE_UPDATED', targetId: profileId }, orderBy: { timestamp: 'desc' },
    });
    expect(row.beforeValue).toEqual({ displayKeys: KEYS });
    expect(row.afterValue).toEqual({ displayKeys: next });
    expect(row.reason).toBe('Trend page shows run state');
  });

  it('a stored value that is not a list reads as none', async () => {
    await prisma.$executeRaw`UPDATE instrument_profiles SET display_keys = '"x"'::jsonb WHERE id = ${profileId}`;
    expect((await get()).displayKeys).toEqual([]);
  });

  it('the list route carries displayKeys too', async () => {
    expect((await put(sa, KEYS)).statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/api/instrument-profiles', headers: sa });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { id: string; displayKeys: unknown[] }[] } | { id: string; displayKeys: unknown[] }[];
    const list = Array.isArray(body) ? body : body.data;
    expect(list.find((p) => p.id === profileId)?.displayKeys).toEqual(KEYS);
  });
});
