/**
 * Audit 2026-10-03, API-3 and API-4.
 *
 * API-3 — `PUT /api/functional-locations/:id` returned `counts.get(id)` (a
 * `{total, active}` object) into a response field declared `integer`, so the
 * serializer threw AFTER the rename and its audit row had committed. Every
 * rename of a location holding at least one instrument — the common case —
 * read as "could not save", and a retry wrote a second audit row. No PUT
 * e2e existed.
 *
 * API-4 — the name was unbounded and the create / update / link audit rows
 * were written OUTSIDE the transaction, with the path interpolated into
 * `signature_meaning VARCHAR(255)`: a long name committed the row and failed
 * the audit insert. The name is bounded (`FL_NAME_MAX`), every signature
 * meaning is clamped once in `auditLog`, and the three writes are
 * transactional.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { prisma } from '../lib/prisma.js';
import { FL_NAME_MAX } from '../modules/functional-locations/validation.js';
import { SIGNATURE_MEANING_MAX } from '../lib/audit.js';

let app: FastifyInstance;
let admin: Record<string, string>;
const made: string[] = [];
const instrumentIds: string[] = [];
const stamp = Date.now();

beforeAll(async () => {
  app = await buildApp();
  admin = { authorization: `Bearer ${await loginAs(app)}` };
});

afterAll(async () => {
  await prisma.instrument.deleteMany({ where: { id: { in: instrumentIds } } });
  await prisma.functionalLocation.deleteMany({ where: { id: { in: made } } });
  await app.close();
});

async function block(name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/functional-locations', headers: admin, payload: { name, type: 'BLOCK' } });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  made.push(id);
  return id;
}

describe('PUT /api/functional-locations/:id', () => {
  it('renames a location that HOLDS an instrument and returns integer counts (the serializer used to throw after the commit)', async () => {
    const id = await block(`E2E-FLU-${stamp}`);
    const code = `E2E-FLU-INST-${stamp}`;
    const inst = await app.inject({
      method: 'POST', url: '/api/instruments', headers: admin,
      payload: { name: code, code, profileId: await fixtureProfileId('fixture:fl-update'), functionalLocationId: id },
    });
    expect(inst.statusCode).toBe(201);
    instrumentIds.push(inst.json().id);
    await prisma.instrument.update({ where: { id: inst.json().id }, data: { functionalLocationId: id } });

    const res = await app.inject({
      method: 'PUT', url: `/api/functional-locations/${id}`, headers: admin,
      payload: { name: `E2E-FLU-${stamp}-renamed`, type: 'BLOCK', parentId: null },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe(`E2E-FLU-${stamp}-renamed`);
    expect(body.ownCount).toBe(1);
    expect(body.totalCount).toBe(1);
    // `active` is the activity-window count; a fresh instrument has never reported.
    expect(Number.isInteger(body.activeCount)).toBe(true);
    // Exactly one audit row for the rename, inside the same transaction.
    const rows = await prisma.auditTrail.findMany({ where: { action: 'FUNCTIONAL_LOCATION_UPDATED', targetId: id } });
    expect(rows).toHaveLength(1);
  });

  it('refuses a name over the bound before anything is written', async () => {
    const before = await prisma.functionalLocation.count();
    const res = await app.inject({
      method: 'POST', url: '/api/functional-locations', headers: admin,
      payload: { name: 'N'.repeat(FL_NAME_MAX + 1), type: 'BLOCK' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('name');
    expect(await prisma.functionalLocation.count()).toBe(before);
  });

  it('a name AT the bound creates, and its audit row carries a meaning within the column', async () => {
    const name = `E2E-${stamp}-` + 'N'.repeat(FL_NAME_MAX - 20);
    const id = await block(name);
    const row = await prisma.auditTrail.findFirst({ where: { action: 'FUNCTIONAL_LOCATION_CREATED', targetId: id } });
    expect(row).not.toBeNull();
    expect(row!.signatureMeaning!.length).toBeLessThanOrEqual(SIGNATURE_MEANING_MAX);
    expect(row!.signatureMeaning).toContain('created');
  });

  it('a very long path under a long block is clamped by auditLog, not refused after the write', async () => {
    const blockId = await block(`E2E-${stamp}-` + 'B'.repeat(FL_NAME_MAX - 20));
    const res = await app.inject({
      method: 'POST', url: '/api/functional-locations', headers: admin,
      payload: { name: `E2E-${stamp}-` + 'A'.repeat(FL_NAME_MAX - 20), type: 'AREA', parentId: blockId },
    });
    expect(res.statusCode).toBe(201);
    made.push(res.json().id);
    const row = await prisma.auditTrail.findFirst({ where: { action: 'FUNCTIONAL_LOCATION_CREATED', targetId: res.json().id } });
    expect(row).not.toBeNull();
    expect(row!.signatureMeaning!.length).toBeLessThanOrEqual(SIGNATURE_MEANING_MAX);
    // The full path is still on the record, unbounded.
    expect((row!.afterValue as { location: string }).location).toContain('B'.repeat(20));
  });
});

/**
 * Audit 2026-10-03, API-20: `PUT /:id/instruments` skipped an id that did not
 * exist and wrote the raw uuid into the audit row's `linked` list, while its
 * floorplan twin refuses. Now both refuse.
 */
describe('PUT /api/functional-locations/:id/instruments', () => {
  it('refuses an unknown instrument id with 400, linking nothing and auditing nothing', async () => {
    const b = await block(`FL-LINK-${stamp}`);
    const real = await app.inject({
      method: 'POST', url: '/api/instruments', headers: admin,
      payload: { name: `FLL-${stamp}`, code: `FLL-${stamp}`, profileId: await fixtureProfileId('fixture:fl-update') },
    });
    expect(real.statusCode).toBe(201);
    instrumentIds.push(real.json().id);
    const ghost = '00000000-0000-4000-8000-000000000000';

    const res = await app.inject({
      method: 'PUT', url: `/api/functional-locations/${b}/instruments`, headers: admin,
      payload: { instrumentIds: [real.json().id, ghost] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
    expect(res.json().message).toContain(ghost);
    // The real one was not linked either — the request is refused whole.
    expect(await prisma.instrument.findUnique({ where: { id: real.json().id }, select: { functionalLocationId: true } })).toMatchObject({ functionalLocationId: null });
    expect(await prisma.auditTrail.count({ where: { action: 'FUNCTIONAL_LOCATION_INSTRUMENTS_CHANGED', targetId: b } })).toBe(0);

    // Positive control: the same call without the ghost links, and the audit
    // row names the CODE, never a uuid.
    const ok = await app.inject({
      method: 'PUT', url: `/api/functional-locations/${b}/instruments`, headers: admin,
      payload: { instrumentIds: [real.json().id] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ linked: 1 });
    const row = await prisma.auditTrail.findFirst({ where: { action: 'FUNCTIONAL_LOCATION_INSTRUMENTS_CHANGED', targetId: b }, orderBy: { timestamp: 'desc' } });
    expect((row!.afterValue as { linked: string[] }).linked).toEqual([`FLL-${stamp}`]);
  });
});
