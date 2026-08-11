import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

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
  for (const id of instruments) {
    await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  }
  await app.close();
});

async function createPlan(name: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/floorplans', headers: auth,
    payload: {
      name, imagePath: '/uploads/floorplans/x.png',
      imageWidth: 1000, imageHeight: 700, ...extra,
    },
  });
  if (res.statusCode === 201) plans.push(res.json().id);
  return res;
}

async function addRoom(planId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: `/api/floorplans/${planId}/rooms`, headers: auth,
    payload: { x: 0.1, y: 0.1, w: 0.2, h: 0.2, ...payload },
  });
}

async function createInstrument(code: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { name: code, code, profileId: await fixtureProfileId('fixture:floorplans') },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string };
  instruments.push(body.id);
  return body;
}

const lastAudit = (action: string, targetId: string) =>
  prisma.auditTrail.findFirst({ where: { action, targetId }, orderBy: { timestamp: 'desc' } });

describe('Floorplan CRUD', () => {
  it('creates a plan and writes an audit row', async () => {
    const res = await createPlan(`Plan A ${s}`);
    expect(res.statusCode).toBe(201);
    const plan = res.json();
    expect(plan.name).toBe(`Plan A ${s}`);

    const row = await lastAudit('FLOORPLAN_CREATED', plan.id);
    expect(row).not.toBeNull();
    expect((row!.afterValue as Record<string, unknown>).name).toBe(`Plan A ${s}`);
  });

  it('rejects a duplicate plan name', async () => {
    await createPlan(`Plan DUP ${s}`);
    const again = await createPlan(`Plan DUP ${s}`);
    expect(again.statusCode).toBe(409);
  });

  it('updates a plan and records before and after', async () => {
    const plan = (await createPlan(`Plan U ${s}`)).json();
    const res = await app.inject({
      method: 'PUT', url: `/api/floorplans/${plan.id}`, headers: auth,
      payload: { name: `Plan U renamed ${s}` },
    });
    expect(res.statusCode).toBe(200);

    const row = await lastAudit('FLOORPLAN_UPDATED', plan.id);
    expect((row!.beforeValue as Record<string, unknown>).name).toBe(`Plan U ${s}`);
    expect((row!.afterValue as Record<string, unknown>).name).toBe(`Plan U renamed ${s}`);
  });

  it('404s for an unknown plan', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/floorplans/00000000-0000-0000-0000-000000000000', headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Room geometry and limits', () => {
  it('adds a room and audits it', async () => {
    const plan = (await createPlan(`Plan R ${s}`)).json();
    const res = await addRoom(plan.id, { code: 'CWH-I/142', label: 'WET LAB', tempMin: 18, tempMax: 25 });
    expect(res.statusCode).toBe(201);
    const room = res.json();
    expect(room.code).toBe('CWH-I/142');

    const row = await lastAudit('FLOORPLAN_ROOM_CREATED', room.id);
    expect(row).not.toBeNull();
    const after = row!.afterValue as Record<string, any>;
    expect(after.limits).toMatchObject({ tempMin: 18, tempMax: 25 });
  });

  it('keeps a slash in the room code through sanitisation', async () => {
    // Room codes are drafting-office identifiers matched against the printed
    // drawing. HTML stripping must not touch them.
    const plan = (await createPlan(`Plan SLASH ${s}`)).json();
    const res = await addRoom(plan.id, { code: 'CWH-I/220' });
    expect(res.statusCode).toBe(201);
    expect(res.json().code).toBe('CWH-I/220');
  });

  it('rejects a room running off the right edge', async () => {
    const plan = (await createPlan(`Plan EDGE ${s}`)).json();
    const res = await addRoom(plan.id, { code: 'OFF-R', x: 0.9, w: 0.2 });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/right edge/i);
  });

  it('rejects an inverted temperature range', async () => {
    const plan = (await createPlan(`Plan INV ${s}`)).json();
    const res = await addRoom(plan.id, { code: 'INV', tempMin: 25, tempMax: 18 });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/temperature/i);
  });

  it('rejects a duplicate room code on the same plan but allows it on another', async () => {
    const a = (await createPlan(`Plan DA ${s}`)).json();
    const b = (await createPlan(`Plan DB ${s}`)).json();
    expect((await addRoom(a.id, { code: 'SAME' })).statusCode).toBe(201);
    expect((await addRoom(a.id, { code: 'SAME' })).statusCode).toBe(409);
    // Same code on a different plan is legitimate — codes are unique per plan,
    // not globally.
    expect((await addRoom(b.id, { code: 'SAME' })).statusCode).toBe(201);
  });

  it('records the limit change on update, both sides', async () => {
    const plan = (await createPlan(`Plan LIM ${s}`)).json();
    const room = (await addRoom(plan.id, { code: 'LIM', tempMin: 18, tempMax: 25 })).json();

    const res = await app.inject({
      method: 'PUT', url: `/api/floorplans/${plan.id}/rooms/${room.id}`, headers: auth,
      payload: { code: 'LIM', x: 0.1, y: 0.1, w: 0.2, h: 0.2, tempMin: 20, tempMax: 24 },
    });
    expect(res.statusCode).toBe(200);

    const row = await lastAudit('FLOORPLAN_ROOM_UPDATED', room.id);
    expect((row!.beforeValue as Record<string, any>).limits).toMatchObject({ tempMin: 18, tempMax: 25 });
    expect((row!.afterValue as Record<string, any>).limits).toMatchObject({ tempMin: 20, tempMax: 24 });
  });

  it('404s for a room on a different plan', async () => {
    const a = (await createPlan(`Plan XA ${s}`)).json();
    const b = (await createPlan(`Plan XB ${s}`)).json();
    const room = (await addRoom(a.id, { code: 'XR' })).json();
    const res = await app.inject({
      method: 'PUT', url: `/api/floorplans/${b.id}/rooms/${room.id}`, headers: auth,
      payload: { code: 'XR', x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Room membership', () => {
  it('sets membership, then unlinks an instrument omitted from a later call', async () => {
    const plan = (await createPlan(`Plan M ${s}`)).json();
    const room = (await addRoom(plan.id, { code: 'M1' })).json();
    const i1 = await createInstrument(`FP-M1-${s}`);
    const i2 = await createInstrument(`FP-M2-${s}`);

    const set = await app.inject({
      method: 'PUT', url: `/api/floorplans/${plan.id}/rooms/${room.id}/instruments`,
      headers: auth, payload: { instrumentIds: [i1.id, i2.id] },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().instrumentIds).toHaveLength(2);

    // Omitting i2 removes it from the room — wholesale, not additive.
    const narrowed = await app.inject({
      method: 'PUT', url: `/api/floorplans/${plan.id}/rooms/${room.id}/instruments`,
      headers: auth, payload: { instrumentIds: [i1.id] },
    });
    expect(narrowed.statusCode).toBe(200);

    const after2 = await prisma.instrument.findUnique({ where: { id: i2.id } });
    // Unlinked, NOT deleted.
    expect(after2).not.toBeNull();
    expect(after2!.roomId).toBeNull();
    const after1 = await prisma.instrument.findUnique({ where: { id: i1.id } });
    expect(after1!.roomId).toBe(room.id);
  });

  it('moves an instrument that already belongs to another room, and says so', async () => {
    const plan = (await createPlan(`Plan MV ${s}`)).json();
    const roomA = (await addRoom(plan.id, { code: 'MV-A' })).json();
    const roomB = (await addRoom(plan.id, { code: 'MV-B', x: 0.5 })).json();
    const inst = await createInstrument(`FP-MV-${s}`);

    await app.inject({
      method: 'PUT', url: `/api/floorplans/${plan.id}/rooms/${roomA.id}/instruments`,
      headers: auth, payload: { instrumentIds: [inst.id] },
    });
    const res = await app.inject({
      method: 'PUT', url: `/api/floorplans/${plan.id}/rooms/${roomB.id}/instruments`,
      headers: auth, payload: { instrumentIds: [inst.id] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toHaveLength(1);
    expect(res.json().moved[0].fromRoom.code).toBe('MV-A');

    const moved = await prisma.instrument.findUnique({ where: { id: inst.id } });
    expect(moved!.roomId).toBe(roomB.id);
  });

  it('rejects an unknown instrument id rather than silently skipping it', async () => {
    const plan = (await createPlan(`Plan BAD ${s}`)).json();
    const room = (await addRoom(plan.id, { code: 'BAD' })).json();
    const res = await app.inject({
      method: 'PUT', url: `/api/floorplans/${plan.id}/rooms/${room.id}/instruments`,
      headers: auth, payload: { instrumentIds: ['00000000-0000-0000-0000-000000000000'] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Deletion', () => {
  it('deleting a room unplaces its instruments but keeps them', async () => {
    const plan = (await createPlan(`Plan DR ${s}`)).json();
    const room = (await addRoom(plan.id, { code: 'DR' })).json();
    const inst = await createInstrument(`FP-DR-${s}`);
    await app.inject({
      method: 'PUT', url: `/api/floorplans/${plan.id}/rooms/${room.id}/instruments`,
      headers: auth, payload: { instrumentIds: [inst.id] },
    });

    const res = await app.inject({
      method: 'DELETE', url: `/api/floorplans/${plan.id}/rooms/${room.id}`, headers: auth,
    });
    expect(res.statusCode).toBe(204);

    const still = await prisma.instrument.findUnique({ where: { id: inst.id } });
    expect(still).not.toBeNull();
    expect(still!.roomId).toBeNull();

    const row = await lastAudit('FLOORPLAN_ROOM_DELETED', room.id);
    expect((row!.beforeValue as Record<string, any>).instruments).toContain(`FP-DR-${s}`);
  });

  it('deleting a plan cascades its rooms and keeps the instruments', async () => {
    const plan = (await createPlan(`Plan DP ${s}`)).json();
    const room = (await addRoom(plan.id, { code: 'DP' })).json();
    const inst = await createInstrument(`FP-DP-${s}`);
    await app.inject({
      method: 'PUT', url: `/api/floorplans/${plan.id}/rooms/${room.id}/instruments`,
      headers: auth, payload: { instrumentIds: [inst.id] },
    });

    const res = await app.inject({
      method: 'DELETE', url: `/api/floorplans/${plan.id}`, headers: auth,
    });
    expect(res.statusCode).toBe(204);

    expect(await prisma.floorplanRoom.findUnique({ where: { id: room.id } })).toBeNull();
    const still = await prisma.instrument.findUnique({ where: { id: inst.id } });
    expect(still).not.toBeNull();
    expect(still!.roomId).toBeNull();
  });
});

describe('Authorisation', () => {
  it('requires authentication on reads', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/floorplans' });
    expect(res.statusCode).toBe(401);
  });

  it('requires authentication on writes', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/floorplans',
      payload: { name: 'nope', imagePath: '/x.png', imageWidth: 10, imageHeight: 10 },
    });
    expect(res.statusCode).toBe(401);
  });
});
