/**
 * 2026-10-24 — per-USER attribute access, combined with the role's rule
 * (operator: "who can edit which attributes … configurable role wise or user
 * wise"; decision: a user rule and the role rule COMBINE).
 *
 * Throwaway role (Edit Instruments) + two users of it + one instrument with
 * attributes `Room` and `Area`. The role is SELECTED [Room]; user A also gets
 * SELECTED [Area] of their own; user B gets nothing of their own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

const S = Date.now().toString(36).toUpperCase();
const ROLE = `UAA_${S}`;
const PW = 'UserAttr@Pass1';
const U = { A: `uaa${S}a`.toLowerCase(), B: `uaa${S}b`.toLowerCase() };
const ids: Record<string, string> = {};
let app: FastifyInstance;
const tok: Record<string, Record<string, string>> = {};
let instrumentId = '';
let originalReauth: { configValue: unknown; configType: string; requiresReauth: boolean } | null = null;

const setRoleRule = (rule: unknown) => prisma.roleConfig.upsert({
  where: { role: ROLE },
  update: { attributeAccess: (rule ?? Prisma.DbNull) as never },
  create: { role: ROLE, attributeAccess: (rule ?? Prisma.DbNull) as never },
});
const setUserRule = (userId: string, rule: unknown) => prisma.userConfig.upsert({
  where: { userId },
  update: { attributeAccess: (rule ?? Prisma.DbNull) as never },
  create: { userId, attributeAccess: (rule ?? Prisma.DbNull) as never },
});
const putAttr = (who: string, key: string, value: string) => app.inject({
  method: 'PUT', url: `/api/instruments/${instrumentId}/attributes/${encodeURIComponent(key)}`, headers: tok[who],
  payload: { value, reason: 'e2e attribute change' },
});
const me = async (who: string) =>
  (await app.inject({ method: 'GET', url: '/api/instruments/attribute-access/me', headers: tok[who] })).json();

beforeAll(async () => {
  app = await buildApp();
  const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
  if (existing) originalReauth = { configValue: existing.configValue, configType: existing.configType, requiresReauth: existing.requiresReauth };
  await prisma.systemConfig.upsert({
    where: { configKey: 'action-reauth' },
    update: { configValue: {} as never },
    create: { configKey: 'action-reauth', configValue: {} as never, configType: 'security', requiresReauth: false },
  });
  invalidateReauthCache();
  await prisma.role.create({
    data: { name: ROLE, displayName: ROLE, hierarchyLevel: 1, isSystem: false, permissions: ['INSTRUMENT_READ', 'INSTRUMENT_UPDATE'] },
  });
  invalidateRolePermsCache(ROLE);
  for (const [k, username] of Object.entries(U)) {
    ids[k] = (await prisma.user.create({
      data: { username, fullName: username, role: ROLE, status: 'ENABLED', passwordHash: await hashPassword(PW), passwordChangedAt: new Date() },
    })).id;
    tok[k] = { authorization: `Bearer ${await loginAs(app, username, PW)}` };
  }
  const admin = { authorization: `Bearer ${await loginAs(app)}` };
  const created = await app.inject({
    method: 'POST', url: '/api/instruments', headers: admin,
    payload: { name: `UAA-${S}`, code: `UAA-${S}`, profileId: await fixtureProfileId('fixture:user-attribute-access') },
  });
  expect(created.statusCode, created.body).toBe(201);
  instrumentId = created.json().id;
  for (const key of ['Room', 'Area']) {
    const r = await app.inject({ method: 'POST', url: `/api/instruments/${instrumentId}/attributes`, headers: admin, payload: { key, value: 'x' } });
    expect(r.statusCode, r.body).toBeLessThan(300);
  }
});

afterAll(async () => {
  try {
    if (originalReauth) await prisma.systemConfig.update({ where: { configKey: 'action-reauth' }, data: originalReauth as never });
    else await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
  } finally { invalidateReauthCache(); }
  try { await prisma.instrument.deleteMany({ where: { id: instrumentId } }); } catch { /* best effort */ }
  try {
    const userIds = Object.values(ids);
    await prisma.userConfig.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.passwordHistory.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  } catch { /* best effort */ }
  try {
    await prisma.roleConfig.deleteMany({ where: { role: ROLE } });
    await prisma.role.deleteMany({ where: { name: ROLE } });
  } finally { invalidateRolePermsCache(ROLE); }
  await app.close();
});

describe('a user rule is COMBINED with the role rule', () => {
  it('role SELECTED [Room] + user A SELECTED [Area]: A may change Area, B (no rule of their own) may not', async () => {
    await setRoleRule({ mode: 'SELECTED', keys: ['Room'], requireReauth: false });
    await setUserRule(ids.A, { mode: 'SELECTED', keys: ['Area'], requireReauth: false });
    const a = await putAttr('A', 'Area', 'a1');
    expect(a.statusCode, a.body).toBe(200);
    expect((await putAttr('A', 'Room', 'r1')).statusCode).toBe(200);
    const refused = await putAttr('B', 'Area', 'b1');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toMatch(/You may view "Area"/);
  });

  it('/attribute-access/me returns the combined rule — the same one the gate enforced', async () => {
    expect(await me('A')).toMatchObject({ mode: 'SELECTED', keys: ['Room', 'Area'] });
    expect(await me('B')).toMatchObject({ mode: 'SELECTED', keys: ['Room'] });
  });

  it('role not configured: a user ALL_VIEW rule leaves everything editable', async () => {
    await setRoleRule(null);
    await setUserRule(ids.A, { mode: 'ALL_VIEW', keys: [], requireReauth: false });
    expect((await putAttr('A', 'Room', 'r2')).statusCode).toBe(200);
    expect((await me('A')).mode).toBe('ALL_EDIT');
  });

  it('a user ALL_EDIT rule never edits without Edit Instruments on the role', async () => {
    await setRoleRule({ mode: 'ALL_VIEW', keys: [], requireReauth: false });
    await setUserRule(ids.A, { mode: 'ALL_EDIT', keys: [], requireReauth: false });
    await prisma.role.update({ where: { name: ROLE }, data: { permissions: ['INSTRUMENT_READ'] } });
    invalidateRolePermsCache(ROLE);
    try {
      expect((await putAttr('A', 'Room', 'r3')).statusCode).toBe(403);
    } finally {
      await prisma.role.update({ where: { name: ROLE }, data: { permissions: ['INSTRUMENT_READ', 'INSTRUMENT_UPDATE'] } });
      invalidateRolePermsCache(ROLE);
    }
  });
});
