/**
 * Phase 3 — RFID & Offline route-layer e2e tests.
 *
 * Closes part of PHASE_5_RECENT_WORK.md § 11 (verification gap on Phase 3
 * RFID + offline-replay surfaces). Sister files cover other phases.
 *
 * What this file covers (Phase 3 specific):
 *   1. Identifier value lookup miss → 404 NOT_FOUND
 *   2. Identifier value lookup hit  → 200 with full asset payload (the
 *      RFID tablet uses this for offline cache priming)
 *   3. One-identifier-per-entity backend enforcement (409 ENTITY_HAS_IDENTIFIER)
 *   4. Duplicate identifier value across entities (409 DUPLICATE_IDENTIFIER_VALUE)
 *   5. Identifier delete round-trip (200)
 *   6. Offline-replay header skips reauth (sync-engine.ts sends
 *      `x-offline-replay: 'true'` so the backend does NOT prompt for password
 *      on replayed mutations)
 *   7. Same endpoint without the header AND without the password →
 *      401 REAUTH_REQUIRED (proves the gate is real, not vacuously open)
 *
 * What this file does NOT cover (and why):
 *   - POST /api/filters/:id/advance offlinePerformedAt round-trip:
 *     advance() requires a started cycle which needs block + cleaning
 *     profile + filter profile + pipeline graph + FilterDetails sidecar +
 *     cleaning reasons fixtures. That setup is multi-table and outside the
 *     scope of a route-layer test. The test-helper used by the rest of the
 *     e2e suite does not register filterOperationsRoutes. The
 *     offline-replay branch of enforceReauth() is shared with the
 *     identifier endpoint and is exercised here. See it.skip below.
 *
 * Test infrastructure:
 *   Uses the existing buildApp() / loginAs() helpers from test-helper.ts —
 *   real Fastify, real prisma against the local digilog_db. assetRoutes is
 *   already mounted, which includes identifier.routes.ts. No new
 *   dependencies; no production code modified.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPost, authDelete, obtainOfflineGrant, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';

// Unique suffix isolates this run's fixtures from other suites.
const SUFFIX = `p3-${Date.now().toString(36)}`;

describe('Phase 3 — RFID & Offline (identifier lookup + offline-replay header)', () => {
  let app: FastifyInstance;
  let adminToken: string;

  // Fixtures created in beforeAll, cleaned in afterAll
  let templateId: string;
  let assetA: string;            // first entity, gets one identifier
  let assetB: string;            // second entity, used for "duplicate value across entities" test
  let identifierA: string;       // identifier on assetA (deleted in tests 5/6)
  const identValueA = `RFID-${SUFFIX}-A`;
  const identValueB = `RFID-${SUFFIX}-B`;

  // Snapshot of the action-reauth row prior to test mutation, restored in afterAll
  let originalReauthConfigValue: unknown = undefined;
  let reauthRowExisted = false;

  beforeAll(async () => {
    app = await buildApp();
    adminToken = await loginAs(app);

    // ---- Fixtures: template + two entities --------------------------------
    const template = await prisma.assetTemplate.create({
      data: {
        name: `P3 Template ${SUFFIX}`,
        category: 'Equipment',
        attributeSchema: [],
        telemetrySchema: [],
        expectedIdentifiers: [],
        createdBy: 'system',
      },
    });
    templateId = template.id;

    const a = await prisma.assetInstance.create({
      data: {
        name: `P3 Asset A ${SUFFIX}`,
        templateId,
        attributes: {},
        createdBy: 'system',
      },
    });
    assetA = a.id;

    const b = await prisma.assetInstance.create({
      data: {
        name: `P3 Asset B ${SUFFIX}`,
        templateId,
        attributes: {},
        createdBy: 'system',
      },
    });
    assetB = b.id;

    // ---- Snapshot existing action-reauth row so we can restore it later ---
    const existingRow = await prisma.systemConfig.findUnique({
      where: { configKey: 'action-reauth' },
    });
    if (existingRow) {
      reauthRowExisted = true;
      originalReauthConfigValue = existingRow.configValue;
    }
  });

  afterAll(async () => {
    // Best-effort cleanup of fixtures (delete identifiers first to satisfy FKs)
    try {
      await prisma.assetIdentifier.deleteMany({
        where: { assetId: { in: [assetA, assetB].filter(Boolean) } },
      });
      if (assetA) await prisma.assetInstance.delete({ where: { id: assetA } }).catch(() => undefined);
      if (assetB) await prisma.assetInstance.delete({ where: { id: assetB } }).catch(() => undefined);
      if (templateId) await prisma.assetTemplate.delete({ where: { id: templateId } }).catch(() => undefined);
    } catch {
      // swallow — cleanup is best-effort, real assertion failures are surfaced by tests
    }

    // Restore action-reauth row (or delete it if it didn't exist before)
    if (reauthRowExisted) {
      await prisma.systemConfig.update({
        where: { configKey: 'action-reauth' },
        data: { configValue: originalReauthConfigValue as any },
      }).catch(() => undefined);
    } else {
      await prisma.systemConfig.delete({
        where: { configKey: 'action-reauth' },
      }).catch(() => undefined);
    }
    invalidateReauthCache();

    await app.close();
  });

  // =========================================================================
  // 1. Identifier value lookup miss
  // =========================================================================
  it('GET /api/assets/identifiers/lookup/:value returns 404 when value not found', async () => {
    const res = await authGet(
      app,
      `/api/assets/identifiers/lookup/NONEXISTENT-${SUFFIX}-${Math.random().toString(36).slice(2)}`,
      adminToken,
    );
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    // AppError code is in `error`; message is human-readable.
    expect(body.error || body.message).toBeTruthy();
  });

  // =========================================================================
  // 2. Identifier value lookup hit (after creating one)
  // =========================================================================
  it('POST /api/assets/identifiers + GET /api/assets/identifiers/lookup/:value returns the asset', async () => {
    // Create identifier on assetA via the route (exercises real route + service)
    const createRes = await authPost(
      app,
      '/api/assets/identifiers',
      adminToken,
      {
        assetId: assetA,
        identifierType: 'RFID',
        identifierValue: identValueA,
        isPrimary: true,
      },
      ADMIN_PASSWORD,
    );
    expect([200, 201]).toContain(createRes.statusCode);
    const createBody = JSON.parse(createRes.body);
    const identData = createBody.data || createBody;
    expect(identData.id).toBeTruthy();
    expect(identData.identifierValue).toBe(identValueA);
    identifierA = identData.id;

    // Lookup by value — backbone of the offline RFID cache
    const lookupRes = await authGet(
      app,
      `/api/assets/identifiers/lookup/${identValueA}`,
      adminToken,
    );
    expect(lookupRes.statusCode).toBe(200);
    const lookupBody = JSON.parse(lookupRes.body);
    expect(lookupBody.identifierValue).toBe(identValueA);
    expect(lookupBody.assetId).toBe(assetA);
    // Service includes the asset relation with template + identifiers
    expect(lookupBody.asset).toBeTruthy();
    expect(lookupBody.asset.id).toBe(assetA);
  });

  // =========================================================================
  // 3. One-identifier-per-entity backend enforcement
  // =========================================================================
  it('POST /api/assets/identifiers rejects a SECOND identifier on the same entity (409 ENTITY_HAS_IDENTIFIER)', async () => {
    // assetA already has identifierA from test 2; try to add another
    const res = await authPost(
      app,
      '/api/assets/identifiers',
      adminToken,
      {
        assetId: assetA,
        identifierType: 'QR',
        identifierValue: `OTHER-${SUFFIX}`,
      },
      ADMIN_PASSWORD,
    );
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('ENTITY_HAS_IDENTIFIER');
  });

  // =========================================================================
  // 4. Duplicate identifier value across entities
  // =========================================================================
  it('POST /api/assets/identifiers rejects a duplicate VALUE on a DIFFERENT entity (409 DUPLICATE_IDENTIFIER_VALUE)', async () => {
    // assetB has no identifier yet, but identValueA is taken by assetA
    const res = await authPost(
      app,
      '/api/assets/identifiers',
      adminToken,
      {
        assetId: assetB,
        identifierType: 'RFID',
        identifierValue: identValueA,   // same value as assetA's identifier
      },
      ADMIN_PASSWORD,
    );
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('DUPLICATE_IDENTIFIER_VALUE');
  });

  // =========================================================================
  // 5. Identifier delete round-trip
  // =========================================================================
  it('DELETE /api/assets/identifiers/:id removes the identifier (200)', async () => {
    expect(identifierA).toBeTruthy();
    // The route has a body schema (type:'object') for the optional `reason` field.
    // Fastify rejects a bodyless DELETE with 400; the web client (api-client.ts)
    // already sends `body: JSON.stringify({})` for all DELETE calls (2026-05-21
    // Android Content-Type fix). Pass {} here to match that real-client behaviour.
    const res = await authDelete(
      app,
      `/api/assets/identifiers/${identifierA}`,
      adminToken,
      ADMIN_PASSWORD,
      {},
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // Verify the identifier is actually gone (lookup returns 404)
    const lookupRes = await authGet(
      app,
      `/api/assets/identifiers/lookup/${identValueA}`,
      adminToken,
    );
    expect(lookupRes.statusCode).toBe(404);
  });

  // =========================================================================
  // 6. Offline-replay grant token skips reauth on a route guarded by enforceReauth
  //
  // Audit 2026-05-04 fix C1: bare `x-offline-replay: true` header is no longer
  // accepted. sync-engine.ts now obtains a signed grant via
  // POST /api/auth/offline-grant at login, sends it as
  //   headers['x-offline-replay-token'] = '<jwt>'
  // and the backend auth plugin (plugins/auth.ts) verifies + decorates
  // req.offlineReplayVerified, which reauth-check.ts honors. Grant is bound
  // to the calling user + session — a stolen JWT cannot mint one.
  // =========================================================================
  it('POST /api/assets/identifiers with x-offline-replay-token skips reauth (no password needed)', async () => {
    // 6a — Inject a real reauth requirement in the schema-correct shape
    //      (Record<string, string[]>). The seed file uses {actions:[...]}
    //      which does not match actionReauthConfigSchema, so we override
    //      explicitly to make the gate observable.
    await prisma.systemConfig.upsert({
      where: { configKey: 'action-reauth' },
      update: {
        configValue: {
          CREATE_ASSET_IDENTIFIER: ['SUPER_ADMIN', 'ADMIN'],
        },
      },
      create: {
        configKey: 'action-reauth',
        configValue: {
          CREATE_ASSET_IDENTIFIER: ['SUPER_ADMIN', 'ADMIN'],
        },
        configType: 'security',
        requiresReauth: true,
      },
    });
    // The reauth-check module caches config for 10s in-memory — invalidate
    // so our injection is visible immediately.
    invalidateReauthCache();

    // Sanity check 6b: WITHOUT password and WITHOUT header → 401 REAUTH_REQUIRED.
    // This proves the gate is actually live and our injected config is taking effect.
    const gateCheck = await app.inject({
      method: 'POST',
      url: '/api/assets/identifiers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        assetId: assetB,
        identifierType: 'RFID',
        identifierValue: `${identValueB}-gatecheck`,
      },
    });
    expect(gateCheck.statusCode).toBe(401);
    const gateBody = JSON.parse(gateCheck.body);
    expect(gateBody.error).toBe('REAUTH_REQUIRED');

    // 6c: obtain a real signed grant, then call with x-offline-replay-token
    //     (no password required) → 201 created
    const offlineGrant = await obtainOfflineGrant(app, adminToken);
    const replayRes = await app.inject({
      method: 'POST',
      url: '/api/assets/identifiers',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'x-offline-replay-token': offlineGrant,
      },
      payload: {
        assetId: assetB,
        identifierType: 'RFID',
        identifierValue: identValueB,
      },
    });
    expect([200, 201]).toContain(replayRes.statusCode);
    const replayBody = JSON.parse(replayRes.body);
    const replayData = replayBody.data || replayBody;
    expect(replayData.identifierValue).toBe(identValueB);
    expect(replayData.assetId).toBe(assetB);

    // 6d: bare legacy header is now rejected — proves the cutover is real.
    const legacyRes = await app.inject({
      method: 'POST',
      url: '/api/assets/identifiers',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'x-offline-replay': 'true',
      },
      payload: {
        assetId: assetB,
        identifierType: 'RFID',
        identifierValue: `${identValueB}-legacy-rejected`,
      },
    });
    expect(legacyRes.statusCode).toBe(401);
    expect(JSON.parse(legacyRes.body).error).toBe('OFFLINE_REPLAY_HEADER_DEPRECATED');
  });

  // =========================================================================
  // 7. offlinePerformedAt round-trip on /advance — SKIPPED.
  //
  // The advance() endpoint preserves data.offlinePerformedAt as the
  // regulatory timestamp on the resulting FilterEvent (see
  // apps/api/src/modules/filter-operations/cycle-write/advance.ts L28 +
  // submit-checklist.ts L141). Verifying this end-to-end requires a
  // started cycle, which in turn needs:
  //   block + cleaning profile (with pipeline graph) + filter profile +
  //   FilterDetails sidecar + cleaning reasons fixtures + filter mounted on
  //   the block, plus the filter-operations route module registered on the
  //   test app (test-helper.ts currently does not register it).
  // That setup is multi-table and out of scope for a route-layer Phase 3
  // test. The offline-replay branch (the other half of the offline
  // contract) IS exercised in test 6 above via the identifier endpoint,
  // which shares the same enforceReauth() gate.
  // =========================================================================
  it.skip('POST /api/filters/:id/advance preserves offlinePerformedAt timestamp on FilterEvent (requires cycle setup)', () => {
    // Intentionally skipped — see block comment above for justification.
  });
});
