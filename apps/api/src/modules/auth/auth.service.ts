import { sanitizeStrings } from "../../lib/sanitize.js";
import { prisma } from "../../lib/prisma.js";
import type { RequestContext } from '../../types/context.js';
import { auditLog } from '../../lib/audit.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { isPasswordExpired } from '../../lib/password-expiry.js';
import { ldapService } from '../ldap/ldap.service.js';
import { signToken, signVerificationToken, verifyToken } from '../../lib/jwt.js';
import { AppError, NotFoundError, ValidationError, ConflictError } from '../../lib/errors.js';
import { authRepository } from './auth.repository.js';
import { createNotification } from '../notifications/notification.service.js';
import { dispatchNotification } from '../notification-delivery/notification-dispatcher.js';
import { invalidateSessionAuthCache } from '../../plugins/auth.js';

const DUMMY_HASH = '$2b$12$7fXFzVUc/0SLHtxesM41PODN09mcQBJ0QB/uy7BQHDWzsklxK9yh6';

/**
 * Record a failed password verification and apply the account-lockout policy.
 * Shared by login AND the re-authentication surface (reauth-check.ts + /verify)
 * so a reauth password-guessing attack counts toward the SAME lockout as login.
 * Closes the 2026-07-09 security-review gap where a holder of a valid session
 * could grind the password via reauth without the account ever locking.
 *
 * SUPER_ADMIN is lockout-exempt (documented 21 CFR §11.10(g) trade-off, per user
 * 2026-05-25). Returns whether the account is now LOCKED. Emits the ACCOUNT_LOCKED
 * audit + notifications only when the threshold trips; the caller owns its own
 * action-specific audit (LOGIN_FAILED / reauth) for the non-locking case.
 */
export async function applyFailedPasswordAttempt(
  user: { id: string; username: string; fullName: string | null; role: string; failedLoginAttempts: number },
  ip: string,
  userAgent: string | undefined,
): Promise<{ locked: boolean }> {
  if (user.role === 'SUPER_ADMIN') return { locked: false };

  const loginSecurity = await authRepository.getLoginSecurityConfig();
  const passwordPolicy = await authRepository.getPasswordPolicyConfig();
  const maxAttempts = (passwordPolicy.maxFailedAttempts as number) ?? 5;
  const lockoutType = loginSecurity.lockoutType ?? 'TEMPORARY';
  const lockoutDurationMinutes = loginSecurity.lockoutDurationMinutes ?? 30;
  const newAttempts = user.failedLoginAttempts + 1;

  if (newAttempts < maxAttempts) {
    await authRepository.updateUser(user.id, { failedLoginAttempts: newAttempts });
    return { locked: false };
  }

  const lockoutData: Record<string, unknown> = {
    failedLoginAttempts: newAttempts, status: 'LOCKED' as const, lockedAt: new Date(),
  };
  if (lockoutType === 'TEMPORARY') {
    lockoutData.lockoutUntil = new Date(Date.now() + lockoutDurationMinutes * 60 * 1000);
  }
  await authRepository.updateUser(user.id, lockoutData);

  await auditLog({
    userId: user.username, userRole: user.role, action: 'ACCOUNT_LOCKED',
    targetType: 'user', targetId: user.id,
    afterValue: { username: user.username, fullName: user.fullName },
    ipAddress: ip, userAgent,
  });
  await createNotification({
    type: 'ACCOUNT_LOCKED', title: 'Account Locked',
    message: `User ${user.fullName} (${user.username}) has been locked due to multiple failed login attempts.`,
    targetUserId: user.username, forRole: 'ADMIN',
  });
  await createNotification({
    type: 'ACCOUNT_LOCKED', title: 'Your Account Has Been Locked',
    message: `Your account has been locked due to multiple failed login attempts. Please contact an administrator.`,
    targetUserId: user.username, forUserId: user.username,
  });
  dispatchNotification({
    eventType: 'USER_LOCKED',
    context: {},
    variables: {
      username: user.username, fullName: user.fullName ?? user.username,
      reason: 'Multiple failed login attempts', failedAttempts: String(newAttempts),
      ipAddress: ip ?? 'N/A', timestamp: new Date().toISOString(),
    },
  }).catch(err => console.error('[UserLocked] Notification dispatch failed:', err.message));

  return { locked: true };
}

