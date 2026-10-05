/**
 * Audit 2026-10-03, API-1 and API-2.
 *
 * API-1 — `PUT /api/config/roles/:role` (Roles & Access → Permissions /
 * Sidebar) rewrote `roles.permissions` behind ROLE_MANAGE alone, with no check
 * that the caller held what it granted: an ADMIN could give ADMIN
 * `AUDIT_DELETE` in one request, live on the next. The save now applies the
 * SAME rule the Roles page's own create/update applies
 * (`assertRoleWithinCallerPrivilege`): SUPER_ADMIN exempt; otherwise not your
 * own role, not a role at or above your level, and no permission you do not
 * hold yourself. A save that ADDS nothing (a sidebar rearrangement) is still
 * allowed to any ROLE_MANAGE holder.
 *
 * API-2 — the instrument-scope and panel-access PUTs accepted `{}`; `scope ??
 * Prisma.DbNull` then wrote SQL NULL (= unrestricted / all panels) and the
 * signature line threw on `undefined` AFTER the write, with no audit row. The
 * bodies are `required` now, so `{}` is a 400 and nothing is written.
 *
 * Driven through the seeded OPERATOR (level 2) over HTTP, as the scope
 * selection suite does, because SUPER_ADMIN short-circuits every rule here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

let app: FastifyInstance;
let admin: Record<string, string>;
let operator: Record<string, string>;
let operatorPermsBefore: string[] = [];
let viewerPermsBefore: string[] = [];
let viewerConfigExisted = false;

const perms = async (name: string) =>
  ((await prisma.role.findFirstOrThrow({ where: { name }, select: { permissions: true } })).permissions as string[]);

beforeAll(async () => {
  app = await buildApp();
  admin = { authorization: `Bearer ${await loginAs(app)}` };

  operatorPermsBefore = await perms('OPERATOR');
  viewerPermsBefore = await perms('VIEWER');
  viewerConfigExisted = (await prisma.roleConfig.findFirst({ where: { role: 'VIEWER' } })) !== null;

  // The operator may manage roles for this suite — and holds nothing else new.
  await prisma.role.updateMany({
    where: { name: 'OPERATOR' },
    data: { permissions: [...new Set([...operatorPermsBefore, 'ROLE_MANAGE'])] },
  });
  invalidateRolePermsCache('OPERATOR');
  operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
});

afterAll(async () => {
  await prisma.role.updateMany({ where: { name: 'OPERATOR' }, data: { permissions: operatorPermsBefore } });
  await prisma.role.updateMany({ where: { name: 'VIEWER' }, data: { permissions: viewerPermsBefore } });
  invalidateRolePermsCache('OPERATOR');
  invalidateRolePermsCache('VIEWER');
  if (!viewerConfigExisted) await prisma.roleConfig.deleteMany({ where: { role: 'VIEWER' } });
  await app.close();
});

describe('PUT /api/config/roles/:role checks the caller\'s own privilege before writing', () => {
  it('refuses to grant a permission the caller does not hold, and writes nothing', async () => {
    const before = await perms('VIEWER');
    const res = await app.inject({
      method: 'PUT', url: '/api/config/roles/VIEWER', headers: operator,
      payload: { permissions: { 'audit.delete': true } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/AUDIT_DELETE/);
    expect(await perms('VIEWER')).toEqual(before);
  });

  it("refuses the caller's OWN role", async () => {
    const before = await perms('OPERATOR');
    const res = await app.inject({
      method: 'PUT', url: '/api/config/roles/OPERATOR', headers: operator,
      payload: { permissions: { 'audit.delete': true } },
    });
    expect(res.statusCode).toBe(403);
    expect(await perms('OPERATOR')).toEqual(before);
  });

  it('refuses a role at or above the caller\'s level', async () => {
    const before = await perms('ADMIN');
    const res = await app.inject({
      method: 'PUT', url: '/api/config/roles/ADMIN', headers: operator,
      payload: { permissions: { 'audit.delete': true } },
    });
    expect(res.statusCode).toBe(403);
    expect(await perms('ADMIN')).toEqual(before);
  });

  it('still allows a save that grants nothing new (a sidebar rearrangement) to any ROLE_MANAGE holder', async () => {
    const before = await perms('VIEWER');
    const res = await app.inject({
      method: 'PUT', url: '/api/config/roles/VIEWER', headers: operator,
      // `{}` rebuilds the set from no toggles, which REVOKES the viewer's
      // feature permissions — a change to the set, so it carries a reason
      // (DATA-11); what this case pins is that it grants nothing new.
      payload: { permissions: {}, reason: 'e2e: sidebar rearrangement' },
    });
    expect(res.statusCode, res.body).toBe(200);
    // Nothing the viewer did not already have was added.
    const after = await perms('VIEWER');
    expect(after.filter((p) => !before.includes(p))).toEqual([]);
  });

  it('SUPER_ADMIN is exempt — the grant lands', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/config/roles/VIEWER', headers: admin,
      payload: { permissions: { 'audit.delete': true }, reason: 'e2e: privilege check' },
    });
    expect(res.statusCode).toBe(200);
    expect(await perms('VIEWER')).toContain('AUDIT_DELETE');
  });

  // DATA-11 (2026-10-05): this PUT is the Permissions tab, where role
  // permissions actually change from the UI, so a change to the SET needs the
  // operator's reason; a save that moves no permission needs none.
  it('a permission change with no reason is 400 REASON_REQUIRED and writes nothing', async () => {
    const before = await perms('VIEWER');
    const res = await app.inject({
      method: 'PUT', url: '/api/config/roles/VIEWER', headers: admin,
      payload: { permissions: { 'audit.delete': !before.includes('AUDIT_DELETE') } },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ error: 'REASON_REQUIRED' });
    expect(await perms('VIEWER')).toEqual(before);
  });

  it('the reason lands on the CONFIG_CHANGED audit row of a permission change', async () => {
    const before = await perms('VIEWER');
    const reason = `e2e perm reason ${Date.now()}`;
    const res = await app.inject({
      method: 'PUT', url: '/api/config/roles/VIEWER', headers: admin,
      payload: { permissions: { 'audit.delete': !before.includes('AUDIT_DELETE') }, reason },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await prisma.auditTrail.findFirst({ where: { action: 'CONFIG_CHANGED', targetType: 'role_config', targetId: 'VIEWER' }, orderBy: { timestamp: 'desc' } });
    expect(row?.reason).toBe(reason);
  });
});

describe('scope and panel PUTs refuse an empty body instead of widening to everything', () => {
  it('instrument scope: {} is a 400 and no row is written', async () => {
    const rowsBefore = await prisma.roleConfig.count({ where: { role: 'VIEWER' } });
    const res = await app.inject({ method: 'PUT', url: '/api/roles/instrument-scope/role/VIEWER', headers: admin, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(await prisma.roleConfig.count({ where: { role: 'VIEWER' } })).toBe(rowsBefore);
  });

  it('instrument scope: an explicit null (inherit) is still accepted — with a reason', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/roles/instrument-scope/role/VIEWER', headers: admin, payload: { scope: null, reason: 'e2e: inherit' } });
    expect(res.statusCode).toBe(200);
  });

  // Audit 2026-10-03, DATA-11: a visibility change carries the operator's
  // reason, stored on the CONFIG_CHANGED row.
  it('instrument scope: a save with no reason is 400 REASON_REQUIRED and writes nothing', async () => {
    const before = await prisma.roleConfig.findUnique({ where: { role: 'VIEWER' }, select: { instrumentScope: true } });
    const res = await app.inject({
      method: 'PUT', url: '/api/roles/instrument-scope/role/VIEWER', headers: admin,
      payload: { scope: { locationIds: [], instrumentIds: [] } },
    });
    expect(res.statusCode).toBe(400);
    const after = await prisma.roleConfig.findUnique({ where: { role: 'VIEWER' }, select: { instrumentScope: true } });
    expect(after?.instrumentScope ?? null).toEqual(before?.instrumentScope ?? null);
  });

  it('instrument scope: the reason lands on the audit row', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/roles/instrument-scope/role/VIEWER', headers: admin,
      payload: { scope: null, reason: 'e2e: viewers see everything again' },
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.auditTrail.findFirst({
      where: { action: 'CONFIG_CHANGED', targetType: 'role_config', targetId: 'VIEWER' },
      orderBy: { timestamp: 'desc' },
    });
    expect(row?.reason).toBe('e2e: viewers see everything again');
  });

  // Audit 2026-10-03, API-20: a role-keyed upsert on a role that does not
  // exist is a 404, not a fresh orphan `role_configs` row.
  it('role-keyed PUTs answer 404 for an unknown role and create no config row', async () => {
    const ghost = `GHOST_${Date.now()}`;
    const scope = await app.inject({ method: 'PUT', url: `/api/roles/instrument-scope/role/${ghost}`, headers: admin, payload: { scope: null, reason: 'x' } });
    const panels = await app.inject({ method: 'PUT', url: `/api/roles/panel-access/role/${ghost}`, headers: admin, payload: { panels: null } });
    const access = await app.inject({ method: 'PUT', url: `/api/roles/attribute-access/${ghost}`, headers: admin, payload: { mode: null } });
    const layout = await app.inject({ method: 'PUT', url: `/api/roles/dashboard-layout/role/${ghost}`, headers: admin, payload: { layout: null } });
    const config = await app.inject({ method: 'PUT', url: `/api/config/roles/${ghost}`, headers: admin, payload: { sidebarItems: ['users'] } });
    for (const r of [scope, panels, access, layout, config]) expect(r.statusCode).toBe(404);
    expect(await prisma.roleConfig.count({ where: { role: ghost } })).toBe(0);
  });

  it('panel access: {} is a 400', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/roles/panel-access/role/VIEWER', headers: admin, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('user scope and user panels: {} is a 400', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'RB0001' }, select: { id: true } });
    const a = await app.inject({ method: 'PUT', url: `/api/roles/instrument-scope/user/${user.id}`, headers: admin, payload: {} });
    const b = await app.inject({ method: 'PUT', url: `/api/roles/panel-access/user/${user.id}`, headers: admin, payload: {} });
    expect(a.statusCode).toBe(400);
    expect(b.statusCode).toBe(400);
  });
});
