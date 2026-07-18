import { prisma } from '../../lib/prisma.js';

/**
 * Quality Notification (QNN) report data + visibility. QNN rows are minted by
 * the PM approval workflow (pm-workflow.generateQnn). The report is visible to
 * the same roles as QNN notifications — config `qnn-notifications.visibleRoles`
 * (default ['ADMIN']) plus SUPER_ADMIN.
 */
export async function canSeeQnn(role?: string | null): Promise<boolean> {
  if (!role) return false;
  if (role === 'SUPER_ADMIN') return true;
  let roles: string[] = ['ADMIN'];
  try {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'qnn-notifications' } });
    const v = row?.configValue as Record<string, unknown> | undefined;
    if (Array.isArray(v?.visibleRoles)) roles = v!.visibleRoles as string[];
  } catch { /* default ADMIN */ }
  return roles.includes(role);
}

export async function listQnn(query: { page?: number; limit?: number; from?: string; to?: string }) {
  const page = query.page ?? 1;
  const limit = Math.min(query.limit ?? 50, 500);
  const where: { createdAt?: { gte?: Date; lte?: Date } } = {};
  if (query.from || query.to) {
    where.createdAt = {};
    if (query.from) where.createdAt.gte = new Date(query.from);
    if (query.to) where.createdAt.lte = new Date(query.to);
  }
  const [data, total] = await Promise.all([
    prisma.qualityNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true, qnn: true, action: true, ahuName: true, message: true,
        performedByName: true, createdAt: true,
      },
    }),
    prisma.qualityNotification.count({ where }),
  ]);
  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}
