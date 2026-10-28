/**
 * A bulk upload naming an Instrument ID that already exists UPDATES it
 * (2026-10-28, operator: "when user doing bulk upload with already exiting
 * instrument ids and like attributes values changed and uploaded then already
 * existed error was coming, there i need like what values are changed those
 * data should update"). End to end over the real routes and database:
 * `POST /bulk/preview` says what would change and writes nothing; `POST /bulk`
 * plans the file AGAIN and writes exactly those changes, one
 * INSTRUMENT_ATTRIBUTE_SET per value, with ONE remark when a recorded value is
 * overwritten.
 *
 * The scope and role cases go through the seeded OPERATOR: SUPER_ADMIN
 * short-circuits both, so an admin-driven version would pass against a route
 * that checked neither.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildApp, loginAs, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

let app: FastifyInstance;
let admin: Record<string, string>;
let profileId = '';
let otherProfileId = '';
const s = Date.now();
const codes: string[] = [];
// `t_hl`, not `High Temperature Limit`: that key was retired from every profile
// (2026-09-16) and `limit-attribute-retirement.e2e` checks that no profile asks for it.
const LIMIT = 't_hl';
const REMARK = 'Limits revised per SOP-114 rev 3';

type Change = { key: string; column: string; from: string | null; to: string };
type Updated = { id: string; code: string; row: number; changes: Change[] };

async function register(code: string, attributes: Record<string, string> = {}, profile = profileId) {
  codes.push(code);
  const res = await app.inject({ method: 'POST', url: '/api/instruments', headers: admin, payload: { name: code, code, profileId: profile } });
  expect(res.statusCode).toBe(201);
  const id = (res.json() as { id: string }).id;
  for (const [key, value] of Object.entries(attributes)) {
    const put = await app.inject({ method: 'POST', url: `/api/instruments/${id}/attributes`, headers: admin, payload: { key, value } });
    expect(put.statusCode).toBe(201);
  }
  return id;
}

async function attrs(id: string) {
  const rows = await prisma.instrumentAttribute.findMany({ where: { instrumentId: id }, select: { key: true, value: true } });
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const attributeAudits = (id: string) => prisma.auditTrail.findMany({
  where: { action: 'INSTRUMENT_ATTRIBUTE_SET', targetId: id },
  select: { beforeValue: true, afterValue: true, reason: true },
  orderBy: { timestamp: 'asc' },
});

const upload = (csv: string, extra: Record<string, unknown> = {}, headers = admin) =>
  app.inject({ method: 'POST', url: '/api/instruments/bulk', headers, payload: { csv, profileId, ...extra } });
const preview = (csv: string, extra: Record<string, unknown> = {}, headers = admin) =>
  app.inject({ method: 'POST', url: '/api/instruments/bulk/preview', headers, payload: { csv, profileId, ...extra } });

beforeAll(async () => {
  app = await buildApp();
  admin = { authorization: `Bearer ${await loginAs(app)}` };
  profileId = await fixtureProfileId('fixture:bulk-update');
  otherProfileId = await fixtureProfileId('fixture:bulk-update-other');
  await prisma.instrumentProfile.update({ where: { id: profileId }, data: { attributeKeys: `Location\n${LIMIT}\nBuilding` } });
});

afterAll(async () => {
  try {
    await prisma.roleConfig.updateMany({ where: { role: 'SUPER_ADMIN' }, data: { attributeAccess: Prisma.DbNull } });
  } finally {
    try {
      admin = { authorization: `Bearer ${await loginAs(app)}` };
      const rows = await prisma.instrument.findMany({ where: { code: { in: codes } }, select: { id: true } });
      for (const r of rows) await app.inject({ method: 'DELETE', url: `/api/instruments/${r.id}`, headers: admin });
    } finally {
      await app.close();
    }
  }
});

describe('POST /api/instruments/bulk/preview + /bulk — an existing Instrument ID is updated', () => {
  let a = '';
  let fresh = '';

  beforeAll(async () => {
    a = await register(`BUP-A-${s}`, { Location: 'Room A', [LIMIT]: '25' });
    fresh = `BUP-NEW-${s}`;
    codes.push(fresh);
  });

  const file = () => `Instrument ID,Location,${LIMIT}\nBUP-A-${s},Room A,27\n${fresh},Room N,`;

  it('the preview names every change and the value it replaces, and writes NOTHING', async () => {
    const before = (await attributeAudits(a)).length;
    const res = await preview(file());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.create).toEqual([{ row: 3, code: fresh }]);
    expect(body.update).toEqual([{
      id: a, code: `BUP-A-${s}`, row: 2,
      changes: [{ key: LIMIT, column: LIMIT, from: '25', to: '27' }],
    }]);
    expect(body.unchanged).toEqual([]);
    expect(body.errors).toEqual([]);
    expect(body.remarkRequired).toBe(true);
    expect(await prisma.instrument.count({ where: { code: fresh } })).toBe(0);
    expect((await attrs(a))[LIMIT]).toBe('25');
    expect((await attributeAudits(a)).length).toBe(before);
  });

  it('without a remark the upload is refused and NOTHING is written — not even the new row', async () => {
    const res = await upload(file());
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('REMARK_REQUIRED');
    expect(await prisma.instrument.count({ where: { code: fresh } })).toBe(0);
    expect((await attrs(a))[LIMIT]).toBe('25');
  });

  it('with a remark: the new row is created with a token, the existing one gets the changed value only', async () => {
    const before = (await attributeAudits(a)).length;
    const res = await upload(file(), { reason: REMARK });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.errors).toEqual([]);
    expect(body.created.map((c: { code: string }) => c.code)).toEqual([fresh]);
    expect(typeof body.created[0].token).toBe('string');
    expect(body.updated).toEqual([{
      id: a, code: `BUP-A-${s}`, row: 2,
      changes: [{ key: LIMIT, column: LIMIT, from: '25', to: '27' }],
    }]);
    expect(body.updated[0]).not.toHaveProperty('token');
    expect(await attrs(a)).toEqual({ Location: 'Room A', [LIMIT]: '27' });

    // ONE audit row — the limit. The matching Location wrote nothing.
    const audits = (await attributeAudits(a)).slice(before);
    expect(audits).toEqual([{
      beforeValue: { code: `BUP-A-${s}`, attribute: LIMIT, value: '25' },
      afterValue: { code: `BUP-A-${s}`, attribute: LIMIT, value: '27' },
      reason: REMARK,
    }]);
  });

  it('the same file again changes nothing: both rows unchanged, no audit row, no error', async () => {
    const before = (await attributeAudits(a)).length;
    const res = await upload(file(), { reason: REMARK });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.errors).toEqual([]);
    expect(body.created).toEqual([]);
    expect(body.updated).toEqual([]);
    expect(body.unchanged).toEqual([{ row: 2, code: `BUP-A-${s}` }, { row: 3, code: fresh }]);
    expect((await attributeAudits(a)).length).toBe(before);
  });

  it('a BLANK cell keeps the stored value', async () => {
    const res = await upload(`Instrument ID,Location,${LIMIT}\nBUP-A-${s},,28`, { reason: REMARK });
    expect(res.statusCode).toBe(200);
    expect(await attrs(a)).toEqual({ Location: 'Room A', [LIMIT]: '28' });
  });

  it('the ID matches ignoring case — no second instrument, the stored spelling answers', async () => {
    const res = await upload(`Instrument ID,Location\nbup-a-${s},Room B`, { reason: REMARK });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated[0]).toMatchObject({ id: a, code: `BUP-A-${s}` });
    expect(await prisma.instrument.count({ where: { code: { equals: `BUP-A-${s}`, mode: 'insensitive' } } })).toBe(1);
    expect((await attrs(a)).Location).toBe('Room B');
  });

  it('a stored key that differs only by case is updated in place — never a second attribute', async () => {
    const b = await register(`BUP-B-${s}`, { location: 'Room A' });
    const res = await upload(`Instrument ID,Location\nBUP-B-${s},Room Z`, { reason: REMARK });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated[0].changes).toEqual([{ key: 'location', column: 'Location', from: 'Room A', to: 'Room Z' }]);
    expect(await attrs(b)).toEqual({ location: 'Room Z' });
  });

  it('a key the instrument does not carry yet is a FIRST FILL: no remark asked, none recorded', async () => {
    const c = await register(`BUP-C-${s}`, { Location: 'Room A' });
    const p = await preview(`Instrument ID,Building\nBUP-C-${s},CWH`);
    expect(p.json().remarkRequired).toBe(false);
    expect(p.json().update[0].changes).toEqual([{ key: 'Building', column: 'Building', from: null, to: 'CWH' }]);
    const res = await upload(`Instrument ID,Building\nBUP-C-${s},CWH`);
    expect(res.statusCode).toBe(200);
    expect(res.json().updated[0].changes[0].from).toBeNull();
    const audits = await attributeAudits(c);
    expect(audits.at(-1)).toEqual({ beforeValue: null, afterValue: { code: `BUP-C-${s}`, attribute: 'Building', value: 'CWH' }, reason: null });
  });

  it('an instrument in ANOTHER profile is refused on its row and left alone', async () => {
    const d = await register(`BUP-D-${s}`, { Location: 'Room A' }, otherProfileId);
    const res = await upload(`Instrument ID,Location\nBUP-D-${s},Room Q`, { reason: REMARK });
    expect(res.statusCode).toBe(200);
    expect(res.json().errors).toEqual([{
      row: 2, column: 'Instrument ID',
      message: `Instrument ID "BUP-D-${s}" belongs to profile "fixture:bulk-update-other". Choose that profile to update it.`,
    }]);
    expect(await attrs(d)).toEqual({ Location: 'Room A' });
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id: d } })).profileId).toBe(otherProfileId);
  });

  // 2026-10-28, operator: "every time when uploading its showing instrument id
  // error was coming". The template's sample row named a REAL instrument
  // (CWH/RDU/001-00), and Excel saves a cleared row as bare commas.
  it('a row naming an existing ID with every cell blank, and rows of bare commas, are no error', async () => {
    const res = await upload(`Instrument ID,Location,${LIMIT}\nBUP-A-${s},,\n,,\n,,`);
    expect(res.statusCode).toBe(200);
    expect(res.json().errors).toEqual([]);
    expect(res.json().unchanged).toEqual([{ row: 2, code: `BUP-A-${s}` }]);
  });
});

describe('the attribute gate and its re-auth apply to every changed cell', () => {
  const setAccess = (value: unknown) => prisma.roleConfig.upsert({
    where: { role: 'SUPER_ADMIN' },
    create: { role: 'SUPER_ADMIN', attributeAccess: value as never },
    update: { attributeAccess: value as never },
  });
  afterEach(async () => {
    await prisma.roleConfig.updateMany({ where: { role: 'SUPER_ADMIN' }, data: { attributeAccess: Prisma.DbNull } });
  });

  it('a key the role may not change fails the WHOLE row, named by its cell; the allowed cell is not written either', async () => {
    const e = await register(`BUP-E-${s}`, { Location: 'Room A', [LIMIT]: '25' });
    await setAccess({ mode: 'SELECTED', keys: ['Location'], requireReauth: false });
    const res = await upload(`Instrument ID,Location,${LIMIT}\nBUP-E-${s},Room B,30`, { reason: REMARK });
    expect(res.statusCode).toBe(200);
    expect(res.json().errors).toEqual([{ row: 2, column: LIMIT, message: `You may view "${LIMIT}" but not change it.` }]);
    expect(res.json().updated).toEqual([]);
    expect(await attrs(e)).toEqual({ Location: 'Room A', [LIMIT]: '25' });
  });

  it('requireReauth: an update is refused without the password and applied with it', async () => {
    const f = await register(`BUP-F-${s}`, { Location: 'Room A' });
    await setAccess({ mode: 'ALL_EDIT', keys: [], requireReauth: true });
    const csv = `Instrument ID,Location\nBUP-F-${s},Room B`;
    const refused = await upload(csv, { reason: REMARK });
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error).toBe('REAUTH_REQUIRED');
    expect((await attrs(f)).Location).toBe('Room A');
    const ok = await upload(csv, { reason: REMARK, _currentPassword: ADMIN_PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect((await attrs(f)).Location).toBe('Room B');
  });
});

describe('a caller with a limited view, and without Instrument Update', () => {
  let operator: Record<string, string>;
  let roleId = '';
  /** The OPERATOR's permissions as this file found them — restored verbatim. */
  let permsAsFound: string[] = [];
  /** Those, less Instrument Update, which the shared database's OPERATOR may hold. */
  let base: string[] = [];
  let operatorUserId = '';
  let userCfgBefore: { existed: boolean; scope: unknown } = { existed: false, scope: null };
  let blockId = '';
  let inScope = '';
  let outOfScope = '';
  const reauth = { 'x-reauth-password': 'Test@1234' };

  const grant = async (perms: string[]) => {
    await prisma.role.update({ where: { id: roleId }, data: { permissions: [...new Set([...base, ...perms])] } });
    invalidateRolePermsCache('OPERATOR');
  };

  beforeAll(async () => {
    blockId = (await prisma.functionalLocation.create({ data: { name: `bup-block-${s}`, type: 'BLOCK' } })).id;
    inScope = await register(`BUP-IN-${s}`, { Location: 'Room A' });
    await prisma.instrument.update({ where: { id: inScope }, data: { functionalLocationId: blockId } });
    outOfScope = await register(`BUP-OUT-${s}`, { Location: 'Room A' });

    const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
    roleId = role.id;
    permsAsFound = role.permissions as string[];
    base = permsAsFound.filter((p) => p !== 'INSTRUMENT_UPDATE');
    await grant(['INSTRUMENT_READ', 'INSTRUMENT_CREATE', 'FUNCTIONAL_LOCATION_READ']);
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
    try {
      if (userCfgBefore.existed) {
        await prisma.userConfig.update({ where: { userId: operatorUserId }, data: { instrumentScope: (userCfgBefore.scope ?? Prisma.DbNull) as never } });
      } else if (operatorUserId) {
        await prisma.userConfig.deleteMany({ where: { userId: operatorUserId } });
      }
    } finally {
      try {
        if (roleId) {
          await prisma.role.update({ where: { id: roleId }, data: { permissions: permsAsFound as never } });
          invalidateRolePermsCache('OPERATOR');
        }
      } finally {
        await prisma.instrument.updateMany({ where: { id: inScope }, data: { functionalLocationId: null } });
        await prisma.functionalLocation.deleteMany({ where: { id: blockId } });
      }
    }
  });

  it('an instrument OUTSIDE the view is the old "already exists" error, and is not touched', async () => {
    const res = await upload(`Instrument ID,Location\nBUP-OUT-${s},Room Q`, { reason: REMARK, functionalLocationId: blockId }, operator);
    expect(res.statusCode).toBe(200);
    expect(res.json().errors).toEqual([{ row: 2, column: 'Instrument ID', message: `Instrument ID "BUP-OUT-${s}" already exists` }]);
    expect(await attrs(outOfScope)).toEqual({ Location: 'Room A' });
    const p = await preview(`Instrument ID,Location\nBUP-OUT-${s},Room Q`, { functionalLocationId: blockId }, operator);
    expect(p.json().update).toEqual([]);
    expect(JSON.stringify(p.json())).not.toContain('Room A');
  });

  it('without Instrument Update a change is refused on its row; an unchanged row is no error', async () => {
    const res = await upload(`Instrument ID,Location\nBUP-IN-${s},Room Q`, { reason: REMARK, functionalLocationId: blockId }, operator);
    expect(res.statusCode).toBe(200);
    expect(res.json().errors[0]).toMatchObject({ row: 2, column: 'Instrument ID' });
    expect(res.json().errors[0].message).toMatch(/may not change instruments/);
    expect(await attrs(inScope)).toEqual({ Location: 'Room A' });
    const same = await upload(`Instrument ID,Location\nBUP-IN-${s},Room A`, { functionalLocationId: blockId }, operator);
    expect(same.json().errors).toEqual([]);
    expect(same.json().unchanged).toEqual([{ row: 2, code: `BUP-IN-${s}` }]);
  });

  it('with Instrument Update the same change in view is applied (positive control)', async () => {
    await grant(['INSTRUMENT_READ', 'INSTRUMENT_CREATE', 'INSTRUMENT_UPDATE', 'FUNCTIONAL_LOCATION_READ']);
    const res = await upload(`Instrument ID,Location\nBUP-IN-${s},Room Q`, { reason: REMARK, functionalLocationId: blockId }, operator);
    expect(res.statusCode).toBe(200);
    expect(res.json().errors).toEqual([]);
    expect(await attrs(inScope)).toEqual({ Location: 'Room Q' });
  });
});
