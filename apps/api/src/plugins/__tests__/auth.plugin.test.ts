import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockVerifyToken, mockPrisma } = vi.hoisted(() => ({
  mockVerifyToken: vi.fn(),
  mockPrisma: {
    session: { findFirst: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
    // auth.ts uses systemConfig.findFirst({where:{configKey:'session'}}) to
    // resolve the sliding-window duration. findUnique kept for any other
    // call site that may want exact-PK lookup.
    systemConfig: { findFirst: vi.fn(), findUnique: vi.fn() },
    role: { findFirst: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock('../../lib/jwt.js', () => ({ verifyToken: mockVerifyToken }));
vi.mock('../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import authPlugin, { invalidatePasswordPolicyCache, invalidateUserAuthCache, invalidateSessionAuthCache, matchesPublicPath } from '../auth.js';
import { invalidateSuperAdminApiCache } from '../../lib/super-admin-lock.js';

describe('matchesPublicPath — segment-boundary public-path matching', () => {
  const PUBLIC = ['/api/auth/login', '/api/health', '/api/roles/active'];
  const DIRS = ['/uploads/photos/', '/uploads/branding/'];

  it('matches exact public paths (and ignores the query string)', () => {
    expect(matchesPublicPath('/api/health', PUBLIC)).toBe(true);
    expect(matchesPublicPath('/api/health?x=1', PUBLIC)).toBe(true);
    expect(matchesPublicPath('/api/auth/login', PUBLIC)).toBe(true);
  });

  it('matches true sub-paths', () => {
    expect(matchesPublicPath('/uploads/photos/abc.jpg', DIRS)).toBe(true);
    expect(matchesPublicPath('/api/auth/login/callback', PUBLIC)).toBe(true);
  });

  it('does NOT match a shadowing sibling (the bug being fixed)', () => {
    // The old `startsWith` would have made these public.
    expect(matchesPublicPath('/api/health-evil', PUBLIC)).toBe(false);
    expect(matchesPublicPath('/api/auth/login-history', PUBLIC)).toBe(false);
    expect(matchesPublicPath('/api/roles/active-secrets', PUBLIC)).toBe(false);
  });

  it('does not match unrelated protected paths', () => {
    expect(matchesPublicPath('/api/users', PUBLIC)).toBe(false);
    expect(matchesPublicPath('/api/instruments/x/attributes', PUBLIC)).toBe(false);
  });
});

function makeReq(overrides: Record<string, any> = {}) {
  return {
    url: '/api/users',
    method: 'GET',
    headers: { authorization: 'Bearer valid-token' },
    user: null as any,
    ...overrides,
  } as any;
}

function makeReply() {
  const reply: any = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
}

describe('authPlugin', () => {
  let onRequestHook: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    // The plugin's caches are module-scope and persist across tests;
    // reset all three so each test's mocks are observed fresh.
    invalidatePasswordPolicyCache();
    invalidateUserAuthCache('u1');
    invalidateSessionAuthCache('s1');
    const app = {
      addHook: vi.fn((event: string, handler: Function) => {
        if (event === 'onRequest') onRequestHook = handler;
      }),
    } as any;
    await authPlugin(app, {});
  });

  it('skips auth for public paths (login)', async () => {
    const req = makeReq({ url: '/api/auth/login' });
    const reply = makeReply();

    await onRequestHook(req, reply);
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it('skips auth for health endpoint', async () => {
    const req = makeReq({ url: '/api/health' });
    const reply = makeReply();

    await onRequestHook(req, reply);
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it('skips auth for branding GET', async () => {
    const req = makeReq({ url: '/api/config/branding', method: 'GET' });
    const reply = makeReply();

    await onRequestHook(req, reply);
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it('rejects requests without authorization header', async () => {
    const req = makeReq({ headers: {} });
    const reply = makeReply();

    await onRequestHook(req, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('verifies token and attaches user to request', async () => {
    const payload = { sub: 'u1', username: 'admin', role: 'ADMIN', sessionId: 's1' };
    mockVerifyToken.mockResolvedValue(payload);
    mockPrisma.session.findFirst.mockResolvedValue({
      id: 's1',
      isActive: true,
      // auth.ts checks Date.now() - createdAt against MAX_ABSOLUTE_SESSION_MS,
      // so the session must include createdAt to avoid throwing inside the
      // try/catch (which would mask the test outcome with a 401).
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 3600000),
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      role: 'ADMIN',
      username: 'admin',
      status: 'ENABLED',
      forcePasswordChange: false,
      passwordChangedAt: new Date(),
      createdAt: new Date(),
      passwordExpiresAt: new Date(Date.now() + 86400000),
    });
    mockPrisma.session.update.mockResolvedValue({});
    // session-duration config; auth.ts queries systemConfig.findFirst with
    // configKey: 'session' to compute the sliding-window expiry.
    mockPrisma.systemConfig.findFirst.mockResolvedValue({
      configValue: { sessionDurationHours: 8 },
    });
    // password-policy is read via findUnique; default 90-day expiry, policy
    // saved a year ago so it's not the binding floor for these fixtures.
    mockPrisma.systemConfig.findUnique.mockResolvedValue({
      configValue: { passwordExpiryDays: 90 },
      updatedAt: new Date(Date.now() - 365 * 86400000),
    });

    const req = makeReq();
    const reply = makeReply();

    await onRequestHook(req, reply);

    // auth.ts re-derives role/username/scope from the DB record and patches
    // req.user, so it's a superset of the JWT payload, not a strict equal.
    expect(req.user).toMatchObject({
      sub: payload.sub,
      sessionId: payload.sessionId,
      role: 'ADMIN',
      username: 'admin',
    });
    expect(mockPrisma.session.update).toHaveBeenCalled(); // lastActiveAt + sliding expiry
  });

  it('rejects expired sessions', async () => {
    const payload = { sub: 'u1', username: 'admin', role: 'ADMIN', sessionId: 's1' };
    mockVerifyToken.mockResolvedValue(payload);
    mockPrisma.session.findFirst.mockResolvedValue({
      id: 's1',
      isActive: true,
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - 1000), // expired
    });
    mockPrisma.session.update.mockResolvedValue({});

    const req = makeReq();
    const reply = makeReply();

    await onRequestHook(req, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('rejects inactive sessions', async () => {
    const payload = { sub: 'u1', username: 'admin', role: 'ADMIN', sessionId: 's1' };
    mockVerifyToken.mockResolvedValue(payload);
    mockPrisma.session.findFirst.mockResolvedValue(null); // no active session

    const req = makeReq();
    const reply = makeReply();

    await onRequestHook(req, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('rejects disabled users', async () => {
    const payload = { sub: 'u1', username: 'admin', role: 'ADMIN', sessionId: 's1' };
    mockVerifyToken.mockResolvedValue(payload);
    mockPrisma.session.findFirst.mockResolvedValue({
      id: 's1',
      isActive: true,
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 3600000),
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      status: 'DISABLED',
    });

    const req = makeReq();
    const reply = makeReply();

    await onRequestHook(req, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('forces password change when password expired', async () => {
    const payload = { sub: 'u1', username: 'admin', role: 'ADMIN', sessionId: 's1' };
    mockVerifyToken.mockResolvedValue(payload);
    mockPrisma.session.findFirst.mockResolvedValue({
      id: 's1',
      isActive: true,
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 3600000),
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      status: 'ENABLED',
      forcePasswordChange: false,                       // start un-flagged
      passwordChangedAt: new Date(Date.now() - 100 * 86400000), // 100 days ago
      createdAt: new Date(Date.now() - 100 * 86400000),
      passwordExpiresAt: new Date(Date.now() + 86400000), // legacy column, ignored
    });
    // 90-day policy + 100-day-old password ⇒ derived expiry trips.
    // policyUpdatedAt is 100 days ago too, so the grace floor doesn't move
    // the anchor; the user is genuinely expired.
    mockPrisma.systemConfig.findUnique.mockResolvedValue({
      configValue: { passwordExpiryDays: 90 },
      updatedAt: new Date(Date.now() - 100 * 86400000),
    });
    // The expired-password branch persists forcePasswordChange via user.update.
    mockPrisma.user.update.mockResolvedValue({});

    const req = makeReq({ url: '/api/users' }); // not in whitelist
    const reply = makeReply();

    await onRequestHook(req, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: 'PASSWORD_EXPIRED' }));
  });

  it('does NOT force password change for SUPER_ADMIN even with an ancient password', async () => {
    const payload = { sub: 'u1', username: 'superadmin', role: 'SUPER_ADMIN', sessionId: 's1' };
    mockVerifyToken.mockResolvedValue(payload);
    mockPrisma.session.findFirst.mockResolvedValue({
      id: 's1',
      isActive: true,
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 3600000),
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      role: 'SUPER_ADMIN',
      username: 'superadmin',
      status: 'ENABLED',
      forcePasswordChange: false,
      passwordChangedAt: new Date(Date.now() - 1000 * 86400000), // 1000 days old
      createdAt: new Date(Date.now() - 1000 * 86400000),
      passwordExpiresAt: new Date(Date.now() - 500 * 86400000),
    });
    mockPrisma.session.update.mockResolvedValue({});
    mockPrisma.systemConfig.findFirst.mockResolvedValue({
      configValue: { sessionDurationHours: 8 },
    });
    // policy = 1 day, saved a year ago — would force-flag any non-SUPER_ADMIN
    mockPrisma.systemConfig.findUnique.mockResolvedValue({
      configValue: { passwordExpiryDays: 1 },
      updatedAt: new Date(Date.now() - 365 * 86400000),
    });

    const req = makeReq({ url: '/api/users' });
    const reply = makeReply();

    await onRequestHook(req, reply);
    // Must NOT 403 — SUPER_ADMIN is exempt
    expect(reply.code).not.toHaveBeenCalledWith(403);
    expect(mockPrisma.user.update).not.toHaveBeenCalled(); // no force-flag write
  });

  it('allows password change endpoint when force password change is true', async () => {
    const payload = { sub: 'u1', username: 'admin', role: 'ADMIN', sessionId: 's1' };
    mockVerifyToken.mockResolvedValue(payload);
    mockPrisma.session.findFirst.mockResolvedValue({
      id: 's1',
      isActive: true,
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 3600000),
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      status: 'ENABLED',
      forcePasswordChange: true,
      passwordChangedAt: new Date(),
      createdAt: new Date(),
      passwordExpiresAt: new Date(Date.now() + 86400000),
    });
    mockPrisma.session.update.mockResolvedValue({});
    mockPrisma.systemConfig.findFirst.mockResolvedValue({
      configValue: { sessionDurationHours: 8 },
    });
    mockPrisma.systemConfig.findUnique.mockResolvedValue({
      configValue: { passwordExpiryDays: 90 },
      updatedAt: new Date(Date.now() - 365 * 86400000),
    });

    const req = makeReq({ url: '/api/auth/change-password' });
    const reply = makeReply();

    await onRequestHook(req, reply);
    // Should NOT return 403 for password change endpoint
    expect(reply.code).not.toHaveBeenCalledWith(403);
  });

  it('returns 401 on token verification failure', async () => {
    mockVerifyToken.mockRejectedValue(new Error('Token expired'));

    const req = makeReq();
    const reply = makeReply();

    await onRequestHook(req, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
  });
});

/**
 * The two gated states — forced password change and the SUPER_ADMIN API
 * kill-switch — each keep a short allowlist (audit 2026-10-03, SEC-4). Both
 * used to match it with a bare `startsWith`, and both named
 * `/api/config/password-policy`, so `PUT /api/config/password-policy` (the
 * policy WRITE, same prefix) was admitted while the account was supposedly
 * frozen. These cases drive the real hook: the write must be refused, the
 * public `/current` read admitted, and a shadowing sibling refused.
 * Mutation-checked: restoring the prefix + `startsWith` fails the PUT cases.
 */
describe('authPlugin — gated-state allowlists are segment-matched (SEC-4)', () => {
  let onRequestHook: Function;

  const liveSession = () => ({
    id: 's1',
    isActive: true,
    createdAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 3_600_000),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    invalidatePasswordPolicyCache();
    invalidateUserAuthCache('u1');
    invalidateSessionAuthCache('s1');
    invalidateSuperAdminApiCache();
    const app = {
      addHook: vi.fn((event: string, handler: Function) => {
        if (event === 'onRequest') onRequestHook = handler;
      }),
    } as any;
    await authPlugin(app, {});
    mockPrisma.session.findFirst.mockResolvedValue(liveSession());
    mockPrisma.session.update.mockResolvedValue({});
    mockPrisma.systemConfig.findFirst.mockResolvedValue({ configValue: { sessionDurationHours: 8 } });
  });

  async function run(url: string, method: string) {
    const reply = makeReply();
    await onRequestHook(makeReq({ url, method }), reply);
    return reply;
  }

  describe('forced password change', () => {
    beforeEach(() => {
      mockVerifyToken.mockResolvedValue({ sub: 'u1', username: 'admin', role: 'ADMIN', sessionId: 's1' });
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1', role: 'ADMIN', username: 'admin', status: 'ENABLED',
        forcePasswordChange: true,
        passwordChangedAt: new Date(), createdAt: new Date(),
      });
      // password-policy row: 90-day expiry, saved long ago (no grace floor).
      mockPrisma.systemConfig.findUnique.mockResolvedValue({
        configValue: { passwordExpiryDays: 90 },
        updatedAt: new Date(Date.now() - 365 * 86_400_000),
      });
    });

    it('refuses the password-policy WRITE', async () => {
      const reply = await run('/api/config/password-policy', 'PUT');
      expect(reply.code).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: 'FORCE_PASSWORD_CHANGE' }));
    });

    it('refuses the admin policy READ too — only the public /current leaf is needed', async () => {
      const reply = await run('/api/config/password-policy', 'GET');
      expect(reply.code).toHaveBeenCalledWith(403);
    });

    it('admits the public policy read the change-password page calls', async () => {
      const reply = await run('/api/config/password-policy/current', 'GET');
      expect(reply.code).not.toHaveBeenCalledWith(403);
    });

    it('admits the change-password and tablet-access leaves, with a query string', async () => {
      expect((await run('/api/auth/change-password', 'POST')).code).not.toHaveBeenCalledWith(403);
      expect((await run('/api/config/tablet-access/my-features?x=1', 'GET')).code).not.toHaveBeenCalledWith(403);
    });

    it('refuses a shadowing sibling of an allowed path', async () => {
      // A bare prefix match would admit these; a segment match must not.
      expect((await run('/api/auth/me-history', 'GET')).code).toHaveBeenCalledWith(403);
      expect((await run('/api/config/password-policy/current-evil', 'GET')).code).toHaveBeenCalledWith(403);
    });
  });

  describe('SUPER_ADMIN API kill-switch OFF', () => {
    beforeEach(() => {
      mockVerifyToken.mockResolvedValue({ sub: 'u1', username: 'superadmin', role: 'SUPER_ADMIN', sessionId: 's1' });
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1', role: 'SUPER_ADMIN', username: 'superadmin', status: 'ENABLED',
        forcePasswordChange: false,
        passwordChangedAt: new Date(), createdAt: new Date(),
      });
      // isSuperAdminApiEnabled() reads the kill-switch row through the same
      // mocked client; answer by key so a policy read (if any) is unaffected.
      mockPrisma.systemConfig.findUnique.mockImplementation(async ({ where }: any) =>
        where?.configKey === 'super-admin-api-access'
          ? { configValue: { enabled: false } }
          : { configValue: { passwordExpiryDays: 90 }, updatedAt: new Date(Date.now() - 365 * 86_400_000) },
      );
    });

    it('refuses the password-policy WRITE while locked', async () => {
      const reply = await run('/api/config/password-policy', 'PUT');
      expect(reply.code).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: 'SUPER_ADMIN_API_LOCKED' }));
    });

    it('admits the public policy read and the lock toggle itself', async () => {
      expect((await run('/api/config/password-policy/current', 'GET')).code).not.toHaveBeenCalledWith(403);
      expect((await run('/api/super-admin/api-lock', 'GET')).code).not.toHaveBeenCalledWith(403);
      expect((await run('/api/super-admin/api-lock', 'PUT')).code).not.toHaveBeenCalledWith(403);
    });

    it('refuses a shadowing sibling of an allowed path', async () => {
      expect((await run('/api/super-admin/api-lockdown', 'GET')).code).toHaveBeenCalledWith(403);
      expect((await run('/api/auth/refresh-all', 'POST')).code).toHaveBeenCalledWith(403);
    });

    it('still freezes everything else', async () => {
      expect((await run('/api/users', 'GET')).code).toHaveBeenCalledWith(403);
    });
  });
});

/**
 * A catch-all around the whole hook turned any DB fault into
 * 401 "Invalid or expired token": Postgres falls over, every operator is told
 * their session died, and the real error never reaches the logs or the global
 * error handler. Only the token check may answer 401; infrastructure faults
 * must propagate so app.ts's setErrorHandler logs them and returns 500.
 */
describe('authPlugin — infrastructure faults are not auth failures', () => {
  let onRequestHook: Function;
  const payload = { sub: 'u1', username: 'admin', role: 'ADMIN', sessionId: 's1' };

  const liveSession = () => ({
    id: 's1',
    isActive: true,
    createdAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const liveUser = () => ({
    id: 'u1',
    role: 'ADMIN',
    username: 'admin',
    status: 'ENABLED',
    forcePasswordChange: false,
    passwordChangedAt: new Date(),
    createdAt: new Date(),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    invalidatePasswordPolicyCache();
    invalidateUserAuthCache('u1');
    invalidateSessionAuthCache('s1');
    const app = {
      addHook: vi.fn((event: string, handler: Function) => {
        if (event === 'onRequest') onRequestHook = handler;
      }),
    } as any;
    await authPlugin(app, {});
    mockVerifyToken.mockResolvedValue(payload);
  });

  it('propagates a session-lookup DB failure instead of answering 401', async () => {
    const dbErr = new Error('Connection terminated unexpectedly');
    mockPrisma.session.findFirst.mockRejectedValue(dbErr);

    const reply = makeReply();
    await expect(onRequestHook(makeReq(), reply)).rejects.toThrow(dbErr);
    // The tell: a swallowed outage looks exactly like a dead session.
    expect(reply.code).not.toHaveBeenCalledWith(401);
  });

  it('propagates a user-lookup DB failure instead of answering 401', async () => {
    mockPrisma.session.findFirst.mockResolvedValue(liveSession());
    const dbErr = new Error('remaining connection slots are reserved');
    mockPrisma.user.findUnique.mockRejectedValue(dbErr);

    const reply = makeReply();
    await expect(onRequestHook(makeReq(), reply)).rejects.toThrow(dbErr);
    expect(reply.code).not.toHaveBeenCalledWith(401);
  });

  it('propagates a password-policy read failure instead of answering 401', async () => {
    mockPrisma.session.findFirst.mockResolvedValue(liveSession());
    mockPrisma.user.findUnique.mockResolvedValue(liveUser());
    const dbErr = new Error('canceling statement due to lock timeout');
    mockPrisma.systemConfig.findUnique.mockRejectedValue(dbErr);

    const reply = makeReply();
    await expect(onRequestHook(makeReq(), reply)).rejects.toThrow(dbErr);
    expect(reply.code).not.toHaveBeenCalledWith(401);
  });

  it('still answers 401 — not 500 — for a genuinely bad token', async () => {
    // The narrowing must not cost us the real auth rejection.
    mockVerifyToken.mockRejectedValue(new Error('signature verification failed'));

    const reply = makeReply();
    await expect(onRequestHook(makeReq(), reply)).resolves.not.toThrow();
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'TOKEN_EXPIRED' }),
    );
  });
});
