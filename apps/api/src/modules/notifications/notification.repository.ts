import { prisma } from '../../lib/prisma.js';

export const notificationRepository = {
  async findMany(where: Record<string, unknown>, skip: number, take?: number) {
    return prisma.notification.findMany({
      where: where as any,
      orderBy: { createdAt: 'desc' },
      ...(take ? { skip, take } : {}),
    });
  },

  async count(where: Record<string, unknown>) {
    return prisma.notification.count({ where: where as any });
  },

  async findById(id: string) {
    return prisma.notification.findUnique({ where: { id } });
  },

  async create(data: {
    type: string;
    title: string;
    message: string;
    targetUserId?: string;
    forUserId?: string;
    forRole?: string;
    metadata?: Record<string, unknown>;
    createdBy?: string;
  }) {
    return prisma.notification.create({
      data: {
        type: data.type as any,
        title: data.title,
        message: data.message,
        targetUserId: data.targetUserId,
        forUserId: data.forUserId,
        forRole: data.forRole,
        metadata: data.metadata as any,
        createdBy: data.createdBy,
      },
    });
  },

  async markRead(id: string) {
    return prisma.notification.update({
      where: { id },
      data: { isRead: true, readAt: new Date() },
    });
  },

  async markUnread(id: string) {
    return prisma.notification.update({
      where: { id },
      data: { isRead: false, readAt: null },
    });
  },

  async markAllRead(where: Record<string, unknown>) {
    return prisma.notification.updateMany({
      where: where as any,
      data: { isRead: true, readAt: new Date() },
    });
  },

  async bulkMarkRead(ids: string[], userRole?: string, username?: string, visibleGated: string[] = []) {
    const where = buildBulkVisibilityFilter(ids, userRole, username, visibleGated);
    return prisma.notification.updateMany({
      where,
      data: { isRead: true, readAt: new Date() },
    });
  },

  async bulkMarkUnread(ids: string[], userRole?: string, username?: string, visibleGated: string[] = []) {
    const where = buildBulkVisibilityFilter(ids, userRole, username, visibleGated);
    return prisma.notification.updateMany({
      where,
      data: { isRead: false, readAt: null },
    });
  },

  async delete(id: string, tx?: PrismaLike) {
    return (tx ?? prisma).notification.delete({ where: { id } });
  },

  /**
   * Rows a bulk delete WOULD destroy, under the same visibility filter the
   * delete itself applies. `deleteMany` returns only a count, so the audit row
   * (21 CFR §11.10(e)) has to capture the identifying fields before they're gone.
   */
  async findBulkDeletable(ids: string[], userRole?: string, username?: string, visibleGated: string[] = [], tx?: PrismaLike) {
    const where = buildBulkVisibilityFilter(ids, userRole, username, visibleGated);
    return (tx ?? prisma).notification.findMany({ where: where as any });
  },

  async bulkDelete(ids: string[], userRole?: string, username?: string, visibleGated: string[] = [], tx?: PrismaLike) {
    const where = buildBulkVisibilityFilter(ids, userRole, username, visibleGated);
    return (tx ?? prisma).notification.deleteMany({ where: where as any });
  },
};

// Minimal structural type so bulk ops can join a caller's transaction (the audit
// row must commit atomically with the delete it records).
type PrismaLike = { notification: { findMany: Function; deleteMany: Function; delete: Function } } & any;

/**
 * 2026-05-26 bug fix: pre-fix, bulkDelete / bulkMarkRead / bulkMarkUnread
 * only filtered by `{ forUserId: username, OR targetUserId: username }`.
 * For ADMIN / SUPER_ADMIN viewing all notifications (per the visibility
 * rules in notification.service.ts buildVisibilityFilter), the bulk
 * ops silently filtered out any notification not directly addressed to
 * the operator and returned { count: <small> } as if successful. The UI
 * cleared the selection + toast'd success while the data lived on.
 *
 * This builder mirrors notification.service.ts buildVisibilityFilter so
 * bulk-op visibility matches list-visibility byte-for-byte:
 *   - SUPER_ADMIN: no extra restriction beyond ID set
 *   - ADMIN: forUserId === self OR forRole === 'ADMIN' OR system-wide
 *     (forRole + forUserId both null); never anything addressed to
 *     SUPER_ADMIN
 *   - everyone else: forUserId === self OR targetUserId === self
 */
function buildBulkVisibilityFilter(
  ids: string[],
  userRole?: string,
  username?: string,
  visibleGated: string[] = [],
): Record<string, unknown> {
  // Visibility fragment (role-based, same rules as the list).
  let normal: Record<string, unknown>;
  if (userRole === 'SUPER_ADMIN') {
    normal = {};
  } else if (userRole === 'ADMIN') {
    normal = {
      OR: [
        { forUserId: username },
        { forRole: 'ADMIN' },
        { forRole: null, forUserId: null },
      ],
      // Null-safe SUPER_ADMIN exclusion — see notification.service.ts
      // buildVisibilityFilter. A bare NOT drops every forRole IS NULL row.
      AND: [{ OR: [{ forRole: null }, { forRole: { not: 'SUPER_ADMIN' } }] }],
    };
  } else {
    normal = username ? { OR: [{ forUserId: username }, { targetUserId: username }] } : {};
  }
  // Config-gated types follow config role lists rather than per-user addressing.
  // The registry (GATED_TYPES in notification.service.ts) is empty as of
  // 2026-08-20, so this list is too — see the note there.
  const GATED: string[] = [];
  if (GATED.length === 0) return { id: { in: ids }, ...normal };
  const branches: Record<string, unknown>[] = [
    { AND: [{ type: { notIn: GATED } }, normal] },
  ];
  for (const t of visibleGated) branches.push({ type: t });
  return { id: { in: ids }, OR: branches };
}
