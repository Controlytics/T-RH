import { prisma } from '../../lib/prisma.js';
import { invalidateUserAuthCache, invalidateSessionAuthCache } from '../../plugins/auth.js';
import { createHash } from 'node:crypto';

export const authRepository = {
  async findUserByUsername(username: string) {
    return prisma.user.findUnique({ where: { username } });
  },

  async findUserById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  },

  async findUserByIdSelect(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true, username: true, fullName: true, email: true, department: true,
        photoUrl: true, role: true, status: true, forcePasswordChange: true,
        isTemporaryPassword: true, lastLogin: true, createdAt: true,
      },
    });
  },

  async getRolePermissions(roleName: string) {
    const role = await prisma.role.findUnique({
      where: { name: roleName },
      select: { permissions: true },
    });
    return (role?.permissions as string[]) || [];
  },

  async findUserByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  },

  async updateUser(id: string, data: Record<string, unknown>) {
    const updated = await prisma.user.update({ where: { id }, data: data as any });
    // Bust 30s auth cache so role/status/forcePasswordChange flips take effect
    // immediately. Closes the May 16 audit gap (admin-force-reset + DB-correct
    // but cache serves stale principal for up to 30s window).
    invalidateUserAuthCache(id);
    return updated;
  },

  async updateUserProfile(id: string, data: Record<string, unknown>) {
    const updated = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true, username: true, fullName: true, email: true, department: true,
        photoUrl: true, role: true,
      },
    });
    invalidateUserAuthCache(id);
    return updated;
  },

  async findActiveSessions(userId: string) {
    return prisma.session.findMany({
      where: { userId, isActive: true, expiresAt: { gt: new Date() } },
    });
  },

  async findActiveSessionsByIp(ipAddress: string, excludeUserId: string) {
    return prisma.session.findMany({
      where: {
        ipAddress,
        isActive: true,
        expiresAt: { gt: new Date() },
        userId: { not: excludeUserId },
      },
      include: { user: { select: { username: true, fullName: true } } },
    });
  },

  async terminateActiveSessions(userId: string, reason: string) {
    // Capture the ids first so we can evict them from the 30s sessionAuthCache
    // in plugins/auth — otherwise the killed session keeps passing auth for up
    // to the cache TTL (force-login / single-tab bypass). See
    // feedback_auth_cache_invalidation_gap line 28.
    const sessions = await prisma.session.findMany({
      where: { userId, isActive: true },
      select: { id: true },
    });
    const result = await prisma.session.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false, terminationReason: reason },
    });
    for (const s of sessions) invalidateSessionAuthCache(s.id);
    return result;
  },

  async terminateSession(sessionId: string, reason: string) {
    const result = await prisma.session.update({
      where: { id: sessionId },
      data: { isActive: false, terminationReason: reason },
    });
    // Self-evict so every terminate path clears its own cache entry (callers
    // like logout() also call this, now redundantly-but-safely).
    invalidateSessionAuthCache(sessionId);
    return result;
  },

  async findSessionById(sessionId: string) {
    return prisma.session.findFirst({
      where: { id: sessionId, isActive: true },
    });
  },

  async createSession(userId: string, ipAddress: string, userAgent: string | undefined, durationHours: number) {
    const sessionToken = createHash('sha256').update(crypto.randomUUID()).digest('hex');
    return prisma.session.create({
      data: {
        userId,
        tokenHash: sessionToken,
        ipAddress,
        userAgent,
        expiresAt: new Date(Date.now() + durationHours * 60 * 60 * 1000),
      },
    });
  },

  async getLoginSecurityConfig() {
    const config = await prisma.systemConfig.findUnique({ where: { configKey: 'login-security' } });
    return (config?.configValue as { lockoutType?: string; lockoutDurationMinutes?: number }) ?? {};
  },

  async getSessionConfig() {
    const config = await prisma.systemConfig.findUnique({ where: { configKey: 'session' } });
    return (config?.configValue as { sessionDurationHours?: number }) ?? {};
  },

  async getPasswordPolicyConfig() {
    const config = await prisma.systemConfig.findUnique({ where: { configKey: 'password-policy' } });
    return (config?.configValue ?? {
      minLength: 8, maxLength: 128, requireUppercase: true, requireLowercase: true,
      requireNumbers: true, requireSpecialChars: true, minUppercase: 1, minLowercase: 1,
      minNumbers: 1, minSpecialChars: 1, preventReuseCount: 12, cannotBeUserId: true,
      cannotContainUserId: true,
    }) as Record<string, unknown>;
  },

  /** Returns the full SystemConfig row for password-policy so callers can
   * read `updatedAt` alongside `configValue` — required by the expiry gate
   * (lib/password-expiry.ts) which floors the per-user anchor at the
   * policy's save time. */
  async getPasswordPolicyRow() {
    return prisma.systemConfig.findUnique({ where: { configKey: 'password-policy' } });
  },

  async getPasswordHistory(userId: string, count: number) {
    return prisma.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: count,
    });
  },

  async changePassword(userId: string, newHash: string, passwordExpiresAt: Date | null) {
    const result = await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash: newHash,
          forcePasswordChange: false,
          isTemporaryPassword: false,
          passwordChangedAt: new Date(),
          passwordExpiresAt,
        },
      }),
      prisma.passwordHistory.create({
        data: { userId, passwordHash: newHash },
      }),
    ]);
    invalidateUserAuthCache(userId);
    return result;
  },

  async findPendingResetRequest(userId: string) {
    return prisma.passwordResetRequest.findFirst({
      where: { userId, status: 'PENDING' },
    });
  },

  async createResetRequest(userId: string) {
    return prisma.passwordResetRequest.create({
      data: { userId, status: 'PENDING' },
    });
  },

  async terminateOtherSessions(userId: string, excludeSessionId: string, reason: string) {
    // Evict the terminated sessions from the auth cache — the whole point of
    // this call (on password change) is to immediately kill potentially-
    // compromised sessions; the 30s cache would otherwise keep them alive.
    const sessions = await prisma.session.findMany({
      where: { userId, isActive: true, id: { not: excludeSessionId } },
      select: { id: true },
    });
    const result = await prisma.session.updateMany({
      where: { userId, isActive: true, id: { not: excludeSessionId } },
      data: { isActive: false, terminationReason: reason },
    });
    for (const s of sessions) invalidateSessionAuthCache(s.id);
    return result;
  },
};