export const authService = {
  async login(username: string, password: string, ip: string, userAgent: string | undefined, force?: boolean) {
    let user = await authRepository.findUserByUsername(username);
    if (!user) {
      // Try LDAP auto-provisioning if enabled
      try {
        const ldapConfig = await ldapService.getConfig();
        if (ldapConfig.enabled) {
          const ldapResult = await ldapService.authenticateUser(username, password);
          if (ldapResult) {
            user = await ldapService.provisionUser(username, ldapResult, ldapConfig) as any;
            // LDAP user auto-provisioned
            // Skip to session creation (user is already authenticated via LDAP bind)
          }
        }
      } catch (ldapErr: any) {
        console.error('[LDAP] Auto-provision error:', ldapErr.message);
      }

      if (!user) {
        await verifyPassword(password, DUMMY_HASH);
        // Audit API-1: unified error — do not reveal whether the user exists
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
      }
    }

    // Check account status (SUPER_ADMIN auto-unlocks)
    if (user.status === 'LOCKED') {
      if (user.role === 'SUPER_ADMIN') {
        // Auto-unlock SUPER_ADMIN accounts
        await authRepository.updateUser(user.id, { status: 'ENABLED', failedLoginAttempts: 0, lockoutUntil: null, lockedAt: null });
      } else if (user.lockoutUntil && user.lockoutUntil < new Date()) {
        await authRepository.updateUser(user.id, { status: 'ENABLED', failedLoginAttempts: 0, lockoutUntil: null, lockedAt: null });
      } else {
        throw new AppError(403, "ACCOUNT_LOCKED", "Account locked due to multiple failed login attempts. Contact administrator.");
      }
    }

    if (user.status === 'DISABLED') {
      throw new AppError(403, 'ACCOUNT_DISABLED', 'Your account has been disabled. Contact administrator.');
    }

    if (user.status === 'EXPIRED') {
      if (user.role === 'SUPER_ADMIN') {
        // Auto-recover SUPER_ADMIN from EXPIRED status
        await authRepository.updateUser(user.id, { status: 'ENABLED', forcePasswordChange: false });
      } else if (user.isTemporaryPassword && user.forcePasswordChange) {
        await authRepository.updateUser(user.id, { status: 'ENABLED' });
      } else {
        throw new AppError(403, "PASSWORD_EXPIRED", "Your password has expired. Contact an administrator to reset your password.");
      }
    }

    // LDAP authentication for LDAP-sourced users
    let skipPasswordCheck = false;
    if ((user as any).authSource === 'ldap' && user.role !== 'SUPER_ADMIN') {
      try {
        const ldapConfig = await ldapService.getConfig();
        if (ldapConfig.enabled) {
          const ldapResult = await ldapService.authenticateUser(username, password);
          if (ldapResult) {
            skipPasswordCheck = true;
            // Sync attributes from LDAP
            await ldapService.syncUserAttributes(user.id, ldapResult, ldapConfig);
          } else {
            // Audit API-1: unified error — do not distinguish LDAP vs local credential failure
            throw new AppError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
          }
        }
      } catch (err: any) {
        if (err instanceof AppError) throw err;
        console.error('[LDAP] Auth error: LDAP authentication failed');
        throw new AppError(401, 'LDAP_ERROR', 'LDAP authentication failed. Contact administrator.');
      }
    }

    // SECURITY (audit C1): a sentinel-hash user has NO local password — they can
    // ONLY be authenticated by a successful LDAP bind THIS request (the block
    // above sets skipPasswordCheck on a successful bind). The sentinel must NEVER
    // be a free pass: if no bind succeeded — LDAP disabled, bind failed, or the
    // user is SUPER_ADMIN (whom the LDAP branch above deliberately excludes) —
    // deny, because otherwise `verifyPassword(anything, sentinel)` combined with a
    // stale sentinel would let ANY password log them in. Previously this block
    // unconditionally set skipPasswordCheck = true, which was the bypass.
    if (user.passwordHash === 'LDAP_EXTERNAL_AUTH' && !skipPasswordCheck) {
      await verifyPassword(password, DUMMY_HASH); // keep timing shape constant
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
    }

    const valid = skipPasswordCheck || await verifyPassword(password, user.passwordHash);
    if (!valid) {
      // SUPER_ADMIN accounts are exempt from lockout — they can always retry
      if (user.role === 'SUPER_ADMIN') {
        await auditLog({
          userId: user.username, userRole: user.role, action: 'LOGIN_FAILED',
          targetType: 'user', targetId: user.id,
          afterValue: { username: user.username, fullName: user.fullName, adminExempt: true },
          ipAddress: ip, userAgent,
        });
        // Audit API-1: unified error — internal audit log retains the distinction
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
      }

      // Shared lockout policy (also used by the reauth surface — see
      // applyFailedPasswordAttempt). Emits ACCOUNT_LOCKED audit + notifications
      // when the threshold trips.
      const { locked } = await applyFailedPasswordAttempt(user, ip, userAgent);
      if (locked) {
        throw new AppError(403, 'ACCOUNT_LOCKED', 'Account locked due to multiple failed login attempts. Contact administrator.');
      }

      await auditLog({
        userId: user.username, userRole: user.role, action: 'LOGIN_FAILED',
        targetType: 'user', targetId: user.id,
        afterValue: { username: user.username, fullName: user.fullName },
        ipAddress: ip, userAgent,
      });

      // Audit API-1: unified error; Audit API-2: do not expose attemptsRemaining in response
      // (audit log above already records the attempt count server-side for admin review)
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
    }

    // Check password expiry (derived from passwordChangedAt + live policy,
    // floored at policy save time). SUPER_ADMIN is exempt — same posture as
    // the auto-unlock / auto-recover / lockout-exempt branches above. This
    // weakens 21 CFR Part 11 §11.10(g) for privileged accounts; documented
    // trade-off per user request 2026-05-25. The legacy `passwordExpiresAt`
    // column is a frozen-at-write snapshot and is no longer authoritative.
    const policyRow = user.role === 'SUPER_ADMIN'
      ? null
      : await authRepository.getPasswordPolicyRow();
    const expiryDays = (policyRow?.configValue as { passwordExpiryDays?: number } | null)?.passwordExpiryDays;
    if (user.role !== 'SUPER_ADMIN'
        && isPasswordExpired(user.passwordChangedAt, user.createdAt, expiryDays, policyRow?.updatedAt ?? null)
        && !user.forcePasswordChange) {
      await authRepository.updateUser(user.id, { forcePasswordChange: true });
      user.forcePasswordChange = true;

      await auditLog({
        userId: user.username, userRole: user.role, action: 'PASSWORD_EXPIRED',
        targetType: 'user', targetId: user.id,
        afterValue: { username: user.username, fullName: user.fullName },
        signatureMeaning: 'System detected expired password at login',
        ipAddress: ip, userAgent,
      });
    }

    // Check for existing sessions (same account, different location)
    const existingSessions = await authRepository.findActiveSessions(user.id);
    if (existingSessions.length > 0) {
      if (!force) {
        // Return session conflict — let the user decide
        const oldSession = existingSessions[0];
        const err = new AppError(409, 'SESSION_CONFLICT', 'An active session already exists for this account.');
        (err as any).activeSession = {
          ipAddress: oldSession.ipAddress ?? 'Unknown',
          loginTime: oldSession.createdAt.toISOString(),
          lastActiveAt: oldSession.lastActiveAt.toISOString(),
        };
        throw err;
      }

      // force=true: terminate existing sessions and proceed
      await authRepository.terminateActiveSessions(user.id, 'new_login');
      await auditLog({
        userId: user.username, userRole: user.role, action: 'FORCED_LOGOUT',
        targetType: 'session', targetId: existingSessions.map((s: any) => s.id).join(','),
        afterValue: { username: user.username, fullName: user.fullName },
        signatureMeaning: 'Previous sessions terminated by user on new login',
        ipAddress: ip, userAgent,
      });
    }

    // Create session
    const sessionCfg = await authRepository.getSessionConfig();
    const sessionDurationHours = sessionCfg.sessionDurationHours ?? 8;
    const session = await authRepository.createSession(user.id, ip, userAgent, sessionDurationHours);

    const token = await signToken({
      sub: user.id, username: user.username, role: user.role, sessionId: session.id,
    }, sessionDurationHours);

    await authRepository.updateUser(user.id, { failedLoginAttempts: 0, lastLogin: new Date(), lockoutUntil: null });

    await auditLog({
      userId: user.username, userRole: user.role, action: 'LOGIN_SUCCESS',
      targetType: 'user', targetId: user.id,
      afterValue: { username: user.username, fullName: user.fullName },
      signatureMeaning: 'User authenticated with username and password',
      ipAddress: ip, userAgent, sessionId: session.id,
    });

    // Dispatch USER_LOGIN notification
    dispatchNotification({
      eventType: 'USER_LOGIN',
      context: {},
      variables: {
        username: user.username, fullName: user.fullName ?? user.username,
        role: user.role, ipAddress: ip ?? 'N/A',
        timestamp: new Date().toISOString(),
      },
    }).catch(err => console.error('[UserLogin] Notification dispatch failed:', err.message));

    return {
      success: true, token,
      user: {
        id: user.id, username: user.username, fullName: user.fullName, role: user.role,
        forcePasswordChange: user.forcePasswordChange, isTemporaryPassword: user.isTemporaryPassword,
      },
      expiresIn: `${sessionDurationHours}h`,
    };
  },

  async logout(sessionId: string, username: string, role: string, ip: string, userAgent: string | undefined, reason: 'manual' | 'idle_timeout' = 'manual') {
    await authRepository.terminateSession(sessionId, reason);
    invalidateSessionAuthCache(sessionId);
    await auditLog({
      userId: username, userRole: role, action: 'LOGOUT',
      targetType: 'session', targetId: sessionId,
      afterValue: { username, reason },
      signatureMeaning: reason === 'idle_timeout'
        ? `Session ended by idle auto-logout for "${username}"`
        : `User "${username}" logged out`,
      ipAddress: ip, userAgent, sessionId,
    });
  },

  async beaconLogout(token: string, ip: string, userAgent: string | undefined) {
    try {
      const payload = await verifyToken(token);
      const session = await authRepository.findSessionById(payload.sessionId);
      if (session) {
        await authRepository.terminateSession(session.id, 'tab_closed');
        invalidateSessionAuthCache(session.id);
        await auditLog({
          userId: payload.username, userRole: payload.role, action: 'LOGOUT',
          targetType: 'session', targetId: payload.sessionId,
          afterValue: { username: payload.username, reason: 'tab_closed' },
          ipAddress: ip, userAgent, sessionId: payload.sessionId,
        });
      }
    } catch {
      // Token invalid/expired — session is already dead
    }
  },

  async getProfile(userId: string) {
    const user = await authRepository.findUserByIdSelect(userId);
    if (!user) return null;
    const permissions = await authRepository.getRolePermissions(user.role);
    return { ...user, permissions };
  },

  async updateProfile(userId: string, data: { fullName?: string; email?: string; department?: string; photoUrl?: string }, ip: string, userAgent: string | undefined, sessionId: string) {
    // Sanitize text inputs to prevent XSS
    data = sanitizeStrings(data, ['photoUrl']);

    const user = await authRepository.findUserById(userId);
    if (!user) throw new NotFoundError('User not found');

    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      throw new ValidationError('Invalid email format');
    }
    if (data.fullName && (data.fullName.length < 2 || data.fullName.length > 100)) {
      throw new ValidationError('Full name must be 2-100 characters');
    }
    if (data.email && data.email !== user.email) {
      const existing = await authRepository.findUserByEmail(data.email);
      if (existing) throw new ConflictError('Email already in use');
    }

    const beforeValue = { fullName: user.fullName, email: user.email, department: user.department, photoUrl: user.photoUrl };

    const updateData: Record<string, string | null | undefined> = {};
    if (data.fullName !== undefined) updateData.fullName = data.fullName;
    if (data.email !== undefined) updateData.email = data.email;
    if (data.department !== undefined) updateData.department = data.department || null;
    if (data.photoUrl !== undefined) updateData.photoUrl = data.photoUrl || null;

    const updatedUser = await authRepository.updateUserProfile(userId, updateData);

    await auditLog({
      userId: user.username, userRole: user.role, action: 'PROFILE_UPDATED',
      targetType: 'user', targetId: user.id,
      beforeValue, afterValue: { ...updateData, username: user.username, fullName: updatedUser.fullName },
      ipAddress: ip, userAgent, sessionId,
    });

    return updatedUser;
  },

  async changePassword(userId: string, currentPassword: string | undefined, newPassword: string, ip: string, userAgent: string | undefined, sessionId: string) {
    const user = await authRepository.findUserById(userId);
    if (!user) throw new NotFoundError('User not found');

    if (!user.isTemporaryPassword) {
      if (!currentPassword) throw new AppError(400, 'INVALID_PASSWORD', 'Current password is required');
      const valid = await verifyPassword(currentPassword, user.passwordHash);
      if (!valid) {
        // Current-password guesses count toward the SAME lockout as login/reauth,
        // so this endpoint isn't a non-locking brute-force oracle for a session holder.
        const { locked } = await applyFailedPasswordAttempt(user, ip, userAgent);
        if (locked) throw new AppError(403, 'ACCOUNT_LOCKED', 'Account locked due to multiple failed attempts. Contact administrator.');
        throw new AppError(400, 'INVALID_PASSWORD', 'Current password is incorrect');
      }
    }

    const policy = await authRepository.getPasswordPolicyConfig();
    const minLength = (policy.minLength as number) ?? 8;
    const maxLength = (policy.maxLength as number) ?? 128;
    if (newPassword.length < minLength) throw new AppError(400, 'POLICY_VIOLATION', `Password must be at least ${minLength} characters`);
    if (newPassword.length > maxLength) throw new AppError(400, 'POLICY_VIOLATION', `Password must be at most ${maxLength} characters`);

    const policyChecks: Array<{ flag: string; regex: RegExp; countKey: string; name: string; defaultMin: number }> = [
      { flag: 'requireUppercase', regex: /[A-Z]/g, countKey: 'minUppercase', name: 'uppercase letter', defaultMin: 1 },
      { flag: 'requireLowercase', regex: /[a-z]/g, countKey: 'minLowercase', name: 'lowercase letter', defaultMin: 1 },
      { flag: 'requireNumbers', regex: /[0-9]/g, countKey: 'minNumbers', name: 'number', defaultMin: 1 },
      { flag: 'requireSpecialChars', regex: /[^A-Za-z0-9]/g, countKey: 'minSpecialChars', name: 'special character', defaultMin: 1 },
    ];
    for (const check of policyChecks) {
      if ((policy as any)[check.flag]) {
        const min = ((policy as any)[check.countKey] as number) ?? check.defaultMin;
        if ((newPassword.match(check.regex) || []).length < min) {
          throw new AppError(400, 'POLICY_VIOLATION', `Password must contain at least ${min} ${check.name}(s)`);
        }
      }
    }
    if (policy.cannotBeUserId !== false && newPassword === user.username) throw new AppError(400, 'POLICY_VIOLATION', 'Password cannot be same as User ID');
    if (policy.cannotContainUserId !== false && newPassword.toLowerCase().includes(user.username.toLowerCase())) throw new AppError(400, 'POLICY_VIOLATION', 'Password cannot contain User ID');

    if (user.isTemporaryPassword) {
      const sameAsTemp = await verifyPassword(newPassword, user.passwordHash);
      if (sameAsTemp) throw new AppError(400, 'POLICY_VIOLATION', 'New password cannot be same as temporary password');
    }

    const reuseCount = (policy.preventReuseCount as number) ?? 12;
    const history = await authRepository.getPasswordHistory(user.id, reuseCount);
    // Only check passwords from the last 12 months
    const maxAge = 365 * 24 * 60 * 60 * 1000; // 12 months
    const recentHistory = history.filter(h => (Date.now() - new Date(h.createdAt).getTime()) < maxAge);
    for (const h of recentHistory) {
      const reused = await verifyPassword(newPassword, h.passwordHash);
      if (reused) throw new AppError(400, 'POLICY_VIOLATION', `Password cannot match any of your last ${reuseCount} passwords`);
    }

    const newHash = await hashPassword(newPassword);
    const expiryDays = (policy.passwordExpiryDays as number) ?? 90;
    const passwordExpiresAt = expiryDays > 0 ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000) : null;

    await authRepository.changePassword(user.id, newHash, passwordExpiresAt);

    // Terminate all other sessions (security: invalidate potentially compromised sessions)
    await authRepository.terminateOtherSessions(user.id, sessionId, 'password_changed');

    await auditLog({
      userId: user.username, userRole: user.role, action: 'PASSWORD_CHANGED',
      targetType: 'user', targetId: user.id,
      afterValue: { username: user.username, fullName: user.fullName },
      signatureMeaning: 'User changed password',
      ipAddress: ip, userAgent, sessionId,
    });
  },

  async verify(userId: string, password: string, ip: string, userAgent: string | undefined) {
    const user = await authRepository.findUserById(userId);
    if (!user) throw new NotFoundError('User not found');
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      // Reauth password guesses count toward the SAME lockout as login.
      const { locked } = await applyFailedPasswordAttempt(user, ip, userAgent);
      if (locked) throw new AppError(403, 'ACCOUNT_LOCKED', 'Account locked due to multiple failed attempts. Contact administrator.');
      throw new AppError(401, 'INVALID_PASSWORD', 'Password is incorrect');
    }
    // Successful password proof clears the consecutive-failure streak (guarded
    // so the common already-zero case pays no write).
    if (user.failedLoginAttempts > 0) {
      await authRepository.updateUser(user.id, { failedLoginAttempts: 0 });
    }
    return await signVerificationToken(user.id);
  },

  async forgotPassword(username: string, ip: string, userAgent: string | undefined) {
    const user = await authRepository.findUserByUsername(username);
    if (!user) return;

    const existingRequest = await authRepository.findPendingResetRequest(user.id);
    if (existingRequest) return 'pending';

    await authRepository.createResetRequest(user.id);

    await createNotification({
      type: 'PASSWORD_RESET_REQUEST', title: 'Password Reset Request',
      message: `User ${user.fullName} (${user.username}) has requested a password reset.`,
      targetUserId: user.username, forRole: 'ADMIN',
    });
  },
};
