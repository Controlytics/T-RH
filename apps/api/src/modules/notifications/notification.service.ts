import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { notificationRepository } from './notification.repository.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { parseDateRange } from '../../lib/query-dates.js';
import { isNotificationVisible, visibilityWhere } from './notification-visibility.js';
import type { RequestContext } from '../../types/context.js';
import type { NotificationType } from '@prisma/client';
import { z } from 'zod';

// Notification types whose visibility is config-driven (a role list), NOT the
// normal per-user/per-role addressing. Each maps to its config key + field.
//
// EMPTY as of 2026-08-20. Its only two entries (PM_SCHEDULE_QNN,
// GUEST_CLEANING_REQUEST) went with the filter domain, and both were already
// reading config keys whose defs the Phase 0 strip removed — `qnn-notifications`
// and `guest-cleaning-requests` have no def and zero system_config rows, so the
// gate resolved to "no roles" on every call. Adding an entry here re-arms the
// mechanism; while it is empty every type uses the normal addressing rules.
export const GATED_TYPES: Record<string, { configKey: string; field: string }> = {};
const GATED_TYPE_KEYS = Object.keys(GATED_TYPES);

// Which config-gated notification types this role may see. Super Admin sees all;
// otherwise a type is visible when the viewer's role is in that type's config list.
export async function gatedTypesVisibleTo(userRole: string): Promise<string[]> {
  if (userRole === 'SUPER_ADMIN') return [...GATED_TYPE_KEYS];
  const out: string[] = [];
  for (const [type, { configKey, field }] of Object.entries(GATED_TYPES)) {
    let roles: string[] = ['ADMIN'];
    try {
      const row = await prisma.systemConfig.findUnique({ where: { configKey } });
      const v = row?.configValue as Record<string, unknown> | undefined;
      if (Array.isArray(v?.[field])) roles = v![field] as string[];
    } catch { /* default ADMIN */ }
    if (roles.includes(userRole)) out.push(type);
  }
  return out;
}

// Visibility enforcing gated-type config: non-gated notifications use the normal
// per-role rules; gated types show only to roles allowed by their config.
function gatedAwareWhere(userRole: string, username: string, visibleGated: string[]): Record<string, unknown> {
  const normal = buildVisibilityFilter(userRole, username);
  // No gated types registered: every notification uses the normal rules. Stated
  // explicitly rather than relying on how `notIn: []` is compiled.
  if (GATED_TYPE_KEYS.length === 0) return normal;
  const branches: Record<string, unknown>[] = [
    { AND: [{ type: { notIn: GATED_TYPE_KEYS } }, normal] },
  ];
  for (const t of visibleGated) branches.push({ type: t });
  return { OR: branches };
}

const notificationQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  // Bounded 2026-08-29 (audit M2). This was `.min(1).optional()` with no
  // default and no ceiling, and the repository does
  // `...(take ? { skip, take } : {})` — so a request omitting `limit` returned
  // EVERY notification row the caller can see, and one asking for 10_000_000
  // was obeyed. `notifications` is a high-growth table (system errors, alarm
  // raises, clears, acknowledgements). Nothing was exploiting it because the
  // only caller (routes/notifications/index.tsx:121) always sends a limit —
  // i.e. the sole protection was a client habit. 500 matches the ceiling
  // alarms/routes.ts:297 already uses for the same reason.
  // No `.max()` (operator, 2026-09-02) — a rejected page size is at least loud,
  // but this one sat beside clamps that truncated silently. See lib/page-size.ts.
  limit: z.coerce.number().min(1).default(50),
  isRead: z.enum(['true', 'false']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  period: z.enum(['today', 'week', 'month', 'quarter', 'year', 'all']).optional(),
});

// The ONE visibility rule, rendered as a where fragment. The rule itself is in
// notification-visibility.ts (audit 2026-10-03, API-16) — the single-row check
// and the bulk builder render the same data, so this cannot drift from them.
function buildVisibilityFilter(userRole: string, username: string): Record<string, unknown> {
  return visibilityWhere(userRole, username);
}

