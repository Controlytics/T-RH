import { sanitizeStrings } from "../../lib/sanitize.js";
import type { RequestContext } from '../../types/context.js';
import { auditLog } from '../../lib/audit.js';
import { hashPassword } from '../../lib/password.js';
import { validatePasswordPolicy } from '../../lib/password-validator.js';
import { validateUserId } from '../../lib/user-id-validator.js';
import { isLdapUser, LDAP_PASSWORD_MANAGED_MESSAGE } from '../../lib/ldap-identity.js';
import { NotFoundError, ValidationError, ConflictError, ForbiddenError } from '../../lib/errors.js';
import { requireReason } from '../../lib/require-reason.js';
import { userRepository } from './user.repository.js';
import { prisma } from '../../lib/prisma.js';
import { createNotification } from '../notifications/notification.service.js';
import { dispatchNotification } from '../notification-delivery/notification-dispatcher.js';
// Drop the per-user auth cache on every mutation so a role/status/password
// change takes effect immediately instead of after the 30s TTL (audit M-7).
import { invalidateUserAuthCache } from '../../plugins/auth.js';
import { logger } from '../../lib/logger.js';

/**
 * EVERY mutation below runs its write and its audit row in ONE transaction
 * (audit 2026-10-03, API-7): `prisma.$transaction(async (tx) => { write(tx);
 * auditLog(entry, tx) })`. Until then the delete wrote its audit row BEFORE
 * the delete (a chained row said the account was gone while it still logged
 * in if the delete then failed) and every other write audited AFTER it (the
 * write committed, the audit insert failed, no row). Row locks are taken
 * before the audit advisory lock — the write first, the audit row last — the
 * same lock order the instruments module documents.
 *
 * Side effects that are NOT part of the record — in-app notifications, the
 * email/SMS dispatch, the auth-cache invalidation — stay OUTSIDE the
 * transaction, after it commits.
 */

/**
 * Privilege-boundary guard for user-mutating operations (audit C2 fix).
 * A caller may only manage a target user whose role is at or below the caller's
 * hierarchy level — mirroring the `>` semantics already in create()/update() so
 * peer management still works. SUPER_ADMIN (top of hierarchy) manages everyone;
 * nobody below may reset/unlock/update/disable/enable a SUPER_ADMIN (or any role
 * above their own). Fails CLOSED if a role can't be resolved.
 */
async function assertCanManageTarget(callerRole: string, targetRoleName: string) {
  if (callerRole === 'SUPER_ADMIN') return; // top of the hierarchy — can manage anyone
  // By NAME, not only by number (application review 2026-10-12, finding 8):
  // a custom role stored at or above SUPER_ADMIN's hierarchy level (the role
  // schema allowed up to 10 while SUPER_ADMIN sits at 6) passed the numeric
  // test below against a SUPER_ADMIN account.
  if (targetRoleName === 'SUPER_ADMIN') {
    throw new ForbiddenError('You cannot manage a user whose role is higher than yours');
  }
  const caller = await userRepository.findRole(callerRole);
  if (!caller) throw new ForbiddenError('Your role is not recognized');
  const target = await userRepository.findRole(targetRoleName);
  if (!target) throw new ForbiddenError('Target user role is not recognized');
  if (target.hierarchyLevel > caller.hierarchyLevel) {
    throw new ForbiddenError('You cannot manage a user whose role is higher than yours');
  }
}

/**
 * The roles a caller's user views must NOT show — the ONE list that both
 * `GET /api/users` and `GET /api/users/stats` apply (audit 2026-10-03, API-20).
 * Until then the list hid SUPER_ADMIN and ADMIN from a lower role while the
 * stats hid only SUPER_ADMIN, and only from an ADMIN — so an OPERATOR's stats
 * counted accounts their list could not show.
 */
export function hiddenRolesFor(callerRole: string | undefined): string[] {
  const hidden: string[] = [];
  if (callerRole !== 'SUPER_ADMIN') hidden.push('SUPER_ADMIN');
  if (callerRole !== 'SUPER_ADMIN' && callerRole !== 'ADMIN') hidden.push('ADMIN');
  return hidden;
}

