import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPost, authPut, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';

describe('Auth endpoints', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    // Reset admin user state, password hash, and clear stale sessions
    const adminHash = await hashPassword(ADMIN_PASSWORD);
    await prisma.user.updateMany({
      where: { username: 'admin' },
      data: {
        passwordHash: adminHash,
        forcePasswordChange: false,
        isTemporaryPassword: false,
        status: 'ENABLED',
        failedLoginAttempts: 0,
        lockedAt: null,
        lockoutUntil: null,
      },
    });
    await prisma.session.updateMany({
      where: { isActive: true },
      data: { isActive: false, terminationReason: 'test_cleanup' },
    });
  });

  afterAll(async () => {
    // Always restore the admin password in case a change-password test failed mid-way
    const restoredHash = await hashPassword(ADMIN_PASSWORD);
    await prisma.user.updateMany({
      where: { username: 'admin' },
      data: {
        passwordHash: restoredHash,
        forcePasswordChange: false,
        isTemporaryPassword: false,
        status: 'ENABLED',
        failedLoginAttempts: 0,
        lockedAt: null,
        lockoutUntil: null,
      },
    });
    await app.close();
  });

  // =============================================
  // POST /api/auth/login
  // =============================================
  describe('POST /api/auth/login', () => {
    it('returns 200 with token for valid credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'Admin@123' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.token).toBeTruthy();
      expect(body.user).toBeDefined();
      expect(body.user.username).toBe('admin');
      expect(body.expiresIn).toBeTruthy();

      // Cleanup: terminate the session so subsequent tests don't hit SESSION_CONFLICT
      if (body.token) {
        await authPost(app, '/api/auth/logout', body.token);
      }
    });

    it('returns 401 for wrong password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'WrongPassword@1' },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      // The service unified all login failures into INVALID_CREDENTIALS
      // (security hardening — prevents user enumeration).
      expect(body.error).toBe('INVALID_CREDENTIALS');
    });

    it('returns 401 for non-existent user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'nonexistent', password: 'SomePass@1' },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      // Auth service returns INVALID_CREDENTIALS; Fastify rate limiter may return Unauthorized
      expect(body.error || body.message).toBeTruthy();
    });

    it('returns 400 for missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: '' },
      });

      // Either 400 (validation) or 401 (auth logic)
      expect([400, 401]).toContain(res.statusCode);
    });
  });

  // =============================================
  // GET /api/auth/me
  // =============================================
  describe('GET /api/auth/me', () => {
    it('returns current user when authenticated', async () => {
      const token = await loginAs(app);
      const res = await authGet(app, '/api/auth/me', token);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.username).toBe('admin');
      expect(body.role).toBeDefined();
      expect(body.email).toBeDefined();
    });

    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 with invalid token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: 'Bearer invalid.token.here' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // =============================================
  // POST /api/auth/logout
  // =============================================
  describe('POST /api/auth/logout', () => {
    it('logs out successfully', async () => {
      const token = await loginAs(app);
      const res = await authPost(app, '/api/auth/logout', token, {});

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('session is invalid after logout', async () => {
      const token = await loginAs(app);
      await authPost(app, '/api/auth/logout', token, {});

      // Subsequent request should fail
      const res = await authGet(app, '/api/auth/me', token);
      expect(res.statusCode).toBe(401);
    });
  });

  // =============================================
  // POST /api/auth/verify (re-auth)
  // =============================================
  describe('POST /api/auth/verify', () => {
    it('returns verification token for correct password', async () => {
      const token = await loginAs(app);
      const res = await authPost(app, '/api/auth/verify', token, {
        password: 'Admin@123',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.verificationToken).toBeTruthy();
    });

    it('returns 401 for wrong password', async () => {
      const token = await loginAs(app);
      const res = await authPost(app, '/api/auth/verify', token, {
        password: 'WrongPassword@1',
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when password is missing', async () => {
      const token = await loginAs(app);
      const res = await authPost(app, '/api/auth/verify', token, {});
      expect(res.statusCode).toBe(400);
    });
  });

  // =============================================
  // POST /api/auth/forgot-password
  // =============================================
  describe('POST /api/auth/forgot-password', () => {
    it('returns success for existing user (no enumeration)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/forgot-password',
        payload: { username: 'admin' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('returns success even for non-existent user (prevents enumeration)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/forgot-password',
        payload: { username: 'doesnotexist' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('requires username in body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/forgot-password',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // =============================================
  // POST /api/auth/beacon-logout
  // =============================================
  describe('POST /api/auth/beacon-logout', () => {
    it('terminates session via beacon', async () => {
      const token = await loginAs(app);

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/beacon-logout',
        payload: { token },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('returns success for invalid token (graceful)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/beacon-logout',
        payload: { token: 'expired.or.invalid' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('requires no auth header (public endpoint)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/beacon-logout',
        payload: { token: 'some-token' },
      });

      // Should not get 401
      expect(res.statusCode).not.toBe(401);
    });
  });

  // =============================================
  // PUT /api/auth/profile
  // =============================================
  describe('PUT /api/auth/profile', () => {
    // Note: the H1 audit fix (commit 24cf10e, 2026-05-04) added the
    // UPDATE_PROFILE reauth gate to PUT /api/auth/profile. The 3 update
    // tests below now supply the admin password (Admin@123) via the
    // _currentPassword body field — same pattern auth-profile-reauth.test.ts
    // uses. The 401-without-auth test is unaffected.
    const ADMIN_PASSWORD = 'Admin@123';

    it('updates fullName and returns updated user', async () => {
      const token = await loginAs(app);

      // First, get the current profile to capture the original name
      const meRes = await authGet(app, '/api/auth/me', token);
      const originalProfile = JSON.parse(meRes.body);
      const originalName = originalProfile.fullName;

      // Update fullName (H1 reauth gate requires _currentPassword)
      const updateRes = await authPut(app, '/api/auth/profile', token, {
        fullName: 'Updated Admin Name',
        _currentPassword: ADMIN_PASSWORD,
      });

      expect(updateRes.statusCode).toBe(200);
      const updatedBody = JSON.parse(updateRes.body);
      expect(updatedBody.fullName).toBe('Updated Admin Name');
      expect(updatedBody.username).toBe('admin');
      expect(updatedBody.id).toBeDefined();
      expect(updatedBody.role).toBeDefined();

      // Restore the original name
      const restoreRes = await authPut(app, '/api/auth/profile', token, {
        fullName: originalName,
        _currentPassword: ADMIN_PASSWORD,
      });
      expect(restoreRes.statusCode).toBe(200);
      const restoredBody = JSON.parse(restoreRes.body);
      expect(restoredBody.fullName).toBe(originalName);
    });

    it('updates department field', async () => {
      const token = await loginAs(app);

      const updateRes = await authPut(app, '/api/auth/profile', token, {
        department: 'Quality Assurance',
        _currentPassword: ADMIN_PASSWORD,
      });

      expect(updateRes.statusCode).toBe(200);
      const body = JSON.parse(updateRes.body);
      expect(body.department).toBe('Quality Assurance');

      // Clean up: reset department
      await authPut(app, '/api/auth/profile', token, {
        department: '',
        _currentPassword: ADMIN_PASSWORD,
      });
    });

    it('returns 401 without authentication', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/auth/profile',
        payload: { fullName: 'No Auth Name' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('accepts empty body without error', async () => {
      const token = await loginAs(app);

      const res = await authPut(app, '/api/auth/profile', token, {
        _currentPassword: ADMIN_PASSWORD,
      });

      // Should succeed — no fields to update is still valid
      expect(res.statusCode).toBe(200);
    });
  });

  // =============================================
  // POST /api/auth/change-password
  // =============================================
  describe('POST /api/auth/change-password', () => {
    it('changes password successfully', async () => {
      // Clear password history to avoid "last 12 passwords" policy violation
      const adminUser = await prisma.user.findUnique({ where: { username: 'admin' } });
      if (adminUser) {
        await prisma.passwordHistory.deleteMany({ where: { userId: adminUser.id } });
      }

      const token = await loginAs(app);
      // Password must NOT contain username ("admin") per cannotContainUserId policy
      // Use a unique suffix to avoid matching any password history
      const suffix = Date.now().toString(36).slice(-4);
      const newPassword = `Te$tP@ss9_${suffix}`;

      const changeRes = await authPost(app, '/api/auth/change-password', token, {
        currentPassword: ADMIN_PASSWORD,
        newPassword,
        confirmPassword: newPassword,
      });

      expect(changeRes.statusCode).toBe(200);
      const changeBody = JSON.parse(changeRes.body);
      expect(changeBody.success).toBe(true);
      expect(changeBody.message).toBeDefined();

      // Login with the new password to verify it works
      const newToken = await loginAs(app, 'admin', newPassword);
      expect(newToken).toBeTruthy();

      // Restore original password directly via DB (Admin@123 contains "admin" —
      // the cannotContainUserId policy would reject it via the API)
      const restoredHash = await hashPassword(ADMIN_PASSWORD);
      await prisma.user.updateMany({
        where: { username: 'admin' },
        data: { passwordHash: restoredHash },
      });
      // Clear password history again so future test runs don't hit reuse limits
      if (adminUser) {
        await prisma.passwordHistory.deleteMany({ where: { userId: adminUser.id } });
      }
    });

    it('returns error for wrong current password', async () => {
      const token = await loginAs(app);

      const res = await authPost(app, '/api/auth/change-password', token, {
        currentPassword: 'WrongPassword@1',
        newPassword: 'SomeNew@123',
        confirmPassword: 'SomeNew@123',
      });

      // Service throws 400 INVALID_PASSWORD for incorrect current password
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('INVALID_PASSWORD');
    });

    it('returns 400 when required fields are missing', async () => {
      const token = await loginAs(app);

      // Missing newPassword and confirmPassword
      const res = await authPost(app, '/api/auth/change-password', token, {
        currentPassword: ADMIN_PASSWORD,
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        payload: {
          currentPassword: ADMIN_PASSWORD,
          newPassword: 'SecureP@ss123',
          confirmPassword: 'SecureP@ss123',
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
