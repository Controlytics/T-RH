import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    notification: {
      findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(),
      create: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
      delete: vi.fn(), deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import { notificationRepository } from '../notification.repository.js';

describe('notification.repository', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('findMany', () => {
    it('returns paginated notifications', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([{ id: 'n1' }]);
      const result = await notificationRepository.findMany({}, 0, 10);
      expect(result).toHaveLength(1);
    });
  });

  describe('count', () => {
    it('returns notification count', async () => {
      mockPrisma.notification.count.mockResolvedValue(5);
      const result = await notificationRepository.count({ isRead: false });
      expect(result).toBe(5);
    });
  });

  describe('findById', () => {
    it('returns notification by id', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue({ id: 'n1', title: 'Test' });
      const result = await notificationRepository.findById('n1');
      expect(result?.title).toBe('Test');
    });
  });

  describe('create', () => {
    it('creates a notification', async () => {
      mockPrisma.notification.create.mockResolvedValue({ id: 'n1', title: 'Created' });
      const result = await notificationRepository.create({
        type: 'USER_CREATED', title: 'Created', message: 'Test',
      });
      expect(result.title).toBe('Created');
    });
  });

  describe('markRead', () => {
    it('marks notification as read', async () => {
      mockPrisma.notification.update.mockResolvedValue({ id: 'n1', isRead: true });
      const result = await notificationRepository.markRead('n1');
      expect(result.isRead).toBe(true);
    });
  });

  describe('markUnread', () => {
    it('marks notification as unread', async () => {
      mockPrisma.notification.update.mockResolvedValue({ id: 'n1', isRead: false });
      const result = await notificationRepository.markUnread('n1');
      expect(result.isRead).toBe(false);
    });
  });

  describe('markAllRead', () => {
    it('marks all matching notifications as read', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 10 });
      const result = await notificationRepository.markAllRead({ isRead: false });
      expect(result.count).toBe(10);
    });
  });

  describe('bulkMarkRead', () => {
    it('marks selected notifications as read', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 3 });
      const result = await notificationRepository.bulkMarkRead(['n1', 'n2', 'n3']);
      expect(result.count).toBe(3);
    });
  });

  describe('delete', () => {
    it('deletes a notification', async () => {
      mockPrisma.notification.delete.mockResolvedValue({ id: 'n1' });
      await notificationRepository.delete('n1');
      expect(mockPrisma.notification.delete).toHaveBeenCalledWith({ where: { id: 'n1' } });
    });
  });

  describe('bulkDelete', () => {
    it('deletes multiple notifications', async () => {
      mockPrisma.notification.deleteMany.mockResolvedValue({ count: 2 });
      const result = await notificationRepository.bulkDelete(['n1', 'n2']);
      expect(result.count).toBe(2);
    });
  });
});
