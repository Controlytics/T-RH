import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * Floorplan writes that the 2026-10-12 application review found unrecorded or
 * unsafe. Every assertion goes over HTTP and reads the audit rows the route
 * wrote.
 */
let app: FastifyInstance;
let auth: Record<string, string>;
const s = Date.now();
const plans: string[] = [];
const instruments: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});
afterAll(async () => {
  for (const id of plans) await prisma.floorplan.deleteMany({ where: { id } });
  for (const id of instruments) await prisma.instrument.deleteMany({ where: { id } });
  await app.close();
});

async function blankPlan(name: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/floorplans', headers: auth,
    payload: { name, imagePath: null, imageWidth: 1600, imageHeight: 1200 },
  });
  expect(res.statusCode).toBe(201);
  plans.push(res.json().id);
  return res.json() as { id: string; updatedAt?: string };
}
const room = async (planId: string, code: string, payload: Record<string, unknown>) => {
  const res = await app.inject({ method: 'POST', url: `/api/floorplans/${planId}/rooms`, headers: auth, payload: { code, ...payload } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; code: string };
};
const link = async (planId: string, payload: Record<string, unknown>) => {
  const res = await app.inject({ method: 'POST', url: `/api/floorplans/${planId}/links`, headers: auth, payload });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
};
async function instrument(code: string) {
  const i = await prisma.instrument.create({ data: { code, name: code, profileId: await fixtureProfileId('fixture:floorplans') } as never, select: { id: true, code: true } });
  instruments.push(i.id);
  return i;
}
const box = (x: number, y: number) => ({ x, y, w: 0.2, h: 0.2 });

describe('deletes record every link they take with them (finding 6)', () => {
  it('room DELETE writes one FLOORPLAN_LINK_DELETED row per link, in the same transaction', async () => {
    const p = await blankPlan(`Del room ${s}`);
    const a = await room(p.id, 'A', box(0.1, 0.1));
    const b = await room(p.id, 'B', box(0.3, 0.1));
    const c = await room(p.id, 'C', box(0.6, 0.6));
    const opening = await link(p.id, { fromRoomId: a.id, toRoomId: b.id, kind: 'OPENING', fromEdge: 1, offset: 0.3, width: 0.3 });
    const conn = await link(p.id, { fromRoomId: c.id, toRoomId: b.id, kind: 'CONNECTOR' });

    const del = await app.inject({ method: 'DELETE', url: `/api/floorplans/${p.id}/rooms/${b.id}`, headers: auth });
    expect(del.statusCode).toBe(204);
    for (const l of [opening, conn]) {
      const row = await prisma.auditTrail.findFirst({ where: { action: 'FLOORPLAN_LINK_DELETED', targetId: l.id } });
      expect(row, `link ${l.id} has no audit row`).not.toBeNull();
    }
    const roomRow = await prisma.auditTrail.findFirst({ where: { action: 'FLOORPLAN_ROOM_DELETED', targetId: b.id } });
    expect((roomRow!.beforeValue as { links: string[] }).links).toHaveLength(2);
  });

  it('plan DELETE audits every link, and names the unplaced instruments and each room\'s limits', async () => {
    const p = await blankPlan(`Del plan ${s}`);
    const a = await room(p.id, 'A', { ...box(0.1, 0.1), tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 });
    const b = await room(p.id, 'B', box(0.3, 0.1));
    const l = await link(p.id, { fromRoomId: a.id, toRoomId: b.id, kind: 'CONNECTOR' });
    const inst = await instrument(`FPDEL-${s}`);
    await prisma.instrument.update({ where: { id: inst.id }, data: { roomId: a.id } });

    const del = await app.inject({ method: 'DELETE', url: `/api/floorplans/${p.id}`, headers: auth });
    expect(del.statusCode).toBe(204);
    expect(await prisma.auditTrail.count({ where: { action: 'FLOORPLAN_LINK_DELETED', targetId: l.id } })).toBe(1);
    const row = await prisma.auditTrail.findFirst({ where: { action: 'FLOORPLAN_DELETED', targetId: p.id } });
    const before = row!.beforeValue as { rooms: { code: string; limits: unknown; instruments: string[] }[]; instrumentsUnplaced: string[] };
    expect(before.instrumentsUnplaced).toEqual([inst.code]);
    expect(before.rooms.find((r) => r.code === 'A')).toMatchObject({ limits: { tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 }, instruments: [inst.code] });
    expect((await prisma.instrument.findUnique({ where: { id: inst.id } }))!.roomId).toBeNull();
  });
});

describe('room membership: a move is recorded on both rooms (finding 9)', () => {
  it('writes a row on the SOURCE room and names where each moved instrument came from on the target', async () => {
    const p = await blankPlan(`Members ${s}`);
    const from = await room(p.id, 'FROM', box(0.1, 0.1));
    const to = await room(p.id, 'TO', box(0.5, 0.5));
    const inst = await instrument(`FPMOVE-${s}`);
    const stay = await instrument(`FPSTAY-${s}`);
    await prisma.instrument.updateMany({ where: { id: { in: [inst.id, stay.id] } }, data: { roomId: from.id } });

    const res = await app.inject({
      method: 'PUT', url: `/api/floorplans/${p.id}/rooms/${to.id}/instruments`, headers: auth,
      payload: { instrumentIds: [inst.id] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toHaveLength(1);

    const target = await prisma.auditTrail.findFirst({ where: { action: 'FLOORPLAN_ROOM_UPDATED', targetId: to.id }, orderBy: { timestamp: 'desc' } });
    expect((target!.afterValue as { movedFrom: unknown }).movedFrom).toEqual([{ instrument: inst.code, room: 'FROM' }]);
    const source = await prisma.auditTrail.findFirst({ where: { action: 'FLOORPLAN_ROOM_UPDATED', targetId: from.id }, orderBy: { timestamp: 'desc' } });
    expect(source, 'the source room has no audit row').not.toBeNull();
    expect((source!.beforeValue as { instruments: string[] }).instruments.sort()).toEqual([inst.code, stay.code].sort());
    expect((source!.afterValue as { instruments: string[] }).instruments).toEqual([stay.code]);
    expect((source!.afterValue as { movedTo: unknown }).movedTo).toEqual([{ instrument: inst.code, room: 'TO' }]);
  });
});
