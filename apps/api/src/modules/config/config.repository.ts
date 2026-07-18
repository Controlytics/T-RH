import { prisma } from '../../lib/prisma.js';

export const configRepository = {
  async getSystemConfig(key: string) {
    return prisma.systemConfig.findUnique({ where: { configKey: key } });
  },

  async upsertSystemConfig(key: string, value: any, configType: string, requiresReauth: boolean, updatedBy: string) {
    return prisma.systemConfig.upsert({
      where: { configKey: key },
      create: { configKey: key, configValue: value, configType, requiresReauth, updatedBy },
      update: { configValue: value, updatedAt: new Date(), updatedBy },
    });
  },

  // Role Configuration
  async findAllRoleConfigs() {
    return prisma.roleConfig.findMany({ orderBy: { role: 'asc' } });
  },

  async findRoleConfig(role: string) {
    return prisma.roleConfig.findUnique({ where: { role: role as any } });
  },

  async upsertRoleConfig(role: string, data: { sidebarItems?: string[]; homeWidgets?: string[]; permissions?: Record<string, boolean> }, existing: any, updatedBy: string) {
    // Build update object — only include fields that are explicitly provided,
    // otherwise preserve existing values (supports partial saves from different tabs)
    const updateData: Record<string, any> = { updatedAt: new Date(), updatedBy };
    if (data.sidebarItems !== undefined) updateData.sidebarItems = data.sidebarItems;
    if (data.homeWidgets !== undefined) updateData.homeWidgets = data.homeWidgets;
    if (data.permissions !== undefined) updateData.permissions = data.permissions;

    return prisma.roleConfig.upsert({
      where: { role: role as any },
      create: {
        role: role as any,
        sidebarItems: data.sidebarItems ?? existing?.sidebarItems ?? [],
        homeWidgets: data.homeWidgets ?? existing?.homeWidgets ?? [],
        permissions: data.permissions ?? existing?.permissions ?? {},
        updatedBy,
      },
      update: updateData,
    });
  },

  // User Configuration
  async findUserConfig(userId: string) {
    return prisma.userConfig.findUnique({ where: { userId } });
  },

  async upsertUserConfig(userId: string, data: { sidebarItems?: string[]; homeWidgets?: string[]; permissions?: Record<string, boolean> }, existing: any, updatedBy: string) {
    const updateData: Record<string, any> = { updatedAt: new Date(), updatedBy };
    if (data.sidebarItems !== undefined) updateData.sidebarItems = data.sidebarItems;
    if (data.homeWidgets !== undefined) updateData.homeWidgets = data.homeWidgets;
    if (data.permissions !== undefined) updateData.permissions = data.permissions;

    return prisma.userConfig.upsert({
      where: { userId },
      create: {
        userId,
        sidebarItems: data.sidebarItems ?? existing?.sidebarItems ?? [],
        homeWidgets: data.homeWidgets ?? existing?.homeWidgets ?? [],
        permissions: data.permissions ?? existing?.permissions ?? {},
        updatedBy,
      },
      update: updateData,
    });
  },

  async findUserByUsername(username: string) {
    return prisma.user.findUnique({ where: { username } });
  },

  async findUserById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  },

  // Field IDs
  async findAllFieldIds() {
    return prisma.fieldIdConfig.findMany({ orderBy: { fieldId: 'asc' } });
  },

  async findFieldId(fieldId: string) {
    return prisma.fieldIdConfig.findUnique({ where: { fieldId } });
  },

  async updateFieldId(fieldId: string, displayName: string, updatedBy: string) {
    return prisma.fieldIdConfig.update({
      where: { fieldId },
      data: { displayName: displayName.trim(), updatedBy, updatedAt: new Date() },
    });
  },

  // Raw queries for User ID next
  async getMaxUserIdNum(prefix: string) {
    return prisma.$queryRawUnsafe(
      `SELECT MAX(CAST(SUBSTRING(username FROM '\\d+$') AS INTEGER)) AS max_num FROM users WHERE username LIKE $1`,
      `${prefix}%`
    ) as Promise<{ max_num: number | null }[]>;
  },

  async getMaxUserIdNumAll() {
    return prisma.$queryRawUnsafe(
      `SELECT MAX(CAST(SUBSTRING(username FROM '\\d+$') AS INTEGER)) AS max_num FROM users WHERE username ~ '\\d+$'`
    ) as Promise<{ max_num: number | null }[]>;
  },
};
