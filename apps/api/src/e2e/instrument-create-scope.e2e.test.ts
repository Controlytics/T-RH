/**
 * A caller whose instrument view is LIMITED can only register an instrument it
 * will be able to see — and a child's detail names its gateway even when the
 * caller cannot open the gateway.
 *
 * What happened (AWS, 2026-10-26): a MAINTENANCE user scoped to two functional
 * locations registered two instruments with no location. Each existed, but sat
 * outside its creator's scope, so every following request — the attribute
 * writes the New Instrument form sends straight after, the detail page, its
 * telemetry — answered 404 "Instrument not found." Every attribute typed into
 * the form was lost. Separately, every child detail page looked its gateway up
 * by id; IOTGW01 sits in no location, so a scoped viewer got a "Load Error"
 * toast on every child it opened.
 *
 * Driven through the seeded OPERATOR, never `admin`: SUPER_ADMIN short-circuits
 * visibility, so an admin-driven version of these assertions would pass against
 * a route with no scoping at all. Each refusal is paired with a positive
 * control for the reverse reason.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

let app: FastifyInstance;
let admin: Record<string, string>;
let operator: Record<string, string>;
let profileId = '';

const s = Date.now();
/** enforceReauth passes with the header present whether or not the role requires it. */
const reauth = { 'x-reauth-password': 'Test@1234' };
const adminReauth = { 'x-reauth-password': 'Admin@123' };

let blockId = '';
let areaId = '';
let otherBlockId = '';
let roleId = '';
let rolePermsBefore: string[] = [];
let operatorUserId = '';
let userCfgBefore: { existed: boolean; scope: unknown } = { existed: false, scope: null };

/** Every instrument any case creates, by code — deleted in afterAll whoever made it. */
const codes: string[] = [];

const GRANTS = ['INSTRUMENT_READ', 'INSTRUMENT_CREATE', 'INSTRUMENT_UPDATE', 'FUNCTIONAL_LOCATION_READ'];

async function create(headers: Record<string, string>, code: string, extra: Record<string, unknown> = {}) {
  codes.push(code);
  return app.inject({
    method: 'POST', url: '/api/instruments', headers,
    payload: { name: code, code, profileId, ...extra },
  });
}

async function createdAuditRows(code: string) {
  return prisma.auditTrail.count({
    where: { action: 'INSTRUMENT_CREATED', afterValue: { path: ['code'], equals: code } },
  });
}

