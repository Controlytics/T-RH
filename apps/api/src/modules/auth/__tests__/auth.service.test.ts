import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────
const {
  mockRepo,
  mockHashPassword,
  mockVerifyPassword,
  mockSignToken,
  mockSignVerificationToken,
  mockVerifyToken,
  mockAuditLog,
  mockCreateNotification,
} = vi.hoisted(() => ({
  mockRepo: {
    findUserByUsername: vi.fn(),
    findUserById: vi.fn(),
    findUserByIdSelect: vi.fn(),
    getRolePermissions: vi.fn(),
    findUserByEmail: vi.fn(),
    updateUser: vi.fn(),
    updateUserProfile: vi.fn(),
    findActiveSessions: vi.fn(),
    findActiveSessionsByIp: vi.fn(),
    terminateActiveSessions: vi.fn(),
    terminateSession: vi.fn(),
    findSessionById: vi.fn(),
    createSession: vi.fn(),
    getLoginSecurityConfig: vi.fn(),
    getSessionConfig: vi.fn(),
    getPasswordPolicyConfig: vi.fn(),
    getPasswordPolicyRow: vi.fn(),
    getPasswordHistory: vi.fn(),
    changePassword: vi.fn(),
    findPendingResetRequest: vi.fn(),
    createResetRequest: vi.fn(),
    terminateOtherSessions: vi.fn(),
  },
  mockHashPassword: vi.fn(),
  mockVerifyPassword: vi.fn(),
  mockSignToken: vi.fn(),
  mockSignVerificationToken: vi.fn(),
  mockVerifyToken: vi.fn(),
  mockAuditLog: vi.fn(),
  mockCreateNotification: vi.fn(),
}));

vi.mock('../auth.repository.js', () => ({ authRepository: mockRepo }));
vi.mock('../../../lib/password.js', () => ({ hashPassword: mockHashPassword, verifyPassword: mockVerifyPassword }));
vi.mock('../../../lib/jwt.js', () => ({ signToken: mockSignToken, signVerificationToken: mockSignVerificationToken, verifyToken: mockVerifyToken }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));
vi.mock('../../notifications/notification.service.js', () => ({ createNotification: mockCreateNotification }));

import { authService } from '../auth.service.js';

