/**
 * Application review 2026-10-12 — the follow-ups to findings 6 and 10.
 *
 * 1 — the panel-access (role + user) and dashboard-layout PUTs had no
 *     own-role / hierarchy check, and wrote their audit rows outside the
 *     write's transaction.
 * 2 — `PUT /api/config/users/:userId` (per-user sidebar / permission
 *     overrides) had no target check: any ROLE_MANAGE holder could rewrite its
 *     own or a SUPER_ADMIN's overrides; an unknown id created an orphan row.
 * 3 — a restricted ROLE_MANAGE holder could give a lower role or user an
 *     instrument scope WIDER than its own (even "all instruments").
 *
 * Driven by a throwaway level-3 role holding ROLE_MANAGE whose own scope is
 * one Area of a throwaway Block; SUPER_ADMIN is the positive control.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

const S = Date.now().toString(36).toUpperCase();
const MGR = `AF_MGR_${S}`;
const PEER = `AF_PEER_${S}`;
const LOW = `AF_LOW_${S}`;
const ROLES = [MGR, PEER, LOW];
const PW = 'Mgr0@Passw0rd';
const users: string[] = [];
const locations: string[] = [];
const instruments: string[] = [];

let app: FastifyInstance;
let sa: Record<string, string>;
let mgr: Record<string, string>;
let mgrUser: { id: string };
let peerUser: { id: string };
let lowUser: { id: string };
let saUser: { id: string };
let block1 = '', area1 = '', area2 = '', inst1 = '', inst2 = '';

async function makeUser(username: string, role: string, password = 'Victim@Pass1') {
  const u = await prisma.user.create({
    data: { username, fullName: username, role, status: 'ENABLED', passwordHash: await hashPassword(password), passwordChangedAt: new Date(), isTemporaryPassword: false, forcePasswordChange: false },
  });
  users.push(u.id);
  return u;
}
const put = (url: string, payload: unknown, headers = mgr) => app.inject({ method: 'PUT', url, headers, payload: payload as never });

beforeAll(async () => {
  app = await buildApp();
  const mk = (name: string, level: number, permissions: string[] = []) =>
    prisma.role.create({ data: { name, displayName: name, hierarchyLevel: level, permissions } });
  await mk(MGR, 3, ['ROLE_MANAGE', 'CONFIG_READ']);
  await mk(PEER, 4);
  await mk(LOW, 2);
  invalidateRolePermsCache();

  const b = await prisma.functionalLocation.create({ data: { name: `AF Block ${S}`, type: 'BLOCK' } });
  const a1 = await prisma.functionalLocation.create({ data: { name: `AF Area1 ${S}`, type: 'AREA', parentId: b.id } });
  const a2 = await prisma.functionalLocation.create({ data: { name: `AF Area2 ${S}`, type: 'AREA', parentId: b.id } });
  block1 = b.id; area1 = a1.id; area2 = a2.id;
  locations.push(a1.id, a2.id, b.id);
  const profileId = await fixtureProfileId('fixture:auth-followups');
  const i1 = await prisma.instrument.create({ data: { code: `AF-${S}-1`, name: `AF-${S}-1`, profileId, functionalLocationId: area1 } });
  const i2 = await prisma.instrument.create({ data: { code: `AF-${S}-2`, name: `AF-${S}-2`, profileId, functionalLocationId: area2 } });
  inst1 = i1.id; inst2 = i2.id;
  instruments.push(i1.id, i2.id);

  // The caller sees Area1 only.
  await prisma.roleConfig.create({ data: { role: MGR, instrumentScope: { locationIds: [area1], instrumentIds: [] } } });

  mgrUser = await makeUser(`af${S}m`.toLowerCase(), MGR, PW);
  peerUser = await makeUser(`af${S}p`.toLowerCase(), PEER);
  lowUser = await makeUser(`af${S}l`.toLowerCase(), LOW);
  saUser = await makeUser(`af${S}s`.toLowerCase(), 'SUPER_ADMIN');
  sa = { authorization: `Bearer ${await loginAs(app)}` };
  mgr = { authorization: `Bearer ${await loginAs(app, `af${S}m`.toLowerCase(), PW)}` };
});

afterAll(async () => {
  try {
    await prisma.userConfig.deleteMany({ where: { userId: { in: users } } });
    await prisma.session.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  } catch { /* best effort */ }
  try {
    await prisma.roleConfig.deleteMany({ where: { role: { in: ROLES } } });
    await prisma.role.deleteMany({ where: { name: { in: ROLES } } });
  } finally { invalidateRolePermsCache(); }
  try {
    await prisma.instrument.deleteMany({ where: { id: { in: instruments } } });
    for (const id of locations) await prisma.functionalLocation.deleteMany({ where: { id } });
  } catch { /* best effort */ }
  await app.close();
});

