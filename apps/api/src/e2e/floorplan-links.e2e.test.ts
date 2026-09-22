import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

/**
 * Room links over HTTP (Layout Designer, 2026-09-22): an OPENING in a shared
 * wall, checked against the rooms' real geometry, and a CONNECTOR between rooms
 * that do not touch. Every assertion reads the JSON that leaves the route.
 */
let app: FastifyInstance;
let auth: Record<string, string>;
const s = Date.now();
const plans: string[] = [];

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
const room = async (planId: string, code: string, box: { x: number; y: number; w: number; h: number }) => {
  const res = await app.inject({
    method: 'POST', url: `/api/floorplans/${planId}/rooms`, headers: auth,
    payload: { code, ...box },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; code: string };
};
const link = (planId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/floorplans/${planId}/links`, headers: auth, payload });

describe('room links', () => {
  it('creates an opening on a shared wall, returns it on the plan, audits it, and cascades with the room', async () => {
    const p = await blankPlan(`Links ${s}`);
    const a = await room(p.id, 'A', { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    const b = await room(p.id, 'B', { x: 0.3, y: 0.1, w: 0.2, h: 0.2 });
    const res = await link(p.id, { fromRoomId: a.id, toRoomId: b.id, kind: 'OPENING', fromEdge: 1, offset: 0.3, width: 0.3, door: 'ENTRY' });
    expect(res.statusCode).toBe(201);
    const made = res.json();
    expect(made).toMatchObject({ kind: 'OPENING', fromEdge: 1, offset: 0.3, width: 0.3, door: 'ENTRY', fromRoomId: a.id, toRoomId: b.id });

    const list = await app.inject({ method: 'GET', url: '/api/floorplans', headers: auth });
    const mine = (list.json().data as { id: string; links: { id: string; fromEdge: number; door: string }[] }[]).find((x) => x.id === p.id)!;
    expect(mine.links).toHaveLength(1);
    expect(mine.links[0]).toMatchObject({ id: made.id, fromEdge: 1, door: 'ENTRY' });
    const detail = await app.inject({ method: 'GET', url: `/api/floorplans/${p.id}`, headers: auth });
    expect(detail.json().links[0].id).toBe(made.id);

    const row = await prisma.auditTrail.findFirst({ where: { action: 'FLOORPLAN_LINK_CREATED', targetId: made.id } });
    expect(row).not.toBeNull();
    expect((row!.afterValue as { code: string }).code).toBe('A ↔ B');

    const del = await app.inject({ method: 'DELETE', url: `/api/floorplans/${p.id}/rooms/${b.id}`, headers: auth });
    expect(del.statusCode).toBe(204);
    expect(await prisma.floorplanRoomLink.count({ where: { id: made.id } })).toBe(0);
  });

  it('refuses an opening between rooms that do not share that stretch of wall, and a self-link', async () => {
    const p = await blankPlan(`Apart ${s}`);
    const a = await room(p.id, 'A', { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    const b = await room(p.id, 'B', { x: 0.6, y: 0.6, w: 0.2, h: 0.2 });
    const far = await link(p.id, { fromRoomId: a.id, toRoomId: b.id, kind: 'OPENING', fromEdge: 1, offset: 0.3, width: 0.3 });
    expect(far.statusCode).toBe(400);
    expect(far.json().error).toBe('NOT_ADJACENT');
    // Touching, but the opening runs past the shared stretch.
    const c = await room(p.id, 'C', { x: 0.3, y: 0.2, w: 0.2, h: 0.2 });
    const past = await link(p.id, { fromRoomId: a.id, toRoomId: c.id, kind: 'OPENING', fromEdge: 1, offset: 0.2, width: 0.5 });
    expect(past.statusCode).toBe(400);
    const self = await link(p.id, { fromRoomId: a.id, toRoomId: a.id, kind: 'CONNECTOR' });
    expect(self.statusCode).toBe(400);
    const missing = await link(p.id, { fromRoomId: a.id, toRoomId: '00000000-0000-4000-8000-000000000000', kind: 'CONNECTOR' });
    expect(missing.statusCode).toBe(404);
  });

  it('a connector needs no adjacency, may be labelled, updates, refuses a duplicate either way round, and deletes', async () => {
    const p = await blankPlan(`Conn ${s}`);
    const a = await room(p.id, 'A', { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    const b = await room(p.id, 'B', { x: 0.6, y: 0.6, w: 0.2, h: 0.2 });
    const made = await link(p.id, { fromRoomId: a.id, toRoomId: b.id, kind: 'CONNECTOR', label: 'pass-through' });
    expect(made.statusCode).toBe(201);
    expect(made.json().label).toBe('pass-through');
    const dup = await link(p.id, { fromRoomId: b.id, toRoomId: a.id, kind: 'CONNECTOR' });
    expect(dup.statusCode).toBe(409);
    const upd = await app.inject({
      method: 'PUT', url: `/api/floorplans/${p.id}/links/${made.json().id}`, headers: auth,
      payload: { fromRoomId: a.id, toRoomId: b.id, kind: 'CONNECTOR', label: 'hatch' },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().label).toBe('hatch');
    expect(await prisma.auditTrail.count({ where: { action: 'FLOORPLAN_LINK_UPDATED', targetId: made.json().id } })).toBe(1);
    const del = await app.inject({ method: 'DELETE', url: `/api/floorplans/${p.id}/links/${made.json().id}`, headers: auth });
    expect(del.statusCode).toBe(204);
    expect(await prisma.auditTrail.count({ where: { action: 'FLOORPLAN_LINK_DELETED', targetId: made.json().id } })).toBe(1);
    const gone = await app.inject({ method: 'DELETE', url: `/api/floorplans/${p.id}/links/${made.json().id}`, headers: auth });
    expect(gone.statusCode).toBe(404);
  });
});
