import { prisma } from '../../lib/prisma.js';
import { invalidateUserAuthCache, invalidateSessionAuthCache } from '../../plugins/auth.js';

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Every write below takes an optional `tx` (audit 2026-10-03, API-7) so the
 * service can run the mutation and its `auditLog(entry, tx)` in ONE
 * transaction: a user row must not be able to commit — or vanish — with no
 * audit row, and an audit row must not be able to assert a change that rolled
 * back. Without a `tx` each write still stands alone, as before.
 */
const db = (tx?: Tx) => tx ?? prisma;

/**
 * Remove every row that holds an ON DELETE RESTRICT foreign key to the users
 * being deleted, so `user.delete` can proceed. Without this a user who ever
 * authored content gets a Prisma P2003 ("Foreign key constraint failed") and
 * the Users page surfaces a generic delete error.
 *
 *  - `user_configs` — sidebar/permission overrides for the user.
 *  - `report_*` — the Reports feature was removed from the app (2026-06-08) but
 *    its tables linger with RESTRICT FKs (created_by / generated_by / user_id).
 *    Any user who authored a report template (or signed/generated a report)
 *    could not be deleted. These rows are vestigial; clear them. Children
 *    (versions, signatures) cascade from their parents, but we also delete the
 *    user-owned children directly in case the parent was authored by someone else.
 */
async function clearUserDeleteBlockers(tx: Tx, ids: string[]): Promise<void> {
  await tx.userConfig.deleteMany({ where: { userId: { in: ids } } });
  // (reportSignature/reportInstance/reportTemplateVersion/reportTemplate cascade
  // cleanup removed 2026-07-04 with the orphaned reports module + its tables.)
}