// ── Helpers ─────────────────────────────────────────────────
function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1', username: 'admin', fullName: 'Admin User',
    email: 'admin@test.com', role: 'ADMIN', status: 'ENABLED',
    passwordHash: '$2b$12$hash', failedLoginAttempts: 0,
    forcePasswordChange: false, isTemporaryPassword: false,
    lockoutUntil: null, lockedAt: null,
    passwordExpiresAt: null, passwordChangedAt: new Date(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────
describe('authService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditLog.mockResolvedValue(undefined);
    mockCreateNotification.mockResolvedValue(undefined);
    mockRepo.getLoginSecurityConfig.mockResolvedValue({});
    mockRepo.getSessionConfig.mockResolvedValue({ sessionDurationHours: 8 });
    mockRepo.getPasswordPolicyConfig.mockResolvedValue({ maxFailedAttempts: 5 });
    // Default to a long-ago policy save so the grace floor doesn't bind.
    mockRepo.getPasswordPolicyRow.mockResolvedValue({
      configValue: { passwordExpiryDays: 90 },
      updatedAt: new Date(Date.now() - 365 * 86400000),
    });
    mockRepo.terminateOtherSessions.mockResolvedValue({ count: 0 });
  });

  // ── login ──
  describe('login', () => {
    it('returns token on successful login', async () => {
      const user = makeUser();
      mockRepo.findUserByUsername.mockResolvedValue(user);
      mockVerifyPassword.mockResolvedValue(true);
      mockRepo.findActiveSessions.mockResolvedValue([]);
      mockRepo.createSession.mockResolvedValue({ id: 'sess-1' });
      mockSignToken.mockResolvedValue('jwt-token');
      mockRepo.updateUser.mockResolvedValue(user);

      const result = await authService.login('admin', 'pass', '127.0.0.1', 'agent');

      expect(result.success).toBe(true);
      expect(result.token).toBe('jwt-token');
      expect(result.user.username).toBe('admin');
    });

    it('throws USER_NOT_FOUND when no user matches the username', async () => {
      mockRepo.findUserByUsername.mockResolvedValue(null);
      mockVerifyPassword.mockResolvedValue(false); // dummy hash timing

      // The service unified all login failures into a single generic message
      // (security hardening — prevents user enumeration). Both USER_NOT_FOUND
      // and wrong-password paths surface 401 with the same message.
      await expect(authService.login('nobody', 'pass', '127.0.0.1', undefined))
        .rejects.toThrow('Username or password is incorrect.');
    });

    it('throws ACCOUNT_DISABLED for disabled user', async () => {
      mockRepo.findUserByUsername.mockResolvedValue(makeUser({ status: 'DISABLED' }));

      await expect(authService.login('admin', 'pass', '127.0.0.1', undefined))
        .rejects.toThrow('disabled');
    });

    it('throws ACCOUNT_LOCKED for locked user without expired lockout', async () => {
      const future = new Date(Date.now() + 60000);
      mockRepo.findUserByUsername.mockResolvedValue(makeUser({ status: 'LOCKED', lockoutUntil: future }));

      await expect(authService.login('admin', 'pass', '127.0.0.1', undefined))
        .rejects.toThrow('locked');
    });

    it('unlocks user when lockout has expired', async () => {
      const past = new Date(Date.now() - 60000);
      const user = makeUser({ status: 'LOCKED', lockoutUntil: past });
      mockRepo.findUserByUsername.mockResolvedValue(user);
      mockVerifyPassword.mockResolvedValue(true);
      mockRepo.findActiveSessions.mockResolvedValue([]);
      mockRepo.createSession.mockResolvedValue({ id: 'sess-1' });
      mockSignToken.mockResolvedValue('token');
      mockRepo.updateUser.mockResolvedValue(user);

      const result = await authService.login('admin', 'pass', '127.0.0.1', undefined);
      expect(result.success).toBe(true);
      // updateUser called to unlock
      expect(mockRepo.updateUser).toHaveBeenCalledWith(user.id, expect.objectContaining({ status: 'ENABLED' }));
    });

    it('increments failed attempts on wrong password', async () => {
      const user = makeUser({ failedLoginAttempts: 0 });
      mockRepo.findUserByUsername.mockResolvedValue(user);
      mockVerifyPassword.mockResolvedValue(false);
      mockRepo.getLoginSecurityConfig.mockResolvedValue({ maxFailedAttempts: 5 });
      mockRepo.updateUser.mockResolvedValue(user);

      await expect(authService.login('admin', 'wrong', '127.0.0.1', undefined))
        .rejects.toThrow('Username or password is incorrect.');

      expect(mockRepo.updateUser).toHaveBeenCalledWith(user.id, expect.objectContaining({ failedLoginAttempts: 1 }));
    });

    it('locks account after max failed attempts', async () => {
      const user = makeUser({ failedLoginAttempts: 4 });
      mockRepo.findUserByUsername.mockResolvedValue(user);
      mockVerifyPassword.mockResolvedValue(false);
      mockRepo.getLoginSecurityConfig.mockResolvedValue({ maxFailedAttempts: 5, lockoutType: 'TEMPORARY', lockoutDurationMinutes: 30 });
      mockRepo.updateUser.mockResolvedValue(user);

      await expect(authService.login('admin', 'wrong', '127.0.0.1', undefined))
        .rejects.toThrow('locked');

      expect(mockRepo.updateUser).toHaveBeenCalledWith(user.id, expect.objectContaining({ status: 'LOCKED' }));
    });

    it('throws SESSION_CONFLICT when session exists and force=false', async () => {
      const user = makeUser();
      mockRepo.findUserByUsername.mockResolvedValue(user);
      mockVerifyPassword.mockResolvedValue(true);
      mockRepo.findActiveSessions.mockResolvedValue([{ id: 'old-sess', ipAddress: '10.0.0.1', createdAt: new Date(), lastActiveAt: new Date() }]);

      await expect(authService.login('admin', 'pass', '127.0.0.1', undefined, false))
        .rejects.toThrow('active session');
    });

    it('terminates existing sessions when force=true', async () => {
      const user = makeUser();
      mockRepo.findUserByUsername.mockResolvedValue(user);
      mockVerifyPassword.mockResolvedValue(true);
      mockRepo.findActiveSessions.mockResolvedValue([{ id: 'old-sess', ipAddress: '10.0.0.1', createdAt: new Date(), lastActiveAt: new Date() }]);
      mockRepo.terminateActiveSessions.mockResolvedValue({ count: 1 });
      mockRepo.createSession.mockResolvedValue({ id: 'new-sess' });
      mockSignToken.mockResolvedValue('token');
      mockRepo.updateUser.mockResolvedValue(user);

      const result = await authService.login('admin', 'pass', '127.0.0.1', undefined, true);
      expect(result.success).toBe(true);
      expect(mockRepo.terminateActiveSessions).toHaveBeenCalledWith(user.id, 'new_login');
    });
  });

  // ── logout ──
  describe('logout', () => {
    it('terminates session and logs audit (default reason manual)', async () => {
      mockRepo.terminateSession.mockResolvedValue({});

      await authService.logout('sess-1', 'admin', 'ADMIN', '127.0.0.1', 'agent');

      expect(mockRepo.terminateSession).toHaveBeenCalledWith('sess-1', 'manual');
      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
        action: 'LOGOUT', afterValue: expect.objectContaining({ reason: 'manual' }),
      }));
    });

    it('records the idle_timeout reason when passed', async () => {
      mockRepo.terminateSession.mockResolvedValue({});

      await authService.logout('sess-2', 'op', 'OPERATOR', '127.0.0.1', 'agent', 'idle_timeout');

      expect(mockRepo.terminateSession).toHaveBeenCalledWith('sess-2', 'idle_timeout');
      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
        action: 'LOGOUT', afterValue: expect.objectContaining({ reason: 'idle_timeout' }),
      }));
    });
  });

  // ── beaconLogout ──
  describe('beaconLogout', () => {
    it('terminates session from token', async () => {
      mockVerifyToken.mockResolvedValue({ sub: 'user-1', username: 'admin', role: 'ADMIN', sessionId: 'sess-1' });
      mockRepo.findSessionById.mockResolvedValue({ id: 'sess-1' });
      mockRepo.terminateSession.mockResolvedValue({});

      await authService.beaconLogout('valid-token', '127.0.0.1', 'agent');

      expect(mockRepo.terminateSession).toHaveBeenCalledWith('sess-1', 'tab_closed');
    });

    it('does not throw when token is invalid', async () => {
      mockVerifyToken.mockRejectedValue(new Error('expired'));

      await expect(authService.beaconLogout('bad-token', '127.0.0.1', undefined)).resolves.toBeUndefined();
    });
  });

  // ── getProfile ──
  describe('getProfile', () => {
    it('returns user with permissions', async () => {
      mockRepo.findUserByIdSelect.mockResolvedValue({ id: 'u1', username: 'admin', role: 'ADMIN' });
      mockRepo.getRolePermissions.mockResolvedValue(['USER_CREATE', 'USER_READ']);

      const result = await authService.getProfile('u1');
      expect(result).toEqual(expect.objectContaining({ username: 'admin', permissions: ['USER_CREATE', 'USER_READ'] }));
    });

    it('returns null for missing user', async () => {
      mockRepo.findUserByIdSelect.mockResolvedValue(null);
      expect(await authService.getProfile('missing')).toBeNull();
    });
  });

  // ── updateProfile ──
  describe('updateProfile', () => {
    it('updates profile and logs audit', async () => {
      const user = makeUser();
      mockRepo.findUserById.mockResolvedValue(user);
      mockRepo.updateUserProfile.mockResolvedValue({ ...user, fullName: 'New Name' });

      const result = await authService.updateProfile('user-1', { fullName: 'New Name' }, '127.0.0.1', 'agent', 'sess-1');
      expect(result.fullName).toBe('New Name');
      expect(mockAuditLog).toHaveBeenCalled();
    });

    it('throws for invalid email', async () => {
      mockRepo.findUserById.mockResolvedValue(makeUser());

      await expect(authService.updateProfile('user-1', { email: 'bad' }, '127.0.0.1', 'agent', 'sess-1'))
        .rejects.toThrow('email');
    });

    it('throws for duplicate email', async () => {
      mockRepo.findUserById.mockResolvedValue(makeUser());
      mockRepo.findUserByEmail.mockResolvedValue({ id: 'other' });

      await expect(authService.updateProfile('user-1', { email: 'taken@test.com' }, '127.0.0.1', 'agent', 'sess-1'))
        .rejects.toThrow('already in use');
    });
  });

  // ── changePassword ──
  describe('changePassword', () => {
    it('changes password when current is valid', async () => {
      const user = makeUser();
      mockRepo.findUserById.mockResolvedValue(user);
      mockVerifyPassword.mockResolvedValue(true);
      mockRepo.getPasswordPolicyConfig.mockResolvedValue({ minLength: 8, maxLength: 128, preventReuseCount: 1 });
      mockRepo.getPasswordHistory.mockResolvedValue([]);
      mockHashPassword.mockResolvedValue('new-hash');
      mockRepo.changePassword.mockResolvedValue([]);

      await authService.changePassword('user-1', 'OldPass@1', 'NewPass@123', '127.0.0.1', 'agent', 'sess-1');

      expect(mockRepo.changePassword).toHaveBeenCalled();
      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'PASSWORD_CHANGED' }));
    });

    it('rejects when current password is wrong', async () => {
      mockRepo.findUserById.mockResolvedValue(makeUser());
      mockVerifyPassword.mockResolvedValue(false);

      await expect(authService.changePassword('user-1', 'wrong', 'New@1234', '127.0.0.1', 'agent', 'sess-1'))
        .rejects.toThrow('incorrect');
    });

    it('rejects password that matches username', async () => {
      const user = makeUser({ username: 'testuser' });
      mockRepo.findUserById.mockResolvedValue(user);
      mockVerifyPassword.mockResolvedValue(true);
      mockRepo.getPasswordPolicyConfig.mockResolvedValue({ minLength: 8, cannotBeUserId: true });

      await expect(authService.changePassword('user-1', 'old', 'testuser', '127.0.0.1', 'agent', 'sess-1'))
        .rejects.toThrow('User ID');
    });

    it('rejects reused password', async () => {
      mockRepo.findUserById.mockResolvedValue(makeUser());
      mockVerifyPassword.mockImplementation(async (pw: string, hash: string) => {
        if (hash === '$2b$12$hash') return true; // current password
        if (hash === 'old-hash') return true;     // history match
        return false;
      });
      mockRepo.getPasswordPolicyConfig.mockResolvedValue({ minLength: 8, preventReuseCount: 5 });
      // Service filters history to entries created within the last 12 months,
      // so we need a fresh-ish createdAt or the entry gets dropped before
      // the reuse comparison runs.
      mockRepo.getPasswordHistory.mockResolvedValue([
        { passwordHash: 'old-hash', createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      ]);

      await expect(authService.changePassword('user-1', 'Old@1234', 'Reused@123', '127.0.0.1', 'agent', 'sess-1'))
        .rejects.toThrow('last');
    });
  });

  // ── verify ──
  describe('verify', () => {
    it('returns verification token on valid password', async () => {
      mockRepo.findUserById.mockResolvedValue(makeUser());
      mockVerifyPassword.mockResolvedValue(true);
      mockSignVerificationToken.mockResolvedValue('vtoken');

      const result = await authService.verify('user-1', 'pass');
      expect(result).toBe('vtoken');
    });

    it('throws for wrong password', async () => {
      mockRepo.findUserById.mockResolvedValue(makeUser());
      mockVerifyPassword.mockResolvedValue(false);

      await expect(authService.verify('user-1', 'wrong')).rejects.toThrow('incorrect');
    });
  });

  // ── forgotPassword ──
  describe('forgotPassword', () => {
    it('creates reset request and notifies admins', async () => {
      mockRepo.findUserByUsername.mockResolvedValue(makeUser());
      mockRepo.findPendingResetRequest.mockResolvedValue(null);
      mockRepo.createResetRequest.mockResolvedValue({});

      await authService.forgotPassword('admin', '127.0.0.1', 'agent');

      expect(mockRepo.createResetRequest).toHaveBeenCalled();
      expect(mockCreateNotification).toHaveBeenCalled();
    });

    it('returns "pending" when request already exists', async () => {
      mockRepo.findUserByUsername.mockResolvedValue(makeUser());
      mockRepo.findPendingResetRequest.mockResolvedValue({ id: 'req-1' });

      const result = await authService.forgotPassword('admin', '127.0.0.1', 'agent');
      expect(result).toBe('pending');
    });

    it('does nothing for unknown user (no enumeration)', async () => {
      mockRepo.findUserByUsername.mockResolvedValue(null);

      await authService.forgotPassword('nobody', '127.0.0.1', 'agent');
      expect(mockRepo.createResetRequest).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    it('a wrong current password counts toward account lockout (not a silent oracle)', async () => {
      mockRepo.findUserById.mockResolvedValue({
        id: 'u1', username: 'op1', fullName: 'Op', role: 'OPERATOR',
        isTemporaryPassword: false, failedLoginAttempts: 0, passwordHash: 'hash',
      });
      mockVerifyPassword.mockResolvedValue(false); // wrong current password
      mockRepo.getPasswordPolicyConfig.mockResolvedValue({ maxFailedAttempts: 5 });
      mockRepo.getLoginSecurityConfig.mockResolvedValue({ maxFailedAttempts: 5 });

      await expect(authService.changePassword('u1', 'WrongCurrent', 'NewPass@1', '127.0.0.1', 'agent', 'sess-1'))
        .rejects.toThrow(/current password is incorrect/i);
      // The failed attempt was recorded (increment), so repeated guesses eventually lock.
      expect(mockRepo.updateUser).toHaveBeenCalledWith('u1', expect.objectContaining({ failedLoginAttempts: 1 }));
    });
  });
});
