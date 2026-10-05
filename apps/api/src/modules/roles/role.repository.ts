import { prisma } from '../../lib/prisma.js';
import { invalidateRolePermsCache } from '../../plugins/rbac.js';
import { AppError } from '../../lib/errors.js';

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
const db = (tx?: Tx) => tx ?? prisma;

export const roleRepository = {
  /** Find all roles ordered by hierarchy level descending. */
  async findAll() {
    return prisma.role.findMany({
      orderBy: { hierarchyLevel: 'desc' },
    });
  },

  /** Find active roles with minimal fields for dropdowns. */
  async findActive() {
    return prisma.role.findMany({
      where: { isActive: true },
      orderBy: { hierarchyLevel: 'desc' },
      select: {
        id: true,
        name: true,
        displayName: true,
        hierarchyLevel: true,
        color: true,
      },
    });
  },

  /** Find a single role by its unique name. */
  async findByName(name: string) {
    return prisma.role.findUnique({ where: { name } });
  },

  /** Create a new role. `tx` joins the caller's transaction (audit 2026-10-03, API-7). */
  async create(data: {
    name: string;
    displayName: string;
    description?: string;
    hierarchyLevel: number;
    permissions: string[];
    color: string;
    createdBy: string;
  }, tx?: Tx) {
    return db(tx).role.create({
      data: {
        name: data.name,
        displayName: data.displayName,
        description: data.description,
        hierarchyLevel: data.hierarchyLevel,
        permissions: data.permissions,
        color: data.color,
        isSystem: false,
        createdBy: data.createdBy,
      },
    });
  },

  /** Update a role by name.
   *  Audit 2026-05-04 fix: invalidates the rbac plugin's role-perms cache
   *  so a permissions change propagates to the next request immediately
   *  rather than waiting up to 5s for the TTL to lapse. */
  async update(name: string, data: Record<string, unknown>, tx?: Tx) {
    const result = await db(tx).role.update({
      where: { name },
      data,
    });
    invalidateRolePermsCache(name);
    return result;
  },

  /**
   * Delete a role by name. Same cache invalidation as update().
   *
   * The "no users hold it" check runs INSIDE the transaction, immediately
   * before the delete (audit 2026-10-03, API-20): it used to be a separate
   * count in the service, so a user assigned the role between the count and
   * the delete was left holding a role name that no longer existed —
   * `users.role` carries no foreign key. The window is now the two statements
   * of one transaction; closing it entirely needs the FK, which is a schema
   * change recorded as open rather than taken here.
   */
  async delete(name: string, tx?: Tx) {
    const run = async (t: Tx) => {
      const usersWithRole = await t.user.count({ where: { role: name } });
      if (usersWithRole > 0) {
        const err = new AppError(409, 'ROLE_HAS_USERS', 'Cannot delete role with assigned users');
        (err as any).usersCount = usersWithRole;
        throw err;
      }
      // role_configs.role references roles.name BY CONVENTION (string key, no FK),
      // so deleting the role does not cascade its config. Clean it up in the same
      // transaction — otherwise an orphaned role_configs row lingers and, worse,
      // resurfaces (sidebar + granted permissions) if a new role is later created
      // with the same name. Same for per-user sidebar overrides keyed by role is
      // N/A (user_configs key on userId), so only role_configs needs clearing.
      await t.roleConfig.deleteMany({ where: { role: name } });
      return t.role.delete({ where: { name } });
    };
    const result = tx ? await run(tx) : await prisma.$transaction(run);
    invalidateRolePermsCache(name);
    return result;
  },

  /** Count users assigned to a given role name. */
  async countUsersByRole(roleName: string) {
    return prisma.user.count({ where: { role: roleName } });
  },

  /**
   * End every live session held by a user of this role (audit 2026-10-03,
   * API-15): deactivating a role must revoke access NOW, not leave every
   * bearer valid until it expires.
   */
  async terminateSessionsForRole(roleName: string, reason: string, tx?: Tx): Promise<{ count: number; sessionIds: string[] }> {
    // The ids are returned so the caller can evict them from the auth
    // plugin's SESSION cache after commit: that cache is keyed by session id
    // and `invalidateUserAuthCache` does not touch it, so an ended session
    // would otherwise keep answering for up to its 30 s TTL.
    const sessions = await db(tx).session.findMany({
      where: { isActive: true, user: { role: roleName } },
      select: { id: true },
    });
    const sessionIds = sessions.map((s) => s.id);
    if (sessionIds.length === 0) return { count: 0, sessionIds };
    const { count } = await db(tx).session.updateMany({
      where: { id: { in: sessionIds } },
      data: { isActive: false, terminationReason: reason },
    });
    return { count, sessionIds };
  },

  /** Find active roles with hierarchy level at or below the given level. */
  async findCreatableRoles(hierarchyLevel: number, includeSuperAdmin: boolean = false) {
    return prisma.role.findMany({
      where: {
        isActive: true,
        hierarchyLevel: { lte: hierarchyLevel },
        ...(includeSuperAdmin ? {} : { name: { not: 'SUPER_ADMIN' } }),
      },
      orderBy: { hierarchyLevel: 'desc' },
      select: {
        name: true,
        displayName: true,
        hierarchyLevel: true,
        color: true,
      },
    });
  },
};
