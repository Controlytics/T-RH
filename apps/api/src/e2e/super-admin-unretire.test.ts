/**
 * e2e — POST /api/super-admin/filter-data/retirements/:id/unretire
 *
 * Covers the 2026-07-15 transactionality fix. The endpoint previously ran ~10
 * sequential destructive writes with NO transaction and then hit an uncaught
 * `auditTrail.deleteMany` that the `audit_trail_no_delete` immutability trigger
 * always rejects — so it raised a raw 500 *after* the destruction had already
 * committed. The fix: resolve all reads before `prisma.$transaction` opens, do
 * every write through `tx.`, and drop the audit deletions entirely (the
 * FILTER_RETIRED / FILTER_REPLACED rows are the §11 record and are retained).
 *
 * The two tests are a matched pair and only prove the fix together:
 *
 *   1. Happy path (no fault) — 200, replacement + all its child data GONE.
 *      This is the POSITIVE CONTROL: it proves the destruction statements
 *      actually execute and that control flow reaches the final
 *      `tx.assetInstance.delete(replacement)`. It also proves no audit row is
 *      deleted (old code could not return 200 at all — the trigger saw to it).
 *
 *   2. Atomicity (fault injected) — identical fixture plus one extra row, 500,
 *      and all of that same child data SURVIVES. Survival of the rows the
 *      handler deletes EARLY in the destruction block is the direct evidence
 *      of mid-transaction rollback.
 *
 * Fault injection
 * ---------------
 * Test 2 gives the replacement filter a child AssetInstance (`parentId` →
 * replacement). `asset_instances_parent_id_fkey` is ON DELETE RESTRICT, so the
 * handler's LAST statement — `tx.assetInstance.delete({ id: replacementId })` —
 * raises an FK violation inside the transaction, after every preceding write
 * has run. This is a synthetic-but-real DB constraint used purely as a fault
 * injector; no mocking is involved and the failure genuinely originates in the
 * database mid-transaction.
 *
 * A bogus `parentId` in the request body was rejected as an injection route:
 * `parentId` is written by the FIRST statement in the transaction, so the FK
 * would trip before any write landed — nothing to roll back, and the old
 * non-transactional code would have passed such a test too.
 *
 * Audit rows are never cleaned up: `audit_trail` is delete-protected by trigger.
 * They accumulate in `digilog_test_db` (as they do for every e2e login in this
 * suite). Re-runnability comes from the per-run SUFFIX, not from deleting them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import authPlugin from '../plugins/auth.js';
import rbacPlugin from '../plugins/rbac.js';
import authRoutes from '../modules/auth/routes.js';
import superAdminRoutes from '../modules/super-admin/routes.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { auditLog } from '../lib/audit.js';
import { loginAs } from './test-helper.js';

async function buildUnretireApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ajv: { customOptions: { keywords: ['example'] } } });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(authPlugin);
  await app.register(rbacPlugin);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
    }
    const status = err.statusCode ?? 500;
    return reply.code(status).send({ error: err.message || 'Internal Server Error' });
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(superAdminRoutes, { prefix: '/api/super-admin' });

  await app.ready();
  return app;
}

const SUFFIX = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// Unique SUPER_ADMIN per file — the shared `admin` user races across suites.
const SA_USERNAME = `SAUNR${SUFFIX}`.slice(0, 16).toUpperCase();
const SA_PASSWORD = 'Unretire@Test#1234';

/** Every id this file creates, so afterAll can tear down in FK-safe order. */
const created = {
  templateIds: [] as string[],
  profileIds: [] as string[],
  instanceIds: [] as string[],
};

interface Scenario {
  parentId: string;
  retiredFilterId: string;
  replacementId: string;
  cycleId: string;
  identifierValue: string;
  childId: string | null;
}

