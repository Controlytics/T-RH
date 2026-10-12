/**
 * The parked widget-dashboard module (`/api/dashboards`, no UI) — the defects
 * the 2026-10-12 review found (finding 10): a widget or assignment could be
 * deleted / moved through ANOTHER dashboard's URL, assigning a dashboard that
 * does not exist was a 500, and the list and the detail route disagreed about
 * which dashboards a non-admin may see.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

let app: FastifyInstance;
let auth: Record<string, string>;
let operator: Record<string, string>;
const s = Date.now();
const made: string[] = [];
let roleId = '';
let permsBefore: string[] = [];

async function dashboard(title: string) {
  const res = await app.inject({ method: 'POST', url: '/api/dashboards', headers: auth, payload: { title } });
  expect(res.statusCode, res.body).toBe(201);
  made.push(res.json().id);
  return res.json() as { id: string };
}
async function widget(dashboardId: string) {
  const res = await app.inject({ method: 'POST', url: `/api/dashboards/${dashboardId}/widgets`, headers: auth, payload: { widgetType: 'gauge', title: `w ${s}` } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; position: unknown };
}

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
  roleId = role.id;
  permsBefore = role.permissions as string[];
  await prisma.role.update({ where: { id: roleId }, data: { permissions: ['DASHBOARD_VIEW'] } });
  invalidateRolePermsCache('OPERATOR');
  operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
});

afterAll(async () => {
  try {
    await prisma.role.update({ where: { id: roleId }, data: { permissions: permsBefore } });
    invalidateRolePermsCache('OPERATOR');
  } catch (e) { console.error('restore perms', e); }
  try { await prisma.dashboard.deleteMany({ where: { id: { in: made } } }); } catch (e) { console.error('cleanup', e); }
  await app.close();
});

describe('widgets and assignments are reached only through their own dashboard', () => {
  it('DELETE /:id/widgets/:widgetId refuses a widget of another dashboard', async () => {
    const d1 = await dashboard(`D1 ${s}`);
    const d2 = await dashboard(`D2 ${s}`);
    const w2 = await widget(d2.id);
    const res = await app.inject({ method: 'DELETE', url: `/api/dashboards/${d1.id}/widgets/${w2.id}`, headers: auth });
    expect(res.statusCode).toBe(404);
    expect(await prisma.dashboardWidget.count({ where: { id: w2.id } })).toBe(1);
    const own = await app.inject({ method: 'DELETE', url: `/api/dashboards/${d2.id}/widgets/${w2.id}`, headers: auth });
    expect(own.statusCode).toBe(200);
  });

  it('PUT /:id/layout refuses a widget of another dashboard and moves nothing', async () => {
    const d1 = await dashboard(`L1 ${s}`);
    const d2 = await dashboard(`L2 ${s}`);
    const w1 = await widget(d1.id);
    const w2 = await widget(d2.id);
    const res = await app.inject({
      method: 'PUT', url: `/api/dashboards/${d1.id}/layout`, headers: auth,
      payload: { positions: [{ widgetId: w1.id, x: 5, y: 5, w: 2, h: 2 }, { widgetId: w2.id, x: 9, y: 9, w: 1, h: 1 }] },
    });
    expect(res.statusCode).toBe(404);
    expect((await prisma.dashboardWidget.findUniqueOrThrow({ where: { id: w1.id } })).position).toEqual(w1.position);
    expect((await prisma.dashboardWidget.findUniqueOrThrow({ where: { id: w2.id } })).position).toEqual(w2.position);
  });

  it('POST /:id/assign on a dashboard that does not exist is a 404, not a 500', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/dashboards/00000000-0000-4000-8000-000000000000/assign', headers: auth,
      payload: { assigneeType: 'ROLE', roleValue: 'OPERATOR' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /:id/assign refuses an assignment that names nobody', async () => {
    const d = await dashboard(`A0 ${s}`);
    const res = await app.inject({ method: 'POST', url: `/api/dashboards/${d.id}/assign`, headers: auth, payload: { assigneeType: 'ROLE' } });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /:dashboardId/assign/:assignmentId refuses an assignment of another dashboard', async () => {
    const d1 = await dashboard(`AS1 ${s}`);
    const d2 = await dashboard(`AS2 ${s}`);
    const a = await app.inject({ method: 'POST', url: `/api/dashboards/${d2.id}/assign`, headers: auth, payload: { assigneeType: 'ROLE', roleValue: `NOBODY_${s}` } });
    expect(a.statusCode).toBe(201);
    const res = await app.inject({ method: 'DELETE', url: `/api/dashboards/${d1.id}/assign/${a.json().id}`, headers: auth });
    expect(res.statusCode).toBe(404);
    expect(await prisma.dashboardAssignment.count({ where: { id: a.json().id } })).toBe(1);
  });
});

describe('the list and the detail agree about what a caller may see', () => {
  const listed = async (headers: Record<string, string>) => {
    const res = await app.inject({ method: 'GET', url: '/api/dashboards?limit=1000', headers });
    expect(res.statusCode).toBe(200);
    return (res.json().data as { id: string }[]).map((d) => d.id);
  };
  const detail = async (id: string, headers: Record<string, string>) =>
    (await app.inject({ method: 'GET', url: `/api/dashboards/${id}`, headers })).statusCode;

  it('a non-admin can open exactly the dashboards the list shows them', async () => {
    const open = await dashboard(`V1 ${s}`);
    const assigned = await dashboard(`V2 ${s}`);
    // Before any assignment for this role/user, and after one.
    for (const step of ['before', 'after']) {
      if (step === 'after') {
        const a = await app.inject({ method: 'POST', url: `/api/dashboards/${assigned.id}/assign`, headers: auth, payload: { assigneeType: 'ROLE', roleValue: 'OPERATOR' } });
        expect(a.statusCode).toBe(201);
      }
      const ids = await listed(operator);
      for (const d of [open, assigned]) {
        expect(await detail(d.id, operator), `${step}: ${d.id} listed=${ids.includes(d.id)}`).toBe(ids.includes(d.id) ? 200 : 404);
      }
    }
  });

  it('a deleted (inactive) dashboard is gone from both', async () => {
    const d = await dashboard(`X ${s}`);
    const del = await app.inject({ method: 'DELETE', url: `/api/dashboards/${d.id}`, headers: auth });
    expect(del.statusCode).toBe(200);
    expect(await listed(auth)).not.toContain(d.id);
    expect(await detail(d.id, auth)).toBe(404);
  });
});
