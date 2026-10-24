/**
 * 2026-10-24, operator: "when permissions are allowed some are not coming to
 * user roles, like instruments creation or functional locations creation".
 *
 * Roles & Access → Permissions read a role's toggles from `role_configs`, and
 * for a role never saved there (every role on the operator's install) it
 * reverse-mapped `roles.permissions` with "ANY of the node's grant set". That
 * set carries the READ dependency, so a role holding only INSTRUMENT_READ
 * showed Create / Edit / Delete Instruments ON — "allowed" — while holding
 * none of them: no Add button, 403 at the route. And because the tab sends its
 * whole map on save, the first save of anything granted every false ON for
 * real (Delete Audit Record included).
 *
 * This drives the whole chain the way the browser does: what the tab shows,
 * the save, what the role then holds, what its user's `/api/auth/me` says,
 * and the create routes themselves.
 *
 * Fixtures: a throwaway role (level 1) and user, so no seeded role moves. The
 * re-auth policy is emptied for the suite and restored after.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';

const S = Date.now().toString(36).toUpperCase();
const ROLE = `RPT_${S}`;
const USERNAME = `rpt${S}`.toLowerCase();
const PW = 'Toggle@Pass1';
const made = { locations: [] as string[], instruments: [] as string[], users: [] as string[] };

let app: FastifyInstance;
let admin: Record<string, string>;
let member: Record<string, string>;
let originalReauthRow: { configValue: unknown; configType: string; requiresReauth: boolean } | null = null;

const held = async () =>
  (await prisma.role.findUniqueOrThrow({ where: { name: ROLE }, select: { permissions: true } })).permissions as string[];

const shown = async (): Promise<Record<string, boolean>> => {
  const res = await app.inject({ method: 'GET', url: `/api/config/roles/${ROLE}`, headers: admin });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().permissions;
};

/** What the Permissions tab does: send back the map it showed, with one change. */
const saveWith = async (change: Record<string, boolean>) => {
  const res = await app.inject({
    method: 'PUT', url: `/api/config/roles/${ROLE}`, headers: admin,
    payload: { permissions: { ...(await shown()), ...change }, reason: 'e2e: role permission toggles' },
  });
  expect(res.statusCode, res.body).toBe(200);
};

beforeAll(async () => {
  app = await buildApp();
  const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
  if (existing) originalReauthRow = { configValue: existing.configValue, configType: existing.configType, requiresReauth: existing.requiresReauth };
  await prisma.systemConfig.upsert({
    where: { configKey: 'action-reauth' },
    update: { configValue: {} as never },
    create: { configKey: 'action-reauth', configValue: {} as never, configType: 'security', requiresReauth: false },
  });
  invalidateReauthCache();

  // The operator's roles as found: a READ dependency and nothing else of note.
  await prisma.role.create({
    data: { name: ROLE, displayName: `RPT ${S}`, hierarchyLevel: 1, isSystem: false,
      permissions: ['INSTRUMENT_READ', 'AUDIT_READ', 'DASHBOARD_VIEW'] },
  });
  invalidateRolePermsCache(ROLE);
  const u = await prisma.user.create({
    data: { username: USERNAME, fullName: USERNAME, role: ROLE, status: 'ENABLED',
      passwordHash: await hashPassword(PW), passwordChangedAt: new Date() },
  });
  made.users.push(u.id);
  member = { authorization: `Bearer ${await loginAs(app, USERNAME, PW)}` };
  admin = { authorization: `Bearer ${await loginAs(app)}` };
});

afterAll(async () => {
  try {
    if (originalReauthRow) await prisma.systemConfig.update({ where: { configKey: 'action-reauth' }, data: originalReauthRow as never });
    else await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
  } finally {
    invalidateReauthCache();
  }
  try { await prisma.instrument.deleteMany({ where: { id: { in: made.instruments } } }); } catch { /* best effort */ }
  try { await prisma.functionalLocation.deleteMany({ where: { id: { in: made.locations } } }); } catch { /* best effort */ }
  try {
    await prisma.session.deleteMany({ where: { userId: { in: made.users } } });
    await prisma.passwordHistory.deleteMany({ where: { userId: { in: made.users } } });
    await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  } catch { /* best effort */ }
  try {
    await prisma.roleConfig.deleteMany({ where: { role: ROLE } });
    await prisma.role.deleteMany({ where: { name: ROLE } });
  } finally {
    invalidateRolePermsCache(ROLE);
  }
  await app.close();
});

