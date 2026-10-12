import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Directory-user behaviour in `authService.login` (2026-08-08). Three separate
 * traps, each of which made an AD account unusable in a different way — and one
 * of which the FIX for another trap created. The `authService.verify` cases
 * that used to sit here went with POST /api/auth/verify (audit 2026-10-03,
 * SEC-5); the directory re-bind on re-auth is pinned by
 * lib/__tests__/ldap-identity.test.ts and e2e/ldap-directory.e2e.test.ts.
 */

const {
  mockRepo, mockVerifyPassword, mockSignToken,
  mockAuditLog, mockCreateNotification, mockLdap,
} = vi.hoisted(() => ({
  mockRepo: {
    findUserByUsername: vi.fn(), findUserById: vi.fn(), updateUser: vi.fn(),
    findActiveSessions: vi.fn(), terminateActiveSessions: vi.fn(),
    createSession: vi.fn(), getSessionConfig: vi.fn(),
    getPasswordPolicyConfig: vi.fn(), getPasswordPolicyRow: vi.fn(),
    getLoginSecurityConfig: vi.fn(), getRolePermissions: vi.fn(),
    findPendingResetRequest: vi.fn(), createResetRequest: vi.fn(),
  },
  mockVerifyPassword: vi.fn(),
  mockSignToken: vi.fn(),
  mockAuditLog: vi.fn(),
  mockCreateNotification: vi.fn(),
  mockLdap: { getConfig: vi.fn(), authenticateUser: vi.fn(), syncUserAttributes: vi.fn() },
}));

vi.mock('../auth.repository.js', () => ({ authRepository: mockRepo }));
vi.mock('../../../lib/password.js', () => ({ hashPassword: vi.fn(), verifyPassword: mockVerifyPassword }));
vi.mock('../../../lib/jwt.js', () => ({
  signToken: mockSignToken, verifyToken: vi.fn(),
}));
vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));
vi.mock('../../notifications/notification.service.js', () => ({ createNotification: mockCreateNotification }));
vi.mock('../../ldap/ldap.service.js', () => ({
  LDAP_SENTINEL_HASH: 'LDAP_EXTERNAL_AUTH',
  ldapService: mockLdap,
}));

const { authService } = await import('../auth.service.js');

function directoryUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u-ad', username: 'EMP1234', fullName: 'Ravi Kumar',
    email: 'ravi@corp.local', role: 'SUPERVISOR', status: 'ENABLED',
    authSource: 'ldap', passwordHash: 'LDAP_EXTERNAL_AUTH',
    failedLoginAttempts: 0, forcePasswordChange: false, isTemporaryPassword: false,
    lockoutUntil: null, lockedAt: null,
    passwordExpiresAt: null, passwordChangedAt: new Date(),
    createdAt: new Date(Date.now() - 200 * 86400000), // older than any expiry window
    ...overrides,
  };
}

const bindOk = { success: true, userDn: 'CN=Ravi,DC=corp', attributes: {}, groups: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditLog.mockResolvedValue(undefined);
  mockCreateNotification.mockResolvedValue(undefined);
  mockRepo.getLoginSecurityConfig.mockResolvedValue({});
  mockRepo.getSessionConfig.mockResolvedValue({ sessionDurationHours: 8 });
  mockRepo.getPasswordPolicyConfig.mockResolvedValue({ maxFailedAttempts: 5 });
  mockRepo.getPasswordPolicyRow.mockResolvedValue({
    configValue: { passwordExpiryDays: 90 },
    updatedAt: new Date(Date.now() - 365 * 86400000),
  });
  mockRepo.findActiveSessions.mockResolvedValue([]);
  mockRepo.createSession.mockResolvedValue({ id: 'sess-1' });
  mockRepo.updateUser.mockResolvedValue({});
  mockSignToken.mockResolvedValue('jwt');
  mockLdap.getConfig.mockResolvedValue({ enabled: true });
  mockLdap.syncUserAttributes.mockResolvedValue(undefined);
});

