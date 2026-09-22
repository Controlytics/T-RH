import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

/**
 * Polygon rooms over HTTP (Layout Designer, 2026-09-22). Every assertion reads
 * the JSON that actually LEAVES the route: Fastify strips undeclared response
 * properties silently, and `points` reaching the browser is the whole feature.
 */
let app: FastifyInstance;
let auth: Record<string, string>;
const s = Date.now();
const plans: string[] = [];
const L = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.3 }, { x: 0.3, y: 0.3 }, { x: 0.3, y: 0.5 }, { x: 0.1, y: 0.5 }];

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});
afterAll(async () => {
  for (const id of plans) await prisma.floorplan.deleteMany({ where: { id } });
  await app.close();
});

async function blankPlan(name: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/floorplans', headers: auth,
    payload: { name, imagePath: null, imageWidth: 1600, imageHeight: 1200 },
  });
  expect(res.statusCode).toBe(201);
  plans.push(res.json().id);
  return res.json() as { id: string };
}
let n = 0;
const room = (planId: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST', url: `/api/floorplans/${planId}/rooms`, headers: auth,
    payload: { code: `R${++n}`, x: 0.1, y: 0.1, w: 0.2, h: 0.2, ...payload },
  });

describe('polygon rooms', () => {
  it('a plan can start blank, with no image', async () => {
    const p = await blankPlan(`Blank ${s}`);
    const got = await app.inject({ method: 'GET', url: `/api/floorplans/${p.id}`, headers: auth });
    expect(got.statusCode).toBe(200);
    expect(got.json().imagePath).toBeNull();
    expect(got.json().imageWidth).toBe(1600);
  });

  it('saves points and derives the box, and returns points over the wire on both reads', async () => {
    const p = await blankPlan(`Poly ${s}`);
    const res = await room(p.id, { code: 'L', points: L, x: 0, y: 0, w: 0.01, h: 0.01 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ x: 0.1, y: 0.1, w: 0.4, h: 0.4 });
    expect(res.json().points).toEqual(L);
    const list = await app.inject({ method: 'GET', url: '/api/floorplans', headers: auth });
    const mine = (list.json().data as { id: string; rooms: { code: string; points: unknown }[] }[]).find((x) => x.id === p.id)!;
    expect(mine.rooms[0].points).toEqual(L);
    const detail = await app.inject({ method: 'GET', url: `/api/floorplans/${p.id}`, headers: auth });
    expect(detail.json().rooms[0].points).toEqual(L);
  });

  it('refuses a bow-tie and a corner outside the plan by field', async () => {
    const p = await blankPlan(`Bad ${s}`);
    const bow = await room(p.id, { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }] });
    expect(bow.statusCode).toBe(400);
    expect(bow.json().message).toMatch(/points/);
    const out = await room(p.id, { points: [{ x: 0, y: 0 }, { x: 1.5, y: 0 }, { x: 1, y: 1 }] });
    expect(out.statusCode).toBe(400);
  });

  it('an omitted points key keeps the polygon and its derived box; an explicit null clears it', async () => {
    const p = await blankPlan(`Keep ${s}`);
    const id = (await room(p.id, { code: 'K', points: L })).json().id as string;
    const kept = await app.inject({
      method: 'PUT', url: `/api/floorplans/${p.id}/rooms/${id}`, headers: auth,
      payload: { code: 'K2', x: 0, y: 0, w: 0.05, h: 0.05 },
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().points).toEqual(L);
    expect(kept.json()).toMatchObject({ x: 0.1, w: 0.4 });
    const cleared = await app.inject({
      method: 'PUT', url: `/api/floorplans/${p.id}/rooms/${id}`, headers: auth,
      payload: { code: 'K2', x: 0, y: 0, w: 0.05, h: 0.05, points: null },
    });
    expect(cleared.json().points).toBeNull();
    expect(cleared.json()).toMatchObject({ x: 0, w: 0.05 });
  });

  it('a door by edge is stored and returned; a door on a missing edge is refused', async () => {
    const p = await blankPlan(`Door ${s}`);
    const ok = await room(p.id, { points: L, doors: [{ edge: 4, offset: 0.2, width: 0.2, kind: 'ENTRY' }] });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().doors[0].edge).toBe(4);
    const bad = await room(p.id, { points: L, doors: [{ edge: 6, offset: 0.2, width: 0.2, kind: 'ENTRY' }] });
    expect(bad.statusCode).toBe(400);
  });
});
