/**
 * Application review 2026-10-12, findings 5, 6 and 10.
 *
 * 5 — `DELETE /api/roles/:name` had no isSystem guard and no hierarchy guard:
 *     any ROLE_MANAGE holder could delete a system role, its own role, or a
 *     role above it (only "has users" stopped it).
 * 6 — the per-role and per-user instrument-scope and attribute-access writes
 *     had no own-role / hierarchy check: a restricted ROLE_MANAGE holder could
 *     set its OWN scope to "all instruments".
 * 10 — `PUT /api/config/roles/:role` ran the privilege check only when a save
 *     ADDED permissions, so a sidebar save reached roles at or above the
 *     caller, its own role, and SUPER_ADMIN's config.
 *
 * Driven by a throwaway level-3 role holding ROLE_MANAGE; SUPER_ADMIN bypasses
 * every rule here, so it is only the positive control.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

const S = Date.now().toString(36).toUpperCase();
const MGR = `RG_MGR_${S}`;    // level 3, ROLE_MANAGE — the caller
const PEER = `RG_PEER_${S}`;  // level 4 — above the caller
const LOW = `RG_LOW_${S}`;    // level 2 — below the caller
const SYS = `RG_SYS_${S}`;    // level 1, isSystem — must never be deletable
const ROLES = [MGR, PEER, LOW, SYS, `RG_DEL_${S}`];
const PW = 'Mgr0@Passw0rd';
const users: string[] = [];

let app: FastifyInstance;
let sa: Record<string, string>;
let mgr: Record<string, string>;
let mgrUser: { id: string };
let peerUser: { id: string };
let lowUser: { id: string };
// SUPER_ADMIN's config row is a target of the negative cases; on a regression
// they WRITE it, so it is snapshotted and put back whatever happens.
let saConfigBefore: Awaited<ReturnType<typeof prisma.roleConfig.findUnique>> = null;

async function makeUser(username: string, role: string, password = 'Victim@Pass1') {
  const u = await prisma.user.create({
    data: { username, fullName: username, role, status: 'ENABLED', passwordHash: await hashPassword(password), passwordChangedAt: new Date() },
  });
  users.push(u.id);
  return u;
}
const scopeOf = async (role: string) =>
  (await prisma.roleConfig.findUnique({ where: { role }, select: { instrumentScope: true } }))?.instrumentScope ?? null;

beforeAll(async () => {
  app = await buildApp();
  saConfigBefore = await prisma.roleConfig.findUnique({ where: { role: 'SUPER_ADMIN' } });
  const mk = (name: string, level: number, permissions: string[] = [], isSystem = false) =>
    prisma.role.create({ data: { name, displayName: name, hierarchyLevel: level, permissions, isSystem } });
  await mk(MGR, 3, ['ROLE_MANAGE', 'CONFIG_READ']);
  await mk(PEER, 4);
  await mk(LOW, 2);
  await mk(SYS, 1, [], true);
  invalidateRolePermsCache();
  mgrUser = await makeUser(`rg${S}m`.toLowerCase(), MGR, PW);
  peerUser = await makeUser(`rg${S}p`.toLowerCase(), PEER);
  lowUser = await makeUser(`rg${S}l`.toLowerCase(), LOW);
  // A restricted scope for the caller's own role: the thing it must not lift.
  await prisma.roleConfig.create({ data: { role: MGR, instrumentScope: { locationIds: [], instrumentIds: [] } } });
  sa = { authorization: `Bearer ${await loginAs(app)}` };
  mgr = { authorization: `Bearer ${await loginAs(app, `rg${S}m`.toLowerCase(), PW)}` };
});

afterAll(async () => {
  try {
    if (saConfigBefore) {
      const j = (v: unknown) => (v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));
      await prisma.roleConfig.update({
        where: { role: 'SUPER_ADMIN' },
        data: {
          sidebarItems: saConfigBefore.sidebarItems as Prisma.InputJsonValue,
          homeWidgets: saConfigBefore.homeWidgets as Prisma.InputJsonValue,
          permissions: saConfigBefore.permissions as Prisma.InputJsonValue,
          instrumentScope: j(saConfigBefore.instrumentScope),
          attributeAccess: j(saConfigBefore.attributeAccess),
        },
      });
    } else {
      await prisma.roleConfig.deleteMany({ where: { role: 'SUPER_ADMIN' } });
    }
  } catch { /* best effort — config restore first */ }
  try {
    await prisma.userConfig.deleteMany({ where: { userId: { in: users } } });
    await prisma.session.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  } catch { /* best effort */ }
  try {
    await prisma.roleConfig.deleteMany({ where: { role: { in: ROLES } } });
    await prisma.role.deleteMany({ where: { name: { in: ROLES } } });
  } finally { invalidateRolePermsCache(); }
  await app.close();
});