describe('login — directory users', () => {
  it('authenticates by LDAP bind without consulting bcrypt', async () => {
    mockRepo.findUserByUsername.mockResolvedValue(directoryUser());
    mockLdap.authenticateUser.mockResolvedValue(bindOk);

    await authService.login('EMP1234', 'ADpassword', '1.2.3.4', 'ua');

    expect(mockLdap.authenticateUser).toHaveBeenCalledWith('EMP1234', 'ADpassword');
    expect(mockVerifyPassword).not.toHaveBeenCalled();
  });

  it('does NOT increment the lockout counter on a failed bind', async () => {
    // Lockout is delegated to AD. Counting here too locks the account in this
    // application while AD still regards the credential as valid.
    const user = directoryUser({ failedLoginAttempts: 3 });
    mockRepo.findUserByUsername.mockResolvedValue(user);
    mockLdap.authenticateUser.mockResolvedValue(null);

    await expect(authService.login('EMP1234', 'wrong', '1.2.3.4', 'ua')).rejects.toThrow();

    const incremented = mockRepo.updateUser.mock.calls.some(
      ([, data]: any[]) => data && 'failedLoginAttempts' in data && data.failedLoginAttempts > 0,
    );
    expect(incremented).toBe(false);
  });

  it('still AUDITS a failed bind (only the counter is delegated, never the record)', async () => {
    mockRepo.findUserByUsername.mockResolvedValue(directoryUser());
    mockLdap.authenticateUser.mockResolvedValue(null);

    await expect(authService.login('EMP1234', 'wrong', '1.2.3.4', 'ua')).rejects.toThrow();

    const failure = mockAuditLog.mock.calls.find(([e]: any[]) => e.action === 'LOGIN_FAILED');
    expect(failure).toBeDefined();
    expect(failure![0].afterValue).toMatchObject({ lockoutDelegatedToDirectory: true });
  });

  // ── password expiry ──
  it('never force-expires a directory user, however old the account', async () => {
    // The bug: passwordChangedAt never advances for these users because nothing
    // here changes their password, so at passwordExpiryDays they were flagged
    // "must change password" — and the change-password screen refuses them.
    mockRepo.findUserByUsername.mockResolvedValue(directoryUser({
      passwordChangedAt: new Date(Date.now() - 500 * 86400000),
    }));
    mockLdap.authenticateUser.mockResolvedValue(bindOk);

    await authService.login('EMP1234', 'ADpassword', '1.2.3.4', 'ua');

    expect(mockAuditLog.mock.calls.some(([e]: any[]) => e.action === 'PASSWORD_EXPIRED')).toBe(false);
    const flagged = mockRepo.updateUser.mock.calls.some(
      ([, data]: any[]) => data?.forcePasswordChange === true,
    );
    expect(flagged).toBe(false);
    // Doesn't even read the policy — nothing about it applies.
    expect(mockRepo.getPasswordPolicyRow).not.toHaveBeenCalled();
  });

  // ── the trap the expiry fix would otherwise have created ──
  it('CLEARS a stranded forcePasswordChange flag on a successful bind', async () => {
    // Rows in this state exist because the old expiry bug set the flag. Merely
    // ignoring it server-side is not enough: the login RESPONSE carries it and
    // the web client redirects to /change-password on sight — a screen that now
    // refuses directory accounts. That is a closed loop with no exit.
    mockRepo.findUserByUsername.mockResolvedValue(directoryUser({
      forcePasswordChange: true, isTemporaryPassword: true,
    }));
    mockLdap.authenticateUser.mockResolvedValue(bindOk);

    const result: any = await authService.login('EMP1234', 'ADpassword', '1.2.3.4', 'ua');

    expect(mockRepo.updateUser).toHaveBeenCalledWith('u-ad', expect.objectContaining({
      forcePasswordChange: false, isTemporaryPassword: false,
    }));
    expect(result.user?.forcePasswordChange ?? result.forcePasswordChange).toBeFalsy();
  });

  it('refuses a sentinel-hash user when LDAP is disabled (the sentinel is never a free pass)', async () => {
    mockLdap.getConfig.mockResolvedValue({ enabled: false });
    mockRepo.findUserByUsername.mockResolvedValue(directoryUser());
    mockVerifyPassword.mockResolvedValue(true); // even if bcrypt says yes

    await expect(authService.login('EMP1234', 'anything', '1.2.3.4', 'ua')).rejects.toThrow();
  });
});

describe('changePassword / forgotPassword — directory users', () => {
  it('refuses to change a directory password (would detach the account from AD)', async () => {
    mockRepo.findUserById.mockResolvedValue(directoryUser());

    await expect(authService.changePassword('u-ad', 'old', 'NewPass@123', '1.2.3.4', 'ua', 's'))
      .rejects.toThrow(/directory|Active Directory/i);
  });

  it('files no reset request for a directory user, and reveals nothing', async () => {
    // A request nothing can action would sit pending forever; saying why on a
    // public endpoint would be a user-enumeration oracle. Silence is the answer.
    mockRepo.findUserByUsername.mockResolvedValue(directoryUser());

    const result = await authService.forgotPassword('EMP1234', '1.2.3.4', 'ua');

    expect(result).toBeUndefined();
    expect(mockRepo.createResetRequest).not.toHaveBeenCalled();
    // Returns before even LOOKING for an existing request — the guard is the
    // first thing after the user lookup, not a filter applied later.
    expect(mockRepo.findPendingResetRequest).not.toHaveBeenCalled();
  });
});

// Application review 2026-10-12, follow-up 4: a directory ERROR (not a
// rejected bind) used to answer 401 LDAP_ERROR — telling an anonymous caller
// the username is a directory account. The caller now gets the generic answer;
// the detail goes to the server log and the LOGIN_FAILED audit row.
describe('login — directory error', () => {
  it('answers the generic INVALID_CREDENTIALS and records the error for the operator', async () => {
    mockRepo.findUserByUsername.mockResolvedValue(directoryUser());
    mockLdap.authenticateUser.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:636'));

    const err: any = await authService.login('EMP1234', 'pw', '127.0.0.1', 'ua').catch((e) => e);
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('INVALID_CREDENTIALS');
    expect(err.message).toBe('Username or password is incorrect.');
    const row = mockAuditLog.mock.calls.map(([e]: any[]) => e).find((e: any) => e.action === 'LOGIN_FAILED');
    expect(row?.afterValue?.directoryError).toMatch(/ECONNREFUSED/);
    expect(mockRepo.updateUser).not.toHaveBeenCalled();
  });
});
