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
      const where = mockNotifRepo.findMany.mock.calls[0][0];
      const normal = (where.OR as any[])[0].AND[1];

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
      mockNotifRepo.findById.mockResolvedValue({ id: 'n1' });
      mockNotifRepo.markRead.mockResolvedValue({});

      const result = await notificationService.markRead('n1');
      expect(result.success).toBe(true);
      expect(mockNotifRepo.markRead).toHaveBeenCalledWith('n1');
    });

    it('throws NotFoundError', async () => {
      mockNotifRepo.findById.mockResolvedValue(null);
      await expect(notificationService.markRead('bad')).rejects.toThrow('not found');
    });
  });

  describe('markUnread', () => {
    it('marks notification as unread', async () => {
      mockNotifRepo.findById.mockResolvedValue({ id: 'n1' });
      mockNotifRepo.markUnread.mockResolvedValue({});

      const result = await notificationService.markUnread('n1');
      expect(result.success).toBe(true);
      expect(mockNotifRepo.markUnread).toHaveBeenCalledWith('n1');
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
