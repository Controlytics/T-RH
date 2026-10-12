import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';
import { isProfileInUseError } from '../modules/instrument-profiles/routes.js';

/**
 * Instrument profiles — a named container for instruments.
 *
 * The assertion that matters most here is that a POPULATED profile cannot be
 * deleted, and that this is true at TWO levels: the endpoint refuses it with a
 * count and a next step, and the foreign key refuses it regardless. The second
 * is what makes the rule survive a future edit to the first.
 */

let app: FastifyInstance;
let token: string;

const auth = () => ({ authorization: `Bearer ${token}` });

/** Everything this file creates is prefixed, so cleanup can never touch real data. */
async function cleanup() {
  await prisma.instrument.deleteMany({ where: { code: { startsWith: 'IPT-' } } });
  await prisma.instrumentProfile.deleteMany({ where: { name: { startsWith: 'IPT ' } } });
}

const createProfile = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/instrument-profiles', headers: auth(), payload });

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: ADMIN_PASSWORD, force: true },
  });
  token = JSON.parse(res.body).token;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

beforeEach(cleanup);

describe('POST /api/instrument-profiles', () => {
  it('creates a profile', async () => {
    const res = await createProfile({ name: 'IPT Cleanroom-A', description: 'Grade B' });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({
      name: 'IPT Cleanroom-A', description: 'Grade B', isActive: true,
      instrumentCount: 0, activeCount: 0,
    });
  });

  it('refuses a duplicate name with 409, not a 500 from the unique index', async () => {
    await createProfile({ name: 'IPT Dup' });
    const res = await createProfile({ name: 'IPT Dup' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('DUPLICATE_NAME');
  });

  it('rejects a blank name', async () => {
    expect((await createProfile({ name: '   ' })).statusCode).toBe(400);
  });

  it('writes an audit row naming the profile (§11.10(e))', async () => {
    const created = JSON.parse((await createProfile({ name: 'IPT Audited' })).body);
    const row = await prisma.auditTrail.findFirst({
      where: { action: 'INSTRUMENT_PROFILE_CREATED', targetId: created.id },
    });
    expect(row).toBeTruthy();
    expect(row!.signatureMeaning).toContain('IPT Audited');
  });
});

describe('GET /api/instrument-profiles', () => {
  it('lists profiles with their instrument counts', async () => {
    const p = JSON.parse((await createProfile({ name: 'IPT Counted' })).body);
    await prisma.instrument.create({ data: { name: 'IPT-A', code: 'IPT-A', profileId: p.id, isActive: true } });
    await prisma.instrument.create({ data: { name: 'IPT-B', code: 'IPT-B', profileId: p.id, isActive: false } });

    const res = await app.inject({ method: 'GET', url: '/api/instrument-profiles', headers: auth() });
    expect(res.statusCode).toBe(200);
    const row = JSON.parse(res.body).data.find((x: { id: string }) => x.id === p.id);
    expect(row).toMatchObject({ instrumentCount: 2, activeCount: 1 });
  });

  it('returns 404 for an unknown profile rather than an empty object', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/instrument-profiles/00000000-0000-4000-8000-000000000000', headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /api/instrument-profiles/:id', () => {
  it('renames a profile and records both names in the audit row', async () => {
    const p = JSON.parse((await createProfile({ name: 'IPT Before' })).body);

    const res = await app.inject({
      method: 'PUT', url: `/api/instrument-profiles/${p.id}`, headers: auth(),
      payload: { name: 'IPT After' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('IPT After');

    const row = await prisma.auditTrail.findFirst({
      where: { action: 'INSTRUMENT_PROFILE_UPDATED', targetId: p.id },
    });
    expect(row!.signatureMeaning).toContain('IPT Before');
    expect(row!.signatureMeaning).toContain('IPT After');
  });

  it('refuses a rename that collides with another profile', async () => {
    await createProfile({ name: 'IPT Taken' });
    const p = JSON.parse((await createProfile({ name: 'IPT Mover' })).body);

    const res = await app.inject({
      method: 'PUT', url: `/api/instrument-profiles/${p.id}`, headers: auth(),
      payload: { name: 'IPT Taken' },
    });
    expect(res.statusCode).toBe(409);
  });
});

/**
 * Removing a key from a profile REMOVES that attribute from the profile's
 * instruments (2026-09-16, operator: "when i removed attributes for profile in
 * configuration those are not removing for instruments"). Until then a profile
 * carried prompts only. Each deletion is its own §11 record: one
 * INSTRUMENT_ATTRIBUTE_REMOVED row per instrument with the remark, which is
 * why a removal that would delete recorded values REQUIRES a reason.
 */
describe('PUT /api/instrument-profiles/:id — attribute cascade', () => {
  const mkInstrument = async (profileId: string, code: string) => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { name: code, code, profileId },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body) as { id: string };
  };
  const setAttr = (id: string, key: string, value: string) =>
    app.inject({ method: 'POST', url: `/api/instruments/${id}/attributes`, headers: auth(), payload: { key, value } });
  const attrsOf = async (id: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/instruments/${id}/attributes`, headers: auth() });
    return Object.fromEntries((JSON.parse(res.body).data as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  };

  it('reports which keys are recorded on the profile\'s instruments, folded by case', async () => {
    const p = JSON.parse((await createProfile({ name: 'IPT Usage', attributeKeys: 'Building\nRoom' })).body);
    const a = await mkInstrument(p.id, 'IPT-U1');
    const b = await mkInstrument(p.id, 'IPT-U2');
    await setAttr(a.id, 'Building', 'CWH');
    await setAttr(b.id, 'building', 'CWH');   // a second spelling — one key
    await setAttr(a.id, 'Room', '101');

    const res = await app.inject({ method: 'GET', url: `/api/instrument-profiles/${p.id}/attribute-usage`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const keys = (JSON.parse(res.body).keys as { key: string; instruments: number }[]).sort((x, y) => x.key.localeCompare(y.key));
    expect(keys).toEqual([{ key: 'Building', instruments: 2 }, { key: 'Room', instruments: 1 }]);
  });

  it('refuses to drop a recorded key without a reason, naming what would go', async () => {
    const p = JSON.parse((await createProfile({ name: 'IPT NoReason', attributeKeys: 'Building\nRoom' })).body);
    const a = await mkInstrument(p.id, 'IPT-N1');
    await setAttr(a.id, 'Room', '101');

    const res = await app.inject({
      method: 'PUT', url: `/api/instrument-profiles/${p.id}`, headers: auth(),
      payload: { attributeKeys: 'Building' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('REASON_REQUIRED');
    expect(body.affected).toEqual([{ key: 'Room', instruments: 1 }]);
    // Nothing moved.
    expect(await attrsOf(a.id)).toEqual({ Room: '101' });
    const row = await prisma.instrumentProfile.findUnique({ where: { id: p.id } });
    expect(row?.attributeKeys).toBe('Building\nRoom');
  });

  it('with a reason, drops the key from the profile AND deletes it on every instrument, audited per instrument, case-folded', async () => {
    const p = JSON.parse((await createProfile({ name: 'IPT Cascade', attributeKeys: 'Building\nRoom' })).body);
    const a = await mkInstrument(p.id, 'IPT-C1');
    const b = await mkInstrument(p.id, 'IPT-C2');
    await setAttr(a.id, 'Building', 'CWH');
    await setAttr(a.id, 'Room', '101');
    await setAttr(b.id, 'room', '202');   // differs by case only — still the key being removed

    const res = await app.inject({
      method: 'PUT', url: `/api/instrument-profiles/${p.id}`, headers: auth(),
      payload: { attributeKeys: 'Building', reason: 'Room is tracked on the floor plan now' },
    });
    expect(res.statusCode).toBe(200);
    expect(await attrsOf(a.id)).toEqual({ Building: 'CWH' });
    expect(await attrsOf(b.id)).toEqual({});

    const rows = await prisma.auditTrail.findMany({
      where: { action: 'INSTRUMENT_ATTRIBUTE_REMOVED', targetId: { in: [a.id, b.id] } },
      select: { targetId: true, reason: true, beforeValue: true },
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.reason).toBe('Room is tracked on the floor plan now');
    const before = rows.map((r) => (r.beforeValue as { attribute: string; value: string })).sort((x, y) => x.value.localeCompare(y.value));
    expect(before).toEqual([{ code: 'IPT-C1', attribute: 'Room', value: '101' }, { code: 'IPT-C2', attribute: 'room', value: '202' }]);

    // The profile's own row names the cascade.
    const prof = await prisma.auditTrail.findFirst({
      where: { action: 'INSTRUMENT_PROFILE_UPDATED', targetId: p.id }, orderBy: { timestamp: 'desc' },
    });
    expect(prof!.signatureMeaning).toMatch(/removed .*2 instrument/i);
  });

  it('a key nobody carries is dropped without a reason and without an attribute audit row', async () => {
    const p = JSON.parse((await createProfile({ name: 'IPT Unused', attributeKeys: 'Building\nSpare' })).body);
    const a = await mkInstrument(p.id, 'IPT-S1');
    await setAttr(a.id, 'Building', 'CWH');

    const res = await app.inject({
      method: 'PUT', url: `/api/instrument-profiles/${p.id}`, headers: auth(),
      payload: { attributeKeys: 'Building' },
    });
    expect(res.statusCode).toBe(200);
    expect(await attrsOf(a.id)).toEqual({ Building: 'CWH' });
    const removed = await prisma.auditTrail.count({ where: { action: 'INSTRUMENT_ATTRIBUTE_REMOVED', targetId: a.id } });
    expect(removed).toBe(0);
  });
});

describe('DELETE /api/instrument-profiles/:id', () => {
  it('deletes an empty profile', async () => {
    const p = JSON.parse((await createProfile({ name: 'IPT Empty' })).body);

    const res = await app.inject({ method: 'DELETE', url: `/api/instrument-profiles/${p.id}`, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(await prisma.instrumentProfile.findUnique({ where: { id: p.id } })).toBeNull();
  });

  it('REFUSES a profile that still holds instruments, and says how many', async () => {
    const p = JSON.parse((await createProfile({ name: 'IPT Populated' })).body);
    await prisma.instrument.create({ data: { name: 'IPT-C', code: 'IPT-C', profileId: p.id } });

    const res = await app.inject({ method: 'DELETE', url: `/api/instrument-profiles/${p.id}`, headers: auth() });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('PROFILE_NOT_EMPTY');
    // The count is the point — "it has instruments" without a number gives the
    // operator nothing to act on.
    expect(body.message).toContain('1 instrument');

    // The refusal is real, not cosmetic.
    expect(await prisma.instrumentProfile.findUnique({ where: { id: p.id } })).not.toBeNull();
  });

  it('the DATABASE refuses it too, not only the service', async () => {
    // Proves ON DELETE RESTRICT. If someone later deletes the service-side
    // check, this test still fails closed — which is the whole reason the
    // constraint exists rather than trusting application code.
    const p = await prisma.instrumentProfile.create({ data: { name: 'IPT FkGuard' } });
    await prisma.instrument.create({ data: { name: 'IPT-D', code: 'IPT-D', profileId: p.id } });

    await expect(prisma.instrumentProfile.delete({ where: { id: p.id } })).rejects.toThrow();
    // ...with an error the DELETE route recognises and answers 409
    // PROFILE_NOT_EMPTY, for an instrument that joins the profile between the
    // route's count and its delete. (ON DELETE RESTRICT surfaces as an
    // UNKNOWN request error with no Prisma code, not P2003 — pinned here.)
    const err = await prisma.instrumentProfile.delete({ where: { id: p.id } }).catch((e: unknown) => e);
    expect(isProfileInUseError(err)).toBe(true);
    expect(isProfileInUseError(new Error('connection terminated'))).toBe(false);
  });
});

describe('instruments carry their profile', () => {
  it('POST /api/instruments requires a profile', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { name: 'IPT-E', code: 'IPT-E' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates an instrument inside a profile and reads it back with the name', async () => {
    const p = JSON.parse((await createProfile({ name: 'IPT Wire' })).body);
    const created = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { name: 'IPT-F', code: 'IPT-F', profileId: p.id },
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body).profileId).toBe(p.id);

    // profileName must survive Fastify's response serializer — it strips any
    // property the schema does not declare, so the UI would silently see
    // nothing however correct the query is.
    const read = await app.inject({
      method: 'GET', url: `/api/instruments/${JSON.parse(created.body).id}`, headers: auth(),
    });
    expect(JSON.parse(read.body)).toMatchObject({ profileId: p.id, profileName: 'IPT Wire' });
  });

  it('carries the profile through the LIST endpoint too', async () => {
    const p = JSON.parse((await createProfile({ name: 'IPT Listed' })).body);
    await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { name: 'IPT-K', code: 'IPT-K', profileId: p.id },
    });

    const res = await app.inject({ method: 'GET', url: '/api/instruments?limit=200', headers: auth() });
    const row = JSON.parse(res.body).data.find((r: { code: string }) => r.code === 'IPT-K');
    expect(row).toMatchObject({ profileId: p.id, profileName: 'IPT Listed' });
  });

  it('rejects a profileId that names no profile, with 400 not a raw FK 500', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { name: 'IPT-G', code: 'IPT-G', profileId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('PROFILE_NOT_FOUND');
  });

  it('moves an instrument between profiles', async () => {
    const from = JSON.parse((await createProfile({ name: 'IPT From' })).body);
    const to = JSON.parse((await createProfile({ name: 'IPT To' })).body);
    const created = JSON.parse((await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { name: 'IPT-H', code: 'IPT-H', profileId: from.id },
    })).body);

    const res = await app.inject({
      method: 'PUT', url: `/api/instruments/${created.id}`, headers: auth(),
      payload: { profileId: to.id },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).profileId).toBe(to.id);
  });

  it('applies ONE profile to every row of a bulk upload, with no CSV column', async () => {
    const p = JSON.parse((await createProfile({ name: 'IPT Bulk' })).body);
    // The CSV is exactly the format operators already have on disk — no profile
    // column. That is the whole point of taking it as a sibling field.
    const csv = 'code,name\nIPT-I,IPT-I\nIPT-J,IPT-J\n';

    const res = await app.inject({
      method: 'POST', url: '/api/instruments/bulk', headers: auth(),
      payload: { csv, profileId: p.id },
    });
    expect(res.statusCode).toBe(200);

    const rows = await prisma.instrument.findMany({ where: { code: { in: ['IPT-I', 'IPT-J'] } } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.profileId === p.id)).toBe(true);
  });
});

describe('GET /api/instruments?profileId', () => {
  it('scopes the list AND its total to one profile', async () => {
    // The total is the point. Filtering in the browser left `total` counting
    // every instrument, so an empty profile's footer read "Showing 1-10 of 15"
    // over an empty table — visible the first time this was opened for real.
    const mine = JSON.parse((await createProfile({ name: 'IPT Scoped' })).body);
    const other = JSON.parse((await createProfile({ name: 'IPT Other' })).body);
    await prisma.instrument.create({ data: { name: 'IPT-L', code: 'IPT-L', profileId: mine.id } });
    await prisma.instrument.create({ data: { name: 'IPT-M', code: 'IPT-M', profileId: other.id } });

    const res = await app.inject({
      method: 'GET', url: `/api/instruments?profileId=${mine.id}`, headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(1);
    expect(body.data.map((r: { code: string }) => r.code)).toEqual(['IPT-L']);
  });

  it('reports total 0 for an empty profile', async () => {
    const empty = JSON.parse((await createProfile({ name: 'IPT NoneHere' })).body);
    const res = await app.inject({
      method: 'GET', url: `/api/instruments?profileId=${empty.id}`, headers: auth(),
    });
    expect(JSON.parse(res.body).total).toBe(0);
    expect(JSON.parse(res.body).data).toEqual([]);
  });
});

const updateProfile = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/instrument-profiles/${id}`, headers: auth(), payload });

describe('instrument profile attributeKeys', () => {
  it('starts a new profile EMPTY when attributeKeys is omitted', async () => {
    // 2026-08-08: a new profile used to be seeded from the global
    // `instrument-attributes` template. It no longer is — every new profile
    // opening as an identical copy of the last one is what made the per-profile
    // list read as global. Nothing is inherited; the admin adds the keys.
    const res = await createProfile({ name: 'IPT Seeded' });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).attributeKeys).toBe('');
  });

  it('does NOT copy the global instrument-attributes config into a new profile', async () => {
    // REGRESSION GUARD for the rule above: the config key still exists (it
    // seeds nothing now), so a re-introduced getConfig() call would go
    // unnoticed without an assertion that names it.
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'instrument-attributes' } });
    const configured = (row?.configValue as { keys?: string } | null)?.keys ?? '';
    const res = await createProfile({ name: 'IPT Not Seeded' });
    const stored = JSON.parse(res.body).attributeKeys;
    expect(stored).toBe('');
    if (configured) expect(stored).not.toBe(configured);
  });

  it('stores an explicit list verbatim', async () => {
    const res = await createProfile({ name: 'IPT Explicit', attributeKeys: 'Room\nSlave ID' });
    expect(JSON.parse(res.body).attributeKeys).toBe('Room\nSlave ID');
  });

  it('stores a key containing "<" VERBATIM', async () => {
    // REGRESSION GUARD for the sanitizeStrings skip. stripHtml DISCARDS
    // tag-shaped content, so without ['attributeKeys'] in skipKeys this key
    // becomes "Temp" — while the dynamic-config PUT, which does not strip,
    // would have stored it intact. The two write paths must agree.
    const res = await createProfile({ name: 'IPT Angle', attributeKeys: 'Temp <5C\nRoom' });
    expect(JSON.parse(res.body).attributeKeys).toBe('Temp <5C\nRoom');
  });

  it('accepts an empty list, and it reads back as empty rather than null', async () => {
    const id = JSON.parse((await createProfile({ name: 'IPT Empty' })).body).id;
    const res = await updateProfile(id, { attributeKeys: '' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).attributeKeys).toBe('');
  });

  it('accepts null, which re-arms the default-template fallback', async () => {
    const id = JSON.parse((await createProfile({ name: 'IPT Null' })).body).id;
    const res = await updateProfile(id, { attributeKeys: null });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).attributeKeys).toBeNull();
  });

  it('returns attributeKeys for every profile in the list, so one fetch serves the config page', async () => {
    await createProfile({ name: 'IPT List A', attributeKeys: 'Room' });
    await createProfile({ name: 'IPT List B', attributeKeys: '' });
    const rows = JSON.parse((await app.inject({
      method: 'GET', url: '/api/instrument-profiles', headers: auth(),
    })).body).data as { name: string; attributeKeys: string | null }[];
    const mine = rows.filter((r) => r.name.startsWith('IPT List '));
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => 'attributeKeys' in r)).toBe(true);
  });

  it('audits a key change with the PARSED arrays and a count in the signature', async () => {
    const id = JSON.parse((await createProfile({
      name: 'IPT Audited', attributeKeys: 'Block\nArea\nRoom',
    })).body).id;
    await updateProfile(id, { attributeKeys: 'Room' });

    const row = await prisma.auditTrail.findFirst({
      where: { action: 'INSTRUMENT_PROFILE_UPDATED', targetId: id },
      orderBy: { timestamp: 'desc' },
    });
    expect(row).not.toBeNull();
    // Arrays, not the raw newline string: an inspector reads keys, and the
    // audit UI already diffs keyed arrays.
    expect((row!.beforeValue as { attributeKeys: string[] }).attributeKeys)
      .toEqual(['Block', 'Area', 'Room']);
    expect((row!.afterValue as { attributeKeys: string[] }).attributeKeys).toEqual(['Room']);
    expect(row!.signatureMeaning).toBe('Instrument profile "IPT Audited" attribute keys changed (3 → 1)');
  });

  it('still reports a rename rather than the key change when both happen', async () => {
    const id = JSON.parse((await createProfile({ name: 'IPT Before', attributeKeys: 'Room' })).body).id;
    await updateProfile(id, { name: 'IPT After', attributeKeys: 'Block' });
    const row = await prisma.auditTrail.findFirst({
      where: { action: 'INSTRUMENT_PROFILE_UPDATED', targetId: id },
      orderBy: { timestamp: 'desc' },
    });
    expect(row!.signatureMeaning).toBe('Instrument profile renamed "IPT Before" → "IPT After"');
  });
});

