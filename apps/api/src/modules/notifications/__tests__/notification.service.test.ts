import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockNotifRepo, mockAuditLog, mockPrisma } = vi.hoisted(() => ({
  mockNotifRepo: {
    findMany: vi.fn(),
    count: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    markRead: vi.fn(),
    markUnread: vi.fn(),
    markAllRead: vi.fn(),
    bulkMarkRead: vi.fn(),
    bulkMarkUnread: vi.fn(),
    delete: vi.fn(),
    bulkDelete: vi.fn(),
    findBulkDeletable: vi.fn(),
  },
  mockAuditLog: vi.fn(),
  mockPrisma: {
    systemConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    // Run the callback with a sentinel tx so tests can assert the audit write
    // joined the same transaction as the delete.
    $transaction: vi.fn(async (fn: any) => fn('TX')),
  },
}));

vi.mock('../notification.repository.js', () => ({ notificationRepository: mockNotifRepo }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));
vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import { notificationService, createNotification } from '../notification.service.js';

describe('notificationService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('createNotification', () => {
    it('creates notification via repository', async () => {
      mockNotifRepo.create.mockResolvedValue({ id: 'n1', title: 'Test' });

      const result = await createNotification({
        type: 'USER_CREATED', title: 'Test', message: 'Msg',
        targetUserId: 'u1', forRole: 'ADMIN',
      });

      expect(mockNotifRepo.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Test' }));
      expect(result.title).toBe('Test');
    });
  });

  describe('list', () => {
    it('returns paginated notifications for role', async () => {
      mockNotifRepo.findMany.mockResolvedValue([{ id: 'n1' }]);
      mockNotifRepo.count.mockResolvedValue(1);

      const result = await notificationService.list({ page: 1, limit: 20 }, 'ADMIN', 'user-1');
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    /**
     * Enterprise-audit finding (2026-07-13): the ADMIN visibility filter used a
     * top-level `NOT: { forRole: 'SUPER_ADMIN' }`, which compiles to
     * `NOT (for_role = 'SUPER_ADMIN')`. For a row with for_role IS NULL that
     * evaluates to NULL — not TRUE — so Postgres excluded it. Since the NOT was
     * ANDed over the whole OR, it silently killed two of the three branches:
     * ADMINs saw neither their own personally-addressed notifications nor any
     * general ones. Assert the exclusion is null-safe.
     */
    it('does not exclude null-forRole rows from an ADMIN (null-safe SUPER_ADMIN filter)', async () => {
      mockNotifRepo.findMany.mockResolvedValue([]);
      mockNotifRepo.count.mockResolvedValue(0);

      await notificationService.list({ page: 1, limit: 20 }, 'ADMIN', 'someadmin');
      // With no config-gated types registered (GATED_TYPES is empty as of
      // 2026-08-20) the visibility filter IS the normal one, un-wrapped. Reach
      // through the gated branch only while there is one.
      const where = mockNotifRepo.findMany.mock.calls[0][0] as any;
      const normal = where.OR && where.OR[0]?.AND ? where.OR[0].AND[1] : where;

      // The three visibility branches survive...
      expect(normal.OR).toEqual([
        { forUserId: 'someadmin' },
        { forRole: 'ADMIN' },
        { forRole: null, forUserId: null },
      ]);
      // ...and SUPER_ADMIN is excluded without swallowing forRole IS NULL rows.
      expect(normal.NOT).toBeUndefined();
      expect(normal.AND).toEqual([{ OR: [{ forRole: null }, { forRole: { not: 'SUPER_ADMIN' } }] }]);
    });
  });

  describe('getUnreadCount', () => {
    it('returns count of unread notifications', async () => {
      mockNotifRepo.count.mockResolvedValue(5);

      const result = await notificationService.getUnreadCount('u1', 'ADMIN');
      expect(result.count).toBe(5);
    });
  });

  describe('markRead', () => {
    it('marks notification as read', async () => {
      mockNotifRepo.findById.mockResolvedValue({ id: 'n1', forUserId: 'me', forRole: null });
      mockNotifRepo.markRead.mockResolvedValue({});

      const result = await notificationService.markRead('n1', 'OPERATOR', 'me');
      expect(result.success).toBe(true);
      expect(mockNotifRepo.markRead).toHaveBeenCalledWith('n1');
    });

    it('throws NotFoundError', async () => {
      mockNotifRepo.findById.mockResolvedValue(null);
      await expect(notificationService.markRead('bad', 'SUPER_ADMIN', 'sa')).rejects.toThrow('not found');
    });

    /**
     * Audit 2026-10-03, API-16: the single-row check is the SAME rule as the
     * list. It used to be wider — an ADMIN could act on any row not addressed
     * to SUPER_ADMIN, and a user on the admin-addressed row ABOUT themself.
     */
    it('an ADMIN cannot reach another user\'s personal notification by id (404, nothing written)', async () => {
      mockNotifRepo.findById.mockResolvedValue({ id: 'n1', type: 'USER_CREATED', forUserId: 'someone-else', forRole: null });
      await expect(notificationService.markRead('n1', 'ADMIN', 'me')).rejects.toThrow('not found');
      expect(mockNotifRepo.markRead).not.toHaveBeenCalled();
    });

    it('a user cannot reach the admin-addressed row ABOUT themself by id', async () => {
      mockNotifRepo.findById.mockResolvedValue({ id: 'n1', type: 'USER_LOCKED', forUserId: null, forRole: 'ADMIN', targetUserId: 'me' });
      await expect(notificationService.markRead('n1', 'OPERATOR', 'me')).rejects.toThrow('not found');
      expect(mockNotifRepo.markRead).not.toHaveBeenCalled();
    });

    it('an ADMIN can act on an ADMIN-addressed row', async () => {
      mockNotifRepo.findById.mockResolvedValue({ id: 'n1', type: 'USER_LOCKED', forUserId: null, forRole: 'ADMIN' });
      mockNotifRepo.markRead.mockResolvedValue({});
      await notificationService.markRead('n1', 'ADMIN', 'me');
      expect(mockNotifRepo.markRead).toHaveBeenCalledWith('n1');
    });
  });

  describe('markUnread', () => {
    it('marks notification as unread', async () => {
      mockNotifRepo.findById.mockResolvedValue({ id: 'n1', forUserId: null, forRole: null });
      mockNotifRepo.markUnread.mockResolvedValue({});

      const result = await notificationService.markUnread('n1', 'SUPER_ADMIN', 'sa');
      expect(result.success).toBe(true);
      expect(mockNotifRepo.markUnread).toHaveBeenCalledWith('n1');
    });
  });

  /** Audit 2026-10-03, API-12: a bad date is a 400 by field, never a Prisma 500. */
  describe('list — date validation', () => {
    it('refuses an unparseable startDate with a field-keyed 400', async () => {
      await expect(notificationService.list({ startDate: 'yesterday' }, 'SUPER_ADMIN', 'sa'))
        .rejects.toMatchObject({ statusCode: 400, details: { fieldErrors: { startDate: expect.any(Array) } } });
      expect(mockNotifRepo.findMany).not.toHaveBeenCalled();
    });

    it('a date-only endDate covers the whole of that day', async () => {
      mockNotifRepo.findMany.mockResolvedValue([]);
      mockNotifRepo.count.mockResolvedValue(0);
      await notificationService.list({ endDate: '2026-10-05' }, 'SUPER_ADMIN', 'sa');
      const where = mockNotifRepo.findMany.mock.calls[0][0] as any;
      expect(where.createdAt.lte.toISOString()).toBe('2026-10-05T23:59:59.999Z');
    });
  });

  describe('markAllRead', () => {
    it('marks all notifications as read', async () => {
      mockNotifRepo.markAllRead.mockResolvedValue({ count: 10 });

      await notificationService.markAllRead('u1', 'ADMIN');
      expect(mockNotifRepo.markAllRead).toHaveBeenCalled();
    });
  });

  /**
   * 21 CFR §11.10(e) — notification delete/bulkDelete are PHYSICAL deletes with
   * no soft-delete fallback, and pre-2026-07-15 wrote no audit_trail row at all:
   * an operator could destroy the record of (e.g.) an account-lockout alert with
   * zero trace of who did it, when, or what was in it. The audit row is the only
   * surviving evidence, so it must carry the identifying fields — a bare id is
   * useless to an inspector — and must commit atomically with the delete.
   */
  const ctx = {
    userId: 'someadmin', userSub: 'sub-1', userRole: 'ADMIN',
    ipAddress: '10.0.0.5', userAgent: 'vitest', sessionId: 'sess-1',
  } as any;

  describe('delete', () => {
    const notif = {
      id: 'n1', type: 'ACCOUNT_LOCKED', title: 'Account locked',
      message: 'RB0001 locked out', forUserId: 'someadmin', forRole: null,
      isRead: false, createdAt: new Date('2026-07-01T00:00:00Z'),
    };

    it('deletes notification', async () => {
      mockNotifRepo.findById.mockResolvedValue(notif);
      mockNotifRepo.delete.mockResolvedValue({});

      const result = await notificationService.delete('n1', ctx);
      expect(result.success).toBe(true);
      expect(mockNotifRepo.delete).toHaveBeenCalledWith('n1', 'TX');
    });

    it('a delete of a row outside the caller\'s visibility is a 404 with nothing written (API-16)', async () => {
      mockNotifRepo.findById.mockResolvedValue({ ...notif, forUserId: 'someone-else' });
      await expect(notificationService.delete('n1', ctx)).rejects.toThrow('not found');
      expect(mockNotifRepo.delete).not.toHaveBeenCalled();
      expect(mockAuditLog).not.toHaveBeenCalled();
    });

    it('deletes notification (the original happy path, kept)', async () => {
      mockNotifRepo.findById.mockResolvedValue(notif);
      mockNotifRepo.delete.mockResolvedValue({});

      const result = await notificationService.delete('n1', ctx);
      expect(result.success).toBe(true);
      expect(mockNotifRepo.delete).toHaveBeenCalledWith('n1', 'TX');
    });

    it('writes a NOTIFICATION_DELETED audit row capturing the destroyed record', async () => {
      mockNotifRepo.findById.mockResolvedValue(notif);
      mockNotifRepo.delete.mockResolvedValue({});

      await notificationService.delete('n1', ctx);

      expect(mockAuditLog).toHaveBeenCalledTimes(1);
      const [entry, tx] = mockAuditLog.mock.calls[0];
      expect(entry.action).toBe('NOTIFICATION_DELETED');
      expect(entry.targetId).toBe('n1');
      expect(entry.userId).toBe('someadmin');
      expect(entry.userRole).toBe('ADMIN');
      expect(entry.ipAddress).toBe('10.0.0.5');
      // The identifying payload must survive the row's destruction.
      expect(entry.beforeValue).toMatchObject({
        type: 'ACCOUNT_LOCKED', title: 'Account locked', message: 'RB0001 locked out',
      });
      // Audit joins the delete's transaction — a delete can never commit unaudited.
      expect(tx).toBe('TX');
    });

    it('does not audit when the notification does not exist', async () => {
      mockNotifRepo.findById.mockResolvedValue(null);
      await expect(notificationService.delete('bad', ctx)).rejects.toThrow('not found');
      expect(mockAuditLog).not.toHaveBeenCalled();
      expect(mockNotifRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('bulkDelete', () => {
    it('writes ONE NOTIFICATIONS_BULK_DELETED row enumerating every destroyed record', async () => {
      const doomed = [
        { id: 'n1', type: 'ACCOUNT_LOCKED', title: 'A', forUserId: 'u1', forRole: null, createdAt: new Date() },
        { id: 'n2', type: 'PM_OVERDUE', title: 'B', forUserId: null, forRole: 'ADMIN', createdAt: new Date() },
      ];
      mockNotifRepo.findBulkDeletable.mockResolvedValue(doomed);
      mockNotifRepo.bulkDelete.mockResolvedValue({ count: 2 });

      const result = await notificationService.bulkDelete(['n1', 'n2'], ctx);
      expect(result.count).toBe(2);

      expect(mockAuditLog).toHaveBeenCalledTimes(1);
      const [entry, tx] = mockAuditLog.mock.calls[0];
      expect(entry.action).toBe('NOTIFICATIONS_BULK_DELETED');
      expect(entry.userId).toBe('someadmin');
      expect(entry.beforeValue.recordCount).toBe(2);
      // deleteMany returns only a count — the ids/titles must be captured up-front.
      expect(entry.beforeValue.records.map((r: any) => r.id)).toEqual(['n1', 'n2']);
      expect(entry.beforeValue.records.map((r: any) => r.title)).toEqual(['A', 'B']);
      expect(tx).toBe('TX');
    });

    it('skips the audit row when the visibility filter matches nothing', async () => {
      mockNotifRepo.findBulkDeletable.mockResolvedValue([]);
      mockNotifRepo.bulkDelete.mockResolvedValue({ count: 0 });

      const result = await notificationService.bulkDelete(['nope'], ctx);
      expect(result.count).toBe(0);
      expect(mockAuditLog).not.toHaveBeenCalled();
    });
  });
});
