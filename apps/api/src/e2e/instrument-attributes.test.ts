import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * Free-form per-instrument attributes.
 *
 * These are a child TABLE, not a JSONB blob on the instrument, and the tests
 * below are written around the two things that buys:
 *
 *   1. `@@unique([instrumentId, key])` — "set this attribute" is idempotent.
 *      A JSONB merge would be too, but a duplicate-row bug in a child table is
 *      the kind that only shows up in production, so it is asserted here.
 *   2. One audit row per key, naming the key and both values. An attribute may
 *      hold a calibration due date or a validation reference — a §11 record, not
 *      decoration — so "who changed the calibration date, from what, to what"
 *      has to be answerable from the trail without diffing two JSON blobs.
 */

let app: FastifyInstance;
let auth: Record<string, string>;
const created: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});

afterAll(async () => {
  for (const id of created) {
    await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  }
  await app.close();
});

async function newInstrument(prefix: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: {
      name: prefix, code: `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      profileId: await fixtureProfileId('fixture:instrument-attributes'),
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  created.push(body.id);
  return body as { id: string; code: string };
}

const list = (id: string, headers = auth) =>
  app.inject({ method: 'GET', url: `/api/instruments/${id}/attributes`, headers });

/**
 * A remark is MANDATORY on any write that changes or removes a recorded value
 * (2026-08-19). Not on a first fill — that is registration. These helpers send a
 * usable one by default so the tests below stay about the behaviour they name;
 * the remark rules have their own describe block at the bottom.
 */
const REMARK = 'Corrected against the calibration certificate';

const set = (id: string, key: string, value: string, headers = auth, reason = REMARK) =>
  app.inject({
    method: 'POST', url: `/api/instruments/${id}/attributes`,
    headers, payload: { key, value, reason },
  });

const edit = (id: string, key: string, value: string, headers = auth, reason: string | null = REMARK) =>
  app.inject({
    method: 'PUT', url: `/api/instruments/${id}/attributes/${encodeURIComponent(key)}`,
    headers, payload: reason === null ? { value } : { value, reason },
  });

const remove = (id: string, key: string, headers = auth, reason: string | null = REMARK) =>
  app.inject({
    method: 'DELETE', url: `/api/instruments/${id}/attributes/${encodeURIComponent(key)}`,
    headers, payload: reason === null ? {} : { reason },
  });

const auditRows = (instrumentId: string, action: string) =>
  prisma.auditTrail.findMany({ where: { action, targetId: instrumentId }, orderBy: { timestamp: 'asc' } });

describe('Instrument attributes — round trip', () => {
  it('starts empty, then lists what was set', async () => {
    const inst = await newInstrument('ATTR');
    expect((await list(inst.id)).json().data).toEqual([]);

    expect((await set(inst.id, 'Calibration Due', '2027-01-31')).statusCode).toBe(201);
    expect((await set(inst.id, 'Asset Tag', 'AT-9931')).statusCode).toBe(201);

    const data = (await list(inst.id)).json().data;
    expect(data).toHaveLength(2);
    // Sorted by key so the panel is stable between renders.
    expect(data.map((a: { key: string }) => a.key)).toEqual(['Asset Tag', 'Calibration Due']);
    expect(data.find((a: { key: string }) => a.key === 'Calibration Due').value).toBe('2027-01-31');
  });

  it('setting the same key twice UPDATES rather than duplicating', async () => {
    const inst = await newInstrument('ATTRUP');
    await set(inst.id, 'Calibration Due', '2027-01-31');
    const second = await set(inst.id, 'Calibration Due', '2028-06-30');
    // 200, not 201: the second call changed a record, it did not create one.
    expect(second.statusCode).toBe(200);

    const data = (await list(inst.id)).json().data;
    expect(data).toHaveLength(1);
    expect(data[0].value).toBe('2028-06-30');

    // And at the storage layer, which is what the unique constraint protects.
    expect(await prisma.instrumentAttribute.count({
      where: { instrumentId: inst.id, key: 'Calibration Due' },
    })).toBe(1);
  });

  it('PUT edits an existing attribute and 404s for one that does not exist', async () => {
    const inst = await newInstrument('ATTRPUT');
    await set(inst.id, 'Firmware', '1.0.4');

    expect((await edit(inst.id, 'Firmware', '1.1.0')).statusCode).toBe(200);
    expect((await list(inst.id)).json().data[0].value).toBe('1.1.0');

    // PUT does NOT create. POST is the upsert; a mistyped key on an edit must
    // not silently grow a second attribute nobody asked for.
    const missing = await edit(inst.id, 'Firmwrae', '1.1.0');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('ATTRIBUTE_NOT_FOUND');
    expect((await list(inst.id)).json().data).toHaveLength(1);
  });

  it('DELETE removes exactly the named key, and 404s the second time', async () => {
    const inst = await newInstrument('ATTRDEL');
    await set(inst.id, 'Keep', 'yes');
    await set(inst.id, 'Drop', 'no');

    expect((await remove(inst.id, 'Drop')).statusCode).toBe(200);
    expect((await list(inst.id)).json().data.map((a: { key: string }) => a.key)).toEqual(['Keep']);

    const again = await remove(inst.id, 'Drop');
    expect(again.statusCode).toBe(404);
    expect(again.json().error).toBe('ATTRIBUTE_NOT_FOUND');
  });

  it('keys are per-instrument: the same key on two instruments is two attributes', async () => {
    const a = await newInstrument('ATTRA');
    const b = await newInstrument('ATTRB');
    expect((await set(a.id, 'Room', 'CR-1')).statusCode).toBe(201);
    expect((await set(b.id, 'Room', 'CR-2')).statusCode).toBe(201);
    expect((await list(a.id)).json().data[0].value).toBe('CR-1');
    expect((await list(b.id)).json().data[0].value).toBe('CR-2');
  });

  it('404s on every verb for an instrument that does not exist', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect((await list(ghost)).statusCode).toBe(404);
    expect((await set(ghost, 'k', 'v')).statusCode).toBe(404);
    expect((await edit(ghost, 'k', 'v')).statusCode).toBe(404);
    expect((await remove(ghost, 'k')).statusCode).toBe(404);
  });

  it('rejects a missing remark BEFORE it says whether the instrument exists', async () => {
    // Body-schema validation runs ahead of the handler, so a write with no remark
    // is a 400 whatever id it names. That ordering is the right way round: it
    // answers the malformed request without confirming what does or does not
    // exist.
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect((await edit(ghost, 'k', 'v', auth, null)).statusCode).toBe(400);
    expect((await remove(ghost, 'k', auth, null)).statusCode).toBe(400);
  });
});

describe('Instrument attributes — validation', () => {
  it('refuses a key that is empty after trimming', async () => {
    const inst = await newInstrument('ATTRWS');
    // Whitespace-only keys are how a table quietly fills with rows nobody can
    // find, edit or delete — the URL for such a key is unusable.
    for (const key of ['', '   ', '\t', '\n  \t ']) {
      const res = await set(inst.id, key, 'x');
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('VALIDATION_ERROR');
    }
    expect((await list(inst.id)).json().data).toEqual([]);
  });

  it('trims the key, so " Room " and "Room" are the SAME attribute', async () => {
    const inst = await newInstrument('ATTRTRIM');
    expect((await set(inst.id, ' Room ', 'CR-1')).statusCode).toBe(201);
    const again = await set(inst.id, 'Room', 'CR-2');
    expect(again.statusCode).toBe(200);

    const data = (await list(inst.id)).json().data;
    expect(data).toHaveLength(1);
    expect(data[0].key).toBe('Room');
    expect(data[0].value).toBe('CR-2');
  });

  it('caps the key at 64 and the value at 1000 characters', async () => {
    const inst = await newInstrument('ATTRCAP');
    expect((await set(inst.id, 'k'.repeat(65), 'v')).statusCode).toBe(400);
    expect((await set(inst.id, 'k'.repeat(64), 'v')).statusCode).toBe(201);
    expect((await set(inst.id, 'long', 'v'.repeat(1001))).statusCode).toBe(400);
    expect((await set(inst.id, 'long', 'v'.repeat(1000))).statusCode).toBe(201);
    expect((await edit(inst.id, 'long', 'v'.repeat(1001))).statusCode).toBe(400);
  });

  it('sanitises markup out of both key and value, like every other text field here', async () => {
    const inst = await newInstrument('ATTRSAN');
    const res = await set(inst.id, '<b>Vendor</b>', '<script>alert(1)</script>Acme');
    expect(res.statusCode).toBe(201);
    const data = (await list(inst.id)).json().data;
    expect(data[0].key).not.toContain('<');
    expect(data[0].value).not.toContain('<script');
  });

  it('accepts an empty value — "recorded but not yet known" is a real state', async () => {
    const inst = await newInstrument('ATTREMPTY');
    expect((await set(inst.id, 'Serial Sticker', '')).statusCode).toBe(201);
    expect((await list(inst.id)).json().data[0].value).toBe('');
  });
});

describe('Instrument attributes — audit trail', () => {
  it('writes ONE row per create, naming the key and the new value', async () => {
    const inst = await newInstrument('ATTRAUD');
    await set(inst.id, 'Calibration Due', '2027-01-31');

    const rows = await auditRows(inst.id, 'INSTRUMENT_ATTRIBUTE_SET');
    expect(rows).toHaveLength(1);
    expect(rows[0].afterValue).toMatchObject({
      code: inst.code, attribute: 'Calibration Due', value: '2027-01-31',
    });
    // A create has no "before" — it must not fake one.
    expect(rows[0].beforeValue).toBeNull();
  });

  it('an UPDATE row carries both the old and the new value', async () => {
    const inst = await newInstrument('ATTRAUD2');
    await set(inst.id, 'Calibration Due', '2027-01-31');
    await set(inst.id, 'Calibration Due', '2028-06-30');

    const rows = await auditRows(inst.id, 'INSTRUMENT_ATTRIBUTE_SET');
    expect(rows).toHaveLength(2);
    expect(rows[1].beforeValue).toMatchObject({ attribute: 'Calibration Due', value: '2027-01-31' });
    expect(rows[1].afterValue).toMatchObject({ attribute: 'Calibration Due', value: '2028-06-30' });
  });

  it('a PUT edit is audited the same as a POST update', async () => {
    const inst = await newInstrument('ATTRAUD3');
    await set(inst.id, 'Firmware', '1.0.4');
    await edit(inst.id, 'Firmware', '1.1.0');

    const rows = await auditRows(inst.id, 'INSTRUMENT_ATTRIBUTE_SET');
    expect(rows).toHaveLength(2);
    expect(rows[1].beforeValue).toMatchObject({ attribute: 'Firmware', value: '1.0.4' });
    expect(rows[1].afterValue).toMatchObject({ attribute: 'Firmware', value: '1.1.0' });
  });

  it('a delete writes ONE _REMOVED row carrying the value that was lost', async () => {
    const inst = await newInstrument('ATTRAUD4');
    await set(inst.id, 'Asset Tag', 'AT-9931');
    await remove(inst.id, 'Asset Tag');

    const rows = await auditRows(inst.id, 'INSTRUMENT_ATTRIBUTE_REMOVED');
    expect(rows).toHaveLength(1);
    expect(rows[0].beforeValue).toMatchObject({
      code: inst.code, attribute: 'Asset Tag', value: 'AT-9931',
    });
    expect(rows[0].afterValue).toBeNull();
  });

  it('a REFUSED write leaves no audit row', async () => {
    const inst = await newInstrument('ATTRAUD5');
    await set(inst.id, '   ', 'x');
    await edit(inst.id, 'never-existed', 'x');
    await remove(inst.id, 'never-existed');
    expect(await auditRows(inst.id, 'INSTRUMENT_ATTRIBUTE_SET')).toHaveLength(0);
    expect(await auditRows(inst.id, 'INSTRUMENT_ATTRIBUTE_REMOVED')).toHaveLength(0);
  });

  it('the audit row survives the instrument it describes — that is the point of §11', async () => {
    const inst = await newInstrument('ATTRAUD6');
    await set(inst.id, 'Vendor', 'Acme');
    await app.inject({ method: 'DELETE', url: `/api/instruments/${inst.id}`, headers: auth });

    const rows = await auditRows(inst.id, 'INSTRUMENT_ATTRIBUTE_SET');
    expect(rows).toHaveLength(1);
    // The attribute row itself is gone with the instrument (see the cascade
    // test); the audit record of it is not.
    expect(await prisma.instrumentAttribute.count({ where: { instrumentId: inst.id } })).toBe(0);
  });
});

describe('Instrument attributes — cascade and permissions', () => {
  it('deleting the instrument takes its attributes with it', async () => {
    const inst = await newInstrument('ATTRCASC');
    await set(inst.id, 'a', '1');
    await set(inst.id, 'b', '2');
    expect(await prisma.instrumentAttribute.count({ where: { instrumentId: inst.id } })).toBe(2);

    const del = await app.inject({ method: 'DELETE', url: `/api/instruments/${inst.id}`, headers: auth });
    expect(del.statusCode).toBe(200);
    // ON DELETE CASCADE, not application cleanup: an orphaned attribute row
    // pointing at a deleted instrument would be unreachable forever.
    expect(await prisma.instrumentAttribute.count({ where: { instrumentId: inst.id } })).toBe(0);
  });

  it('a role holding INSTRUMENT_READ alone may LIST but not write or delete', async () => {
    const inst = await newInstrument('ATTRPERM');
    await set(inst.id, 'Vendor', 'Acme');

    // `admin` is SUPER_ADMIN and bypasses requirePermission entirely, so every
    // other test in this file would pass with a misspelt permission string. The
    // seeded OPERATOR holds no INSTRUMENT_* permission at all, which would only
    // prove "403 for everything" — so it is granted INSTRUMENT_READ *and nothing
    // else* here. That is what discriminates: the list must open, and the three
    // writes must still refuse. Grant INSTRUMENT_UPDATE to the read route by
    // mistake and the first assertion still passes; drop INSTRUMENT_READ from
    // the write routes' requirement and the next three fail.
    const before = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
    await prisma.role.update({
      where: { id: before.id },
      data: { permissions: [...(before.permissions as string[]), 'INSTRUMENT_READ'] },
    });
    invalidateRolePermsCache('OPERATOR');
    try {
      const operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };

      expect((await list(inst.id, operator)).statusCode).toBe(200);
      expect((await set(inst.id, 'Vendor', 'Other', operator)).statusCode).toBe(403);
      expect((await edit(inst.id, 'Vendor', 'Other', operator)).statusCode).toBe(403);
      expect((await remove(inst.id, 'Vendor', operator)).statusCode).toBe(403);
    } finally {
      await prisma.role.update({
        where: { id: before.id }, data: { permissions: before.permissions as never },
      });
      invalidateRolePermsCache('OPERATOR');
      auth = { authorization: `Bearer ${await loginAs(app)}` };
    }

    // Nothing changed, and the refusals wrote no audit row.
    expect((await list(inst.id)).json().data[0].value).toBe('Acme');
    expect(await auditRows(inst.id, 'INSTRUMENT_ATTRIBUTE_SET')).toHaveLength(1);
    expect(await auditRows(inst.id, 'INSTRUMENT_ATTRIBUTE_REMOVED')).toHaveLength(0);
  });

  it('requires authentication at all', async () => {
    const inst = await newInstrument('ATTRANON');
    expect((await app.inject({ method: 'GET', url: `/api/instruments/${inst.id}/attributes` })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST', url: `/api/instruments/${inst.id}/attributes`, payload: { key: 'k', value: 'v' },
    })).statusCode).toBe(401);
  });
});

/**
 * The per-role attribute gate (2026-08-19).
 *
 * Driven by writing `role_configs.attribute_access` directly and restoring it
 * afterwards, because the alternative — logging in as a second role — would need
 * a role that holds INSTRUMENT_UPDATE and nothing else, and `loginAs` is
 * SUPER_ADMIN. The rule is read per request with no cache, which is what makes
 * this work.
 *
 * These assert the SERVER refuses. The panel hiding a button is a convenience;
 * this is the control.
 */
describe('Instrument attributes — per-role access', () => {
  const ROLE = 'SUPER_ADMIN';

  const setAccess = async (value: unknown) => {
    await prisma.roleConfig.upsert({
      where: { role: ROLE },
      create: { role: ROLE, attributeAccess: value as never },
      update: { attributeAccess: value as never },
    });
  };
  const clearAccess = async () => {
    await prisma.roleConfig.updateMany({ where: { role: ROLE }, data: { attributeAccess: Prisma.DbNull } });
  };

  afterEach(clearAccess);

  it('ALL_VIEW refuses every write, including adding a new key', async () => {
    const inst = await newInstrument('ATTRACC');
    expect((await set(inst.id, 'Room', 'B-1')).statusCode).toBe(201);

    await setAccess({ mode: 'ALL_VIEW', keys: [], requireReauth: false });
    expect((await edit(inst.id, 'Room', 'B-2')).statusCode).toBe(403);
    expect((await remove(inst.id, 'Room')).statusCode).toBe(403);
    expect((await set(inst.id, 'Another', 'x')).statusCode).toBe(403);

    // And nothing changed underneath the refusal.
    const rows = (await list(inst.id)).json().data as { key: string; value: string }[];
    expect(rows.find((r) => r.key === 'Room')?.value).toBe('B-1');
    expect(rows.some((r) => r.key === 'Another')).toBe(false);
  });

  it('SELECTED protects an unnamed key but allows the named one', async () => {
    const inst = await newInstrument('ATTRSEL');
    await set(inst.id, 'Room', 'B-1');
    await set(inst.id, 'High Temperature Limit', '25');

    await setAccess({ mode: 'SELECTED', keys: ['Room'], requireReauth: false });
    expect((await edit(inst.id, 'Room', 'B-2')).statusCode).toBe(200);
    expect((await edit(inst.id, 'High Temperature Limit', '30')).statusCode).toBe(403);
    expect((await remove(inst.id, 'High Temperature Limit')).statusCode).toBe(403);

    const rows = (await list(inst.id)).json().data as { key: string; value: string }[];
    expect(rows.find((r) => r.key === 'High Temperature Limit')?.value).toBe('25');
  });

  it('SELECTED still allows a brand-new key — it cannot overwrite a protected one', async () => {
    const inst = await newInstrument('ATTRSELNEW');
    await setAccess({ mode: 'SELECTED', keys: ['Room'], requireReauth: false });
    expect((await set(inst.id, 'Supplier Ref', 'SR-1')).statusCode).toBe(201);
  });

  it('matches a selected key case-insensitively', async () => {
    const inst = await newInstrument('ATTRCASE');
    await set(inst.id, 'Room', 'B-1');
    await setAccess({ mode: 'SELECTED', keys: [' ROOM '], requireReauth: false });
    expect((await edit(inst.id, 'Room', 'B-2')).statusCode).toBe(200);
  });

  it('a garbage rule is treated as UNCONFIGURED, never as a grant or a lockout', async () => {
    const inst = await newInstrument('ATTRJUNK');
    await set(inst.id, 'Room', 'B-1');
    await setAccess({ mode: 'EVERYTHING' });
    expect((await edit(inst.id, 'Room', 'B-2')).statusCode).toBe(200);
  });

  it('requireReauth demands a password and refuses without one', async () => {
    const inst = await newInstrument('ATTRRE');
    await set(inst.id, 'Room', 'B-1');
    await setAccess({ mode: 'ALL_EDIT', keys: [], requireReauth: true });

    const refused = await edit(inst.id, 'Room', 'B-2');
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error).toBe('REAUTH_REQUIRED');

    const accepted = await app.inject({
      method: 'PUT', url: `/api/instruments/${inst.id}/attributes/Room`,
      headers: auth, payload: { value: 'B-3', reason: REMARK, _currentPassword: 'Admin@123' },
    });
    expect(accepted.statusCode).toBe(200);
  });

  it('checks access BEFORE the password — a refused write never costs a prompt', async () => {
    const inst = await newInstrument('ATTRREV');
    await set(inst.id, 'Room', 'B-1');
    await setAccess({ mode: 'ALL_VIEW', keys: [], requireReauth: true });
    expect((await edit(inst.id, 'Room', 'B-2')).statusCode).toBe(403);
  });
});

describe('Instrument attributes — the remark is recorded, not just demanded', () => {
  it('writes the operator’s remark onto the audit row for a change and a delete', async () => {
    const inst = await newInstrument('ATTRREM');
    await set(inst.id, 'Room', 'B-1');
    await edit(inst.id, 'Room', 'B-2', auth, 'Moved to the new bay after the refit');
    await remove(inst.id, 'Room', auth, 'Instrument relocated off site');

    const changes = await auditRows(inst.id, 'INSTRUMENT_ATTRIBUTE_SET');
    expect(changes.at(-1)?.reason).toBe('Moved to the new bay after the refit');
    const removals = await auditRows(inst.id, 'INSTRUMENT_ATTRIBUTE_REMOVED');
    expect(removals.at(-1)?.reason).toBe('Instrument relocated off site');
  });

  it('records NO remark for a first fill, rather than an empty one', async () => {
    // An empty string in the trail would claim the operator gave a blank answer.
    const inst = await newInstrument('ATTRFIRST');
    await set(inst.id, 'Room', 'B-1', auth, undefined as unknown as string);
    const rows = await auditRows(inst.id, 'INSTRUMENT_ATTRIBUTE_SET');
    expect(rows.at(-1)?.reason ?? null).toBeNull();
  });
});

describe('Instrument attributes — the remark survives the sanitiser', () => {
  it('keeps a remark containing angle brackets instead of blanking it', async () => {
    // `stripHtml` empties anything tag-shaped, and this codebase has already lost
    // a value that way. All three verbs read the remark through the SAME exempted
    // path, so a real sentence about a limit cannot vanish from a §11 record.
    const inst = await newInstrument('ATTRSAN');
    await set(inst.id, 'Room', 'B-1');
    const remark = 'Reset because value < 20 per SOP-114';
    expect((await edit(inst.id, 'Room', 'B-2', auth, remark)).statusCode).toBe(200);
    const rows = await auditRows(inst.id, 'INSTRUMENT_ATTRIBUTE_SET');
    expect(rows.at(-1)?.reason).toBe(remark);
  });
});