export const userRepository = {
  async findMany(where: Record<string, unknown>, page: number, limit?: number) {
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where: where as any,
        select: {
          id: true, username: true, fullName: true, email: true, department: true,
          role: true, status: true, lastLogin: true, createdAt: true, createdBy: true,
          authSource: true,
        },
        orderBy: { createdAt: 'desc' },
        ...(limit ? { skip: (page - 1) * limit, take: limit } : {}),
      }),
      prisma.user.count({ where: where as any }),
    ]);
    return { users, total };
  },

  async findById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true, username: true, fullName: true, email: true, department: true,
        role: true, status: true, failedLoginAttempts: true, forcePasswordChange: true,
        isTemporaryPassword: true, lastLogin: true, passwordChangedAt: true,
        createdAt: true, updatedAt: true, createdBy: true, updatedBy: true,
        // Identity origin — drives the "Active Directory" badge and the
        // disabling of local-password controls on the user detail/edit page.
        authSource: true, ldapDn: true,
      },
    });
  },

  async findByIdFull(id: string) {
    return prisma.user.findUnique({ where: { id } });
  },

  async findByUsername(username: string) {
    return prisma.user.findUnique({ where: { username } });
  },

  async findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  },

  async findByUsernameOrEmail(username: string, email: string) {
    return prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
    });
  },

  async create(data: {
    username: string;
    fullName: string;
    email?: string | null;
    department?: string;
    role: string;
    passwordHash: string;
    status: string;
    forcePasswordChange: boolean;
    isTemporaryPassword: boolean;
    passwordExpiresAt: Date | null;
    createdBy: string;
  }, tx?: Tx) {
    return db(tx).user.create({
      data: {
        username: data.username,
        fullName: data.fullName,
        email: data.email,
        department: data.department,
        role: data.role as any,
        passwordHash: data.passwordHash,
        status: data.status as any,
        forcePasswordChange: data.forcePasswordChange,
        isTemporaryPassword: data.isTemporaryPassword,
        passwordChangedAt: new Date(),
        passwordExpiresAt: data.passwordExpiresAt,
        createdBy: data.createdBy,
      },
    });
  },

  async update(id: string, data: Record<string, unknown>, tx?: Tx) {
    const updated = await db(tx).user.update({ where: { id }, data: data as any });
    invalidateUserAuthCache(id);
    return updated;
  },

  async delete(id: string, tx?: Tx) {
    const run = async (t: Tx) => {
      await clearUserDeleteBlockers(t, [id]);
      return t.user.delete({ where: { id } });
    };
    const result = tx ? await run(tx) : await prisma.$transaction(run);
    invalidateUserAuthCache(id);
    return result;
  },

  async deleteMany(ids: string[], tx?: Tx) {
    const run = async (t: Tx) => {
      await clearUserDeleteBlockers(t, ids);
      return t.user.deleteMany({ where: { id: { in: ids } } });
    };
    const result = tx ? await run(tx) : await prisma.$transaction(run);
    for (const id of ids) invalidateUserAuthCache(id);
    return result;
  },

  async findManyByIds(ids: string[]) {
    return prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true, fullName: true, role: true, status: true },
    });
  },

  async countByStatus(roleFilter: Record<string, unknown>) {
    const [total, enabled, disabled, locked, expired] = await Promise.all([
      prisma.user.count({ where: { ...roleFilter } }),
      prisma.user.count({ where: { status: 'ENABLED' as any, ...roleFilter } }),
      prisma.user.count({ where: { status: 'DISABLED' as any, ...roleFilter } }),
      prisma.user.count({ where: { status: 'LOCKED' as any, ...roleFilter } }),
      prisma.user.count({ where: { status: 'EXPIRED' as any, ...roleFilter } }),
    ]);
    return { total, enabled, disabled, locked, expired };
  },

  async addPasswordHistory(userId: string, passwordHash: string, tx?: Tx) {
    return db(tx).passwordHistory.create({ data: { userId, passwordHash } });
  },

  async findRole(name: string) {
    return prisma.role.findUnique({ where: { name } });
  },

  async terminateSessions(userId: string, reason: string, tx?: Tx) {
    // The auth plugin caches SESSIONS by session id for 30 s, and
    // `invalidateUserAuthCache` (which every caller runs after the commit)
    // never touches that cache — so an ended session kept answering until the
    // TTL ran out: a user whose ROLE was changed kept the OLD token with the
    // NEW role's grants for up to 30 s, and a disabled / unlocked / reset user
    // was refused only by the user-status check, if at all (found 2026-10-05 by
    // the api-a sweep). Evict each ended session by id, the pattern
    // auth.repository's own terminate paths already follow.
    const sessions = await db(tx).session.findMany({ where: { userId, isActive: true }, select: { id: true } });
    const result = await db(tx).session.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false, terminationReason: reason },
    });
    for (const s of sessions) invalidateSessionAuthCache(s.id);
    return result;
  },

  async getPasswordExpiresAt(): Promise<Date | null> {
    const config = await prisma.systemConfig.findUnique({ where: { configKey: 'password-policy' } });
    const policy = config?.configValue as { passwordExpiryDays?: number } | null;
    const days = policy?.passwordExpiryDays ?? 90;
    if (days <= 0) return null;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  },

  /**
   * Clear an account lock without touching the credential.
   *
   * Used for directory (LDAP/AD) accounts, whose password this application does
   * not own — see userService.unlock(). Deliberately writes NO passwordHash, NO
   * passwordHistory row, and does NOT set forcePasswordChange/isTemporaryPassword:
   * there is no local password to change, so flagging one would strand the user
   * at a change-password screen that refuses directory accounts.
   */
  async unlockWithoutPasswordChange(id: string, updatedBy: string, tx?: Tx) {
    const result = await db(tx).user.update({
      where: { id },
      data: {
        status: 'ENABLED',
        failedLoginAttempts: 0,
        lockedAt: null,
        lockoutUntil: null,
        forcePasswordChange: false,
        isTemporaryPassword: false,
        updatedBy,
      },
    });
    invalidateUserAuthCache(id);
    return result;
  },

  async unlockUser(id: string, newHash: string, passwordExpiresAt: Date | null, updatedBy: string, tx?: Tx) {
    const run = async (t: Tx) => {
      const user = await t.user.update({
        where: { id },
        data: {
          status: 'ENABLED',
          failedLoginAttempts: 0,
          lockedAt: null,
          lockoutUntil: null,
          passwordHash: newHash,
          forcePasswordChange: true,
          isTemporaryPassword: true,
          passwordChangedAt: new Date(),
          passwordExpiresAt,
          updatedBy,
        },
      });
      const history = await t.passwordHistory.create({ data: { userId: id, passwordHash: newHash } });
      return [user, history] as const;
    };
    const result = tx ? await run(tx) : await prisma.$transaction(run);
    invalidateUserAuthCache(id);
    return result;
  },

  async resetPassword(id: string, newHash: string, passwordExpiresAt: Date | null, updatedBy: string, tx?: Tx) {
    const run = async (t: Tx) => {
      const user = await t.user.update({
        where: { id },
        data: {
          passwordHash: newHash,
          forcePasswordChange: true,
          isTemporaryPassword: true,
          failedLoginAttempts: 0,
          lockedAt: null,
          lockoutUntil: null,
          status: 'ENABLED',
          passwordChangedAt: new Date(),
          passwordExpiresAt,
          updatedBy,
        },
      });
      const history = await t.passwordHistory.create({ data: { userId: id, passwordHash: newHash } });
      return [user, history] as const;
    };
    const result = tx ? await run(tx) : await prisma.$transaction(run);
    invalidateUserAuthCache(id);
    return result;
  },

  // Password Reset Requests
  async findResetRequests() {
    return prisma.passwordResetRequest.findMany({ orderBy: { requestedAt: 'desc' } });
  },

  async countPendingResetRequests() {
    return prisma.passwordResetRequest.count({ where: { status: 'PENDING' } });
  },

  async findResetRequestById(id: string) {
    return prisma.passwordResetRequest.findUnique({ where: { id } });
  },

  async approveResetRequest(requestId: string, userId: string, newHash: string, passwordExpiresAt: Date | null, processedBy: string, notes?: string, tx?: Tx) {
    const run = async (t: Tx) => {
      const user = await t.user.update({
        where: { id: userId },
        data: {
          passwordHash: newHash,
          forcePasswordChange: true,
          isTemporaryPassword: true,
          failedLoginAttempts: 0,
          lockedAt: null,
          lockoutUntil: null,
          status: 'ENABLED',
          passwordChangedAt: new Date(),
          passwordExpiresAt,
          updatedBy: processedBy,
        },
      });
      const history = await t.passwordHistory.create({ data: { userId, passwordHash: newHash } });
      const request = await t.passwordResetRequest.update({
        where: { id: requestId },
        data: { status: 'APPROVED', processedAt: new Date(), processedBy, notes },
      });
      return [user, history, request] as const;
    };
    const result = tx ? await run(tx) : await prisma.$transaction(run);
    invalidateUserAuthCache(userId);
    return result;
  },

  async rejectResetRequest(requestId: string, processedBy: string, notes?: string, tx?: Tx) {
    return db(tx).passwordResetRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', processedAt: new Date(), processedBy, notes },
    });
  },

  async findUsersByUsernames(usernames: string[]) {
    return prisma.user.findMany({
      where: { username: { in: usernames } },
      select: { username: true, fullName: true, email: true, department: true },
    });
  },

  async findUsersByIds(ids: string[]) {
    return prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true, fullName: true, email: true, department: true },
    });
  },
};