/**
 * Audit 2026-10-12 (brief finding 3): the profile cascade deletes an attribute
 * on every instrument of the profile — the same act the per-instrument DELETE
 * signs with `UPDATE_INSTRUMENT_ATTRIBUTE` re-auth when the role's Attribute
 * Access asks for it. The cascade checked the access rule but never asked for
 * the password. The password goes in the BODY here on purpose: the route's own
 * configurable re-auth strips `_currentPassword` first, so a fix that only
 * re-reads the body would refuse a caller who did send it.
 */
describe('PUT /api/instrument-profiles/:id — cascade re-auth follows Attribute Access', () => {
  const setAccess = async (value: unknown) => {
    await prisma.roleConfig.upsert({
      where: { role: 'SUPER_ADMIN' },
      create: { role: 'SUPER_ADMIN', attributeAccess: value as never },
      update: { attributeAccess: value as never },
    });
  };
  afterEach(async () => {
    await prisma.roleConfig.updateMany({ where: { role: 'SUPER_ADMIN' }, data: { attributeAccess: Prisma.DbNull } });
  });

  const seed = async (name: string, code: string) => {
    const p = JSON.parse((await createProfile({ name, attributeKeys: 'Building\nRoom' })).body);
    const inst = await prisma.instrument.create({ data: { name: code, code, profileId: p.id } });
    await prisma.instrumentAttribute.create({ data: { instrumentId: inst.id, key: 'Room', value: '101' } });
    return { p, inst };
  };
  const roomOf = async (id: string) =>
    (await prisma.instrumentAttribute.findUnique({ where: { instrumentId_key: { instrumentId: id, key: 'Room' } } }))?.value;

  it('refuses the cascade without a password when the role requires re-auth, and deletes nothing', async () => {
    const { p, inst } = await seed('IPT ReauthNo', 'IPT-RA1');
    await setAccess({ mode: 'ALL_EDIT', keys: [], requireReauth: true });
    const res = await app.inject({
      method: 'PUT', url: `/api/instrument-profiles/${p.id}`, headers: auth(),
      payload: { attributeKeys: 'Building', reason: 'Room moved to the floor plan' },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('REAUTH_REQUIRED');
    expect(await roomOf(inst.id)).toBe('101');
    expect((await prisma.instrumentProfile.findUnique({ where: { id: p.id } }))?.attributeKeys).toBe('Building\nRoom');
  });

  it('accepts the cascade with the password in the BODY', async () => {
    const { p, inst } = await seed('IPT ReauthYes', 'IPT-RA2');
    await setAccess({ mode: 'ALL_EDIT', keys: [], requireReauth: true });
    const res = await app.inject({
      method: 'PUT', url: `/api/instrument-profiles/${p.id}`, headers: auth(),
      payload: { attributeKeys: 'Building', reason: 'Room moved to the floor plan', _currentPassword: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(await roomOf(inst.id)).toBeUndefined();
  });

  it('a profile edit that removes no carried key never asks for the attribute password', async () => {
    const { p } = await seed('IPT ReauthNone', 'IPT-RA3');
    await setAccess({ mode: 'ALL_EDIT', keys: [], requireReauth: true });
    const res = await app.inject({
      method: 'PUT', url: `/api/instrument-profiles/${p.id}`, headers: auth(),
      payload: { description: 'just a description' },
    });
    expect(res.statusCode).toBe(200);
  });
});

/**
 * Audit 2026-10-12 (brief finding 6): profile create / update / delete wrote
 * their audit row AFTER the change had committed, so a failed audit write left
 * a §11 change with no record. A temporary trigger on THIS test database makes
 * the audit insert fail for profiles named "IPT AUDITFAIL…" only; the change
 * must roll back with it.
 */
describe('instrument profile writes are atomic with their audit row', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION zz_test_refuse_profile_audit() RETURNS trigger AS $f$
      BEGIN
        IF NEW.action LIKE 'INSTRUMENT_PROFILE_%'
           AND coalesce(NEW.after_value->>'name', NEW.before_value->>'name') LIKE 'IPT AUDITFAIL%' THEN
          RAISE EXCEPTION 'test: audit write refused';
        END IF;
        RETURN NEW;
      END $f$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS zz_test_refuse_profile_audit ON audit_trail`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER zz_test_refuse_profile_audit BEFORE INSERT ON audit_trail
      FOR EACH ROW EXECUTE FUNCTION zz_test_refuse_profile_audit()`);
  });
  afterAll(async () => {
    try { await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS zz_test_refuse_profile_audit ON audit_trail`); } catch { /* next line still runs */ }
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS zz_test_refuse_profile_audit()`);
  });

  it('CREATE: a failed audit write leaves no profile behind', async () => {
    const res = await createProfile({ name: 'IPT AUDITFAIL create' });
    expect(res.statusCode).toBe(500);
    expect(await prisma.instrumentProfile.findFirst({ where: { name: 'IPT AUDITFAIL create' } })).toBeNull();
  });

  it('UPDATE: a failed audit write leaves the profile unchanged', async () => {
    const p = await prisma.instrumentProfile.create({ data: { name: 'IPT AuditOk' } });
    const res = await app.inject({
      method: 'PUT', url: `/api/instrument-profiles/${p.id}`, headers: auth(), payload: { name: 'IPT AUDITFAIL renamed' },
    });
    expect(res.statusCode).toBe(500);
    expect((await prisma.instrumentProfile.findUnique({ where: { id: p.id } }))?.name).toBe('IPT AuditOk');
  });

  it('DELETE: a failed audit write leaves the profile in place', async () => {
    const p = await prisma.instrumentProfile.create({ data: { name: 'IPT AUDITFAIL delete' } });
    const res = await app.inject({ method: 'DELETE', url: `/api/instrument-profiles/${p.id}`, headers: auth() });
    expect(res.statusCode).toBe(500);
    expect(await prisma.instrumentProfile.findUnique({ where: { id: p.id } })).not.toBeNull();
  });
});