function applyDateFilter(where: Record<string, unknown>, period?: string, startDate?: string, endDate?: string) {
  if (period && period !== 'all') {
    const now = new Date();
    let start: Date;

    switch (period) {
      case 'today':
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week':
        start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'quarter':
        start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      case 'year':
        start = new Date(now.getFullYear(), 0, 1);
        break;
      default:
        start = new Date(0);
    }

    where.createdAt = { gte: start };
  } else if (startDate !== undefined || endDate !== undefined) {
    // Validated, never `new Date(raw)` straight into the query (audit
    // 2026-10-03, API-12): an unparseable value was a Prisma 500 plus a
    // SYSTEM_ERROR notification. A date-only endDate is the END of that day —
    // see lib/query-dates.ts. The 400 is field-keyed, as the alarms list's is.
    const range = parseDateRange(startDate, endDate);
    if (!range.ok) throw new ValidationError('Invalid date range', { fieldErrors: range.fieldErrors });
    where.createdAt = {
      ...(range.gte ? { gte: range.gte } : {}),
      ...(range.lte ? { lte: range.lte } : {}),
    };
  }
}

export const notificationService = {
  async list(query: unknown, userRole: string, username: string) {
    // safeParse → 400 by field; a thrown ZodError was a 500 (API-12).
    const parsedQuery = notificationQuerySchema.safeParse(query);
    if (!parsedQuery.success) throw new ValidationError('Invalid query', parsedQuery.error.flatten());
    const parsed = parsedQuery.data;
    const where = gatedAwareWhere(userRole, username, await gatedTypesVisibleTo(userRole));

    // Apply date filtering
    applyDateFilter(where, parsed.period, parsed.startDate, parsed.endDate);

    // Apply isRead filter
    if (parsed.isRead !== undefined) {
      where.isRead = parsed.isRead === 'true';
    }

    const [data, total, unreadCount] = await Promise.all([
      notificationRepository.findMany(where, (parsed.page - 1) * parsed.limit, parsed.limit),
      notificationRepository.count(where),
      notificationRepository.count({ ...where, isRead: false }),
    ]);

    return {
      data,
      total,
      unreadCount,
      page: parsed.page,
      limit: parsed.limit,
      totalPages: Math.ceil(total / parsed.limit),
    };
  },

  async getUnreadCount(userRole: string, username: string) {
    const where = gatedAwareWhere(userRole, username, await gatedTypesVisibleTo(userRole));
    where.isRead = false;
    return { count: await notificationRepository.count(where) };
  },

  async markRead(id: string, userRole: string, username: string) {
    const notification = await notificationRepository.findById(id);
    if (!notification) throw new NotFoundError('Notification not found');
    assertNotificationVisible(notification, userRole, username, await gatedTypesVisibleTo(userRole));
    await notificationRepository.markRead(id);
    return { success: true };
  },

  async markUnread(id: string, userRole: string, username: string) {
    const notification = await notificationRepository.findById(id);
    if (!notification) throw new NotFoundError('Notification not found');
    assertNotificationVisible(notification, userRole, username, await gatedTypesVisibleTo(userRole));
    await notificationRepository.markUnread(id);
    return { success: true };
  },

  async markAllRead(userRole: string, username: string) {
    const where = gatedAwareWhere(userRole, username, await gatedTypesVisibleTo(userRole));
    where.isRead = false;
    await notificationRepository.markAllRead(where);
    return { success: true };
  },

  async bulkRead(ids: string[], userRole: string, username: string) {
    const result = await notificationRepository.bulkMarkRead(ids, userRole, username, await gatedTypesVisibleTo(userRole));
    return { success: true, count: result.count };
  },

  async bulkUnread(ids: string[], userRole: string, username: string) {
    const result = await notificationRepository.bulkMarkUnread(ids, userRole, username, await gatedTypesVisibleTo(userRole));
    return { success: true, count: result.count };
  },

  /**
   * Physical delete — no soft-delete fallback, so the audit row is the only
   * surviving record of what was destroyed (21 CFR §11.10(e)). Capture the
   * rows first (deleteMany returns a bare count), then audit-then-delete inside
   * one transaction so a delete can never commit without its audit row.
   * `ctx` replaces the old (userRole, username) pair — buildContext sets
   * ctx.userId = req.user.username, so both are derivable from it.
   */
  async bulkDelete(ids: string[], ctx: RequestContext) {
    const userRole = ctx.userRole;
    const username = ctx.userId;
    const visibleGated = await gatedTypesVisibleTo(userRole);

    const doomed = await notificationRepository.findBulkDeletable(ids, userRole, username, visibleGated);

    const result = await prisma.$transaction(async (tx) => {
      if (doomed.length > 0) {
        await auditLog({
          userId: ctx.userId, userRole: ctx.userRole,
          action: 'NOTIFICATIONS_BULK_DELETED',
          targetType: 'notification',
          // No single targetId — the destroyed rows are enumerated in beforeValue.
          beforeValue: {
            recordCount: doomed.length,
            records: doomed.map((n: any) => ({
              id: n.id, type: n.type, title: n.title,
              forUserId: n.forUserId, forRole: n.forRole, createdAt: n.createdAt,
            })),
          },
          signatureMeaning: `${doomed.length} notification(s) permanently deleted`,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      }
      return notificationRepository.bulkDelete(ids, userRole, username, visibleGated, tx);
    });

    return { success: true, count: result.count };
  },

  async delete(id: string, ctx: RequestContext) {
    const userRole = ctx.userRole;
    const username = ctx.userId;
    const notification = await notificationRepository.findById(id);
    if (!notification) throw new NotFoundError('Notification not found');
    assertNotificationVisible(notification, userRole, username, await gatedTypesVisibleTo(userRole));

    await prisma.$transaction(async (tx) => {
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'NOTIFICATION_DELETED',
        targetType: 'notification', targetId: id,
        beforeValue: {
          type: notification.type, title: notification.title, message: notification.message,
          forUserId: notification.forUserId, forRole: notification.forRole,
          isRead: notification.isRead, createdAt: notification.createdAt,
        },
        signatureMeaning: `Notification "${notification.title}" permanently deleted`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      await notificationRepository.delete(id, tx);
    });

    return { success: true };
  },
};

/**
 * 404 (never 403 — that would confirm the row exists) when the caller may not
 * see the notification. The decision is `isNotificationVisible`, the in-memory
 * rendering of the SAME rule the list query runs (audit 2026-10-03, API-16):
 * until then this copy let an ADMIN act on any row not addressed to
 * SUPER_ADMIN, and a user act on the admin-addressed row ABOUT themself.
 */
function assertNotificationVisible(notif: any, userRole: string, username: string, visibleGated: string[]): void {
  // Config-gated types follow config role lists, not per-user addressing.
  if (GATED_TYPE_KEYS.includes(notif.type)) {
    if (visibleGated.includes(notif.type)) return;
    throw new NotFoundError('Notification not found');
  }
  if (!isNotificationVisible(notif, userRole, username)) throw new NotFoundError('Notification not found');
}

// Exported for use by other modules (auth.service.ts, user.service.ts)
export async function createNotification(data: {
  // The generated enum, not a hand-kept union. The union this replaces had
  // drifted in BOTH directions — it still listed three BLOCK_CHANGE_* values
  // that were never in the enum, and omitted DEVICE_*, USER_LOGIN, USER_LOCKED,
  // SYSTEM_ERROR and the three USER_CREATION_REQUEST_* that are.
  type: NotificationType;
  title: string;
  message: string;
  targetUserId?: string;
  forUserId?: string;
  forRole?: string;
  metadata?: Record<string, unknown>;
  createdBy?: string;
}) {
  return notificationRepository.create(data);
}