describe('follow-up 1 — panel and dashboard-layout writes respect the caller\'s level', () => {
  it('own role and a higher role: panels and default layout are refused', async () => {
    for (const name of [MGR, PEER]) {
      expect((await put(`/api/roles/panel-access/role/${name}`, { panels: [] })).statusCode).toBe(403);
      expect((await put(`/api/roles/dashboard-layout/role/${name}`, { layout: null })).statusCode).toBe(403);
    }
    const cfg = await prisma.roleConfig.findUnique({ where: { role: PEER } });
    expect(cfg).toBeNull();
  });

  it('own user and a higher user: panel override refused', async () => {
    expect((await put(`/api/roles/panel-access/user/${mgrUser.id}`, { panels: [] })).statusCode).toBe(403);
    expect((await put(`/api/roles/panel-access/user/${peerUser.id}`, { panels: [] })).statusCode).toBe(403);
    expect(await prisma.userConfig.count({ where: { userId: { in: [mgrUser.id, peerUser.id] } } })).toBe(0);
  });

  it('a lower role / user can still be configured, and the audit row is written', async () => {
    const r = await put(`/api/roles/panel-access/role/${LOW}`, { panels: [] });
    const u = await put(`/api/roles/panel-access/user/${lowUser.id}`, { panels: [] });
    const l = await put(`/api/roles/dashboard-layout/role/${LOW}`, { layout: null });
    expect([r.statusCode, u.statusCode, l.statusCode]).toEqual([200, 200, 200]);
    const row = await prisma.auditTrail.findFirst({ where: { action: 'CONFIG_CHANGED', targetType: 'user_config', targetId: lowUser.id }, orderBy: { timestamp: 'desc' } });
    expect(row).toBeTruthy();
  });
});

describe('follow-up 2 — per-user config overrides have a target check', () => {
  it('own account, a higher user and a SUPER_ADMIN are refused; an unknown id is 404', async () => {
    for (const id of [mgrUser.id, peerUser.id, saUser.id]) {
      const res = await put(`/api/config/users/${id}`, { sidebarItems: ['users'] });
      expect(res.statusCode, res.body).toBe(403);
    }
    const ghost = await put('/api/config/users/00000000-0000-0000-0000-000000000000', { sidebarItems: [] });
    expect(ghost.statusCode).toBe(404);
    expect(await prisma.userConfig.count({ where: { userId: { in: [mgrUser.id, peerUser.id, saUser.id] }, NOT: { sidebarItems: { equals: [] } } } })).toBe(0);
  });

  it('a lower user can still be configured (positive control)', async () => {
    const res = await put(`/api/config/users/${lowUser.id}`, { sidebarItems: ['users'] });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('follow-up 3 — a restricted admin cannot grant scope wider than its own', () => {
  const role = (scope: unknown, headers = mgr) => put(`/api/roles/instrument-scope/role/${LOW}`, { scope, reason: 'e2e' }, headers);
  const user = (scope: unknown) => put(`/api/roles/instrument-scope/user/${lowUser.id}`, { scope, reason: 'e2e' });

  it('ALL instruments (null) is refused to a restricted caller', async () => {
    expect((await role(null)).statusCode).toBe(403);
  });

  it('a Block whose Areas the caller does not all cover is refused', async () => {
    expect((await role({ locationIds: [block1], instrumentIds: [] })).statusCode).toBe(403);
  });

  it('an Area outside the caller\'s scope, and an instrument in it, are refused', async () => {
    expect((await role({ locationIds: [area2], instrumentIds: [] })).statusCode).toBe(403);
    expect((await role({ locationIds: [], instrumentIds: [inst2] })).statusCode).toBe(403);
  });

  it('within the caller\'s scope is accepted: its Area, an instrument in it, or nothing', async () => {
    expect((await role({ locationIds: [area1], instrumentIds: [] })).statusCode).toBe(200);
    expect((await role({ locationIds: [], instrumentIds: [inst1] })).statusCode).toBe(200);
    expect((await role({ locationIds: [], instrumentIds: [] })).statusCode).toBe(200);
  });

  it('a user override of null INHERITS the role scope — allowed only when that is within the caller', async () => {
    await prisma.roleConfig.update({ where: { role: LOW }, data: { instrumentScope: { locationIds: [area1], instrumentIds: [] } } });
    expect((await user(null)).statusCode).toBe(200);
    await prisma.roleConfig.update({ where: { role: LOW }, data: { instrumentScope: { locationIds: [area2], instrumentIds: [] } } });
    expect((await user(null)).statusCode).toBe(403);
  });

  it('a user override wider than the caller is refused', async () => {
    expect((await user({ locationIds: [block1], instrumentIds: [] })).statusCode).toBe(403);
  });

  it('SUPER_ADMIN may grant anything (positive control)', async () => {
    expect((await role(null, sa)).statusCode).toBe(200);
  });
});
