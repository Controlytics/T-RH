import { prisma } from '../../lib/prisma.js';
import { invalidateRolePermsCache } from '../../plugins/rbac.js';

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

  /**
   * Active roles with the fields the Module Guide needs to compute, per role,
   * which module flowcharts + operations that role can perform: the role's
   * granted `permissions` plus its per-role sidebar override (`sidebarItems`
   * from role_configs, keyed by role name — string key, no FK). Ordered by
   * hierarchy (highest first) so SUPER_ADMIN leads.
   */
  async findActiveWithAccess() {
    const roles = await prisma.role.findMany({
      where: { isActive: true },
      orderBy: { hierarchyLevel: 'desc' },
      select: { name: true, displayName: true, hierarchyLevel: true, color: true, permissions: true },
    });
    const configs = await prisma.roleConfig.findMany({ select: { role: true, sidebarItems: true } });
    const sidebarByRole = new Map(configs.map((c) => [c.role, c.sidebarItems]));
    return roles.map((r) => ({
      name: r.name,
      displayName: r.displayName,
      hierarchyLevel: r.hierarchyLevel,
      color: r.color,
      permissions: Array.isArray(r.permissions) ? (r.permissions as string[]) : [],
      sidebarItems: (sidebarByRole.get(r.name) as string[] | undefined) ?? [],
    }));
  },

  /** Create a new role. */
  async create(data: {
    name: string;
    displayName: string;
    description?: string;
    hierarchyLevel: number;
    permissions: string[];
    color: string;
    createdBy: string;
  }) {
    return prisma.role.create({
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
  async update(name: string, data: Record<string, unknown>) {
    const result = await prisma.role.update({
      where: { name },
      data,
    });
    invalidateRolePermsCache(name);
    return result;
  },

  /** Delete a role by name. Same cache invalidation as update(). */
  async delete(name: string) {
    // role_configs.role references roles.name BY CONVENTION (string key, no FK),
    // so deleting the role does not cascade its config. Clean it up in the same
    // transaction — otherwise an orphaned role_configs row lingers and, worse,
    // resurfaces (sidebar + granted permissions) if a new role is later created
    // with the same name. Same for per-user sidebar overrides keyed by role is
    // N/A (user_configs key on userId), so only role_configs needs clearing.
    const result = await prisma.$transaction(async (tx) => {
      await tx.roleConfig.deleteMany({ where: { role: name } });
      return tx.role.delete({ where: { name } });
    });
    invalidateRolePermsCache(name);
    return result;
  },

  /** Count users assigned to a given role name. */
  async countUsersByRole(roleName: string) {
    return prisma.user.count({ where: { role: roleName } });
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
