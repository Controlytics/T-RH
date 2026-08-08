import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

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
