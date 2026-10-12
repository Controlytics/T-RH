/**
 * Functional-location membership and the tree, for a SCOPED caller (audit
 * 2026-10-12 findings 2 and 7).
 *
 * 2: `PUT /api/functional-locations/:id/instruments` is sent the WHOLE
 *    membership by the panel, but the panel only sees the caller's scope — so
 *    every member the caller cannot see was unlinked. The PUT now adds and
 *    removes only within the caller's scope; out-of-scope members are untouched
 *    and an out-of-scope id is refused like an unknown one.
 * 7: the tree (`GET /`) is read by INSTRUMENT_READ pages (Settings, Data
 *    Report, the trend PDF's Block/Area), so INSTRUMENT_READ may read it; it is
 *    visibility-scoped already.
 *
 * Driven through the seeded OPERATOR: SUPER_ADMIN short-circuits visibility,
 * so an admin-driven version would pass against an unscoped route.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

let app: FastifyInstance;
let operator: Record<string, string>;
const s = Date.now();
const instrumentIds: string[] = [];
let blockId = '';
// The tree / plan scoping fixtures: a Block whose only DIRECT instrument is out
// of scope but whose Area holds a visible one, an empty Block, an empty Area
// under the visible Block; and a plan with a room per case.
let hiddenBlockId = '';
let emptyBlockId = '';
let visAreaId = '';
let emptyAreaId = '';
let inAreaId = '';
let planId = '';
const roomIds: Record<string, string> = {};
let roleId = '';
let permsBefore: string[] = [];
let scopeBefore: { existed: boolean; value: unknown } = { existed: false, value: null };

let visibleMember = '';
let hiddenMember = '';
let visibleOutsider = '';

const reauth = { 'x-reauth-password': 'Test@1234' };

async function setOperatorPerms(perms: string[]) {
  await prisma.role.update({ where: { id: roleId }, data: { permissions: perms } });
  invalidateRolePermsCache('OPERATOR');
}

async function makeInstrument(code: string, functionalLocationId: string | null) {
  const i = await prisma.instrument.create({
    data: { code, name: code, profileId: await fixtureProfileId('fixture:fl-scoped-membership'), functionalLocationId } as never,
    select: { id: true },
  });
  instrumentIds.push(i.id);
  return i.id;
}

beforeAll(async () => {
  app = await buildApp();
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
  roleId = role.id;
  permsBefore = role.permissions as string[];
  const rc = await prisma.roleConfig.findUnique({ where: { role: 'OPERATOR' } });
  scopeBefore = { existed: Boolean(rc), value: rc?.instrumentScope ?? null };

  blockId = (await prisma.functionalLocation.create({ data: { name: `fl-scoped-${s}`, type: 'BLOCK' } })).id;
  visibleMember = await makeInstrument(`FLS-VIS-${s}`, blockId);
  hiddenMember = await makeInstrument(`FLS-HID-${s}`, blockId);
  visibleOutsider = await makeInstrument(`FLS-OUT-${s}`, null);
  hiddenBlockId = (await prisma.functionalLocation.create({ data: { name: `fl-hidden-${s}`, type: 'BLOCK' } })).id;
  emptyBlockId = (await prisma.functionalLocation.create({ data: { name: `fl-empty-${s}`, type: 'BLOCK' } })).id;
  const hiddenOnly = await makeInstrument(`FLS-HID2-${s}`, hiddenBlockId);
  visAreaId = (await prisma.functionalLocation.create({ data: { name: `fl-area-${s}`, type: 'AREA', parentId: hiddenBlockId } })).id;
  emptyAreaId = (await prisma.functionalLocation.create({ data: { name: `fl-area-empty-${s}`, type: 'AREA', parentId: blockId } })).id;
  inAreaId = await makeInstrument(`FLS-AREA-${s}`, visAreaId);
  planId = (await prisma.floorplan.create({ data: { name: `fl-scoped-plan-${s}`, imageWidth: 100, imageHeight: 100 } })).id;
  for (const [code, inst] of [['R-VIS', inAreaId], ['R-HID', hiddenOnly], ['R-EMPTY', null]] as const) {
    const r = await prisma.floorplanRoom.create({ data: { floorplanId: planId, code: `${code}-${s}`, label: `label ${code}`, x: 0.1, y: 0.1, w: 0.1, h: 0.1, tempMin: 18, tempMax: 25, rhMin: 30, rhMax: 60 } });
    roomIds[code] = r.id;
    if (inst) await prisma.instrument.update({ where: { id: inst }, data: { roomId: r.id } });
  }

  // The OPERATOR sees two instruments by name, and NOT the hidden member.
  await prisma.roleConfig.upsert({
    where: { role: 'OPERATOR' },
    create: { role: 'OPERATOR', instrumentScope: { locationIds: [], instrumentIds: [visibleMember, visibleOutsider, inAreaId] } as never },
    update: { instrumentScope: { locationIds: [], instrumentIds: [visibleMember, visibleOutsider, inAreaId] } as never },
  });
  await setOperatorPerms(['INSTRUMENT_READ', 'FUNCTIONAL_LOCATION_READ', 'FUNCTIONAL_LOCATION_UPDATE']);
  operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}`, ...reauth };
});

afterAll(async () => {
  // Restore the shared role FIRST, each step on its own: a suite must hand back
  // what it touched even while it is failing.
  try { await setOperatorPerms(permsBefore); } catch (e) { console.error('restore perms', e); }
  try {
    if (scopeBefore.existed) {
      await prisma.roleConfig.update({
        where: { role: 'OPERATOR' },
        data: { instrumentScope: scopeBefore.value === null ? Prisma.DbNull : (scopeBefore.value as never) },
      });
    } else {
      await prisma.roleConfig.deleteMany({ where: { role: 'OPERATOR' } });
    }
  } catch (e) { console.error('restore scope', e); }
  try { await prisma.instrument.deleteMany({ where: { id: { in: instrumentIds } } }); } catch (e) { console.error('instruments', e); }
  try { await prisma.floorplan.deleteMany({ where: { id: planId } }); } catch (e) { console.error('plan', e); }
  try { await prisma.functionalLocation.deleteMany({ where: { id: { in: [visAreaId, emptyAreaId] } } }); } catch (e) { console.error('areas', e); }
  try { await prisma.functionalLocation.deleteMany({ where: { id: { in: [blockId, hiddenBlockId, emptyBlockId] } } }); } catch (e) { console.error('block', e); }
  await app.close();
});

const flOf = async (id: string) => (await prisma.instrument.findUniqueOrThrow({ where: { id } })).functionalLocationId;

describe('PUT /:id/instruments only changes what the caller can see (finding 2)', () => {
  it('the scoped picker lists the visible member only (positive control for the setup)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/functional-locations/linkable-instruments', headers: operator });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(visibleMember);
    expect(ids).not.toContain(hiddenMember);
  });

  it('replacing the visible member leaves the out-of-scope member linked', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/functional-locations/${blockId}/instruments`, headers: operator,
      payload: { instrumentIds: [visibleOutsider] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ linked: 1, unlinked: 1 });
    expect(await flOf(visibleOutsider)).toBe(blockId);
    expect(await flOf(visibleMember)).toBeNull();
    expect(await flOf(hiddenMember)).toBe(blockId);

    const row = await prisma.auditTrail.findFirst({ where: { action: 'FUNCTIONAL_LOCATION_INSTRUMENTS_CHANGED', targetId: blockId }, orderBy: { timestamp: 'desc' } });
    expect((row!.afterValue as { linked: string[] }).linked.sort()).toEqual([`FLS-HID-${s}`, `FLS-OUT-${s}`].sort());
  });

  it('an out-of-scope id is refused like an unknown one, and nothing changes', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/functional-locations/${blockId}/instruments`, headers: operator,
      payload: { instrumentIds: [visibleOutsider, hiddenMember] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
    expect(await flOf(hiddenMember)).toBe(blockId);
    expect(await flOf(visibleOutsider)).toBe(blockId);
  });
});

describe('GET /api/floorplans for a dashboard role without CONFIG_READ (finding 5)', () => {
  it('is readable with DASHBOARD_VIEW, while the editor detail and writes stay CONFIG_*', async () => {
    await setOperatorPerms(['DASHBOARD_VIEW', 'INSTRUMENT_READ']);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/floorplans', headers: operator });
      expect(res.statusCode, res.body).toBe(200);
      expect(Array.isArray(res.json().data)).toBe(true);
      const plan = await prisma.floorplan.findFirst({ select: { id: true } });
      if (plan) {
        const detail = await app.inject({ method: 'GET', url: `/api/floorplans/${plan.id}`, headers: operator });
        expect(detail.statusCode).toBe(403);
      }
      const write = await app.inject({ method: 'POST', url: '/api/floorplans', headers: operator, payload: { name: `nope ${s}`, imageWidth: 10, imageHeight: 10 } });
      expect(write.statusCode).toBe(403);
    } finally {
      await setOperatorPerms(['INSTRUMENT_READ', 'FUNCTIONAL_LOCATION_READ', 'FUNCTIONAL_LOCATION_UPDATE']);
    }
  });

  it('is still refused to a role with neither CONFIG_READ nor DASHBOARD_VIEW', async () => {
    await setOperatorPerms(['ALARM_READ']);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/floorplans', headers: operator });
      expect(res.statusCode).toBe(403);
    } finally {
      await setOperatorPerms(['INSTRUMENT_READ', 'FUNCTIONAL_LOCATION_READ', 'FUNCTIONAL_LOCATION_UPDATE']);
    }
  });
});

describe('GET / (the tree) for an INSTRUMENT_READ-only role (finding 7)', () => {
  it('is readable with INSTRUMENT_READ alone, and still scoped', async () => {
    await setOperatorPerms(['INSTRUMENT_READ']);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/functional-locations', headers: operator });
      expect(res.statusCode, res.body).toBe(200);
      const mine = (res.json().data as { id: string; instrumentCount?: number; ownCount?: number }[]).find((n) => n.id === blockId);
      expect(mine).toBeDefined();
      // A write still needs the write permission.
      const put = await app.inject({
        method: 'PUT', url: `/api/functional-locations/${blockId}/instruments`, headers: operator,
        payload: { instrumentIds: [] },
      });
      expect(put.statusCode).toBe(403);
    } finally {
      await setOperatorPerms(['INSTRUMENT_READ', 'FUNCTIONAL_LOCATION_READ', 'FUNCTIONAL_LOCATION_UPDATE']);
    }
  });
});

describe('the widened reads are SCOPED for callers without the admin permission (follow-ups to 5 and 7)', () => {
  const restore = () => setOperatorPerms(['INSTRUMENT_READ', 'FUNCTIONAL_LOCATION_READ', 'FUNCTIONAL_LOCATION_UPDATE']);

  it('GET /api/functional-locations on INSTRUMENT_READ alone: only locations holding a visible instrument, with their Block', async () => {
    await setOperatorPerms(['INSTRUMENT_READ']);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/functional-locations', headers: operator });
      expect(res.statusCode, res.body).toBe(200);
      const tree = res.json().data as { id: string; children: { id: string }[] }[];
      const ids = tree.map((b) => b.id);
      expect(ids).toContain(hiddenBlockId);       // the Block of the Area holding one
      expect(ids).not.toContain(emptyBlockId);    // holds nothing visible
      expect(tree.find((b) => b.id === hiddenBlockId)!.children.map((a) => a.id)).toEqual([visAreaId]);
      const vb = tree.find((b) => b.id === blockId);
      if (vb) expect(vb.children.map((a) => a.id)).not.toContain(emptyAreaId);
    } finally { await restore(); }
  });

  it('with FUNCTIONAL_LOCATION_READ the whole structure is still returned (positive control)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/functional-locations', headers: operator });
    const ids = (res.json().data as { id: string }[]).map((b) => b.id);
    expect(ids).toContain(emptyBlockId);
  });

  it('GET /api/floorplans on DASHBOARD_VIEW: geometry for every room, limits and identity only where a visible instrument is', async () => {
    await setOperatorPerms(['DASHBOARD_VIEW', 'INSTRUMENT_READ']);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/floorplans', headers: operator });
      expect(res.statusCode, res.body).toBe(200);
      const plan = (res.json().data as { id: string; rooms: { id: string; code: string; label: string | null; tempMin: number | null; w: number }[] }[]).find((p) => p.id === planId)!;
      const room = (k: string) => plan.rooms.find((r) => r.id === roomIds[k])!;
      expect(plan.rooms).toHaveLength(3);
      expect(room('R-VIS')).toMatchObject({ code: `R-VIS-${s}`, label: 'label R-VIS', tempMin: 18 });
      expect(room('R-HID')).toMatchObject({ code: '', label: null, tempMin: null, w: 0.1 });
      expect(room('R-EMPTY')).toMatchObject({ code: `R-EMPTY-${s}`, tempMin: null });
    } finally { await restore(); }
  });

  it('with CONFIG_READ every room is returned whole (positive control)', async () => {
    await setOperatorPerms(['CONFIG_READ', 'INSTRUMENT_READ']);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/floorplans', headers: operator });
      const plan = (res.json().data as { id: string; rooms: { id: string; code: string; tempMin: number | null }[] }[]).find((p) => p.id === planId)!;
      expect(plan.rooms.find((r) => r.id === roomIds['R-HID'])).toMatchObject({ code: `R-HID-${s}`, tempMin: 18 });
    } finally { await restore(); }
  });
});
