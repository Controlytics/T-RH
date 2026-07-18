import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPost, authPut, authDelete, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

// Unique suffix to avoid collisions between test runs.
// Used to build a 6-char uppercase alphanumeric username that satisfies
// the default User ID config (format LETTERS_NUMBERS, length 6, UPPERCASE).
const SUFFIX = Date.now().toString(36).toUpperCase().slice(-4);

describe('Users endpoints', () => {
  let app: FastifyInstance;
  let adminToken: string;

  // Snapshot + restore user-id config so our generated username always
  // conforms, regardless of what the operator has customised in the live DB.
  // The live DB currently uses PREFIX_LETTERS_NUMBERS/EMP/7 which would reject
  // our 6-char LETTERS_NUMBERS username. We seed a known-permissive default
  // that matches our TS<SUFFIX> username, then restore the original in afterAll.
  let originalUserIdValue: unknown = undefined;
  let userIdRowExisted = false;

  beforeAll(async () => {
    // 1. Save current user-id config (may be operator-customised)
    const existingRow = await prisma.systemConfig.findUnique({
      where: { configKey: 'user-id' },
    });
    if (existingRow) {
      userIdRowExisted = true;
      originalUserIdValue = existingRow.configValue;
    }

    // 2. Seed a known-permissive config that matches our TS<SUFFIX> username:
    //    LETTERS_NUMBERS / length 6 / UPPERCASE. validateUserId() reads the DB
    //    on every call (no cache), so this takes effect immediately.
    await prisma.systemConfig.upsert({
      where: { configKey: 'user-id' },
      update: {
        configValue: {
          format: 'LETTERS_NUMBERS',
          length: 6,
          letterCase: 'UPPERCASE',
          prefix: '',
          prefixSeparator: '-',
        },
      },
      create: {
        configKey: 'user-id',
        configValue: {
          format: 'LETTERS_NUMBERS',
          length: 6,
          letterCase: 'UPPERCASE',
          prefix: '',
          prefixSeparator: '-',
        },
        configType: 'security',
        requiresReauth: false,
      },
    });

    app = await buildApp();
    adminToken = await loginAs(app);
  });

  afterAll(async () => {
    await app.close();

    // Restore the user-id config to exactly what it was before the test ran.
    if (userIdRowExisted) {
      await prisma.systemConfig.update({
        where: { configKey: 'user-id' },
        data: { configValue: originalUserIdValue as any },
      }).catch(() => undefined);
    } else {
      await prisma.systemConfig.delete({
        where: { configKey: 'user-id' },
      }).catch(() => undefined);
    }
  });

  // =============================================
  // Existing tests — list, stats, reset-requests
  // =============================================

  describe('GET /api/users', () => {
    it('returns paginated user list for admin', async () => {
      const res = await authGet(app, '/api/users', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toBeDefined();
      expect(body.total).toBeDefined();
      expect(body.page).toBeDefined();
      expect(body.limit).toBeDefined();
      expect(body.totalPages).toBeDefined();
    });

    it('supports pagination query params', async () => {
      const res = await authGet(app, '/api/users?page=1&limit=5', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.limit).toBe(5);
    });
  });

  describe('GET /api/users/stats', () => {
    it('returns user statistics', async () => {
      const res = await authGet(app, '/api/users/stats', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total).toBeDefined();
    });
  });

  describe('GET /api/users/reset-requests', () => {
    it('returns reset requests', async () => {
      const res = await authGet(app, '/api/users/reset-requests', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // May be { data: [...] } or direct array
      const data = body.data || body;
      expect(data).toBeDefined();
    });
  });

  describe('GET /api/users/reset-requests/pending', () => {
    it('returns pending reset requests info', async () => {
      const res = await authGet(app, '/api/users/reset-requests/pending', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // May be { count: N } or plain array
      expect(body).toBeDefined();
    });
  });

  describe('Access control', () => {
    it('requires authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/users' });
      expect(res.statusCode).toBe(401);
    });
  });

  // =============================================
  // New tests — CRUD lifecycle for a single user
  // =============================================

  describe('User CRUD lifecycle', () => {
    const TEST_USERNAME = `TS${SUFFIX}`;  // e.g. "TS1A2B" — 6 uppercase alphanumeric chars
    const TEST_PASSWORD = 'TestPass@123';
    const TEST_EMAIL = `testuser-${SUFFIX.toLowerCase()}@example.com`;
    let createdUserId: string;

    // ---- 1. POST /api/users — Create user ----
    describe('POST /api/users', () => {
      it('creates a new user', async () => {
        const res = await authPost(app, '/api/users', adminToken, {
          username: TEST_USERNAME,
          fullName: 'Test User E2E',
          email: TEST_EMAIL,
          role: 'OPERATOR',
          password: TEST_PASSWORD,
          confirmPassword: TEST_PASSWORD,
        }, ADMIN_PASSWORD);

        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body.id).toBeTruthy();
        expect(body.username).toBe(TEST_USERNAME);
        expect(body.fullName).toBe('Test User E2E');
        expect(body.email).toBe(TEST_EMAIL);
        expect(body.role).toBe('OPERATOR');
        expect(body.status).toBe('ENABLED');
        createdUserId = body.id;
      });

      it('rejects duplicate username', async () => {
        const res = await authPost(app, '/api/users', adminToken, {
          username: TEST_USERNAME,
          fullName: 'Duplicate User',
          email: `dup-${SUFFIX.toLowerCase()}@example.com`,
          role: 'OPERATOR',
          password: TEST_PASSWORD,
          confirmPassword: TEST_PASSWORD,
        }, ADMIN_PASSWORD);

        expect(res.statusCode).toBe(409);
      });
    });

    // ---- 2. GET /api/users/:id — Get user by ID ----
    describe('GET /api/users/:id', () => {
      it('returns full user detail', async () => {
        expect(createdUserId).toBeTruthy();
        const res = await authGet(app, `/api/users/${createdUserId}`, adminToken);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.id).toBe(createdUserId);
        expect(body.username).toBe(TEST_USERNAME);
        expect(body.fullName).toBe('Test User E2E');
        expect(body.email).toBe(TEST_EMAIL);
        expect(body.role).toBe('OPERATOR');
        expect(body.status).toBe('ENABLED');
        expect(body.createdAt).toBeDefined();
        expect(body.updatedAt).toBeDefined();
      });

      it('returns 404 for non-existent user', async () => {
        const fakeId = '00000000-0000-0000-0000-000000000000';
        const res = await authGet(app, `/api/users/${fakeId}`, adminToken);
        expect(res.statusCode).toBe(404);
      });
    });

    // ---- 3. PUT /api/users/:id — Update user ----
    describe('PUT /api/users/:id', () => {
      it('updates user fullName', async () => {
        expect(createdUserId).toBeTruthy();
        const res = await authPut(app, `/api/users/${createdUserId}`, adminToken, {
          fullName: 'Updated Test User',
        }, ADMIN_PASSWORD);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.fullName).toBe('Updated Test User');
      });

      it('verifies update persisted via GET', async () => {
        const res = await authGet(app, `/api/users/${createdUserId}`, adminToken);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.fullName).toBe('Updated Test User');
      });

      // Reported bug (2026-07-08): editing a user (e.g. changing role) with a
      // blank email was rejected as if email were mandatory. Email is optional —
      // an empty string must update cleanly and clear the stored email to NULL.
      it('accepts an empty email (email is optional) and clears it to null', async () => {
        const res = await authPut(app, `/api/users/${createdUserId}`, adminToken, {
          fullName: 'Updated Test User',
          email: '',
        }, ADMIN_PASSWORD);
        expect(res.statusCode).toBe(200);

        const check = await authGet(app, `/api/users/${createdUserId}`, adminToken);
        const body = JSON.parse(check.body);
        // Stored as NULL (serialized as null/absent/'' — never a validation error).
        expect(body.email == null || body.email === '').toBe(true);
      });
    });

    // ---- 4. POST /api/users/:id/disable — Disable user ----
    describe('POST /api/users/:id/disable', () => {
      it('disables the user', async () => {
        expect(createdUserId).toBeTruthy();
        const res = await authPost(app, `/api/users/${createdUserId}/disable`, adminToken, {}, ADMIN_PASSWORD);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
      });

      it('verifies user is disabled via GET', async () => {
        const res = await authGet(app, `/api/users/${createdUserId}`, adminToken);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.status).toBe('DISABLED');
      });
    });

    // ---- 5. POST /api/users/:id/enable — Enable user ----
    describe('POST /api/users/:id/enable', () => {
      it('re-enables the user', async () => {
        expect(createdUserId).toBeTruthy();
        const res = await authPost(app, `/api/users/${createdUserId}/enable`, adminToken, {}, ADMIN_PASSWORD);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
      });

      it('verifies user is enabled via GET', async () => {
        const res = await authGet(app, `/api/users/${createdUserId}`, adminToken);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.status).toBe('ENABLED');
      });
    });

    // ---- 6. POST /api/users/:id/unlock — Unlock user ----
    describe('POST /api/users/:id/unlock', () => {
      it('unlocks the user with a new temporary password', async () => {
        expect(createdUserId).toBeTruthy();
        const res = await authPost(app, `/api/users/${createdUserId}/unlock`, adminToken, {
          newPassword: 'Unlocked@123',
        }, ADMIN_PASSWORD);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(body.message).toBeDefined();
      });
    });

    // ---- 7. POST /api/users/:id/reset-password — Admin reset password ----
    describe('POST /api/users/:id/reset-password', () => {
      it('resets the user password', async () => {
        expect(createdUserId).toBeTruthy();
        const res = await authPost(app, `/api/users/${createdUserId}/reset-password`, adminToken, {
          newPassword: 'ResetPass@123',
        }, ADMIN_PASSWORD);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(body.message).toBeDefined();
      });
    });

    // ---- 8. DELETE /api/users/:id — Delete user ----
    describe('DELETE /api/users/:id', () => {
      it('deletes the user', async () => {
        expect(createdUserId).toBeTruthy();
        const res = await authDelete(app, `/api/users/${createdUserId}`, adminToken, ADMIN_PASSWORD);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
      });

      it('returns 404 after deletion', async () => {
        const res = await authGet(app, `/api/users/${createdUserId}`, adminToken);
        expect(res.statusCode).toBe(404);
      });
    });
  });
});