export const userService = {
  async list(query: { page: number; limit?: number; role?: string; status?: string; search?: string; callerRole?: string }) {
    const where: Record<string, unknown> = {};
    if (query.role) where.role = query.role;
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { username: { contains: query.search, mode: 'insensitive' } },
        { fullName: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    // Hide higher-privilege accounts from the caller's list view
    const excludedRoles = hiddenRolesFor(query.callerRole);
    if (excludedRoles.length > 0) {
      // An explicit ?role= must NARROW the visible set, never replace the
      // exclusion — `where.role = query.role` let a caller ask for exactly the
      // accounts this filter exists to hide (?role=SUPER_ADMIN as ADMIN).
      // Intersect instead: a request for an excluded role now matches nothing.
      where.role = query.role
        ? (excludedRoles.includes(query.role) ? { in: [] } : query.role)
        : { notIn: excludedRoles };
    } else if (query.role) {
      where.role = query.role;
    }
    const { users, total } = await userRepository.findMany(where, query.page, query.limit);
    return { data: users, total, page: query.page, limit: query.limit ?? total, totalPages: query.limit ? Math.ceil(total / query.limit) : 1 };
  },

  async getStats(callerRole: string) {
    const hidden = hiddenRolesFor(callerRole);
    const roleFilter: Record<string, unknown> = hidden.length > 0 ? { role: { notIn: hidden } } : {};
    return userRepository.countByStatus(roleFilter);
  },

  /**
   * One account — 404 for an account the caller's list would hide
   * (application review 2026-10-12, finding 12): the list and the stats apply
   * `hiddenRolesFor`, and this read did not, so a lower role that knew or
   * guessed an id read a SUPER_ADMIN's or ADMIN's record. 404, never 403: the
   * account is not there for this caller.
   */
  async getById(id: string, callerRole?: string) {
    const user = await userRepository.findById(id);
    if (!user || hiddenRolesFor(callerRole).includes((user as { role: string }).role)) {
      throw new NotFoundError('User not found');
    }
    return user;
  },

  async create(data: {
    username: string; fullName: string; email?: string; department?: string;
    role: string; password: string; status?: string;
  }, ctx: RequestContext) {
    // Sanitize text inputs to prevent XSS
    data = sanitizeStrings(data, ['password', 'email']);

    // Email is optional. Store NULL (not '') when omitted so the @unique index
    // doesn't collide across multiple no-email users (Postgres treats NULLs as
    // distinct). '' is never stored, so the uniqueness probe below can pass ''
    // safely — it matches no one.
    const email = (data.email ?? '').trim() || null;

    // Validate User ID against configuration
    const userIdValidation = await validateUserId(data.username);
    if (!userIdValidation.valid) {
      throw new ValidationError(userIdValidation.errors.join('. '));
    }

    // Check role hierarchy. SUPER_ADMIN is assigned only by a SUPER_ADMIN —
    // by name, whatever the numbers say (finding 8).
    if (data.role === 'SUPER_ADMIN' && ctx.userRole !== 'SUPER_ADMIN') {
      throw new ForbiddenError(`Cannot create users with role ${data.role}`);
    }
    const creatorRole = await userRepository.findRole(ctx.userRole);
    if (!creatorRole) throw new ForbiddenError('Your role is not recognized');
    const targetRole = await userRepository.findRole(data.role);
    if (!targetRole || !targetRole.isActive) throw new ValidationError(`Role ${data.role} does not exist or is inactive`);
    if (targetRole.hierarchyLevel > creatorRole.hierarchyLevel) throw new ForbiddenError(`Cannot create users with role ${data.role}`);

    // Check uniqueness (email probed only when provided — see note above)
    const existing = await userRepository.findByUsernameOrEmail(data.username, email ?? '');
    if (existing) {
      const field = existing.username === data.username ? 'username' : 'email';
      throw new ConflictError(`${field} already exists`);
    }

    // Validate password complexity against active policy
    await validatePasswordPolicy(data.password, data.username);

    const passwordHash = await hashPassword(data.password);
    const passwordExpiresAt = await userRepository.getPasswordExpiresAt();

    const user = await prisma.$transaction(async (tx) => {
      const created = await userRepository.create({
        username: data.username,
        fullName: data.fullName,
        email,
        department: data.department,
        role: data.role,
        passwordHash,
        status: data.status ?? 'ENABLED',
        forcePasswordChange: true,
        isTemporaryPassword: true,
        passwordExpiresAt,
        createdBy: ctx.userId,
      }, tx);

      await userRepository.addPasswordHistory(created.id, passwordHash, tx);

      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'USER_CREATED',
        targetType: 'user',
        targetId: created.id,
        afterValue: { username: data.username, fullName: data.fullName, email: data.email, role: data.role, status: data.status },
        signatureMeaning: 'New user account created by administrator',
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return created;
    });

    await createNotification({
      type: 'USER_CREATED',
      title: 'New User Created',
      message: `User ${data.fullName} (${data.username}) has been created with role ${data.role}.`,
      targetUserId: data.username,
      forRole: 'ADMIN',
      metadata: { userId: user.id, role: data.role },
      createdBy: ctx.userId,
    });

    // Dispatch USER_CREATED notification
    dispatchNotification({
      eventType: 'USER_CREATED',
      context: {},
      variables: {
        username: data.username, fullName: data.fullName ?? data.username,
        email: data.email ?? 'N/A', role: data.role,
        createdBy: ctx.userId ?? 'system',
        timestamp: new Date().toISOString(),
      },
    }).catch(err => logger.error('[UserCreated] Notification dispatch failed:', err.message));

    return {
      id: user.id, username: user.username, fullName: user.fullName,
      email: user.email, department: user.department, role: user.role,
      status: user.status, createdAt: user.createdAt,
    };
  },

  async update(id: string, data: Record<string, any>, ctx: RequestContext) {
    // Sanitize text inputs to prevent XSS
    data = sanitizeStrings(data, ['password', 'passwordHash', 'email']);

    // `status` is NOT an update (application review 2026-10-12, finding 4).
    // It used to be accepted here behind USER_UPDATE + UPDATE_USER, so a role
    // without USER_ENABLE_DISABLE could disable or re-enable an account — with
    // no reason, a USER_UPDATED row instead of USER_DISABLED / USER_ENABLED, and
    // no notification. Enabling and disabling go through `enable` / `disable`
    // (POST /api/users/:id/enable|disable). Refused loudly, never dropped: a
    // silently ignored field reads as success.
    if (data.status !== undefined) {
      throw new ValidationError('Account status cannot be changed by an update — use Enable or Disable', {
        fieldErrors: { status: ['Use Enable or Disable'] },
      });
    }

    const existing = await userRepository.findByIdFull(id);
    if (!existing) throw new NotFoundError('User not found');
    // Privilege boundary: can't manage a target above your own role (audit C2).
    await assertCanManageTarget(ctx.userRole, (existing as any).role);

    // Cannot change own role (prevent self-escalation)
    if (existing.id === ctx.userSub && data.role && data.role !== existing.role) {
      throw new ForbiddenError('Cannot change your own role');
    }

    if (data.role === 'SUPER_ADMIN' && ctx.userRole !== 'SUPER_ADMIN') {
      throw new ForbiddenError(`Cannot assign role ${data.role}`); // by name — finding 8
    }
    if (data.role) {
      const creatorRole = await userRepository.findRole(ctx.userRole);
      const targetRole = await userRepository.findRole(data.role);
      if (!creatorRole || !targetRole || !targetRole.isActive || targetRole.hierarchyLevel > creatorRole.hierarchyLevel) {
        throw new ForbiddenError(`Cannot assign role ${data.role}`);
      }
    }

    // Normalize email: store NULL (not '') when blank, so the @unique index
    // doesn't collide across multiple no-email users (mirrors create()). Only
    // touch it when the caller actually sent an email field.
    if ('email' in data) {
      data.email = (data.email ?? '').trim() || null;
    }

    if (data.email && data.email !== existing.email) {
      const dup = await userRepository.findByEmail(data.email);
      if (dup) throw new ConflictError('Email already exists');
    }

    const beforeValue = { fullName: existing.fullName, email: existing.email, department: existing.department, role: existing.role, status: existing.status };

    // Never let a password reach the (immutable) audit trail. sanitizeStrings
    // only strips HTML from these keys; it does not remove them.
    const { password: _pw, passwordHash: _ph, ...auditData } = data;

    const user = await prisma.$transaction(async (tx) => {
      const updated = await userRepository.update(id, {
        ...data,
        role: data.role as any,
        updatedBy: ctx.userId,
      }, tx);

      // If role changed, invalidate all active sessions so user gets fresh JWT on re-login
      if (data.role && data.role !== existing.role) {
        await userRepository.terminateSessions(id, 'role_changed', tx);
      }

      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'USER_UPDATED',
        targetType: 'user',
        targetId: id,
        beforeValue,
        afterValue: { ...auditData, username: updated.username, fullName: updated.fullName },
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return updated;
    });

    // Take role/status/password change effect immediately (not after the 30s cache TTL).
    invalidateUserAuthCache(id);

    return { id: user.id, username: user.username, fullName: user.fullName, email: user.email, role: user.role, status: user.status };
  },

  async delete(id: string, callerSub: string, ctx: RequestContext, reason?: string) {
    const existing = await userRepository.findByIdFull(id);
    if (!existing) throw new NotFoundError('User not found');
    if (id === callerSub) throw new ValidationError('Cannot delete your own account');
    if ((existing as any).role === 'SUPER_ADMIN') throw new ForbiddenError('Cannot delete SUPER_ADMIN users');
    const why = requireReason(reason, 'Deleting a user');

    // The audit row is written INSIDE the delete's transaction, after the
    // delete (API-7). It used to be written BEFORE, standalone: a delete that
    // then failed on a foreign key left a committed, chained row asserting an
    // account was gone while it still logged in.
    await prisma.$transaction(async (tx) => {
      await userRepository.delete(id, tx);
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'USER_DELETED',
        targetType: 'user',
        targetId: id,
        beforeValue: { username: existing.username, fullName: existing.fullName, email: existing.email, role: existing.role, status: existing.status },
        afterValue: { deleted: true },
        reason: why,
        signatureMeaning: 'User account permanently deleted by administrator',
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    invalidateUserAuthCache(id);
  },

  async bulkDelete(userIds: string[], callerSub: string, ctx: RequestContext, reason?: string) {
    if (userIds.includes(callerSub)) throw new ValidationError('Cannot delete your own account');

    const users = await userRepository.findManyByIds(userIds);
    if (users.length === 0) throw new NotFoundError('No users found with the provided IDs');

    const superAdmins = users.filter((u: any) => u.role === 'SUPER_ADMIN');
    if (superAdmins.length > 0) {
      throw new ForbiddenError(`Cannot delete SUPER_ADMIN users: ${superAdmins.map((u: any) => u.username).join(', ')}`);
    }
    const why = requireReason(reason, 'Deleting users');

    const validIds = users.map((u: any) => u.id);

    // One transaction: the delete and one BULK_USER_DELETED row per account.
    // N standalone rows followed by a deleteMany could record N deletions and
    // perform none (API-7).
    await prisma.$transaction(async (tx) => {
      await userRepository.deleteMany(validIds, tx);
      for (const user of users) {
        await auditLog({
          userId: ctx.userId, userRole: ctx.userRole,
          action: 'BULK_USER_DELETED',
          targetType: 'user',
          targetId: user.id,
          beforeValue: { username: user.username, fullName: user.fullName, role: user.role, status: user.status },
          afterValue: { deleted: true },
          reason: why,
          signatureMeaning: 'User account permanently deleted via bulk delete by administrator',
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      }
    });
    for (const uid of validIds) invalidateUserAuthCache(uid);
    return { deletedCount: validIds.length, deletedUsers: users.map((u: any) => ({ id: u.id, username: u.username })) };
  },

  async enable(id: string, ctx: RequestContext) {
    const user = await userRepository.findByIdFull(id);
    if (!user) throw new NotFoundError('User not found');
    await assertCanManageTarget(ctx.userRole, (user as any).role);

    await prisma.$transaction(async (tx) => {
      await userRepository.update(id, { status: 'ENABLED', updatedBy: ctx.userId }, tx);
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole, action: 'USER_ENABLED',
        targetType: 'user', targetId: id,
        beforeValue: { username: user.username, fullName: user.fullName, status: user.status },
        afterValue: { username: user.username, status: 'ENABLED' },
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    invalidateUserAuthCache(id);

    await createNotification({
      type: 'ACCOUNT_ENABLED', title: 'Account Enabled',
      message: `User ${user.fullName} (${user.username}) has been enabled.`,
      targetUserId: user.username, forRole: 'ADMIN', createdBy: ctx.userId,
    });
    await createNotification({
      type: 'ACCOUNT_ENABLED', title: 'Your Account Has Been Enabled',
      message: `Your account has been enabled by ${ctx.userId}. You can now log in.`,
      targetUserId: user.username, forUserId: user.username, createdBy: ctx.userId,
    });
  },

  async disable(id: string, ctx: RequestContext, reason?: string) {
    const user = await userRepository.findByIdFull(id);
    if (!user) throw new NotFoundError('User not found');
    await assertCanManageTarget(ctx.userRole, (user as any).role);
    const why = requireReason(reason, 'Disabling a user');

    await prisma.$transaction(async (tx) => {
      await userRepository.update(id, { status: 'DISABLED', updatedBy: ctx.userId }, tx);
      await userRepository.terminateSessions(id, 'account_disabled', tx);
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole, action: 'USER_DISABLED',
        targetType: 'user', targetId: id,
        beforeValue: { username: user.username, fullName: user.fullName, status: user.status },
        afterValue: { username: user.username, status: 'DISABLED' },
        reason: why,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    invalidateUserAuthCache(id); // revoke access immediately, not after the 30s TTL

    await createNotification({
      type: 'ACCOUNT_DISABLED', title: 'Account Disabled',
      message: `User ${user.fullName} (${user.username}) has been disabled.`,
      targetUserId: user.username, forRole: 'ADMIN', createdBy: ctx.userId,
    });
    await createNotification({
      type: 'ACCOUNT_DISABLED', title: 'Your Account Has Been Disabled',
      message: `Your account has been disabled. Please contact an administrator.`,
      targetUserId: user.username, forUserId: user.username, createdBy: ctx.userId,
    });
  },

  /**
   * Clear an account lock.
   *
   * Returns `passwordIssued` so the caller can tell the admin the truth about
   * what happened: local accounts get a temporary password they must hand over,
   * directory accounts get their lock cleared and nothing else.
   */
  async unlock(id: string, newPassword: string | undefined, ctx: RequestContext): Promise<{ passwordIssued: boolean }> {
    const user = await userRepository.findByIdFull(id);
    if (!user) throw new NotFoundError('User not found');
    await assertCanManageTarget(ctx.userRole, (user as any).role);

    // Directory accounts unlock WITHOUT a password being set.
    //
    // Unlock's normal job is "clear the lock and hand the user a temporary
    // password"; for an AD user the second half is both impossible and harmful —
    // it would overwrite the sentinel and detach them from the directory exactly
    // like resetPassword did. Clearing the lock alone is the whole meaningful
    // operation: their credential is already valid, it is only this application's
    // lock that stands in the way.
    //
    // These rows can still exist even though LDAP lockout is now delegated —
    // accounts locked before that change, or locked by a non-credential path.
    if (isLdapUser(user as any)) {
      await prisma.$transaction(async (tx) => {
        const after = await userRepository.unlockWithoutPasswordChange(id, ctx.userId, tx);
        await userRepository.terminateSessions(id, 'account_unlocked', tx);
        await auditLog({
          userId: ctx.userId, userRole: ctx.userRole, action: 'ACCOUNT_UNLOCKED',
          targetType: 'user', targetId: id,
          beforeValue: {
            username: user.username, fullName: user.fullName,
            status: user.status, failedLoginAttempts: user.failedLoginAttempts,
          },
          afterValue: {
            username: user.username, fullName: user.fullName,
            // The status the row now HAS: a DISABLED account stays disabled
            // (finding 3), and the record must not claim otherwise.
            status: after.status, failedLoginAttempts: 0, authSource: 'ldap',
            passwordUnchanged: true,
          },
          signatureMeaning:
            'Directory-authenticated account unlocked by administrator '
            + '(no password set — credential remains managed in Active Directory)',
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      });
      invalidateUserAuthCache(id);
      return { passwordIssued: false };
    }

    // Local accounts: a temporary password is mandatory. The route schema no
    // longer enforces it (directory accounts legitimately omit it), so the
    // requirement is asserted here, where the account type is known.
    if (!newPassword) {
      throw new ValidationError('A temporary password is required to unlock a local account');
    }
    // Administrator-set temporary passwords are held to the same configured
    // complexity policy as create()/self-service change. The route's minLength 8
    // is not the policy — it's a floor. (History reuse is deliberately not checked
    // here: the target is forced to change this password at next login anyway.)
    await validatePasswordPolicy(newPassword, user.username);

    const newHash = await hashPassword(newPassword);
    const passwordExpiresAt = await userRepository.getPasswordExpiresAt();

    await prisma.$transaction(async (tx) => {
      const [after] = await userRepository.unlockUser(id, newHash, passwordExpiresAt, ctx.userId, tx);
      // Compromise-response: evict any live sessions/JWTs held for this user so a
      // stolen session can't survive the reset (mirrors disable()).
      await userRepository.terminateSessions(id, 'account_unlocked', tx);
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole, action: 'ACCOUNT_UNLOCKED',
        targetType: 'user', targetId: id,
        beforeValue: { username: user.username, fullName: user.fullName, status: user.status, failedLoginAttempts: user.failedLoginAttempts },
        afterValue: { username: user.username, fullName: user.fullName, status: after.status, failedLoginAttempts: 0, forcePasswordChange: true, isTemporaryPassword: true },
        signatureMeaning: 'User account unlocked by administrator with temporary password',
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    invalidateUserAuthCache(id);

    return { passwordIssued: true };
  },

  async resetPassword(id: string, newPassword: string, ctx: RequestContext) {
    const user = await userRepository.findByIdFull(id);
    if (!user) throw new NotFoundError('User not found');
    await assertCanManageTarget(ctx.userRole, (user as any).role);

    // Refuse for directory accounts (operator decision, 2026-08-08).
    //
    // This used to "work": it hashed the new password over the LDAP sentinel,
    // which silently detached the account from Active Directory. From that
    // moment the employee's AD password no longer signed them in, and — far
    // worse — disabling or deleting them in AD no longer revoked their access
    // to this application, because the credential had quietly become local. An
    // admin clicking a familiar button had no way to know they had done that.
    if (isLdapUser(user as any)) {
      throw new ValidationError(
        `${LDAP_PASSWORD_MANAGED_MESSAGE} To reset it, use your directory tools `
        + '(Active Directory Users and Computers), or ask your IT team.',
      );
    }
    // Same policy parity as unlock()/create() — see note in unlock().
    await validatePasswordPolicy(newPassword, user.username);

    const newHash = await hashPassword(newPassword);
    const passwordExpiresAt = await userRepository.getPasswordExpiresAt();

    await prisma.$transaction(async (tx) => {
      const [after] = await userRepository.resetPassword(id, newHash, passwordExpiresAt, ctx.userId, tx);
      // Compromise-response: evict any live sessions/JWTs held for this user so a
      // stolen session can't survive the reset (mirrors disable()).
      await userRepository.terminateSessions(id, 'password_reset', tx);
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole, action: 'PASSWORD_RESET',
        targetType: 'user', targetId: id,
        beforeValue: { username: user.username, fullName: user.fullName, status: user.status },
        afterValue: { status: after.status, forcePasswordChange: true, isTemporaryPassword: true },
        signatureMeaning: 'Administrator reset user password',
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    invalidateUserAuthCache(id);
  },

  async listResetRequests() {
    const requests = await userRepository.findResetRequests();
    // PasswordResetRequest.userId is a UUID FK to User.id. Previously this
    // looked the IDs up via findUsersByUsernames(), which always missed —
    // so the API returned the UUID in the `userId` field and the operator UI
    // showed the raw UUID instead of the employee/user ID.
    const userIds = [...new Set(requests.map((r: any) => r.userId))] as string[];
    const users = userIds.length > 0 ? await userRepository.findUsersByIds(userIds) : [];
    const userMap = new Map(users.map((u: any) => [u.id, u]));

    return {
      data: requests.map((request: any) => {
        const user = userMap.get(request.userId) as any;
        return {
          ...request,
          // Surface the username (employee ID) as `userId` for display.
          // The PasswordResetRequest's own `id` is used to address the
          // request on the process endpoint, so we don't need to expose the
          // user UUID to the operator UI.
          userId: user?.username ?? request.userId,
          userFullName: user?.fullName ?? user?.username ?? request.userId,
          userEmail: user?.email ?? '',
          userDepartment: user?.department ?? '',
        };
      }),
    };
  },

  async getPendingResetRequestCount() {
    return { count: await userRepository.countPendingResetRequests() };
  },

  async processResetRequest(id: string, action: 'approve' | 'reject', newPassword: string | undefined, notes: string | undefined, ctx: RequestContext) {
    const resetRequest = await userRepository.findResetRequestById(id);
    if (!resetRequest) throw new NotFoundError('Reset request not found');
    if (resetRequest.status !== 'PENDING') throw new ValidationError('Reset request has already been processed');

    // PasswordResetRequest.userId is a UUID FK to User.id. The previous code
    // passed that UUID to findByUsername(), which always missed → approve
    // always returned 404 ("User not found"). It also wrote that UUID into
    // notification.targetUserId / forUserId columns (both VarChar(50)
    // expecting username), which both
    //   (a) leaked a UUID into the admin-facing notification message, and
    //   (b) prevented the recipient from ever seeing the notification —
    //       the in-app visibility filter (notification.service.ts:30)
    //       requires forUserId === currentUsername, and a UUID never
    //       matches.
    // Resolve to the User row by id, then propagate user.username
    // everywhere downstream.
    const user = await userRepository.findById(resetRequest.userId);
    if (!user) throw new NotFoundError('User not found');
    // Same hierarchy guard as resetPassword/unlock/update/disable/enable: an
    // approval sets an attacker-chosen password on the target, so a lower-privilege
    // caller must not be able to process (approve OR reject) a reset request for a
    // higher-privilege user (e.g. ADMIN taking over a SUPER_ADMIN account).
    await assertCanManageTarget(ctx.userRole, (user as any).role);

    if (action === 'approve') {
      // Same conversion hazard as resetPassword() — approving would write a
      // local bcrypt hash over the directory sentinel and detach the account
      // from AD. `forgotPassword` no longer files requests for directory users,
      // so this only fires on requests raised before that guard existed; reject
      // them instead, with a message that tells the admin where to actually go.
      if (isLdapUser(user as any)) {
        throw new ValidationError(
          `${LDAP_PASSWORD_MANAGED_MESSAGE} Reject this request and reset the password in `
          + 'Active Directory instead.',
        );
      }
      if (!newPassword) throw new ValidationError('New password is required');
      // Was a bare `length < 8` check, which ignored the configured policy —
      // same parity fix as unlock()/resetPassword().
      await validatePasswordPolicy(newPassword, user.username);

      const newHash = await hashPassword(newPassword);
      const passwordExpiresAt = await userRepository.getPasswordExpiresAt();

      await prisma.$transaction(async (tx) => {
        await userRepository.approveResetRequest(id, user.id, newHash, passwordExpiresAt, ctx.userId, notes, tx);
        await auditLog({
          userId: ctx.userId, userRole: ctx.userRole, action: 'PASSWORD_RESET_REQUEST_APPROVED',
          targetType: 'user', targetId: user.id,
          afterValue: { requestId: id, username: user.username },
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      });
      invalidateUserAuthCache(user.id);

      await createNotification({
        type: 'PASSWORD_RESET_APPROVED', title: 'Password Reset Approved',
        message: `Password reset request for ${user.username} has been approved.`,
        targetUserId: user.username, forRole: 'ADMIN', createdBy: ctx.userId,
      });
      await createNotification({
        type: 'PASSWORD_RESET_APPROVED', title: 'Password Reset Approved',
        message: `Your password reset request has been approved. Please login with your new temporary password.`,
        targetUserId: user.username, forUserId: user.username, createdBy: ctx.userId,
      });

      return { message: 'Password reset approved and new password set.' };
    } else {
      await prisma.$transaction(async (tx) => {
        await userRepository.rejectResetRequest(id, ctx.userId, notes, tx);
        await auditLog({
          userId: ctx.userId, userRole: ctx.userRole, action: 'PASSWORD_RESET_REQUEST_REJECTED',
          targetType: 'password_reset_request', targetId: id,
          afterValue: { username: user.username, notes },
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      });

      await createNotification({
        type: 'PASSWORD_RESET_REJECTED', title: 'Password Reset Rejected',
        message: `Your password reset request has been rejected. Please contact an administrator.`,
        targetUserId: user.username, forUserId: user.username, createdBy: ctx.userId,
      });

      return { message: 'Password reset request rejected.' };
    }
  },
};
