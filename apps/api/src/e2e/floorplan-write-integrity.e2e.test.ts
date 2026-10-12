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

describe('plan PUT refuses a stale write (finding 4)', () => {
  const ann = (text: string) => ({ style: 'architectural', labels: [{ x: 0.5, y: 0.5, text }] });
  it('exposes updatedAt, accepts the version it was loaded at, and 409s the older one without writing', async () => {
    const p = await blankPlan(`Stale ${s}`);
    const list = await app.inject({ method: 'GET', url: '/api/floorplans', headers: auth });
    const loaded = (list.json().data as { id: string; updatedAt?: string }[]).find((x) => x.id === p.id)!.updatedAt;
    expect(typeof loaded).toBe('string');

    const first = await app.inject({ method: 'PUT', url: `/api/floorplans/${p.id}`, headers: auth, payload: { annotations: ann('FIRST'), expectedUpdatedAt: loaded } });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().updatedAt).not.toBe(loaded);

    // A second editor that loaded the SAME version saves after the first.
    const second = await app.inject({ method: 'PUT', url: `/api/floorplans/${p.id}`, headers: auth, payload: { annotations: ann('SECOND'), expectedUpdatedAt: loaded } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('STALE');
    const stored = await prisma.floorplan.findUniqueOrThrow({ where: { id: p.id } });
    expect((stored.annotations as { labels: { text: string }[] }).labels[0].text).toBe('FIRST');
    expect(await prisma.auditTrail.count({ where: { action: 'FLOORPLAN_UPDATED', targetId: p.id } })).toBe(1);

    // A caller that sends no version (the draw scripts, older clients) is not checked.
    const blind = await app.inject({ method: 'PUT', url: `/api/floorplans/${p.id}`, headers: auth, payload: { annotations: ann('THIRD') } });
    expect(blind.statusCode).toBe(200);
  });

  it('refuses an unreadable expectedUpdatedAt rather than ignoring it', async () => {
    const p = await blankPlan(`StaleBad ${s}`);
    const res = await app.inject({ method: 'PUT', url: `/api/floorplans/${p.id}`, headers: auth, payload: { sortOrder: 1, expectedUpdatedAt: 'yesterday' } });
    expect(res.statusCode).toBe(400);
  });
});

const L6 =[{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.3 }, { x: 0.3, y: 0.3 }, { x: 0.3, y: 0.5 }, { x: 0.1, y: 0.5 }];

describe('room PUT without points validates doors against the stored polygon (finding 8)', () => {
  it('accepts a door on edge 5 of a six-edge room when the outline is not resent', async () => {
    const p = await blankPlan(`Hex ${s}`);
    const r = await room(p.id, 'HEX', { ...box(0.1, 0.1), points: L6, doors: [{ edge: 5, offset: 0.2, width: 0.2, kind: 'ENTRY' }] });
    const res = await app.inject({
      method: 'PUT', url: `/api/floorplans/${p.id}/rooms/${r.id}`, headers: auth,
      payload: { code: 'HEX', label: 'renamed', x: 0.1, y: 0.1, w: 0.4, h: 0.4, doors: [{ edge: 5, offset: 0.3, width: 0.2, kind: 'ENTRY' }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().points).toHaveLength(6);
    expect(res.json().doors[0]).toMatchObject({ edge: 5, offset: 0.3 });
  });
});

describe('room PUT keeps its openings on a shared wall (finding 3)', () => {
  // A (0.1..0.3) and B (0.3..0.5) share A's RIGHT wall = edge 1 of A's rectangle.
  const aRect = [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }, { x: 0.1, y: 0.3 }];
  // A corner inserted on the TOP edge (edge 0): the right wall becomes edge 2.
  const aSplit = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }, { x: 0.1, y: 0.3 }];
  async function pair(name: string) {
    const p = await blankPlan(name);
    const a = await room(p.id, 'A', { ...box(0.1, 0.1), points: aRect });
    const b = await room(p.id, 'B', box(0.3, 0.1));
    const l = await link(p.id, { fromRoomId: a.id, toRoomId: b.id, kind: 'OPENING', fromEdge: 1, offset: 0.3, width: 0.3 });
    return { p, a, b, l };
  }
  const putRoom = (planId: string, roomId: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/floorplans/${planId}/rooms/${roomId}`, headers: auth, payload });

  it('refuses an outline that leaves an opening off its wall, and changes nothing', async () => {
    const { p, a, l } = await pair(`Reindex refuse ${s}`);
    const res = await putRoom(p.id, a.id, { code: 'A', x: 0.1, y: 0.1, w: 0.2, h: 0.2, points: aSplit });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe('LINK_OFF_WALL');
    const stored = await prisma.floorplanRoom.findUniqueOrThrow({ where: { id: a.id } });
    expect((stored.points as unknown[]).length).toBe(4);
    expect((await prisma.floorplanRoomLink.findUniqueOrThrow({ where: { id: l.id } })).fromEdge).toBe(1);
  });

  it('accepts the outline with the opening re-indexed in the SAME request, audited', async () => {
    const { p, a, l } = await pair(`Reindex ok ${s}`);
    const res = await putRoom(p.id, a.id, { code: 'A', x: 0.1, y: 0.1, w: 0.2, h: 0.2, points: aSplit, linkEdges: [{ id: l.id, fromEdge: 2, offset: 0.3, width: 0.3 }] });
    expect(res.statusCode, res.body).toBe(200);
    expect((await prisma.floorplanRoomLink.findUniqueOrThrow({ where: { id: l.id } })).fromEdge).toBe(2);
    const row = await prisma.auditTrail.findFirst({ where: { action: 'FLOORPLAN_LINK_UPDATED', targetId: l.id } });
    expect(row).not.toBeNull();
    expect((row!.beforeValue as { fromEdge: number }).fromEdge).toBe(1);
    expect((row!.afterValue as { fromEdge: number }).fromEdge).toBe(2);
  });

  it('refuses moving the OTHER room away from an opening that names it', async () => {
    const { p, b } = await pair(`Reindex move ${s}`);
    const res = await putRoom(p.id, b.id, { code: 'B', ...box(0.6, 0.6) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('LINK_OFF_WALL');
  });

  it('an opening ALREADY off its wall (stored before the check) does not lock the room against an unrelated save', async () => {
    const { p, a, l } = await pair(`Reindex legacy ${s}`);
    // As the old designer bug left it: the opening names edge 0 (top), which B does not share.
    await prisma.floorplanRoomLink.update({ where: { id: l.id }, data: { fromEdge: 0 } });
    const res = await putRoom(p.id, a.id, { code: 'A', label: 'renamed', x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().label).toBe('renamed');
  });

  it('refuses a linkEdges entry for a link that does not start on this room', async () => {
    const { p, b, l } = await pair(`Reindex wrong ${s}`);
    const res = await putRoom(p.id, b.id, { code: 'B', ...box(0.3, 0.1), linkEdges: [{ id: l.id, fromEdge: 3, offset: 0.3, width: 0.3 }] });
    expect(res.statusCode).toBe(400);
  });
});

describe('merging two pieces is ONE transaction (follow-up to finding 3)', () => {
  // A 0.1..0.3, B 0.3..0.5 (beside A), C below A. The union of A and B is 0.1..0.5 x 0.1..0.3.
  const rectPts = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const union = rectPts(0.1, 0.1, 0.4, 0.2);
  async function three(name: string) {
    const p = await blankPlan(name);
    const a = await room(p.id, 'A', { ...box(0.1, 0.1), points: rectPts(0.1, 0.1, 0.2, 0.2) });
    const b = await room(p.id, 'B', box(0.3, 0.1));
    const c = await room(p.id, 'C', box(0.1, 0.3));
    const ab = await link(p.id, { fromRoomId: a.id, toRoomId: b.id, kind: 'OPENING', fromEdge: 1, offset: 0.3, width: 0.3 });
    // A's BOTTOM wall (edge 2, running right to left) into C: x 0.24..0.18.
    const ac = await link(p.id, { fromRoomId: a.id, toRoomId: c.id, kind: 'OPENING', fromEdge: 2, offset: 0.3, width: 0.3 });
    const inst = await instrument(`FPMERGE-${s}-${name.length}`);
    await prisma.instrument.update({ where: { id: inst.id }, data: { roomId: b.id } });
    return { p, a, b, ab, ac, inst };
  }
  const merge = (planId: string, roomId: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/floorplans/${planId}/rooms/${roomId}/merge`, headers: auth, payload });

  it('a refused merge (an opening the union takes off its wall) changes NOTHING', async () => {
    const { p, a, b, ab, inst } = await three(`Merge refused ${s}`);
    const res = await merge(p.id, a.id, { otherRoomId: b.id, points: union });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe('LINK_OFF_WALL');
    expect(await prisma.floorplanRoom.count({ where: { id: b.id } })).toBe(1);
    expect(await prisma.floorplanRoomLink.count({ where: { id: ab.id } })).toBe(1);
    expect(((await prisma.floorplanRoom.findUniqueOrThrow({ where: { id: a.id } })).points as unknown[]).length).toBe(4);
    expect((await prisma.floorplanRoom.findUniqueOrThrow({ where: { id: a.id } })).w).toBeCloseTo(0.2, 9);
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id: inst.id } })).roomId).toBe(b.id);
    expect(await prisma.auditTrail.count({ where: { action: 'FLOORPLAN_LINK_DELETED', targetId: ab.id } })).toBe(0);
  });

  it('a merge with the opening re-indexed lands whole: union, links, instruments, the other piece gone, all audited', async () => {
    const { p, a, b, ab, ac, inst } = await three(`Merge ok ${s}`);
    const res = await merge(p.id, a.id, { otherRoomId: b.id, points: union, linkEdges: [{ id: ac.id, fromEdge: 2, offset: 0.65, width: 0.15 }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().w).toBeCloseTo(0.4, 9);
    expect(await prisma.floorplanRoom.count({ where: { id: b.id } })).toBe(0);
    expect(await prisma.floorplanRoomLink.count({ where: { id: ab.id } })).toBe(0);
    expect(await prisma.auditTrail.count({ where: { action: 'FLOORPLAN_LINK_DELETED', targetId: ab.id } })).toBe(1);
    expect(await prisma.auditTrail.count({ where: { action: 'FLOORPLAN_LINK_UPDATED', targetId: ac.id } })).toBe(1);
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id: inst.id } })).roomId).toBe(a.id);
    const gone = await prisma.auditTrail.findFirst({ where: { action: 'FLOORPLAN_ROOM_DELETED', targetId: b.id } });
    expect((gone!.beforeValue as { mergedInto: string }).mergedInto).toBe('A');
  });

  it('refuses merging a room with itself', async () => {
    const { p, a } = await three(`Merge self ${s}`);
    expect((await merge(p.id, a.id, { otherRoomId: a.id, points: union })).statusCode).toBe(400);
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
