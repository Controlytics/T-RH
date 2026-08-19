import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';

/**
 * The admin surface for per-role instrument attribute access.
 *
 * What matters here is the round trip THROUGH the same parser the enforcement
 * reads with: a value this endpoint accepts must never be one the gate then
 * treats as unconfigured, because that would silently restore the old
 * everything-editable behaviour with a green save behind it.
 */
let app: FastifyInstance;
let auth: Record<string, string>;
const ROLE = 'OPERATOR';

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});

afterEach(async () => {
  await prisma.roleConfig.updateMany({ where: { role: ROLE }, data: { attributeAccess: Prisma.DbNull } });
});

afterAll(async () => { await app.close(); });

const get = () => app.inject({ method: 'GET', url: '/api/roles/attribute-access', headers: auth });
const put = (body: unknown, role = ROLE) =>
  app.inject({ method: 'PUT', url: `/api/roles/attribute-access/${role}`, headers: auth, payload: body });

const roleRow = async (role = ROLE) =>
  ((await get()).json().roles as { role: string; mode: string | null; keys: string[]; requireReauth: boolean }[])
    .find((r) => r.role === role);

describe('GET /api/roles/attribute-access', () => {
  it('lists every active role, unconfigured by default', async () => {
    const body = (await get()).json();
    expect(body.roles.length).toBeGreaterThan(0);
    expect(await roleRow()).toMatchObject({ mode: null, keys: [], requireReauth: false });
  });

  it('reports whether each role can edit instruments at all', async () => {
    // A role without INSTRUMENT_UPDATE is read-only whatever mode is stored, and
    // the tab has to be able to say so rather than offering a setting that does
    // nothing.
    const body = (await get()).json();
    const sa = body.roles.find((r: { role: string }) => r.role === 'SUPER_ADMIN');
    expect(sa.canUpdateInstruments).toBe(true);
  });

  it('offers the attribute keys actually in use, folded case-insensitively', async () => {
    const keys = (await get()).json().availableKeys as string[];
    expect(Array.isArray(keys)).toBe(true);
    const folded = keys.map((k) => k.toLowerCase());
    expect(new Set(folded).size).toBe(folded.length);
  });
});

describe('PUT /api/roles/attribute-access/:name', () => {
  it('stores a SELECTED rule and reads it back', async () => {
    expect((await put({ mode: 'SELECTED', keys: ['Room', 'Slave ID'], requireReauth: true })).statusCode).toBe(200);
    expect(await roleRow()).toMatchObject({
      mode: 'SELECTED', keys: ['Room', 'Slave ID'], requireReauth: true,
    });
  });

  it('clears the rule back to unconfigured with a null mode', async () => {
    await put({ mode: 'ALL_VIEW', keys: [], requireReauth: false });
    expect((await put({ mode: null })).statusCode).toBe(200);
    expect(await roleRow()).toMatchObject({ mode: null });

    // A real SQL NULL, not the JSON value `null` — "not configured" and
    // "configured as nothing" have to stay distinguishable in the column.
    const row = await prisma.roleConfig.findUnique({ where: { role: ROLE }, select: { attributeAccess: true } });
    expect(row?.attributeAccess).toBeNull();
  });

  it('drops the key list when the mode is not SELECTED', async () => {
    // Otherwise a role switched back to SELECTED silently reappears with the keys
    // it had a month ago.
    await put({ mode: 'SELECTED', keys: ['Room'], requireReauth: false });
    await put({ mode: 'ALL_EDIT', keys: ['Room'], requireReauth: false });
    expect((await roleRow())?.keys).toEqual([]);
  });

  it('refuses a mode it does not recognise rather than storing it', async () => {
    // Stored, it would parse back as unconfigured — everything editable, with a
    // green save behind it.
    expect((await put({ mode: 'EVERYTHING' })).statusCode).toBe(400);
    expect(await roleRow()).toMatchObject({ mode: null });
  });

  it('cleans the key list on the way in', async () => {
    await put({ mode: 'SELECTED', keys: [' Room ', 'Room', ''], requireReauth: false });
    expect((await roleRow())?.keys).toEqual(['Room']);
  });

  it('audits the change, naming the role and what it was set to', async () => {
    await put({ mode: 'ALL_VIEW', keys: [], requireReauth: false });
    const rows = await prisma.auditTrail.findMany({
      where: { action: 'CONFIG_CHANGED', targetType: 'role_config', targetId: ROLE },
      orderBy: { timestamp: 'desc' }, take: 1,
    });
    expect(rows[0]?.signatureMeaning).toContain('view-only');
    // VARCHAR(255) and auditLog does not truncate.
    expect((rows[0]?.signatureMeaning ?? '').length).toBeLessThanOrEqual(255);
  });
});
