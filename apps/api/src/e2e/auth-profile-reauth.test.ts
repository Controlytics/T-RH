import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, authGet, authPut } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';

/**
 * H1 — Reauth gate on PUT /api/auth/profile.
 *
 * Verifies the H1 fix from tasks/AUDIT-2026-05-04-linkage-review.md.
 * Self-profile edits (fullName/email/department/photoUrl) must require
 * password re-authentication when UPDATE_PROFILE is configured for the
 * caller's role; otherwise a stolen JWT alone is enough to silently
 * change the user's email to an attacker-controlled address.
 *
 * Test isolation note (per apps/api/CLAUDE.md):
 *   - Provisions its own SUPER_ADMIN user (`h1_profile_admin`) so the shared
 *     `admin` user (used by auth.test.ts and others) is not impacted under
 *     either single-fork or multi-fork vitest pools.
 *   - Snapshots and restores the `action-reauth` systemConfig row so the
 *     reauth seed/state for other suites is unchanged.
 *   - The seed in `prisma/seed.ts` writes a NESTED `{ actions: [...] }`
 *     shape that the runtime helper (`enforceReauth`) does not understand
 *     (it reads `config[action]` as `Record<string, string[]>`). That is
 *     a pre-existing seed bug and out of scope for H1; this file writes
 *     the FLAT shape directly so the gate actually fires.
 */

const TEST_USERNAME = 'h1_profile_admin';
const TEST_PASSWORD = 'H1Profile@Test1';

