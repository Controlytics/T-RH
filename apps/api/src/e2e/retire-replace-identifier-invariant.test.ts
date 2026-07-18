/**
 * retire() / replace() — RFID identifier ownership invariant (2026-07-15).
 *
 * CHARACTERIZATION TEST. This file exists to STOP a plausible "fix" that would
 * break the most common filter end-of-life path.
 *
 * Context: `filterService.softDelete` was taught to cascade-delete a filter's
 * assetIdentifier rows (#222), so a deleted filter's RFID tag is freed for re-use.
 * The obvious next move is to "fix the pattern" and apply the same cascade to
 * `retire()`. That would be WRONG, and the failure is silent:
 *
 *   `replace()` calls `retire()` FIRST, then MOVES the identifier rows onto the
 *   replacement filter (re-pointing assetId — identifier_value is globally
 *   unique, so it cannot copy). If retire() deleted the identifiers, the
 *   subsequent updateMany would match ZERO rows, the replacement filter would
 *   silently come up with NO tag, and the physical tag still on the wall would be
 *   orphaned — the exact "tag unusable on the replacement filter" wall #222 set
 *   out to fix, reintroduced through the more common door.
 *
 * That dependency was previously protected only by a comment in replace(). These
 * tests make it executable:
 *   - retire() MUST leave identifiers attached (replace() depends on it; unretire
 *     restores the filter and must restore a tagged filter, and the binding is
 *     §11 evidence of what was physically installed).
 *   - replace() MUST carry the tag over to the replacement.
 *
 * If you are here because you just added a cascade to retire(), that is the bug.
 * Free the tag on RE-ASSIGNMENT (the audited DELETE /api/assets/identifiers/:id
 * path), not on retire.
 *
 * Isolation: own SUPER_ADMIN + throwaway FILTER instances on a seeded AHU,
 * removed in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import authPlugin from '../plugins/auth.js';
import rbacPlugin from '../plugins/rbac.js';
import authRoutes from '../modules/auth/routes.js';
import filterOperationsRoutes from '../modules/filter-operations/routes.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { AppError } from '../lib/errors.js';

const TEST_USERNAME = 'retire_ident_admin';
const TEST_PASSWORD = 'RetireIdent@Test1';
const PREFIX = `ZZRETIDENT-${Date.now()}`;

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ajv: { customOptions: { keywords: ['example'] } } });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(authPlugin);
  await app.register(rbacPlugin);
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    return reply.code(err.statusCode ?? 500).send({ error: err.message || 'Internal Server Error' });
  });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(filterOperationsRoutes, { prefix: '/api/filters' });
  await app.ready();
  return app;
}

describe('retire() / replace() — RFID identifier ownership invariant', () => {
  let app: FastifyInstance;
  let token: string;
  let testUserId: string;
  let retireFilterId: string;   // retired standalone — tag must STAY
  let replaceFilterId: string;  // replaced — tag must MOVE to the replacement

  const RETIRE_TAG = `${PREFIX}-TAG-RETIRE`;
  const REPLACE_TAG = `${PREFIX}-TAG-REPLACE`;

  beforeAll(async () => {
    app = await buildTestApp();

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const user = await prisma.user.upsert({
      where: { username: TEST_USERNAME },
      update: {
        passwordHash, role: 'SUPER_ADMIN', status: 'ENABLED',
        forcePasswordChange: false, isTemporaryPassword: false,
        failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null,
      },
      create: {
        username: TEST_USERNAME, passwordHash, fullName: 'Retire Identifier Test Admin',
        email: 'retire-ident-test@example.test', role: 'SUPER_ADMIN', status: 'ENABLED',
        forcePasswordChange: false, isTemporaryPassword: false,
      },
    });
    testUserId = user.id;

    const tpl = await prisma.assetTemplate.findFirst({ where: { templateKind: 'FILTER' } });
    if (!tpl) throw new Error('Test DB has no FILTER template to build on');
    const ahu = await prisma.assetInstance.findFirst({ where: { template: { templateKind: 'AHU' } } });

    const mk = async (name: string, tag: string) => {
      const inst = await prisma.assetInstance.create({
        data: {
          name, templateId: tpl.id, templateVersion: tpl.version ?? 1,
          parentId: ahu?.id ?? null, attributes: {}, status: 'Active', isActive: true,
        },
      });
      await prisma.assetIdentifier.create({
        data: { assetId: inst.id, identifierType: 'RFID', identifierValue: tag, isPrimary: true },
      });
      return inst.id;
    };
    // "-90" increments to a free "-91" on replace (see filter-replace-duplicate-name).
    retireFilterId = await mk(`${PREFIX}-70`, RETIRE_TAG);
    replaceFilterId = await mk(`${PREFIX}-90`, REPLACE_TAG);

    const loginRes = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD, force: true },
    });
    const body = JSON.parse(loginRes.body);
    if (!body.token) throw new Error(`Login failed: ${loginRes.body}`);
    token = body.token;
  });

  afterAll(async () => {
    const mine = await prisma.assetInstance.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
    const ids = mine.map((m) => m.id);
    await prisma.assetIdentifier.deleteMany({ where: { assetId: { in: ids } } });
    await prisma.assetRelationship.deleteMany({ where: { OR: [{ sourceAssetId: { in: ids } }, { targetAssetId: { in: ids } }] } });
    await prisma.filterDetails.deleteMany({ where: { assetInstanceId: { in: ids } } });
    await prisma.assetInstance.deleteMany({ where: { id: { in: ids } } });
    await prisma.session.updateMany({ where: { userId: testUserId }, data: { isActive: false, terminationReason: 'retire_ident_test_cleanup' } });
    try {
      await prisma.user.delete({ where: { id: testUserId } });
    } catch {
      await prisma.user.update({ where: { id: testUserId }, data: { status: 'DISABLED', email: `disabled-${testUserId}@example.test` } });
    }
    await app.close();
  });

  it('retire() leaves the RFID tag bound to the retired filter (replace() depends on this)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/filters/${retireFilterId}/retire`,
      headers: { authorization: `Bearer ${token}`, 'x-reauth-password': TEST_PASSWORD },
      payload: { remarks: 'invariant test — retire keeps the tag' },
    });
    expect(res.statusCode).toBe(200);

    const ident = await prisma.assetIdentifier.findUnique({ where: { identifierValue: RETIRE_TAG } });
    expect(ident).not.toBeNull();               // NOT cascaded away
    expect(ident!.assetId).toBe(retireFilterId); // still evidences what was on the wall
  });

  it('replace() carries the tag over to the replacement filter', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/filters/${replaceFilterId}/replace`,
      headers: { authorization: `Bearer ${token}`, 'x-reauth-password': TEST_PASSWORD },
      payload: { remarks: 'invariant test — replace moves the tag' },
    });
    expect(res.statusCode).toBe(200);

    const ident = await prisma.assetIdentifier.findUnique({ where: { identifierValue: REPLACE_TAG } });
    expect(ident).not.toBeNull();
    // The physical tag stays on the wall; only the filter id behind it changes.
    expect(ident!.assetId).not.toBe(replaceFilterId);

    const replacement = await prisma.assetInstance.findFirst({ where: { name: `${PREFIX}-91` }, select: { id: true } });
    expect(replacement).not.toBeNull();
    expect(ident!.assetId).toBe(replacement!.id);
  });
});
