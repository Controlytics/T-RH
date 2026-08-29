/**
 * Dashboard layout: the caller's own, the role default beneath it, and the
 * built-in beneath that.
 *
 * Driven through the seeded OPERATOR over HTTP. Layout grants nothing — it is a
 * preference — but it is narrowed by panel assignment, and THAT is governance, so
 * the case proving a hidden panel's entry never reaches the wire is the one that
 * matters most here.
 *
 * The other load-bearing case is the audit asymmetry: a user's own layout writes
 * NO audit row, a role's default writes one. Both directions are asserted,
 * because "we forgot to audit it" and "we audit every drag" are each a plausible
 * future mistake and they point opposite ways.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { LAYOUT_VERSION } from '@digilog/shared';

let app: FastifyInstance;
let auth: Record<string, string>;
let operator: Record<string, string>;
let operatorId = '';
const reauth = { 'x-reauth-password': 'Admin@123' };

const item = (i: string, y: number) => ({ i, x: 0, y, w: 12, h: 6 });
const layout = (...keys: string[]) =>
  ({ version: LAYOUT_VERSION, items: keys.map((k, n) => item(k, n * 6)) });

async function myLayout(): Promise<{ items: { i: string }[] } | null> {
  const res = await app.inject({ method: 'GET', url: '/api/config/my-config', headers: operator });
  expect(res.statusCode).toBe(200);
  return (res.json() as { layout: { items: { i: string }[] } | null }).layout;
}

const auditCount = () => prisma.auditTrail.count();

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
  operatorId = (await prisma.user.findUniqueOrThrow({ where: { username: 'RB0001' }, select: { id: true } })).id;
  await prisma.roleConfig.updateMany({
    where: { role: 'OPERATOR' }, data: { dashboardLayout: Prisma.DbNull, dashboardCards: Prisma.DbNull },
  });
  await prisma.userConfig.updateMany({
    where: { userId: operatorId }, data: { dashboardLayout: Prisma.DbNull, dashboardCards: Prisma.DbNull },
  });
});

afterAll(async () => {
  await prisma.roleConfig.updateMany({
    where: { role: 'OPERATOR' }, data: { dashboardLayout: Prisma.DbNull, dashboardCards: Prisma.DbNull },
  });
  await prisma.userConfig.updateMany({
    where: { userId: operatorId }, data: { dashboardLayout: Prisma.DbNull, dashboardCards: Prisma.DbNull },
  });
  await app.close();
});

describe('dashboard layout', () => {
  it('falls back to the built-in when nothing is stored', async () => {
    const l = await myLayout();
    expect(l).not.toBeNull();
    expect(l!.items.length).toBeGreaterThan(0);
  });

  it('round-trips the caller own layout through my-config', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/config/my-dashboard-layout',
      headers: operator, payload: { layout: layout('dashboard_alarms', 'telemetry_table') },
    });
    expect(res.statusCode).toBe(200);
    expect((await myLayout())!.items.map((i) => i.i).slice(0, 2))
      .toEqual(['dashboard_alarms', 'telemetry_table']);
  });

  it('writes NO audit row for a user own layout', async () => {
    // Deliberate. A hash-chained §11 trail filling with "moved a card 40px left"
    // is one in which the records that matter become harder to find. If this ever
    // fails because someone "fixed" the missing auditLog call, read the comment on
    // the route before changing the test.
    const before = await auditCount();
    const res = await app.inject({
      method: 'PUT', url: '/api/config/my-dashboard-layout',
      headers: operator, payload: { layout: layout('telemetry_table') },
    });
    expect(res.statusCode).toBe(200);
    expect(await auditCount()).toBe(before);
  });

  it('DELETE resets the caller to the role default', async () => {
    await app.inject({
      method: 'PUT', url: '/api/roles/dashboard-layout/role/OPERATOR',
      headers: { ...auth, ...reauth }, payload: { layout: layout('dashboard_alarms') },
    });
    const res = await app.inject({
      method: 'DELETE', url: '/api/config/my-dashboard-layout', headers: operator,
    });
    expect(res.statusCode).toBe(200);
    const [row] = await prisma.$queryRaw<{ isNull: boolean }[]>`
      SELECT dashboard_layout IS NULL AS "isNull" FROM user_configs WHERE user_id = ${operatorId}::uuid`;
    expect(row.isNull).toBe(true);
    // And the role's arrangement is what they now get.
    expect((await myLayout())!.items[0].i).toBe('dashboard_alarms');
  });

  it('DOES audit a role default, and names the role', async () => {
    const before = await auditCount();
    const res = await app.inject({
      method: 'PUT', url: '/api/roles/dashboard-layout/role/OPERATOR',
      headers: { ...auth, ...reauth }, payload: { layout: layout('dashboard_alarms') },
    });
    expect(res.statusCode).toBe(200);
    // An admin acting on other people, which is the line this codebase draws
    // everywhere else.
    expect(await auditCount()).toBeGreaterThan(before);
    const row = await prisma.auditTrail.findFirst({
      where: { targetType: 'role_config', targetId: 'OPERATOR' },
      orderBy: { timestamp: 'desc' }, select: { signatureMeaning: true },
    });
    expect(row?.signatureMeaning).toContain('OPERATOR');
    expect(row?.signatureMeaning?.toLowerCase()).toContain('layout');
  });

  it('refuses a role default without ROLE_MANAGE', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/roles/dashboard-layout/role/OPERATOR',
      headers: operator, payload: { layout: layout('dashboard_alarms') },
    });
    expect(res.statusCode).toBe(403);
  });

  it('never returns an entry for a panel the caller may not see', async () => {
    // Layout withholds nothing on its own — panel assignment does — but a layout
    // that mentioned a hidden panel would disclose that it exists.
    await prisma.roleConfig.updateMany({
      where: { role: 'OPERATOR' }, data: { dashboardCards: ['telemetry_table'] as never },
    });
    await app.inject({
      method: 'PUT', url: '/api/config/my-dashboard-layout',
      headers: operator, payload: { layout: layout('dashboard_alarms', 'telemetry_table') },
    });
    const l = await myLayout();
    expect(l!.items.map((i) => i.i)).toEqual(['telemetry_table']);

    await prisma.roleConfig.updateMany({
      where: { role: 'OPERATOR' }, data: { dashboardCards: Prisma.DbNull },
    });
  });

  it('rejects a malformed layout rather than storing it', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/config/my-dashboard-layout',
      headers: operator, payload: { layout: { version: 1, items: [{ i: 'dashboard_alarms' }] } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('per-card styling rides on the layout', () => {
  it('a tint and a custom heading survive the round trip', async () => {
    // The trap this pins: Fastify's ajv REMOVES body properties a schema does not
    // declare, and Fastify strips undeclared RESPONSE fields too. Either omission
    // gives a 200 that silently stores or returns nothing — a save that reports
    // success and loses the operator's work. Verified against the running server
    // before the schemas were written.
    const res = await app.inject({
      method: 'PUT', url: '/api/config/my-dashboard-layout',
      headers: operator,
      payload: { layout: { version: LAYOUT_VERSION, items: [
        { i: 'telemetry_table', x: 0, y: 0, w: 12, h: 9, style: { tint: 'sky', title: 'Cold room' } },
      ] } },
    });
    expect(res.statusCode).toBe(200);

    const l = await myLayout();
    const card = l!.items.find((i) => i.i === 'telemetry_table') as unknown as
      { style?: { tint?: string; title?: string } };
    expect(card.style).toEqual({ tint: 'sky', title: 'Cold room' });
  });

  it('refuses a colour outside the bounded palette', async () => {
    // Free hex is what the bounded palette exists to refuse — someone posting one
    // directly must not get it. The item survives; only the style is dropped, so a
    // bad colour cannot cost someone their arrangement.
    const res = await app.inject({
      method: 'PUT', url: '/api/config/my-dashboard-layout',
      headers: operator,
      payload: { layout: { version: LAYOUT_VERSION, items: [
        { i: 'telemetry_table', x: 0, y: 0, w: 12, h: 9, style: { tint: '#00ff00' } },
      ] } },
    });
    expect(res.statusCode).toBe(200);
    const card = (await myLayout())!.items.find((i) => i.i === 'telemetry_table') as unknown as
      { style?: unknown };
    expect(card.style).toBeUndefined();
  });
});