describe('H1 — PUT /api/auth/profile reauth gate', () => {
  let app: FastifyInstance;
  let token: string;
  let testUserId: string;
  let originalReauthRow: { configValue: any; configType: string; requiresReauth: boolean } | null = null;

  beforeAll(async () => {
    app = await buildApp();

    // Provision a dedicated SUPER_ADMIN user for this file. Avoids contention
    // with the shared `admin` user that auth.test.ts logs out mid-suite.
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const upserted = await prisma.user.upsert({
      where: { username: TEST_USERNAME },
      update: {
        passwordHash,
        fullName: 'H1 Profile Test Admin',
        email: 'h1-profile-test@example.test',
        role: 'SUPER_ADMIN',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        failedLoginAttempts: 0,
        lockedAt: null,
        lockoutUntil: null,
      },
      create: {
        username: TEST_USERNAME,
        passwordHash,
        fullName: 'H1 Profile Test Admin',
        email: 'h1-profile-test@example.test',
        role: 'SUPER_ADMIN',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
      },
    });
    testUserId = upserted.id;

    // Snapshot existing action-reauth config so we can restore it.
    const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
    if (existing) {
      originalReauthRow = {
        configValue: existing.configValue,
        configType: existing.configType,
        requiresReauth: existing.requiresReauth,
      };
    }

    // Write the FLAT shape that `enforceReauth` actually understands so the
    // UPDATE_PROFILE gate fires for SUPER_ADMIN. Other actions are left empty
    // — this file does NOT seed a full matrix.
    await prisma.systemConfig.upsert({
      where: { configKey: 'action-reauth' },
      update: {
        configValue: { UPDATE_PROFILE: ['SUPER_ADMIN'] } as any,
        configType: 'security',
        requiresReauth: false,
      },
      create: {
        configKey: 'action-reauth',
        configValue: { UPDATE_PROFILE: ['SUPER_ADMIN'] } as any,
        configType: 'security',
        requiresReauth: false,
      },
    });
    invalidateReauthCache();

    // Login the dedicated test user.
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD, force: true },
    });
    const body = JSON.parse(loginRes.body);
    if (!body.token) {
      throw new Error(`Login failed for ${TEST_USERNAME}: ${loginRes.body}`);
    }
    token = body.token;
  });

  afterAll(async () => {
    // Restore the original action-reauth row so other suites (config.test.ts
    // and similar) see what they expect.
    if (originalReauthRow) {
      await prisma.systemConfig.update({
        where: { configKey: 'action-reauth' },
        data: {
          configValue: originalReauthRow.configValue,
          configType: originalReauthRow.configType,
          requiresReauth: originalReauthRow.requiresReauth,
        },
      });
    } else {
      await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
    }
    invalidateReauthCache();

    // Tear down sessions + delete the test user. Use deleteMany for the
    // sessions because there is no unique compound key.
    await prisma.session.updateMany({
      where: { userId: testUserId },
      data: { isActive: false, terminationReason: 'h1_test_cleanup' },
    });
    // Audit logs reference the user via FK — null them out before delete.
    try {
      await prisma.user.delete({ where: { id: testUserId } });
    } catch {
      // If FK prevents delete (audit trail), at least disable the user so the
      // shared admin pool is unaffected.
      await prisma.user.update({
        where: { id: testUserId },
        data: { status: 'DISABLED', email: `disabled-${testUserId}@example.test` },
      });
    }

    await app.close();
  });

  beforeEach(() => {
    // Each test should see fresh cache state — the cache TTL is 10s but
    // explicit invalidation removes any flake from beforeAll/afterAll order.
    invalidateReauthCache();
  });

  it('rejects update without password (REAUTH_REQUIRED)', async () => {
    // Sanity: the user can read their own profile.
    const meRes = await authGet(app, '/api/auth/me', token);
    expect(meRes.statusCode).toBe(200);

    // PUT without _currentPassword or x-reauth-password must 401.
    const res = await authPut(app, '/api/auth/profile', token, {
      fullName: 'Attacker Renamed Me',
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('REAUTH_REQUIRED');
    expect(body.action).toBe('UPDATE_PROFILE');

    // Verify the value did NOT change in the database.
    const me = await prisma.user.findUnique({ where: { id: testUserId } });
    expect(me?.fullName).toBe('H1 Profile Test Admin');
  });

  it('rejects update with wrong password (REAUTH_FAILED)', async () => {
    const res = await authPut(
      app,
      '/api/auth/profile',
      token,
      { fullName: 'Should Not Apply' },
      'WrongPassword@1',
    );

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('REAUTH_FAILED');

    const me = await prisma.user.findUnique({ where: { id: testUserId } });
    expect(me?.fullName).toBe('H1 Profile Test Admin');
  });

  it('accepts update when correct password is supplied via x-reauth-password header', async () => {
    const res = await authPut(
      app,
      '/api/auth/profile',
      token,
      { fullName: 'H1 Updated Name', department: 'QA' },
      TEST_PASSWORD,
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.fullName).toBe('H1 Updated Name');
    expect(body.department).toBe('QA');

    // Restore for subsequent tests.
    const restoreRes = await authPut(
      app,
      '/api/auth/profile',
      token,
      { fullName: 'H1 Profile Test Admin', department: '' },
      TEST_PASSWORD,
    );
    expect(restoreRes.statusCode).toBe(200);
  });

  it('accepts update when correct password is supplied via _currentPassword body field', async () => {
    // Use a plain inject so we can include `_currentPassword` in the body
    // without a header. authPut only sets the header path.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/auth/profile',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        fullName: 'H1 Body Password Update',
        _currentPassword: TEST_PASSWORD,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.fullName).toBe('H1 Body Password Update');

    // Restore.
    const restoreRes = await app.inject({
      method: 'PUT',
      url: '/api/auth/profile',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        fullName: 'H1 Profile Test Admin',
        _currentPassword: TEST_PASSWORD,
      },
    });
    expect(restoreRes.statusCode).toBe(200);
  });

  // Audit 2026-05-04 fix C1: bare `x-offline-replay: true` header is no
  // longer a reauth bypass. Tablets must obtain a signed grant token from
  // POST /api/auth/offline-grant and send it as `x-offline-replay-token`.

  it('rejects bare x-offline-replay: true header (deprecated bypass)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/auth/profile',
      headers: {
        authorization: `Bearer ${token}`,
        'x-offline-replay': 'true',
      },
      payload: { fullName: 'H1 Should Be Rejected' },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('OFFLINE_REPLAY_HEADER_DEPRECATED');
  });

  it('skips reauth on offline replay when a valid grant token is supplied', async () => {
    // Mint a grant via the new endpoint (requires password).
    const grantRes = await app.inject({
      method: 'POST',
      url: '/api/auth/offline-grant',
      headers: { authorization: `Bearer ${token}` },
      payload: { _currentPassword: TEST_PASSWORD },
    });
    expect(grantRes.statusCode).toBe(200);
    const grantBody = JSON.parse(grantRes.body);
    expect(grantBody.token).toBeTruthy();

    // Use the grant on a profile update — should succeed without _currentPassword.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/auth/profile',
      headers: {
        authorization: `Bearer ${token}`,
        'x-offline-replay-token': grantBody.token,
      },
      payload: { fullName: 'H1 Offline Replay' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.fullName).toBe('H1 Offline Replay');

    // Restore.
    await app.inject({
      method: 'PUT',
      url: '/api/auth/profile',
      headers: {
        authorization: `Bearer ${token}`,
        'x-offline-replay-token': grantBody.token,
      },
      payload: { fullName: 'H1 Profile Test Admin' },
    });
  });

  it('rejects offline-grant issuance without password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/offline-grant',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('PASSWORD_REQUIRED');
  });

  it('rejects offline-grant issuance with wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/offline-grant',
      headers: { authorization: `Bearer ${token}` },
      payload: { _currentPassword: 'WrongPassword123!' },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('REAUTH_FAILED');
  });
});
