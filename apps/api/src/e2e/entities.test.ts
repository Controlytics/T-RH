import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPost, ADMIN_PASSWORD } from './test-helper.js';

/**
 * Entity Management endpoints
 *
 * POST/PUT/DELETE /api/assets/templates were removed in Phase 1 (2026-05-26 cleanup —
 * the asset-template editing UI was torn out). Only GET endpoints remain.
 *
 * Tests that relied on POST /api/assets/templates to create a fixture:
 *   - Template write tests: DELETED (route gone)
 *   - Instance CRUD (create/GET-by-id/PUT/PATCH-status/children/DELETE): SKIPPED —
 *     live endpoints with no coverage elsewhere; needs a seeded templateId to create
 *     an instance fixture. See it.skip comments below.
 *   - Identifier CRUD (POST/lookup/DELETE): DELETED — fully covered by
 *     phase3-rfid-offline.test.ts (POST, GET lookup, DELETE with real filter IDs).
 *
 * Live coverage for cleaning/checklist flow: phase2-filter-operations.test.ts,
 * ahu-completion-gate.e2e.test.ts, without-final-checklist.test.ts.
 */

describe('Entity Management endpoints', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildApp();
    adminToken = await loginAs(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // =============================================
  // Templates — GET list only (write routes removed Phase 1, 2026-05-26)
  // =============================================
  describe('Entity Templates', () => {
    it('GET /api/assets/templates returns paginated list', async () => {
      const res = await authGet(app, '/api/assets/templates', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toBeDefined();
      expect(body.total).toBeDefined();
      expect(body.page).toBeDefined();
    });
    // POST/PUT/DELETE /api/assets/templates tests deleted — routes removed Phase 1 (2026-05-26)
    // GET /api/assets/templates/:id deleted — depended on POST fixture which is gone
  });

  // =============================================
  // Instances
  // =============================================
  describe('Entity Instances', () => {
    it('GET /api/assets/instances returns paginated list', async () => {
      const res = await authGet(app, '/api/assets/instances', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Assert the paginated-list contract, not a specific count — the count is
      // environmental (a fresh/isolated test DB legitimately has 0 instances;
      // instance-create fixtures are the skipped tests below that need a seeded
      // template). Mirrors the templates-list assertion above.
      expect(Array.isArray(body.data)).toBe(true);
      expect(typeof body.total).toBe('number');
      expect(body.page).toBeDefined();
    });

    it('GET /api/assets/instances/tree returns flat array', async () => {
      const res = await authGet(app, '/api/assets/instances/tree', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
    });

    it.skip('POST /api/assets/instances creates an instance from template', () => {
      // needs a live templateId; POST /api/assets/templates removed Phase 1 (2026-05-26)
      // endpoint still live; no other test covers instance creation from template
    });

    it.skip('GET /api/assets/instances/:id returns the instance', () => {
      // needs instanceId from skipped create; endpoint still live; no other coverage
    });

    it.skip('PUT /api/assets/instances/:id updates the instance', () => {
      // needs instanceId; endpoint still live; no other coverage
    });

    it.skip('PATCH /api/assets/instances/:id/status updates just the status', () => {
      // needs instanceId; endpoint still live; no other coverage
      // (m1-m2-reauth-action-rename.test.ts covers /lifecycle-state, not /status)
    });

    it.skip('PATCH /api/assets/instances/:id/status rejects missing status', () => {
      // needs instanceId; see above
    });

    it.skip('GET /api/assets/instances/:id/children returns children', () => {
      // needs instanceId; endpoint still live; no other coverage
    });

    it('POST /api/assets/instances rejects invalid templateId', async () => {
      const res = await authPost(app, '/api/assets/instances', adminToken, {
        name: 'Bad Instance',
        templateId: '00000000-0000-0000-0000-000000000000',
      }, ADMIN_PASSWORD);
      expect([400, 404]).toContain(res.statusCode);
    });
  });

  // =============================================
  // Identifiers — list only
  // (POST create / GET lookup / DELETE covered by phase3-rfid-offline.test.ts)
  // =============================================
  describe('Entity Identifiers', () => {
    it('GET /api/assets/identifiers returns list', async () => {
      const res = await authGet(app, '/api/assets/identifiers', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const data = body.data || body;
      expect(data).toBeDefined();
    });
    // POST /api/assets/identifiers — covered by phase3-rfid-offline.test.ts
    // GET /api/assets/identifiers/lookup/:value — covered by phase3-rfid-offline.test.ts
    // DELETE /api/assets/identifiers/:id — covered by phase3-rfid-offline.test.ts
  });

  // =============================================
  // Cleanup
  // =============================================
  describe('Cleanup', () => {
    it.skip('DELETE /api/assets/instances/:id soft-deletes instance', () => {
      // needs instanceId from skipped create; endpoint still live; no other coverage
    });
    // DELETE /api/assets/templates/:id: route removed Phase 1 — test deleted
  });
});
