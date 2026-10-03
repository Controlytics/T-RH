import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, authDelete, ADMIN_PASSWORD } from './test-helper.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { prisma } from '../lib/prisma.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

/**
 * Deleting a functional location (2026-10-03, operator: "add delete option for
 * functional locations for super admin").
 *
 * An EMPTY location deletes as it always did. A location that holds areas or
 * instruments is refused (409) — unless a SUPER_ADMIN asks for `?cascade=true`,
 * when its areas go with it and every instrument in any of them is UNLINKED,
 * never deleted. A role holding FUNCTIONAL_LOCATION_DELETE that asks for the
 * cascade is refused (403): the power is the super admin's alone.
 */
let app: FastifyInstance;
let admin: string;
let operator: string;
const s = Date.now();
const made = { locations: [] as string[], instruments: [] as string[] };
let roleId: string;
let rolePermsBefore: string[];

async function block(name: string, parentId: string | null = null) {
  const row = await prisma.functionalLocation.create({ data: { name, type: parentId ? 'AREA' : 'BLOCK', parentId } });
  made.locations.push(row.id);
  return row;
}
async function instrument(code: string, functionalLocationId: string | null) {
  // Through the route, the way the scope e2e does: the create route knows the row's shape.
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: { authorization: `Bearer ${admin}` },
    payload: { name: code, code, profileId: await fixtureProfileId('fixture:fl-delete') },
  });
  expect(res.statusCode).toBe(201);
  const { id } = res.json() as { id: string };
  made.instruments.push(id);
  if (functionalLocationId) await prisma.instrument.update({ where: { id }, data: { functionalLocationId } });
  return id;
}
const del = (token: string, id: string, cascade?: boolean) =>
  authDelete(app, `/api/functional-locations/${id}${cascade ? '?cascade=true' : ''}`, token, ADMIN_PASSWORD);

beforeAll(async () => {
  app = await buildApp();
  admin = await loginAs(app);
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
  roleId = role.id;
  rolePermsBefore = role.permissions as string[];
  await prisma.role.update({ where: { id: roleId }, data: { permissions: [...rolePermsBefore, 'FUNCTIONAL_LOCATION_DELETE'] } });
  invalidateRolePermsCache('OPERATOR');
  operator = await loginAs(app, 'RB0001', 'Test@1234');
  // The admin's bearer again: every login terminates the user's other sessions.
  admin = await loginAs(app);
});

afterAll(async () => {
  if (roleId) {
    await prisma.role.update({ where: { id: roleId }, data: { permissions: rolePermsBefore as never } });
    invalidateRolePermsCache('OPERATOR');
  }
  await prisma.instrument.deleteMany({ where: { id: { in: made.instruments } } });
  // Areas before blocks: the parent FK is RESTRICT.
  await prisma.functionalLocation.deleteMany({ where: { id: { in: made.locations }, parentId: { not: null } } });
  await prisma.functionalLocation.deleteMany({ where: { id: { in: made.locations } } });
  await app.close();
});

describe('DELETE /api/functional-locations/:id', () => {
  it('deletes an empty location, audited', async () => {
    const b = await block(`FLD empty ${s}`);
    const res = await del(admin, b.id);
    expect(res.statusCode).toBe(204);
    expect(await prisma.functionalLocation.findUnique({ where: { id: b.id } })).toBeNull();
    const audit = await prisma.auditTrail.findFirst({ where: { action: 'FUNCTIONAL_LOCATION_DELETED', targetId: b.id } });
    expect(audit).toBeTruthy();
  });

  it('refuses a location that holds an instrument or an area, naming what it holds', async () => {
    const b = await block(`FLD held ${s}`);
    const a = await block(`FLD held area ${s}`, b.id);
    await instrument(`FLD-HELD-${s}`, a.id);
    const res = await del(admin, b.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('NOT_EMPTY');
    expect(res.json().message).toContain('1 instrument(s) and 1 area(s)');
    // A super admin is told the way through; the location is untouched.
    expect(res.json().message).toContain('delete it with everything in it');
    expect(await prisma.functionalLocation.count({ where: { id: { in: [b.id, a.id] } } })).toBe(2);
  });

  it('a SUPER_ADMIN deletes a Block WITH its areas; the instruments are unlinked, not deleted; one audit row per location', async () => {
    const b = await block(`FLD cascade ${s}`);
    const a1 = await block(`FLD cascade area 1 ${s}`, b.id);
    const a2 = await block(`FLD cascade area 2 ${s}`, b.id);
    const own = await instrument(`FLD-OWN-${s}`, b.id);
    const inArea = await instrument(`FLD-AREA-${s}`, a1.id);
    const res = await del(admin, b.id, true);
    expect(res.statusCode).toBe(204);
    expect(await prisma.functionalLocation.count({ where: { id: { in: [b.id, a1.id, a2.id] } } })).toBe(0);
    const rows = await prisma.instrument.findMany({ where: { id: { in: [own, inArea] } }, select: { code: true, functionalLocationId: true } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.functionalLocationId === null)).toBe(true);
    const audits = await prisma.auditTrail.findMany({ where: { action: 'FUNCTIONAL_LOCATION_DELETED', targetId: { in: [b.id, a1.id, a2.id] } } });
    expect(audits).toHaveLength(3);
    const blockRow = audits.find((r) => r.targetId === b.id)!;
    const before = blockRow.beforeValue as Record<string, unknown>;
    expect(before.areasDeleted).toEqual(expect.arrayContaining([a1.name, a2.name]));
    expect(before.instrumentsUnlinked).toEqual([`FLD-OWN-${s}`]);
    expect(before.instrumentsUnlinkedInAreas).toEqual([`FLD-AREA-${s}`]);
    const areaRow = audits.find((r) => r.targetId === a1.id)!;
    expect((areaRow.beforeValue as Record<string, unknown>).instrumentsUnlinked).toEqual([`FLD-AREA-${s}`]);
  });

  it('a role holding FUNCTIONAL_LOCATION_DELETE still cannot cascade: 403, nothing changed', async () => {
    const b = await block(`FLD op ${s}`);
    const a = await block(`FLD op area ${s}`, b.id);
    const inst = await instrument(`FLD-OP-${s}`, a.id);
    const res = await del(operator, b.id, true);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('SUPER_ADMIN_ONLY');
    expect(await prisma.functionalLocation.count({ where: { id: { in: [b.id, a.id] } } })).toBe(2);
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id: inst } })).functionalLocationId).toBe(a.id);
    // ...and without the cascade the same role gets the plain refusal, without the super admin's hint.
    const plain = await del(operator, b.id);
    expect(plain.statusCode).toBe(409);
    expect(plain.json().message).not.toContain('everything in it');
    // An EMPTY location, that role may delete.
    const empty = await block(`FLD op empty ${s}`);
    expect((await del(operator, empty.id)).statusCode).toBe(204);
  });
});
