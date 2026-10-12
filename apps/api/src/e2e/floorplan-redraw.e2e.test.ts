import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import {
  REDRAW_ROOM_SELECT, REDRAW_LINK_SELECT, carriedLimits, describeLimits, duplicateRoomCodes, replacePlanRooms, type RedrawRoom,
} from '../modules/floorplans/redraw.js';

/**
 * Audit 2026-10-12 finding 1: the draw scripts replaced a plan's rooms and
 * DROPPED their four limits. They now go through `replacePlanRooms`, which is
 * what this file drives, against the real database: limits carried by code
 * survive, the audit rows name them, links are deleted with a row each, and the
 * whole redraw is one transaction.
 */

const s = Date.now();
const ACTOR = 'superadmin';
const audit = { userId: ACTOR, userRole: 'SUPER_ADMIN', ipAddress: '127.0.0.1', userAgent: 'floorplan-redraw.e2e', sessionId: null, reason: `redraw test ${s}` };
let planId = '';
let planName = '';

const room = (code: string, x: number, limits = carriedLimits(null)): RedrawRoom => ({
  code, label: `label ${code}`, x, y: 0.1, w: 0.1, h: 0.1, points: null, doors: [], grade: 'C', meta: null, limits, instrumentIds: [],
});

async function load() {
  return prisma.floorplan.findUniqueOrThrow({ where: { id: planId }, select: { rooms: { select: REDRAW_ROOM_SELECT }, links: { select: REDRAW_LINK_SELECT } } });
}

beforeEach(async () => {
  planName = `Redraw ${s} ${Math.random().toString(36).slice(2, 8)}`;
  const plan = await prisma.floorplan.create({ data: { name: planName, imageWidth: 1000, imageHeight: 700 } });
  planId = plan.id;
  const a = await prisma.floorplanRoom.create({ data: { floorplanId: planId, code: 'R-A', x: 0.1, y: 0.1, w: 0.1, h: 0.1, tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 } });
  const b = await prisma.floorplanRoom.create({ data: { floorplanId: planId, code: 'R-B', x: 0.3, y: 0.1, w: 0.1, h: 0.1, tempMax: 8 } });
  await prisma.floorplanRoomLink.create({ data: { floorplanId: planId, fromRoomId: a.id, toRoomId: b.id, kind: 'CONNECTOR', label: 'pipe' } });
});

afterAll(async () => {
  await prisma.floorplan.deleteMany({ where: { name: { startsWith: `Redraw ${s}` } } });
});

describe('replacePlanRooms — a redraw keeps each room\'s limits', () => {
  it('carries the four limits by code onto the new rooms, and a new code gets none', async () => {
    const old = await load();
    const byCode = new Map(old.rooms.map((r) => [r.code.toUpperCase(), r]));
    const specs = ['R-A', 'R-B', 'R-NEW'].map((c, i) => room(c, 0.1 + i * 0.2, carriedLimits(byCode.get(c))));

    await prisma.$transaction((tx) => replacePlanRooms(tx, {
      planId, planName, oldRooms: old.rooms, oldLinks: old.links, rooms: specs, audit, actor: ACTOR, why: 'test redraw',
    }));

    const after = await prisma.floorplanRoom.findMany({ where: { floorplanId: planId }, orderBy: { code: 'asc' } });
    const lim = (code: string) => {
      const r = after.find((x) => x.code === code)!;
      return { tempMin: r.tempMin, tempMax: r.tempMax, rhMin: r.rhMin, rhMax: r.rhMax };
    };
    expect(after.map((r) => r.code)).toEqual(['R-A', 'R-B', 'R-NEW']);
    expect(lim('R-A')).toEqual({ tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 });
    expect(lim('R-B')).toEqual({ tempMin: null, tempMax: 8, rhMin: null, rhMax: null });
    expect(lim('R-NEW')).toEqual({ tempMin: null, tempMax: null, rhMin: null, rhMax: null });
    // The old rows are gone — these are NEW rooms, not the old ones left behind.
    expect(after.some((r) => old.rooms.some((o) => o.id === r.id))).toBe(false);
  });

  it('names the limits in the delete and create audit rows, and deletes each link with its own row', async () => {
    const old = await load();
    const oldA = old.rooms.find((r) => r.code === 'R-A')!;
    const link = old.links[0];
    const specs = [room('R-A', 0.1, carriedLimits(oldA))];

    await prisma.$transaction((tx) => replacePlanRooms(tx, {
      planId, planName, oldRooms: old.rooms, oldLinks: old.links, rooms: specs, audit, actor: ACTOR, why: 'test redraw',
    }));

    const deleted = await prisma.auditTrail.findFirst({ where: { action: 'FLOORPLAN_ROOM_DELETED', targetId: oldA.id } });
    expect((deleted!.beforeValue as { limits: unknown }).limits).toEqual({ tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 });
    const newA = await prisma.floorplanRoom.findFirstOrThrow({ where: { floorplanId: planId, code: 'R-A' } });
    const created = await prisma.auditTrail.findFirst({ where: { action: 'FLOORPLAN_ROOM_CREATED', targetId: newA.id } });
    expect((created!.afterValue as { limits: unknown }).limits).toEqual({ tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 });
    expect(created!.reason).toBe(audit.reason);
    const linkRow = await prisma.auditTrail.findFirst({ where: { action: 'FLOORPLAN_LINK_DELETED', targetId: link.id } });
    expect(linkRow).not.toBeNull();
    expect((linkRow!.beforeValue as { code: string }).code).toBe('R-A ↔ R-B');
  });

  it('is all or nothing: a failure after it leaves the plan exactly as it was', async () => {
    const old = await load();
    await expect(prisma.$transaction(async (tx) => {
      await replacePlanRooms(tx, {
        planId, planName, oldRooms: old.rooms, oldLinks: old.links, rooms: [room('R-X', 0.1)], audit, actor: ACTOR, why: 'test redraw',
      });
      throw new Error('a later step failed');
    })).rejects.toThrow('a later step failed');
    const still = await load();
    expect(still.rooms.map((r) => r.code).sort()).toEqual(['R-A', 'R-B']);
    expect(still.links).toHaveLength(1);
    expect(still.rooms.find((r) => r.code === 'R-A')!.tempMin).toBe(18);
  });

  it('refuses a layout that repeats a room code (ignoring case) before writing anything', async () => {
    const old = await load();
    await expect(prisma.$transaction((tx) => replacePlanRooms(tx, {
      planId, planName, oldRooms: old.rooms, oldLinks: old.links, rooms: [room('R-A', 0.1), room('r-a', 0.3)], audit, actor: ACTOR, why: 'test redraw',
    }))).rejects.toThrow(/repeated.*R-A/);
    expect((await load()).rooms).toHaveLength(2);
  });
});

describe('redraw helpers', () => {
  it('duplicateRoomCodes compares ignoring case; describeLimits prints what the dry run shows', () => {
    expect(duplicateRoomCodes(['A', 'b', 'a', 'B', 'c'])).toEqual(['A', 'B']);
    expect(duplicateRoomCodes(['A', 'A (2)'])).toEqual([]);
    expect(describeLimits(carriedLimits(null))).toBe('none');
    expect(describeLimits(carriedLimits({ tempMin: 18, tempMax: 25, rhMax: 60 }))).toBe('T 18..25  RH -..60');
  });
});
