/**
 * Audit 2026-10-03, API-5, API-8, API-9, API-10.
 *
 * Instrument visibility (`instrument_scope`) was "enforced on the query" for
 * the READ routes since 2026-08 — and nowhere else. `GET /:id/attributes`
 * (every limit, range and placement attribute) was a bare lookup and an
 * existence oracle; `PUT /:id`, `DELETE /:id`, the token routes and the three
 * attribute writes looked up by id alone; the two instrument pickers and the
 * functional-location detail route listed the whole plant; and a profile's
 * key-removal cascade deleted attributes on every instrument of the profile
 * with neither the attribute-access gate nor the scope consulted.
 *
 * Driven through the seeded OPERATOR, scoped to ONE Block, against an
 * instrument in that Block (positive control) and one in another (must be
 * invisible: 404, never 403, and absent from every picker).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildApp, loginAs } from './test-helper.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { prisma } from '../lib/prisma.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

let app: FastifyInstance;
let admin: Record<string, string>;
let operator: Record<string, string>;
const s = Date.now();
let blockId = '';
let otherBlockId = '';
let inScopeId = '';
let outOfScopeId = '';
let profileId = '';
let rolePermsBefore: string[] = [];
let roleId = '';
let accessBefore: unknown = null;

async function createInstrument(code: string, functionalLocationId: string | null): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: admin,
    payload: { name: code, code, profileId, functionalLocationId },
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  if (functionalLocationId) await prisma.instrument.update({ where: { id }, data: { functionalLocationId } });
  return id;
}

beforeAll(async () => {
  app = await buildApp();
  admin = { authorization: `Bearer ${await loginAs(app)}` };
  profileId = await fixtureProfileId('fixture:scope-writes');

  blockId = (await prisma.functionalLocation.create({ data: { name: `scope-w-block-${s}`, type: 'BLOCK' } })).id;
  otherBlockId = (await prisma.functionalLocation.create({ data: { name: `scope-w-other-${s}`, type: 'BLOCK' } })).id;
  inScopeId = await createInstrument(`SCOPE-W-IN-${s}`, blockId);
  outOfScopeId = await createInstrument(`SCOPE-W-OUT-${s}`, otherBlockId);

  // Both carry an attribute the operator will try to read / change / delete.
  for (const id of [inScopeId, outOfScopeId]) {
    await prisma.instrumentAttribute.create({ data: { instrumentId: id, key: 'Location', value: 'Room X' } });
  }

  const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
  roleId = role.id;
  rolePermsBefore = role.permissions as string[];
  await prisma.role.update({
    where: { id: roleId },
    data: { permissions: [...new Set([...rolePermsBefore, 'INSTRUMENT_READ', 'INSTRUMENT_UPDATE', 'INSTRUMENT_DELETE', 'FUNCTIONAL_LOCATION_READ'])] },
  });
  invalidateRolePermsCache('OPERATOR');
  const cfg = await prisma.roleConfig.findFirst({ where: { role: 'OPERATOR' } });
  accessBefore = cfg?.attributeAccess ?? null;
  await prisma.roleConfig.upsert({
    where: { role: 'OPERATOR' },
    create: { role: 'OPERATOR', instrumentScope: { locationIds: [blockId], instrumentIds: [] } as never },
    update: { instrumentScope: { locationIds: [blockId], instrumentIds: [] } as never },
  });
  operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
});

afterAll(async () => {
  await prisma.roleConfig.updateMany({ where: { role: 'OPERATOR' }, data: { instrumentScope: Prisma.DbNull, attributeAccess: (accessBefore ?? Prisma.DbNull) as never } });
  await prisma.role.update({ where: { id: roleId }, data: { permissions: rolePermsBefore as never } });
  invalidateRolePermsCache('OPERATOR');
  admin = { authorization: `Bearer ${await loginAs(app)}` };
  for (const id of [inScopeId, outOfScopeId]) {
    await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: admin });
  }
  await prisma.functionalLocation.deleteMany({ where: { id: { in: [blockId, otherBlockId] } } });
  await app.close();
});

describe('an instrument outside the scope is 404, never 403, on every route that names one', () => {
  it('GET /:id/attributes', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/instruments/${outOfScopeId}/attributes`, headers: operator })).statusCode).toBe(404);
    const ok = await app.inject({ method: 'GET', url: `/api/instruments/${inScopeId}/attributes`, headers: operator });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.map((a: { key: string }) => a.key)).toContain('Location');
  });

  it('PUT /:id and DELETE /:id', async () => {
    const put = await app.inject({ method: 'PUT', url: `/api/instruments/${outOfScopeId}`, headers: operator, payload: { name: 'renamed' } });
    expect(put.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/api/instruments/${outOfScopeId}`, headers: operator });
    expect(del.statusCode).toBe(404);
    expect(await prisma.instrument.findUnique({ where: { id: outOfScopeId }, select: { name: true } })).toMatchObject({ name: `SCOPE-W-OUT-${s}` });
    // Positive control: the in-scope one renames.
    const ok = await app.inject({ method: 'PUT', url: `/api/instruments/${inScopeId}`, headers: operator, payload: { name: 'renamed-in-scope' } });
    expect(ok.statusCode).toBe(200);
  });

  it('the attribute writes', async () => {
    const post = await app.inject({ method: 'POST', url: `/api/instruments/${outOfScopeId}/attributes`, headers: operator, payload: { key: 'Note', value: 'x' } });
    expect(post.statusCode).toBe(404);
    const put = await app.inject({ method: 'PUT', url: `/api/instruments/${outOfScopeId}/attributes/Location`, headers: operator, payload: { value: 'Room Y', reason: 'e2e' } });
    expect(put.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/api/instruments/${outOfScopeId}/attributes/Location`, headers: operator, payload: { reason: 'e2e' } });
    expect(del.statusCode).toBe(404);
    expect(await prisma.instrumentAttribute.findUnique({ where: { instrumentId_key: { instrumentId: outOfScopeId, key: 'Location' } } })).toMatchObject({ value: 'Room X' });
  });

  it('the token routes (re-authenticated, so the lookup is reached)', async () => {
    const reauth = { ...operator, 'x-reauth-password': 'Test@1234' };
    expect((await app.inject({ method: 'GET', url: `/api/instruments/${outOfScopeId}/token`, headers: reauth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/instruments/${outOfScopeId}/regenerate-token`, headers: reauth })).statusCode).toBe(404);
    // Positive control: the in-scope token is readable.
    expect((await app.inject({ method: 'GET', url: `/api/instruments/${inScopeId}/token`, headers: reauth })).statusCode).toBe(200);
  });
});

describe('the pickers and the location detail show only the scope', () => {
  it('GET /eligible-children', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instruments/eligible-children', headers: operator });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((r: { id: string }) => r.id);
    expect(ids).toContain(inScopeId);
    expect(ids).not.toContain(outOfScopeId);
  });

  it('GET /api/functional-locations/linkable-instruments', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/functional-locations/linkable-instruments', headers: operator });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((r: { id: string }) => r.id);
    expect(ids).toContain(inScopeId);
    expect(ids).not.toContain(outOfScopeId);
  });

  it('GET /api/functional-locations/:id counts and lists only visible instruments', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/functional-locations/${otherBlockId}`, headers: operator });
    expect(res.statusCode).toBe(200);
    expect(res.json().ownCount).toBe(0);
    expect(res.json().instruments ?? []).toEqual([]);
    const mine = await app.inject({ method: 'GET', url: `/api/functional-locations/${blockId}`, headers: operator });
    expect(mine.json().ownCount).toBe(1);
  });
});

describe('a profile key removal answers to the attribute gate and the scope', () => {
  it('is refused OUT_OF_SCOPE when an instrument the caller cannot see carries the key', async () => {
    const before = await prisma.instrumentProfile.findUniqueOrThrow({ where: { id: profileId }, select: { attributeKeys: true } });
    await prisma.instrumentProfile.update({ where: { id: profileId }, data: { attributeKeys: ['Location', 'Note'].join(String.fromCharCode(10)) } });
    try {
      // PUT /api/instrument-profiles/:id is gated on INSTRUMENT_UPDATE, which the operator holds for this suite.
      const res = await app.inject({
        method: 'PUT', url: `/api/instrument-profiles/${profileId}`, headers: operator,
        payload: { attributeKeys: 'Note', reason: 'e2e removal' },
      });
      expect([403, 400]).toContain(res.statusCode);
      if (res.statusCode === 403) expect(res.json().error).toBe('OUT_OF_SCOPE');
      // Nothing was deleted on the out-of-scope instrument.
      expect(await prisma.instrumentAttribute.findUnique({ where: { instrumentId_key: { instrumentId: outOfScopeId, key: 'Location' } } })).not.toBeNull();
    } finally {
      await prisma.instrumentProfile.update({ where: { id: profileId }, data: { attributeKeys: before.attributeKeys } });
    }
  });
});

/**
 * Audit 2026-10-03, API-20: `GET /api/instrument-profiles/:id/attribute-usage`
 * counted every instrument of the profile for every caller, while its sibling
 * reads on the same module are scoped. Both fixture instruments carry
 * `Location`; the operator sees ONE of them.
 */
describe('GET /api/instrument-profiles/:id/attribute-usage is instrument-visibility scoped', () => {
  it('counts only the instruments in the caller\'s scope; SUPER_ADMIN still sees all', async () => {
    const forOperator = await app.inject({ method: 'GET', url: `/api/instrument-profiles/${profileId}/attribute-usage`, headers: operator });
    expect(forOperator.statusCode).toBe(200);
    const opLocation = (forOperator.json().keys as { key: string; instruments: number }[]).find((k) => k.key.toLowerCase() === 'location');
    expect(opLocation?.instruments).toBe(1);

    const forAdmin = await app.inject({ method: 'GET', url: `/api/instrument-profiles/${profileId}/attribute-usage`, headers: admin });
    expect(forAdmin.statusCode).toBe(200);
    const adminLocation = (forAdmin.json().keys as { key: string; instruments: number }[]).find((k) => k.key.toLowerCase() === 'location');
    expect(adminLocation?.instruments).toBe(2);
  });
});