describe('Roles & Access → Permissions shows what the role holds, and a save reaches its users', () => {
  it('a never-saved role holding only READ shows View ON and Create / Edit / Delete OFF', async () => {
    const t = await shown();
    expect(t['instruments.view']).toBe(true);
    expect(t['instruments.create']).toBe(false);
    expect(t['instruments.edit']).toBe(false);
    expect(t['instruments.delete']).toBe(false);
    expect(t['settings.edit']).toBe(false);
    expect(t['audit.view']).toBe(true);
    expect(t['audit.delete']).toBe(false);
    expect(t['functional_locations.create']).toBe(false);
  });

  it('saving Create Functional Locations grants exactly that — no false ON rides along', async () => {
    await saveWith({ 'functional_locations.create': true });
    const perms = await held();
    expect(perms).toEqual(expect.arrayContaining(['FUNCTIONAL_LOCATION_CREATE', 'FUNCTIONAL_LOCATION_READ', 'INSTRUMENT_READ', 'AUDIT_READ']));
    for (const p of ['INSTRUMENT_CREATE', 'INSTRUMENT_UPDATE', 'INSTRUMENT_DELETE', 'AUDIT_DELETE', 'DASHBOARD_MANAGE']) {
      expect(perms, p).not.toContain(p);
    }
  });

  it("the role's user sees it in /api/auth/me and can create a Block — and still cannot create an instrument", async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: member });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().permissions).toContain('FUNCTIONAL_LOCATION_CREATE');

    const fl = await app.inject({
      method: 'POST', url: '/api/functional-locations', headers: member,
      payload: { name: `RPT Block ${S}`, type: 'BLOCK' },
    });
    expect(fl.statusCode, fl.body).toBe(201);
    made.locations.push(fl.json().id);

    const inst = await app.inject({
      method: 'POST', url: '/api/instruments', headers: member,
      payload: { name: `RPT-${S}`, code: `RPT-${S}`, profileId: await fixtureProfileId('fixture:role-permission-toggles') },
    });
    expect(inst.statusCode).toBe(403);
  });

  it('saving Create Instruments reaches the user too, and the tab then shows both ON', async () => {
    await saveWith({ 'instruments.create': true });
    expect(await held()).toContain('INSTRUMENT_CREATE');

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: member });
    expect(me.json().permissions).toContain('INSTRUMENT_CREATE');

    const inst = await app.inject({
      method: 'POST', url: '/api/instruments', headers: member,
      payload: { name: `RPT-${S}`, code: `RPT-${S}`, profileId: await fixtureProfileId('fixture:role-permission-toggles') },
    });
    expect(inst.statusCode, inst.body).toBe(201);
    made.instruments.push(inst.json().id);

    const t = await shown();
    expect(t['instruments.create']).toBe(true);
    expect(t['functional_locations.create']).toBe(true);
    expect(t['instruments.delete']).toBe(false);
  });

  it('a toggle stored ON that the role no longer holds reads OFF (the stored map is not the truth)', async () => {
    // Another writer moves roles.permissions without touching role_configs —
    // the Roles page's PUT, the seed, a restore.
    await prisma.role.update({
      where: { name: ROLE },
      data: { permissions: (await held()).filter((p) => p !== 'INSTRUMENT_CREATE') },
    });
    invalidateRolePermsCache(ROLE);
    const stored = await prisma.roleConfig.findUniqueOrThrow({ where: { role: ROLE }, select: { permissions: true } });
    expect((stored.permissions as Record<string, boolean>)['instruments.create']).toBe(true);
    expect((await shown())['instruments.create']).toBe(false);
  });
});

// "Export Audit Trail" (AUDIT_EXPORT) only hid the button until 2026-10-24: a
// role that could READ the trail could record an export — and so produce one —
// by calling the API. Both paths that make the file now ask for it.
describe('Export Audit Trail is enforced by the server, not only by the button', () => {
  const setPerms = async (perms: string[]) => {
    await prisma.role.update({ where: { name: ROLE }, data: { permissions: perms } });
    invalidateRolePermsCache(ROLE);
  };
  const excel = () => app.inject({
    method: 'POST', url: '/api/audit/report-export-log', headers: member,
    payload: { reportType: 'Audit Trail', format: 'Excel', recordCount: 1, remarks: 'e2e export check' },
  });
  const pdfRequest = () => app.inject({
    method: 'POST', url: '/api/report-reviews', headers: member,
    payload: { reportKind: 'audit-trail', reportType: 'Audit Trail', title: 'Audit Trail', requestMeta: {}, dataSnapshot: {}, remarks: 'e2e export check' },
  });

  it('reading the trail is not enough: the Excel record and the PDF request are 403', async () => {
    await setPerms(['AUDIT_READ', 'REPORT_REVIEW_READ']);
    const x = await excel();
    expect(x.statusCode, x.body).toBe(403);
    const p = await pdfRequest();
    expect(p.statusCode, p.body).toBe(403);
  });

  it('with Export Audit Trail the Excel export is recorded, and the PDF request passes the permission', async () => {
    await setPerms(['AUDIT_READ', 'AUDIT_EXPORT', 'REPORT_REVIEW_READ']);
    const x = await excel();
    expect(x.statusCode, x.body).toBe(200);
    // The request may still be refused by the report type's own settings
    // (approvers, remarks) — what matters here is that it is not the permission.
    const p = await pdfRequest();
    expect(p.statusCode, p.body).not.toBe(403);
  });

  it('another report type is not touched by it', async () => {
    await setPerms(['AUDIT_READ', 'ALARM_READ']);
    const res = await app.inject({
      method: 'POST', url: '/api/audit/report-export-log', headers: member,
      payload: { reportKind: 'alarms', reportType: 'Alarms', format: 'PDF', recordCount: 1, remarks: 'e2e' },
    });
    expect(res.statusCode, res.body).not.toBe(403);
  });
});
