import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * "Edit Settings" is its own permission, INSTRUMENT_ATTRIBUTE_UPDATE (2026-10-30).
 *
 * It granted INSTRUMENT_UPDATE until then — the permission that also renames an
 * instrument, relinks its gateway, disables it and hands out its token. The OQ
 * walkthrough found a Supervisor, whose role is "NMT / NLT switches and limits
 * only", able to change the Instrument ID on the Settings page and to edit the
 * instrument by URL. Now a role with Edit Settings changes ATTRIBUTES only (and
 * only those its attribute rule allows); the instrument itself stays on
 * INSTRUMENT_UPDATE, which still implies the attribute permission so no role
 * holding Edit Instruments lost anything.
 */
const S = Date.now().toString(36).toUpperCase();
const ATTR_ROLE = `OQ_ATTR_${S}`;
const UPD_ROLE = `OQ_UPD_${S}`;
const PW = 'Attr1b@Passw0rd';
const REMARK = 'Corrected against the calibration certificate';

let app: FastifyInstance;
let sa: Record<string, string>;
let attrOnly: Record<string, string>;
let updOnly: Record<string, string>;
let inst: { id: string; code: string };
const users: string[] = [];

async function makeUser(username: string, role: string) {
  const u = await prisma.user.create({
    data: {
      username, fullName: username, role, status: 'ENABLED', passwordHash: await hashPassword(PW),
      passwordChangedAt: new Date(), isTemporaryPassword: false, forcePasswordChange: false,
    },
  });
  users.push(u.id);
  return u;
}

beforeAll(async () => {
  app = await buildApp();
  sa = { authorization: `Bearer ${await loginAs(app)}` };
  await prisma.role.create({
    data: { name: ATTR_ROLE, displayName: ATTR_ROLE, hierarchyLevel: 2, permissions: ['INSTRUMENT_READ', 'INSTRUMENT_ATTRIBUTE_UPDATE'] },
  });
  await prisma.role.create({
    data: { name: UPD_ROLE, displayName: UPD_ROLE, hierarchyLevel: 2, permissions: ['INSTRUMENT_READ', 'INSTRUMENT_UPDATE'] },
  });
  // The Supervisor's shape: one limit editable, everything else view-only.
  await prisma.roleConfig.create({
    data: { role: ATTR_ROLE, attributeAccess: { mode: 'SELECTED', keys: ['t_hl'], requireReauth: false } },
  });
  invalidateRolePermsCache();
  await makeUser(`oq_attr_${S}`.toLowerCase(), ATTR_ROLE);
  await makeUser(`oq_upd_${S}`.toLowerCase(), UPD_ROLE);
  attrOnly = { authorization: `Bearer ${await loginAs(app, `oq_attr_${S}`.toLowerCase(), PW)}` };
  updOnly = { authorization: `Bearer ${await loginAs(app, `oq_upd_${S}`.toLowerCase(), PW)}` };

  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: sa,
    payload: { name: 'attr-perm', code: `ATTRPERM-${S}`, profileId: await fixtureProfileId('fixture:instrument-attributes') },
  });
  expect(res.statusCode).toBe(201);
  inst = res.json();
  for (const [key, value] of [['t_hl', '27'], ['Location', 'Room 1']]) {
    const r = await app.inject({
      method: 'POST', url: `/api/instruments/${inst.id}/attributes`, headers: sa, payload: { key, value, reason: REMARK },
    });
    expect(r.statusCode).toBe(201);
  }
});

afterAll(async () => {
  try { if (inst) await app.inject({ method: 'DELETE', url: `/api/instruments/${inst.id}`, headers: sa }); } catch { /* best effort */ }
  try {
    await prisma.session.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.roleConfig.deleteMany({ where: { role: { in: [ATTR_ROLE, UPD_ROLE] } } });
    await prisma.role.deleteMany({ where: { name: { in: [ATTR_ROLE, UPD_ROLE] } } });
    invalidateRolePermsCache();
  } catch { /* best effort */ }
  await app.close();
});

const editAttr = (key: string, value: string, headers: Record<string, string>) =>
  app.inject({
    method: 'PUT', url: `/api/instruments/${inst.id}/attributes/${encodeURIComponent(key)}`,
    headers, payload: { value, reason: REMARK },
  });

describe('Edit Settings (INSTRUMENT_ATTRIBUTE_UPDATE) changes attributes, never the instrument', () => {
  it('changes an attribute its rule allows', async () => {
    const res = await editAttr('t_hl', '26', attrOnly);
    expect(res.statusCode).toBe(200);
  });

  it('is refused an attribute its rule withholds', async () => {
    const res = await editAttr('Location', 'Room 2', attrOnly);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ATTRIBUTE_NOT_EDITABLE');
  });

  it('is refused the Instrument ID', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/instruments/${inst.id}`, headers: attrOnly, payload: { code: `${inst.code}-X` },
    });
    expect(res.statusCode).toBe(403);
    const row = await prisma.instrument.findUniqueOrThrow({ where: { id: inst.id }, select: { code: true } });
    expect(row.code).toBe(inst.code);
  });

  it("is refused the instrument's token", async () => {
    const res = await app.inject({ method: 'GET', url: `/api/instruments/${inst.id}/token`, headers: attrOnly });
    expect(res.statusCode).toBe(403);
  });
});

describe('Edit Instruments (INSTRUMENT_UPDATE) still implies attribute edits', () => {
  it('a role holding only INSTRUMENT_UPDATE still changes attributes — nobody was frozen out', async () => {
    const res = await editAttr('Location', 'Room 3', updOnly);
    expect(res.statusCode).toBe(200);
  });

  it('the Attribute Edit Access tab counts both roles as able to edit', async () => {
    const roles = (await app.inject({ method: 'GET', url: '/api/roles/attribute-access', headers: sa })).json().roles as
      { role: string; canUpdateInstruments: boolean }[];
    expect(roles.find((r) => r.role === ATTR_ROLE)?.canUpdateInstruments).toBe(true);
    expect(roles.find((r) => r.role === UPD_ROLE)?.canUpdateInstruments).toBe(true);
  });
});
