import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPost, authPut, authDelete, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';

const SUFFIX = Date.now();
const TEST_ROLE_NAME = `TEST_ROLE_${SUFFIX}`;

describe('Roles endpoints', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildApp();
    adminToken = await loginAs(app);
  });

  afterAll(async () => {
    // Cleanup: try to delete the test role in case a test left it behind
    await authDelete(app, `/api/roles/${TEST_ROLE_NAME}`, adminToken, ADMIN_PASSWORD, { reason: 'e2e cleanup' });
    await app.close();
  });

  // ===========================================================================
  // EXISTING TESTS (unchanged)
  // ===========================================================================

  describe('GET /api/roles', () => {
    it('returns all roles for admin', async () => {
      const res = await authGet(app, '/api/roles', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);

      // Check default system roles exist
      const names = body.map((r: any) => r.name);
      expect(names).toContain('SUPER_ADMIN');
      expect(names).toContain('ADMIN');
      expect(names).toContain('VIEWER');
    });
  });

  describe('GET /api/roles/active', () => {
    it('returns active roles', async () => {
      const res = await authGet(app, '/api/roles/active', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);

      // Each role should have basic fields
      for (const role of body) {
        expect(role.name).toBeTruthy();
        expect(role.displayName).toBeTruthy();
      }
    });
  });

  describe('GET /api/roles/:name', () => {
    it('returns a specific role', async () => {
      const res = await authGet(app, '/api/roles/ADMIN', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.name).toBe('ADMIN');
      expect(body.permissions).toBeDefined();
    });

    // Audit 2026-10-03, API-14: `description` is `String?`; a NULL used to
    // serialise as "" because the schema did not declare it nullable.
    it('serialises a NULL description as null, in the list and the detail', async () => {
      const name = `NULLDESC_${SUFFIX}`;
      await prisma.role.create({ data: { name, displayName: 'Null desc', hierarchyLevel: 1, permissions: [], description: null } });
      try {
        const one = JSON.parse((await authGet(app, `/api/roles/${name}`, adminToken)).body);
        expect(one).toHaveProperty('description');
        expect(one.description).toBeNull();
        const list = JSON.parse((await authGet(app, '/api/roles', adminToken)).body) as any[];
        expect(list.find((r) => r.name === name)?.description).toBeNull();
      } finally {
        await prisma.role.deleteMany({ where: { name } });
      }
    });

    it('returns 404 for non-existent role', async () => {
      const res = await authGet(app, '/api/roles/NONEXISTENT', adminToken);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/roles/permissions/all', () => {
    it('returns all available permissions', async () => {
      const res = await authGet(app, '/api/roles/permissions/all', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Response may be { permissions: [...] } or plain array
      const perms = body.permissions || body;
      if (Array.isArray(perms)) {
        expect(perms.length).toBeGreaterThan(0);
      } else {
        // It's an object with permission keys
        expect(Object.keys(perms).length).toBeGreaterThan(0);
      }
    });
  });

  describe('GET /api/roles/:name/creatable', () => {
    it('returns creatable roles for SUPER_ADMIN', async () => {
      const res = await authGet(app, '/api/roles/SUPER_ADMIN/creatable', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
    });
  });

  // ===========================================================================
  // NEW TESTS — POST / PUT / DELETE
  // ===========================================================================

  describe('POST /api/roles — Create role', () => {
    it('creates a new custom role', async () => {
      const res = await authPost(app, '/api/roles', adminToken, {
        name: TEST_ROLE_NAME,
        displayName: `Test Role ${SUFFIX}`,
        description: 'Role created by e2e test',
        hierarchyLevel: 1,
        permissions: ['AUDIT_READ'],
        color: '#22c55e',
      }, ADMIN_PASSWORD);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(body.data.name).toBe(TEST_ROLE_NAME);
      expect(body.data.displayName).toBe(`Test Role ${SUFFIX}`);
      expect(body.data.hierarchyLevel).toBe(1);
      expect(body.data.color).toBe('#22c55e');
    });

    it('returns 409 when creating a duplicate role name', async () => {
      const res = await authPost(app, '/api/roles', adminToken, {
        name: TEST_ROLE_NAME,
        displayName: 'Duplicate Role',
        hierarchyLevel: 1,
      }, ADMIN_PASSWORD);

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toBeTruthy();
    });

    it('returns 400 for invalid input (missing required fields)', async () => {
      const res = await authPost(app, '/api/roles', adminToken, {
        name: 'x', // Too short and lowercase
      }, ADMIN_PASSWORD);

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PUT /api/roles/:name — Update role', () => {
    it('updates the displayName of the test role', async () => {
      const newDisplayName = `Updated Role ${SUFFIX}`;
      const res = await authPut(app, `/api/roles/${TEST_ROLE_NAME}`, adminToken, {
        displayName: newDisplayName,
        description: 'Updated by e2e test',
      }, ADMIN_PASSWORD);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(body.data.displayName).toBe(newDisplayName);
    });

    // Audit 2026-10-03, DATA-11: a permission CHANGE needs a reason, and the
    // reason lands on the ROLE_UPDATED row. An unchanged list needs none.
    it('refuses a permission change without a reason (400 REASON_REQUIRED), writing nothing', async () => {
      const res = await authPut(app, `/api/roles/${TEST_ROLE_NAME}`, adminToken, {
        permissions: ['AUDIT_READ', 'CONFIG_READ'],
      }, ADMIN_PASSWORD);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('REASON_REQUIRED');
      const role = JSON.parse((await authGet(app, `/api/roles/${TEST_ROLE_NAME}`, adminToken)).body);
      expect(role.permissions).toEqual(['AUDIT_READ']);
    });

    it('updates permissions of the test role when a reason is given, and records it', async () => {
      const res = await authPut(app, `/api/roles/${TEST_ROLE_NAME}`, adminToken, {
        permissions: ['AUDIT_READ', 'CONFIG_READ'],
        reason: 'e2e: the role now reads configuration',
      }, ADMIN_PASSWORD);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.permissions).toContain('AUDIT_READ');
      expect(body.data.permissions).toContain('CONFIG_READ');
      const row = await prisma.auditTrail.findFirst({
        where: { action: 'ROLE_UPDATED', targetId: TEST_ROLE_NAME },
        orderBy: { timestamp: 'desc' },
      });
      expect(row?.reason).toBe('e2e: the role now reads configuration');
    });

    it('an unchanged permission list (the form echoing it back) needs no reason', async () => {
      const res = await authPut(app, `/api/roles/${TEST_ROLE_NAME}`, adminToken, {
        displayName: `Echo ${SUFFIX}`,
        permissions: ['CONFIG_READ', 'AUDIT_READ'],
      }, ADMIN_PASSWORD);
      expect(res.statusCode).toBe(200);
    });

    it('can update a system role displayName and color (restricted fields)', async () => {
      // Read current VIEWER role first
      const before = await authGet(app, '/api/roles/VIEWER', adminToken);
      const original = JSON.parse(before.body);

      const res = await authPut(app, '/api/roles/VIEWER', adminToken, {
        displayName: 'Viewer Updated',
        color: '#ef4444',
        // The Roles page sends the stored level back on every save; an echo
        // is not a change and must pass (audit 2026-10-03, API-15).
        hierarchyLevel: original.hierarchyLevel,
      }, ADMIN_PASSWORD);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.displayName).toBe('Viewer Updated');

      // Restore original values
      await authPut(app, '/api/roles/VIEWER', adminToken, {
        displayName: original.displayName,
        color: original.color,
      }, ADMIN_PASSWORD);
    });

    // Audit 2026-10-03, API-15: a system-role field that cannot change is
    // refused, not dropped with `success: true`.
    it('refuses to CHANGE a system role\'s hierarchyLevel or isActive (400), and writes nothing', async () => {
      const original = JSON.parse((await authGet(app, '/api/roles/VIEWER', adminToken)).body);
      const a = await authPut(app, '/api/roles/VIEWER', adminToken, { hierarchyLevel: original.hierarchyLevel + 1 }, ADMIN_PASSWORD);
      expect(a.statusCode).toBe(400);
      expect(JSON.parse(a.body).message).toMatch(/hierarchyLevel cannot be changed/);
      const b = await authPut(app, '/api/roles/VIEWER', adminToken, { isActive: false }, ADMIN_PASSWORD);
      expect(b.statusCode).toBe(400);
      const after = JSON.parse((await authGet(app, '/api/roles/VIEWER', adminToken)).body);
      expect(after.hierarchyLevel).toBe(original.hierarchyLevel);
      expect(after.isActive).toBe(true);
    });

    it('returns 404 for updating a non-existent role', async () => {
      const res = await authPut(app, '/api/roles/NONEXISTENT_ROLE_XYZ', adminToken, {
        displayName: 'Ghost',
      }, ADMIN_PASSWORD);

      expect(res.statusCode).toBe(404);
    });
  });

  /**
   * Audit 2026-10-03, API-15: deactivating a role revokes access NOW. Driven
   * through the seeded OPERATOR user (RB0001), temporarily moved onto the
   * test role, because SUPER_ADMIN short-circuits every permission check.
   */
  describe('PUT /api/roles/:name { isActive: false } — deactivation revokes access', () => {
    let operatorToken = '';

    beforeAll(async () => {
      await prisma.user.update({ where: { username: 'RB0001' }, data: { role: TEST_ROLE_NAME } });
      operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
    });

    afterAll(async () => {
      await prisma.user.update({ where: { username: 'RB0001' }, data: { role: 'OPERATOR' } });
      await prisma.role.updateMany({ where: { name: TEST_ROLE_NAME }, data: { isActive: true } });
      invalidateRolePermsCache(TEST_ROLE_NAME);
    });

    it('the role holder can read the audit trail while the role is active (control)', async () => {
      expect((await authGet(app, '/api/audit?limit=1', operatorToken)).statusCode).toBe(200);
    });

    it('deactivating ends the holder\'s session, and a fresh login holds no permissions', async () => {
      const res = await authPut(app, `/api/roles/${TEST_ROLE_NAME}`, adminToken, { isActive: false }, ADMIN_PASSWORD);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.isActive).toBe(false);

      // The bearer issued before the deactivation is dead: the session row
      // was ended in the same transaction as the role update.
      expect((await authGet(app, '/api/audit?limit=1', operatorToken)).statusCode).toBe(401);
      const ended = await prisma.session.findFirst({
        where: { user: { username: 'RB0001' }, terminationReason: 'role_deactivated' },
      });
      expect(ended).not.toBeNull();

      // Logging in again does not help: an inactive role holds nothing.
      const again = await loginAs(app, 'RB0001', 'Test@1234');
      expect((await authGet(app, '/api/audit?limit=1', again)).statusCode).toBe(403);
    });

    it('re-activating restores the role\'s grants', async () => {
      const res = await authPut(app, `/api/roles/${TEST_ROLE_NAME}`, adminToken, { isActive: true }, ADMIN_PASSWORD);
      expect(res.statusCode).toBe(200);
      const token = await loginAs(app, 'RB0001', 'Test@1234');
      expect((await authGet(app, '/api/audit?limit=1', token)).statusCode).toBe(200);
    });
  });

  describe('DELETE /api/roles/:name — Delete role', () => {
    it('returns 409 when deleting a role that has users assigned (SUPER_ADMIN)', async () => {
      // SUPER_ADMIN has the admin user assigned to it, so delete should return 409
      const res = await authDelete(app, '/api/roles/SUPER_ADMIN', adminToken, ADMIN_PASSWORD);

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toBeTruthy();
      expect(body.usersCount).toBeGreaterThan(0);
      // The count runs inside the delete's transaction (API-20); a refused
      // delete writes no audit row.
      expect(await prisma.auditTrail.count({ where: { action: 'ROLE_DELETED', targetId: 'SUPER_ADMIN' } })).toBe(0);
    });

    it('deletes the test role successfully, recording the reason', async () => {
      const res = await authDelete(app, `/api/roles/${TEST_ROLE_NAME}`, adminToken, ADMIN_PASSWORD, { reason: 'e2e: role retired' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      const row = await prisma.auditTrail.findFirst({
        where: { action: 'ROLE_DELETED', targetId: TEST_ROLE_NAME },
        orderBy: { timestamp: 'desc' },
      });
      expect(row?.reason).toBe('e2e: role retired');
    });

    it('returns 404 when deleting an already-deleted role', async () => {
      const res = await authDelete(app, `/api/roles/${TEST_ROLE_NAME}`, adminToken, ADMIN_PASSWORD);

      expect(res.statusCode).toBe(404);
    });
  });
});