describe('finding 5 — DELETE /api/roles/:name', () => {
  it('a system role cannot be deleted, even by SUPER_ADMIN', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/roles/${SYS}`, headers: sa });
    expect([400, 403]).toContain(res.statusCode);
    expect(await prisma.role.count({ where: { name: SYS } })).toBe(1);
  });

  it('the caller\'s own role cannot be deleted', async () => {
    // Give the caller a role with no other holder so ROLE_HAS_USERS cannot be
    // the reason: move the caller onto a scratch role for this one check.
    const res = await app.inject({ method: 'DELETE', url: `/api/roles/${MGR}`, headers: mgr });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('a role above the caller cannot be deleted', async () => {
    await prisma.user.update({ where: { id: peerUser.id }, data: { role: LOW } }); // empty PEER so 409 cannot answer
    try {
      const res = await app.inject({ method: 'DELETE', url: `/api/roles/${PEER}`, headers: mgr });
      expect(res.statusCode, res.body).toBe(403);
      expect(await prisma.role.count({ where: { name: PEER } })).toBe(1);
    } finally {
      await prisma.user.update({ where: { id: peerUser.id }, data: { role: PEER } });
    }
  });

  it('a custom role below the caller can still be deleted (positive control)', async () => {
    await prisma.role.create({ data: { name: `RG_DEL_${S}`, displayName: 'del', hierarchyLevel: 1, permissions: [] } });
    const res = await app.inject({ method: 'DELETE', url: `/api/roles/RG_DEL_${S}`, headers: mgr });
    expect(res.statusCode, res.body).toBe(200);
    expect(await prisma.role.count({ where: { name: `RG_DEL_${S}` } })).toBe(0);
  });
});

describe('finding 6 — scope and attribute-access writes respect the caller\'s own level', () => {
  it('the caller cannot widen its OWN role\'s instrument scope', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/roles/instrument-scope/role/${MGR}`, headers: mgr, payload: { scope: null, reason: 'mine' } });
    expect(res.statusCode, res.body).toBe(403);
    expect(await scopeOf(MGR)).toEqual({ locationIds: [], instrumentIds: [] });
  });

  it('the caller cannot set the scope of a role above it', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/roles/instrument-scope/role/${PEER}`, headers: mgr, payload: { scope: { locationIds: [], instrumentIds: [] }, reason: 'x' } });
    expect(res.statusCode, res.body).toBe(403);
    expect(await scopeOf(PEER)).toBeNull();
  });

  it('nor SUPER_ADMIN\'s', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/roles/instrument-scope/role/SUPER_ADMIN', headers: mgr, payload: { scope: { locationIds: [], instrumentIds: [] }, reason: 'x' } });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('the caller cannot give ITSELF a user override', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/roles/instrument-scope/user/${mgrUser.id}`, headers: mgr, payload: { scope: null, reason: 'mine' } });
    // null on a user override means "inherit role" — try a widening selection too
    const res2 = await app.inject({ method: 'PUT', url: `/api/roles/instrument-scope/user/${mgrUser.id}`, headers: mgr, payload: { scope: { locationIds: ['x'], instrumentIds: [] }, reason: 'mine' } });
    expect(res.statusCode, res.body).toBe(403);
    expect(res2.statusCode, res2.body).toBe(403);
    expect(await prisma.userConfig.count({ where: { userId: mgrUser.id } })).toBe(0);
  });

  it('the caller cannot override a user whose role is above it', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/roles/instrument-scope/user/${peerUser.id}`, headers: mgr, payload: { scope: { locationIds: [], instrumentIds: [] }, reason: 'x' } });
    expect(res.statusCode, res.body).toBe(403);
    expect(await prisma.userConfig.count({ where: { userId: peerUser.id } })).toBe(0);
  });

  // The per-USER attribute rule (2026-10-24) answers to the same rule as the
  // per-user scope override: not yourself, not a user whose role is above you.
  it('per-user attribute access: own user and a user above are refused, nothing written', async () => {
    const own = await app.inject({ method: 'PUT', url: `/api/roles/attribute-access/user/${mgrUser.id}`, headers: mgr, payload: { mode: 'ALL_EDIT', reason: 'mine' } });
    const up = await app.inject({ method: 'PUT', url: `/api/roles/attribute-access/user/${peerUser.id}`, headers: mgr, payload: { mode: 'ALL_EDIT', reason: 'x' } });
    expect(own.statusCode, own.body).toBe(403);
    expect(up.statusCode, up.body).toBe(403);
    const rows = await prisma.userConfig.findMany({ where: { userId: { in: [mgrUser.id, peerUser.id] } }, select: { attributeAccess: true } });
    expect(rows.every((r) => r.attributeAccess === null)).toBe(true);
  });

  it('attribute access: own role and a higher role are refused', async () => {
    const own = await app.inject({ method: 'PUT', url: `/api/roles/attribute-access/${MGR}`, headers: mgr, payload: { mode: 'ALL_EDIT' } });
    const up = await app.inject({ method: 'PUT', url: `/api/roles/attribute-access/${PEER}`, headers: mgr, payload: { mode: 'ALL_EDIT' } });
    expect(own.statusCode, own.body).toBe(403);
    expect(up.statusCode, up.body).toBe(403);
    const cfg = await prisma.roleConfig.findUnique({ where: { role: MGR }, select: { attributeAccess: true } });
    expect(cfg?.attributeAccess ?? null).toBeNull();
  });

  it('a role and a user BELOW the caller can still be configured (positive control)', async () => {
    const r = await app.inject({ method: 'PUT', url: `/api/roles/instrument-scope/role/${LOW}`, headers: mgr, payload: { scope: { locationIds: [], instrumentIds: [] }, reason: 'e2e' } });
    const u = await app.inject({ method: 'PUT', url: `/api/roles/instrument-scope/user/${lowUser.id}`, headers: mgr, payload: { scope: { locationIds: [], instrumentIds: [] }, reason: 'e2e' } });
    // A reason is required on attribute-access saves since 2026-10-24.
    const a = await app.inject({ method: 'PUT', url: `/api/roles/attribute-access/${LOW}`, headers: mgr, payload: { mode: 'ALL_VIEW', reason: 'e2e' } });
    const ua = await app.inject({ method: 'PUT', url: `/api/roles/attribute-access/user/${lowUser.id}`, headers: mgr, payload: { mode: 'SELECTED', keys: ['Room'], reason: 'e2e' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(u.statusCode, u.body).toBe(200);
    expect(a.statusCode, a.body).toBe(200);
    expect(ua.statusCode, ua.body).toBe(200);
  });
});

describe('finding 10 — PUT /api/config/roles/:role checks the target even when nothing is added', () => {
  it('a sidebar save to a role above the caller is refused', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/config/roles/${PEER}`, headers: mgr, payload: { sidebarItems: [] } });
    expect(res.statusCode, res.body).toBe(403);
    expect(await prisma.roleConfig.count({ where: { role: PEER } })).toBe(0);
  });

  it('a sidebar save to the caller\'s own role is refused', async () => {
    const before = await prisma.roleConfig.findUnique({ where: { role: MGR }, select: { sidebarItems: true } });
    const res = await app.inject({ method: 'PUT', url: `/api/config/roles/${MGR}`, headers: mgr, payload: { sidebarItems: [] } });
    expect(res.statusCode, res.body).toBe(403);
    const after = await prisma.roleConfig.findUnique({ where: { role: MGR }, select: { sidebarItems: true } });
    expect(after?.sidebarItems).toEqual(before?.sidebarItems);
  });

  it('SUPER_ADMIN\'s config is refused to a non-SUPER_ADMIN', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config/roles/SUPER_ADMIN', headers: mgr, payload: { sidebarItems: [] } });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('a sidebar save to a role below the caller still works (positive control)', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/config/roles/${LOW}`, headers: mgr, payload: { sidebarItems: [] } });
    expect(res.statusCode, res.body).toBe(200);
  });
});