beforeAll(async () => {
  app = await buildApp();
  admin = { authorization: `Bearer ${await loginAs(app)}`, ...adminReauth };
  profileId = await fixtureProfileId('fixture:create-scope');

  blockId = (await prisma.functionalLocation.create({ data: { name: `cscope-block-${s}`, type: 'BLOCK' } })).id;
  areaId = (await prisma.functionalLocation.create({ data: { name: `cscope-area-${s}`, type: 'AREA', parentId: blockId } })).id;
  otherBlockId = (await prisma.functionalLocation.create({ data: { name: `cscope-other-${s}`, type: 'BLOCK' } })).id;

  const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
  roleId = role.id;
  rolePermsBefore = role.permissions as string[];
  await prisma.role.update({
    where: { id: roleId },
    data: { permissions: [...new Set([...rolePermsBefore, ...GRANTS])] },
  });
  invalidateRolePermsCache('OPERATOR');

  // The AWS shape exactly: a USER scope naming the Block (which expands to its Area).
  const user = await prisma.user.findUniqueOrThrow({ where: { username: 'RB0001' }, select: { id: true } });
  operatorUserId = user.id;
  const cfg = await prisma.userConfig.findUnique({ where: { userId: operatorUserId }, select: { instrumentScope: true } });
  userCfgBefore = { existed: Boolean(cfg), scope: cfg?.instrumentScope ?? null };
  await prisma.userConfig.upsert({
    where: { userId: operatorUserId },
    create: { userId: operatorUserId, instrumentScope: { locationIds: [blockId], instrumentIds: [] } },
    update: { instrumentScope: { locationIds: [blockId], instrumentIds: [] } },
  });

  operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}`, ...reauth };
});

afterAll(async () => {
  // Access-control rows FIRST, each step in its own `finally` so a failure in
  // one still runs the rest and still FAILS the suite: a suite must hand back
  // what it touched even while failing (the shared test DB has bitten twice).
  try {
    if (userCfgBefore.existed) {
      await prisma.userConfig.update({
        where: { userId: operatorUserId },
        data: { instrumentScope: (userCfgBefore.scope ?? Prisma.DbNull) as never },
      });
    } else if (operatorUserId) {
      await prisma.userConfig.deleteMany({ where: { userId: operatorUserId } });
    }
  } finally {
    try {
      if (roleId) {
        await prisma.role.update({ where: { id: roleId }, data: { permissions: rolePermsBefore as never } });
        invalidateRolePermsCache('OPERATOR');
      }
    } finally {
      try {
        admin = { authorization: `Bearer ${await loginAs(app)}`, ...adminReauth };
        const rows = await prisma.instrument.findMany({ where: { code: { in: codes } }, select: { id: true, isGateway: true } });
        // Children before their gateway.
        for (const r of [...rows].sort((a, b) => Number(a.isGateway) - Number(b.isGateway))) {
          await app.inject({ method: 'DELETE', url: `/api/instruments/${r.id}`, headers: admin });
        }
        await prisma.functionalLocation.deleteMany({ where: { id: { in: [areaId, blockId, otherBlockId].filter(Boolean) } } });
      } finally {
        await app.close();
      }
    }
  }
});

describe('POST /api/instruments as a caller with a limited instrument view', () => {
  it('refuses an instrument with NO location, and leaves no row and no audit record', async () => {
    const code = `CSCOPE-NONE-${s}`;
    const res = await create(operator, code);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('LOCATION_REQUIRED');
    expect(await prisma.instrument.count({ where: { code } })).toBe(0);
    expect(await createdAuditRows(code)).toBe(0);
  });

  it('refuses a location OUTSIDE the caller\'s view', async () => {
    const code = `CSCOPE-OUT-${s}`;
    const res = await create(operator, code, { functionalLocationId: otherBlockId });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('LOCATION_OUT_OF_SCOPE');
    expect(await prisma.instrument.count({ where: { code } })).toBe(0);
  });

  it('refuses a location that does not exist with a 400, not a foreign-key 500', async () => {
    const res = await create(operator, `CSCOPE-GONE-${s}`, { functionalLocationId: '00000000-0000-4000-8000-000000000000' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('LOCATION_NOT_FOUND');
  });

  it('registers into an Area of the granted Block — and the creator can open it and write its attributes', async () => {
    const code = `CSCOPE-IN-${s}`;
    const res = await create(operator, code, { functionalLocationId: areaId });
    expect(res.statusCode).toBe(201);
    const { id, functionalLocationId } = res.json() as { id: string; functionalLocationId: string };
    expect(functionalLocationId).toBe(areaId);

    // The two requests that 404'd on AWS, straight after the create.
    const detail = await app.inject({ method: 'GET', url: `/api/instruments/${id}`, headers: operator });
    expect(detail.statusCode).toBe(200);
    const attr = await app.inject({
      method: 'POST', url: `/api/instruments/${id}/attributes`, headers: operator,
      payload: { key: `Note-${s}`, value: 'placed' },
    });
    expect(attr.statusCode).toBeLessThan(300);

    // The location is on the §11 record of the registration.
    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'INSTRUMENT_CREATED', targetId: id },
      select: { afterValue: true },
    });
    expect(audit?.afterValue).toMatchObject({ functionalLocationId: areaId, functionalLocation: `cscope-area-${s}` });
  });
});

describe('POST /api/instruments as an unrestricted caller (control)', () => {
  it('still registers with no location at all', async () => {
    const res = await create(admin, `CSCOPE-ADMIN-${s}`);
    expect(res.statusCode).toBe(201);
    expect((res.json() as { functionalLocationId: string | null }).functionalLocationId).toBeNull();
  });
});

describe('POST /api/instruments/bulk as a caller with a limited instrument view', () => {
  it('refuses the WHOLE upload when no location is chosen — nothing is created', async () => {
    const code = `CSCOPE-BULK-NONE-${s}`;
    codes.push(code);
    const res = await app.inject({
      method: 'POST', url: '/api/instruments/bulk', headers: operator,
      payload: { csv: `Instrument ID\n${code}`, profileId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('LOCATION_REQUIRED');
    expect(await prisma.instrument.count({ where: { code } })).toBe(0);
  });

  it('creates every row in the chosen in-scope location, visible to the uploader', async () => {
    const code = `CSCOPE-BULK-IN-${s}`;
    codes.push(code);
    const res = await app.inject({
      method: 'POST', url: '/api/instruments/bulk', headers: operator,
      payload: { csv: `Instrument ID\n${code}`, profileId, functionalLocationId: areaId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { created: { id: string }[]; errors: unknown[] };
    expect(body.errors).toEqual([]);
    expect(body.created).toHaveLength(1);
    const detail = await app.inject({ method: 'GET', url: `/api/instruments/${body.created[0].id}`, headers: operator });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().functionalLocationId).toBe(areaId);
  });
});

describe('GET /api/functional-locations — where the caller may place an instrument', () => {
  type Node = { id: string; placeable: boolean; children: Node[] };
  const find = (tree: Node[], id: string) =>
    tree.find((n) => n.id === id) ?? tree.flatMap((n) => n.children).find((n) => n.id === id);

  it('flags the granted Block and its Area, not the other Block, and says placement is required', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/functional-locations', headers: operator });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Node[]; placementRequired: boolean };
    expect(body.placementRequired).toBe(true);
    expect(find(body.data, blockId)?.placeable).toBe(true);
    expect(find(body.data, areaId)?.placeable).toBe(true);
    expect(find(body.data, otherBlockId)?.placeable).toBe(false);
  });

  it('places anywhere, optionally, for an unrestricted caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/functional-locations', headers: admin });
    const body = res.json() as { data: Node[]; placementRequired: boolean };
    expect(body.placementRequired).toBe(false);
    expect(find(body.data, otherBlockId)?.placeable).toBe(true);
  });
});

describe('GET /api/instruments/:id names the gateway the caller cannot open', () => {
  it('carries the gateway code, and says whether the caller may open it', async () => {
    // A gateway in NO location — IOTGW01's shape on AWS — with a child in the
    // operator's Area.
    const gwCode = `CSCOPE-GW-${s}`;
    const gw = await create(admin, gwCode, { isGateway: true });
    expect(gw.statusCode).toBe(201);
    const gwId = (gw.json() as { id: string }).id;
    const child = await create(admin, `CSCOPE-CHILD-${s}`, { gatewayId: gwId, functionalLocationId: areaId });
    expect(child.statusCode).toBe(201);
    const childId = (child.json() as { id: string }).id;

    const asOperator = await app.inject({ method: 'GET', url: `/api/instruments/${childId}`, headers: operator });
    expect(asOperator.statusCode).toBe(200);
    expect(asOperator.json()).toMatchObject({ gatewayId: gwId, gatewayCode: gwCode, gatewayVisible: false });
    // The control that makes `gatewayVisible: false` mean something: following it would 404.
    const gwAsOperator = await app.inject({ method: 'GET', url: `/api/instruments/${gwId}`, headers: operator });
    expect(gwAsOperator.statusCode).toBe(404);

    const asAdmin = await app.inject({ method: 'GET', url: `/api/instruments/${childId}`, headers: admin });
    expect(asAdmin.json()).toMatchObject({ gatewayCode: gwCode, gatewayVisible: true });
  });

  it('reports no gateway for an instrument that has none', async () => {
    const res = await create(admin, `CSCOPE-SOLO-${s}`, { functionalLocationId: areaId });
    const id = (res.json() as { id: string }).id;
    const detail = await app.inject({ method: 'GET', url: `/api/instruments/${id}`, headers: operator });
    expect(detail.json()).toMatchObject({ gatewayCode: null, gatewayVisible: false });
  });
});