describe('POST /api/super-admin/filter-data/retirements/:id/unretire', () => {
  let app: FastifyInstance;
  let token: string;
  let saUserId: string;

  /**
   * Build a full retire→replace scenario: a parent AHU, a Retired filter that
   * remembers its pre-retire parent, and an Active replacement filter carrying
   * the child data the handler is expected to destroy (relationships,
   * identifier, cleaning cycle, filter event). The FILTER_RETIRED /
   * FILTER_REPLACED audit rows are written through the real `auditLog` so the
   * hash chain stays valid.
   *
   * `withFault` adds a child AssetInstance under the replacement, which makes
   * the handler's final delete trip asset_instances_parent_id_fkey (RESTRICT).
   */
  async function seedScenario(tag: string, withFault: boolean): Promise<Scenario> {
    const tpl = await prisma.assetTemplate.create({
      data: { name: `Unretire Tmpl ${tag}`, category: 'Filter', templateKind: 'FILTER' },
    });
    created.templateIds.push(tpl.id);

    const parent = await prisma.assetInstance.create({
      data: { name: `Unretire AHU ${tag}`, templateId: tpl.id, status: 'Active', isActive: true },
    });
    created.instanceIds.push(parent.id);

    // Retired filter: parentId detached, pre-retire parent stashed in
    // customAttributes — exactly what the retire flow leaves behind.
    const retired = await prisma.assetInstance.create({
      data: {
        name: `Unretire Filter ${tag}`,
        templateId: tpl.id,
        status: 'Retired',
        isActive: false,
        parentId: null,
        customAttributes: { _preRetireParentId: parent.id },
      },
    });
    created.instanceIds.push(retired.id);
    await prisma.filterDetails.create({
      data: { assetInstanceId: retired.id, currentLifecycleState: 'RETIRED' },
    });

    const replacement = await prisma.assetInstance.create({
      data: {
        name: `Unretire Replacement ${tag}`,
        templateId: tpl.id,
        status: 'Active',
        isActive: true,
        parentId: parent.id,
      },
    });
    created.instanceIds.push(replacement.id);
    await prisma.filterDetails.create({ data: { assetInstanceId: replacement.id } });

    await prisma.assetRelationship.createMany({
      data: [
        { sourceAssetId: parent.id, targetAssetId: replacement.id, relationshipType: 'CONTAINS' },
        { sourceAssetId: replacement.id, targetAssetId: parent.id, relationshipType: 'CONTAINED_IN' },
      ],
    });

    const identifierValue = `RFID-UNRET-${tag}`;
    await prisma.assetIdentifier.create({
      data: { assetId: replacement.id, identifierType: 'RFID', identifierValue },
    });

    // cleaning_cycles.profile_id → filter_cleaning_profiles(id) RESTRICT, so a
    // real profile row is required.
    const profile = await prisma.filterCleaningProfile.create({
      data: {
        lineageId: crypto.randomUUID(),
        name: `Unretire Profile ${tag}`,
        version: 1,
        status: 'ACTIVE',
        createdBy: saUserId,
      },
    });
    created.profileIds.push(profile.id);

    const cycle = await prisma.cleaningCycle.create({
      data: {
        cycleCode: `UNRET-${tag}`,
        filterId: replacement.id,
        profileId: profile.id,
        profileVersion: 1,
        sequenceNumber: 1,
        status: 'COMPLETED',
        cleaningReasonKey: 'ROUTINE',
        cleaningReasonLabel: 'Routine',
      },
    });
    // filter_details.current_cycle_id → cleaning_cycles(id) is ON DELETE SET
    // NULL, so the handler deleting the cycle before clearing the pointer is
    // safe; set it so the fixture mirrors a real in-service filter.
    await prisma.filterDetails.update({
      where: { assetInstanceId: replacement.id },
      data: { currentCycleId: cycle.id },
    });

    await prisma.filterEvent.create({
      data: {
        filterId: replacement.id,
        cycleId: cycle.id,
        eventType: 'CYCLE_STARTED',
        performedBy: saUserId,
        checksum: 'unretire-test-fixture-checksum',
        ipAddress: '127.0.0.1',
      },
    });

    await auditLog({
      userId: saUserId,
      userName: SA_USERNAME,
      userRole: 'SUPER_ADMIN',
      action: 'FILTER_RETIRED',
      targetType: 'filter',
      targetId: retired.id,
      afterValue: { status: 'Retired' },
    });
    // The handler resolves the replacement via afterValue.newFilterId — the key
    // name is load-bearing. If it drifts, replacementFilterId resolves null and
    // the destruction branch silently never runs; the happy-path assertion that
    // the replacement is GONE is what catches that.
    await auditLog({
      userId: saUserId,
      userName: SA_USERNAME,
      userRole: 'SUPER_ADMIN',
      action: 'FILTER_REPLACED',
      targetType: 'filter',
      targetId: retired.id,
      afterValue: { newFilterId: replacement.id },
    });

    let childId: string | null = null;
    if (withFault) {
      const child = await prisma.assetInstance.create({
        data: {
          name: `Unretire Child ${tag}`,
          templateId: tpl.id,
          status: 'Active',
          isActive: true,
          parentId: replacement.id,
        },
      });
      childId = child.id;
      created.instanceIds.push(child.id);
    }

    return {
      parentId: parent.id,
      retiredFilterId: retired.id,
      replacementId: replacement.id,
      cycleId: cycle.id,
      identifierValue,
      childId,
    };
  }

  const unretire = (id: string) =>
    app.inject({
      method: 'POST',
      url: `/api/super-admin/filter-data/retirements/${id}/unretire`,
      // Always send the correct reauth password: SUPER_ADMIN_DATA_EDIT reauth is
      // config-driven (off by default), and enforceReauth ignores the header when
      // the action isn't configured — so this is correct either way. A WRONG
      // password would trip the login lockout policy and brick the test user.
      headers: { authorization: `Bearer ${token}`, 'x-reauth-password': SA_PASSWORD },
      payload: {},
    });

  beforeAll(async () => {
    app = await buildUnretireApp();

    const passwordHash = await hashPassword(SA_PASSWORD);
    const user = await prisma.user.upsert({
      where: { username: SA_USERNAME },
      update: {
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        failedLoginAttempts: 0,
        lockedAt: null,
        lockoutUntil: null,
      },
      create: {
        username: SA_USERNAME,
        fullName: 'Unretire Test Admin',
        email: `${SA_USERNAME.toLowerCase()}@unretire-test.local`,
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        createdBy: 'unretire-test',
      },
    });
    saUserId = user.id;
    token = await loginAs(app, SA_USERNAME, SA_PASSWORD);
  });

  afterAll(async () => {
    // FK-safe teardown order: children before parents. audit_trail rows are
    // delete-protected by trigger and are deliberately left behind.
    try {
      const ids = created.instanceIds;
      await prisma.filterEvent.deleteMany({ where: { filterId: { in: ids } } });
      await prisma.cleaningCycle.deleteMany({ where: { filterId: { in: ids } } });
      await prisma.assetIdentifier.deleteMany({ where: { assetId: { in: ids } } });
      await prisma.assetRelationship.deleteMany({
        where: { OR: [{ sourceAssetId: { in: ids } }, { targetAssetId: { in: ids } }] },
      });
      await prisma.filterDetails.deleteMany({ where: { assetInstanceId: { in: ids } } });
      // Deepest-first: children reference parents via parent_id RESTRICT.
      for (const id of [...ids].reverse()) {
        await prisma.assetInstance.deleteMany({ where: { id } });
      }
      await prisma.assetInstance.deleteMany({ where: { id: { in: ids } } });
      await prisma.filterCleaningProfile.deleteMany({ where: { id: { in: created.profileIds } } });
      await prisma.assetTemplate.deleteMany({ where: { id: { in: created.templateIds } } });
      await prisma.session.updateMany({
        where: { user: { username: SA_USERNAME }, isActive: true },
        data: { isActive: false, terminationReason: 'unretire_test_cleanup' },
      });
    } catch {
      // Best-effort — never mask a test failure with a cleanup failure.
    }
    await app.close();
  });

  // ── 1. Happy path — positive control ───────────────────────────────
  it('restores the filter to Active, destroys the replacement, and RETAINS the §11 audit rows', async () => {
    const s = await seedScenario(`ok${SUFFIX}`, false);

    const auditWhere = {
      action: { in: ['FILTER_RETIRED', 'FILTER_REPLACED'] },
      targetId: s.retiredFilterId,
    };
    const auditBefore = await prisma.auditTrail.count({ where: auditWhere });
    expect(auditBefore).toBe(2);

    const res = await unretire(s.retiredFilterId);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });

    // Filter restored, and the pre-retire bookkeeping cleaned off.
    const filter = await prisma.assetInstance.findUnique({ where: { id: s.retiredFilterId } });
    expect(filter?.status).toBe('Active');
    expect(filter?.isActive).toBe(true);
    expect(filter?.parentId).toBe(s.parentId);
    expect((filter?.customAttributes as any)._preRetireParentId).toBeUndefined();

    const details = await prisma.filterDetails.findUnique({
      where: { assetInstanceId: s.retiredFilterId },
    });
    expect(details?.currentLifecycleState).toBeNull();

    // Parent containment restored (both directions).
    const rels = await prisma.assetRelationship.findMany({
      where: { OR: [{ sourceAssetId: s.retiredFilterId }, { targetAssetId: s.retiredFilterId }] },
    });
    expect(rels.map((r) => r.relationshipType).sort()).toEqual(['CONTAINED_IN', 'CONTAINS']);

    // Positive control: the replacement and ALL its child data are gone. This
    // proves the destruction statements ran and that control flow reached the
    // final tx.assetInstance.delete — which is what test 2 then rolls back.
    expect(await prisma.assetInstance.findUnique({ where: { id: s.replacementId } })).toBeNull();
    expect(await prisma.assetIdentifier.count({ where: { assetId: s.replacementId } })).toBe(0);
    expect(await prisma.filterEvent.count({ where: { filterId: s.replacementId } })).toBe(0);
    expect(await prisma.cleaningCycle.count({ where: { filterId: s.replacementId } })).toBe(0);
    expect(
      await prisma.assetRelationship.count({
        where: { OR: [{ sourceAssetId: s.replacementId }, { targetAssetId: s.replacementId }] },
      }),
    ).toBe(0);

    // The deliberate §11 behavior change: the retire/replace audit rows survive
    // an unretire. The old code tried to delete them, which the immutability
    // trigger rejected — it could never have reached the 200 above.
    expect(await prisma.auditTrail.count({ where: auditWhere })).toBe(auditBefore);
  });

  // ── 2. Atomicity — the load-bearing test ───────────────────────────
  it('rolls back every write when the transaction fails at the final delete', async () => {
    // Identical fixture to test 1 plus a child under the replacement, which
    // makes the LAST statement in the transaction violate
    // asset_instances_parent_id_fkey (RESTRICT) — after all preceding writes.
    const s = await seedScenario(`fail${SUFFIX}`, true);
    expect(s.childId).not.toBeNull();

    const res = await unretire(s.retiredFilterId);

    // Must be 500 specifically, not merely non-2xx: the handler doesn't catch, so
    // the Prisma FK error carries no statusCode and the error handler defaults it
    // to 500. Pinning the code proves the request actually reached the handler and
    // failed INSIDE the transaction. A looser `>= 400` would let a preHandler
    // short-circuit (e.g. a 401 if SUPER_ADMIN_DATA_EDIT reauth is ever switched on
    // in the test seed) satisfy the row-survival assertions below trivially — the
    // rows would survive because nothing ran, and this test would pass for the
    // wrong reason.
    expect(res.statusCode).toBe(500);

    // ── The rollback proof ──
    // These four row-sets are deleted EARLY in the destruction block, before
    // the statement that fails. Under the old non-transactional code they were
    // already committed and unrecoverable by the time the 500 was raised. Their
    // survival is the direct evidence of mid-transaction rollback.
    expect(await prisma.assetIdentifier.count({ where: { assetId: s.replacementId } })).toBe(1);
    expect(await prisma.filterEvent.count({ where: { filterId: s.replacementId } })).toBe(1);
    expect(await prisma.cleaningCycle.count({ where: { filterId: s.replacementId } })).toBe(1);
    expect(
      await prisma.assetRelationship.count({
        where: { OR: [{ sourceAssetId: s.replacementId }, { targetAssetId: s.replacementId }] },
      }),
    ).toBe(2);
    expect(await prisma.assetInstance.findUnique({ where: { id: s.replacementId } })).not.toBeNull();

    // The first two statements in the transaction also rolled back.
    const filter = await prisma.assetInstance.findUnique({ where: { id: s.retiredFilterId } });
    expect(filter?.status).toBe('Retired');
    expect(filter?.isActive).toBe(false);
    expect(filter?.parentId).toBeNull();
    expect((filter?.customAttributes as any)._preRetireParentId).toBe(s.parentId);

    const details = await prisma.filterDetails.findUnique({
      where: { assetInstanceId: s.retiredFilterId },
    });
    expect(details?.currentLifecycleState).toBe('RETIRED');

    // No new parent relationships were left behind for the retired filter.
    expect(
      await prisma.assetRelationship.count({
        where: { OR: [{ sourceAssetId: s.retiredFilterId }, { targetAssetId: s.retiredFilterId }] },
      }),
    ).toBe(0);
  });
});
