/**
 * Panel assignment, per role and per user.
 *
 * Driven through the seeded OPERATOR over HTTP, never through the resolver
 * directly: SUPER_ADMIN short-circuits to "every panel", so an admin-driven
 * version of these assertions would pass against a route with no resolution at
 * all. Every restricted case is paired with a positive control.
 *
 * What this file exists to prove is the three-state rule. `NULL` = inherit,
 * `[]` = NO panels, `[keys]` = these. Collapsing the first two — which is exactly
 * what `getMyConfig` does for `sidebarItems` a few lines from the resolver — turns
 * a deliberate deny into a grant.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

let app: FastifyInstance;
let auth: Record<string, string>;
let operator: Record<string, string>;
let operatorId = '';
const reauth = { 'x-reauth-password': 'Admin@123' };

/** The panels the seeded OPERATOR resolves to right now, as the wire reports them. */
async function myPanels(): Promise<string[] | null> {
  const res = await app.inject({ method: 'GET', url: '/api/config/my-config', headers: operator });
  expect(res.statusCode).toBe(200);
  return (res.json() as { panels: string[] | null }).panels;
}

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
  operatorId = (await prisma.user.findUniqueOrThrow({ where: { username: 'RB0001' }, select: { id: true } })).id;
  // Start from a known state: the migration may have carried a list onto OPERATOR.
  await prisma.roleConfig.updateMany({ where: { role: 'OPERATOR' }, data: { dashboardCards: Prisma.DbNull } });
  await prisma.userConfig.updateMany({ where: { userId: operatorId }, data: { dashboardCards: Prisma.DbNull } });
});

afterAll(async () => {
  await prisma.roleConfig.updateMany({ where: { role: 'OPERATOR' }, data: { dashboardCards: Prisma.DbNull } });
  await prisma.userConfig.updateMany({ where: { userId: operatorId }, data: { dashboardCards: Prisma.DbNull } });
  await app.close();
});

describe('panel assignment', () => {
  it('resolves to every panel when nothing is stored', async () => {
    expect(await myPanels()).toBeNull();
  });

  it('applies a role list', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/roles/panel-access/role/OPERATOR',
      headers: { ...auth, ...reauth }, payload: { panels: ['trend_charts'] },
    });
    expect(res.statusCode).toBe(200);
    expect(await myPanels()).toEqual(['trend_charts']);
  });

  it('lets a user override REPLACE the role list, widening it', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/roles/panel-access/user/${operatorId}`,
      headers: { ...auth, ...reauth }, payload: { panels: ['trend_charts', 'trend_alarms'] },
    });
    expect(res.statusCode).toBe(200);
    expect(await myPanels()).toEqual(['trend_charts', 'trend_alarms']);
  });

  it('treats an EMPTY user list as NO panels, never as inherit', async () => {
    // The load-bearing case. If this ever returns the role's list, a deliberate
    // deny has become a grant.
    const res = await app.inject({
      method: 'PUT', url: `/api/roles/panel-access/user/${operatorId}`,
      headers: { ...auth, ...reauth }, payload: { panels: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(await myPanels()).toEqual([]);
  });

  it('writes a real SQL NULL for "all panels", not the JSON value null', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/roles/panel-access/user/${operatorId}`,
      headers: { ...auth, ...reauth }, payload: { panels: null },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await prisma.$queryRaw<{ isNull: boolean }[]>`
      SELECT dashboard_cards IS NULL AS "isNull" FROM user_configs WHERE user_id = ${operatorId}::uuid`;
    expect(row.isNull).toBe(true);
    // And it inherits the role again, which proves the override was what did it.
    expect(await myPanels()).toEqual(['trend_charts']);
  });

  it('rejects a key that is not in the catalogue', async () => {
    // A retired key must not be storable. Accepting it would put a value in the
    // column that normalizePanels then silently drops on every read — a stored
    // setting that does nothing, which is what this whole change removed.
    const res = await app.inject({
      method: 'PUT', url: '/api/roles/panel-access/role/OPERATOR',
      headers: { ...auth, ...reauth }, payload: { panels: ['total_users'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s for a user that does not exist', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/roles/panel-access/user/00000000-0000-0000-0000-000000000000',
      headers: { ...auth, ...reauth }, payload: { panels: [] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('audits the role write, naming the count', async () => {
    await app.inject({
      method: 'PUT', url: '/api/roles/panel-access/role/OPERATOR',
      headers: { ...auth, ...reauth }, payload: { panels: ['trend_charts', 'trend_alarms'] },
    });
    const row = await prisma.auditTrail.findFirst({
      where: { targetType: 'role_config', targetId: 'OPERATOR' },
      orderBy: { timestamp: 'desc' }, select: { signatureMeaning: true },
    });
    expect(row?.signatureMeaning).toContain('2 of 7');
  });

  it('audits the user write too', async () => {
    await app.inject({
      method: 'PUT', url: `/api/roles/panel-access/user/${operatorId}`,
      headers: { ...auth, ...reauth }, payload: { panels: [] },
    });
    const row = await prisma.auditTrail.findFirst({
      where: { targetType: 'user_config', targetId: operatorId },
      orderBy: { timestamp: 'desc' }, select: { signatureMeaning: true },
    });
    // "NO panels" spelled out: a §11 signature reading "0 of 7" invites the reader
    // to wonder whether the save failed.
    expect(row?.signatureMeaning).toContain('NO panels');
  });

  it('lists every role and every user override', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/roles/panel-access', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      roles: { role: string; panels: string[] | null }[];
      users: { userId: string; panels: string[] | null }[];
    };
    expect(body.roles.find((r) => r.role === 'OPERATOR')!.panels).toEqual(['trend_charts', 'trend_alarms']);
    expect(body.users.find((u) => u.userId === operatorId)!.panels).toEqual([]);
  });

  it('refuses both writes without ROLE_MANAGE', async () => {
    // The positive controls above all run as admin; this is the negative one.
    const roleRes = await app.inject({
      method: 'PUT', url: '/api/roles/panel-access/role/OPERATOR',
      headers: operator, payload: { panels: [] },
    });
    expect(roleRes.statusCode).toBe(403);
    const listRes = await app.inject({ method: 'GET', url: '/api/roles/panel-access', headers: operator });
    expect(listRes.statusCode).toBe(403);
  });
});
