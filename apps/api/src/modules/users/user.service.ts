import { sanitizeStrings } from "../../lib/sanitize.js";
import type { RequestContext } from '../../types/context.js';
import { auditLog } from '../../lib/audit.js';
import { hashPassword } from '../../lib/password.js';
import { validatePasswordPolicy } from '../../lib/password-validator.js';
import { validateUserId } from '../../lib/user-id-validator.js';
import { NotFoundError, ValidationError, ConflictError, ForbiddenError } from '../../lib/errors.js';
import { userRepository } from './user.repository.js';
import { prisma } from '../../lib/prisma.js';
import { createNotification } from '../notifications/notification.service.js';
import { dispatchNotification } from '../notification-delivery/notification-dispatcher.js';
// Drop the per-user auth cache on every mutation so a role/status/password
// change takes effect immediately instead of after the 30s TTL (audit M-7).
import { invalidateUserAuthCache } from '../../plugins/auth.js';

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
  const caller = await userRepository.findRole(callerRole);
  if (!caller) throw new ForbiddenError('Your role is not recognized');
  const target = await userRepository.findRole(targetRoleName);
  if (!target) throw new ForbiddenError('Target user role is not recognized');
  if (target.hierarchyLevel > caller.hierarchyLevel) {
    throw new ForbiddenError('You cannot manage a user whose role is higher than yours');
  }
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
    const excludedRoles: string[] = [];
    if (query.callerRole !== 'SUPER_ADMIN') excludedRoles.push('SUPER_ADMIN');
    if (query.callerRole !== 'SUPER_ADMIN' && query.callerRole !== 'ADMIN') excludedRoles.push('ADMIN');
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
    const roleFilter: Record<string, unknown> = callerRole === 'ADMIN' ? { role: { not: 'SUPER_ADMIN' as any } } : {};
    return userRepository.countByStatus(roleFilter);
  },

  async getById(id: string) {
    const user = await userRepository.findById(id);
    if (!user) throw new NotFoundError('User not found');
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

    // Check role hierarchy
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

    const user = await userRepository.create({
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
    });

    await userRepository.addPasswordHistory(user.id, passwordHash);

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'USER_CREATED',
      targetType: 'user',
      targetId: user.id,
      afterValue: { username: data.username, fullName: data.fullName, email: data.email, role: data.role, status: data.status },
      signatureMeaning: 'New user account created by administrator',
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
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
    }).catch(err => console.error('[UserCreated] Notification dispatch failed:', err.message));

    return {
      id: user.id, username: user.username, fullName: user.fullName,
      email: user.email, department: user.department, role: user.role,
      status: user.status, createdAt: user.createdAt,
    };
  },

  async update(id: string, data: Record<string, any>, ctx: RequestContext) {
    // Sanitize text inputs to prevent XSS
    data = sanitizeStrings(data, ['password', 'passwordHash', 'email']);

    const existing = await userRepository.findByIdFull(id);
    if (!existing) throw new NotFoundError('User not found');
    // Privilege boundary: can't manage a target above your own role (audit C2).
    await assertCanManageTarget(ctx.userRole, (existing as any).role);

    // Cannot change own role (prevent self-escalation)
    if (existing.id === ctx.userSub && data.role && data.role !== existing.role) {
      throw new ForbiddenError('Cannot change your own role');
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

    const user = await userRepository.update(id, {
      ...data,
      role: data.role as any,
      status: data.status as any,
      updatedBy: ctx.userId,
    });

    // If role changed, invalidate all active sessions so user gets fresh JWT on re-login
    if (data.role && data.role !== existing.role) {
      await prisma.session.updateMany({
        where: { userId: id, isActive: true },
        data: { isActive: false, terminationReason: 'role_changed' },
      });
    }

    // If status changed to non-ENABLED, also invalidate sessions
    if (data.status && data.status !== 'ENABLED' && data.status !== existing.status) {
      await prisma.session.updateMany({
        where: { userId: id, isActive: true },
        data: { isActive: false, terminationReason: 'account_disabled' },
      });
    }

    // Take role/status/password change effect immediately (not after the 30s cache TTL).
    invalidateUserAuthCache(id);

    // Never let a password reach the (immutable) audit trail. sanitizeStrings
    // only strips HTML from these keys; it does not remove them.
    const { password: _pw, passwordHash: _ph, ...auditData } = data;
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'USER_UPDATED',
      targetType: 'user',
      targetId: id,
      beforeValue,
      afterValue: { ...auditData, username: user.username, fullName: user.fullName },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return { id: user.id, username: user.username, fullName: user.fullName, email: user.email, role: user.role, status: user.status };
  },

  async delete(id: string, callerSub: string, ctx: RequestContext) {
    const existing = await userRepository.findByIdFull(id);
    if (!existing) throw new NotFoundError('User not found');
    if (id === callerSub) throw new ValidationError('Cannot delete your own account');
    if ((existing as any).role === 'SUPER_ADMIN') throw new ForbiddenError('Cannot delete SUPER_ADMIN users');

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'USER_DELETED',
      targetType: 'user',
      targetId: id,
      beforeValue: { username: existing.username, fullName: existing.fullName, email: existing.email, role: existing.role, status: existing.status },
      afterValue: { deleted: true },
      signatureMeaning: 'User account permanently deleted by administrator',
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    await userRepository.delete(id);
  },

  async bulkDelete(userIds: string[], callerSub: string, ctx: RequestContext) {
    if (userIds.includes(callerSub)) throw new ValidationError('Cannot delete your own account');

    const users = await userRepository.findManyByIds(userIds);
    if (users.length === 0) throw new NotFoundError('No users found with the provided IDs');

    const superAdmins = users.filter((u: any) => u.role === 'SUPER_ADMIN');
    if (superAdmins.length > 0) {
      throw new ForbiddenError(`Cannot delete SUPER_ADMIN users: ${superAdmins.map((u: any) => u.username).join(', ')}`);
    }

    const validIds = users.map((u: any) => u.id);

    for (const user of users) {
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'BULK_USER_DELETED',
        targetType: 'user',
        targetId: user.id,
        beforeValue: { username: user.username, fullName: user.fullName, role: user.role, status: user.status },
        afterValue: { deleted: true },
        signatureMeaning: 'User account permanently deleted via bulk delete by administrator',
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      });
    }

    await userRepository.deleteMany(validIds);
    for (const uid of validIds) invalidateUserAuthCache(uid);
    return { deletedCount: validIds.length, deletedUsers: users.map((u: any) => ({ id: u.id, username: u.username })) };
  },

  async enable(id: string, ctx: RequestContext) {
    const user = await userRepository.findByIdFull(id);
    if (!user) throw new NotFoundError('User not found');
    await assertCanManageTarget(ctx.userRole, (user as any).role);

    await userRepository.update(id, { status: 'ENABLED', updatedBy: ctx.userId });
    invalidateUserAuthCache(id);

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'USER_ENABLED',
      targetType: 'user', targetId: id,
      beforeValue: { username: user.username, fullName: user.fullName, status: user.status },
      afterValue: { username: user.username, status: 'ENABLED' },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

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

  async disable(id: string, ctx: RequestContext) {
    const user = await userRepository.findByIdFull(id);
    if (!user) throw new NotFoundError('User not found');
    await assertCanManageTarget(ctx.userRole, (user as any).role);

    await userRepository.update(id, { status: 'DISABLED', updatedBy: ctx.userId });
    await userRepository.terminateSessions(id, 'account_disabled');
    invalidateUserAuthCache(id); // revoke access immediately, not after the 30s TTL

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'USER_DISABLED',
      targetType: 'user', targetId: id,
      beforeValue: { username: user.username, fullName: user.fullName, status: user.status },
      afterValue: { username: user.username, status: 'DISABLED' },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

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

  async unlock(id: string, newPassword: string, ctx: RequestContext) {
    const user = await userRepository.findByIdFull(id);
    if (!user) throw new NotFoundError('User not found');
    await assertCanManageTarget(ctx.userRole, (user as any).role);
    // Administrator-set temporary passwords are held to the same configured
    // complexity policy as create()/self-service change. The route's minLength 8
    // is not the policy — it's a floor. (History reuse is deliberately not checked
    // here: the target is forced to change this password at next login anyway.)
    await validatePasswordPolicy(newPassword, user.username);

    const newHash = await hashPassword(newPassword);
    const passwordExpiresAt = await userRepository.getPasswordExpiresAt();

    await userRepository.unlockUser(id, newHash, passwordExpiresAt, ctx.userId);
    // Compromise-response: evict any live sessions/JWTs held for this user so a
    // stolen session can't survive the reset (mirrors disable()).
    await userRepository.terminateSessions(id, 'account_unlocked');
    invalidateUserAuthCache(id);

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'ACCOUNT_UNLOCKED',
      targetType: 'user', targetId: id,
      beforeValue: { username: user.username, fullName: user.fullName, status: user.status, failedLoginAttempts: user.failedLoginAttempts },
      afterValue: { username: user.username, fullName: user.fullName, status: 'ENABLED', failedLoginAttempts: 0, forcePasswordChange: true, isTemporaryPassword: true },
      signatureMeaning: 'User account unlocked by administrator with temporary password',
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
  },

  async resetPassword(id: string, newPassword: string, ctx: RequestContext) {
    const user = await userRepository.findByIdFull(id);
    if (!user) throw new NotFoundError('User not found');
    await assertCanManageTarget(ctx.userRole, (user as any).role);
    // Same policy parity as unlock()/create() — see note in unlock().
    await validatePasswordPolicy(newPassword, user.username);

    const newHash = await hashPassword(newPassword);
    const passwordExpiresAt = await userRepository.getPasswordExpiresAt();

    await userRepository.resetPassword(id, newHash, passwordExpiresAt, ctx.userId);
    // Compromise-response: evict any live sessions/JWTs held for this user so a
    // stolen session can't survive the reset (mirrors disable()).
    await userRepository.terminateSessions(id, 'password_reset');
    invalidateUserAuthCache(id);

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'PASSWORD_RESET',
      targetType: 'user', targetId: id,
      beforeValue: { username: user.username, fullName: user.fullName, status: user.status },
      afterValue: { status: 'ENABLED', forcePasswordChange: true, isTemporaryPassword: true },
      signatureMeaning: 'Administrator reset user password',
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
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
      if (!newPassword) throw new ValidationError('New password is required');
      // Was a bare `length < 8` check, which ignored the configured policy —
      // same parity fix as unlock()/resetPassword().
      await validatePasswordPolicy(newPassword, user.username);

      const newHash = await hashPassword(newPassword);
      const passwordExpiresAt = await userRepository.getPasswordExpiresAt();

      await userRepository.approveResetRequest(id, user.id, newHash, passwordExpiresAt, ctx.userId, notes);

      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole, action: 'PASSWORD_RESET_REQUEST_APPROVED',
        targetType: 'user', targetId: user.id,
        afterValue: { requestId: id, username: user.username },
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      });

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
      await userRepository.rejectResetRequest(id, ctx.userId, notes);

      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole, action: 'PASSWORD_RESET_REQUEST_REJECTED',
        targetType: 'password_reset_request', targetId: id,
        afterValue: { username: user.username, notes },
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
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
