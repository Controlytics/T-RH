import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    userConfig: { deleteMany: vi.fn() },
    session: { updateMany: vi.fn() },
    role: { findUnique: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
    passwordHistory: { findMany: vi.fn(), create: vi.fn() },
    passwordResetRequest: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import { userRepository } from '../user.repository.js';

describe('user.repository', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('findMany', () => {
    it('returns paginated users with total', async () => {
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'u1' }]);
      mockPrisma.user.count.mockResolvedValue(1);
      const result = await userRepository.findMany({}, 1, 10);
      expect(result.users).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('findById', () => {
    it('returns user by id', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', username: 'admin' });
      const result = await userRepository.findById('u1');
      expect(result?.id).toBe('u1');
    });

    it('returns null for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const result = await userRepository.findById('missing');
      expect(result).toBeNull();
    });
  });

  describe('findByUsername', () => {
    it('returns user by username', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', username: 'admin' });
      const result = await userRepository.findByUsername('admin');
      expect(result?.username).toBe('admin');
    });
  });

  describe('findByEmail', () => {
    it('returns user by email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'admin@test.com' });
      const result = await userRepository.findByEmail('admin@test.com');
      expect(result?.email).toBe('admin@test.com');
    });
  });

  describe('create', () => {
    it('creates a new user', async () => {
      const userData = {
        username: 'newuser', fullName: 'New User', email: 'new@test.com',
        role: 'OPERATOR', passwordHash: 'hash', status: 'ENABLED',
        forcePasswordChange: true, isTemporaryPassword: true,
        passwordExpiresAt: null, createdBy: 'admin',
      };
      mockPrisma.user.create.mockResolvedValue({ id: 'u2', ...userData });
      const result = await userRepository.create(userData);
      expect(result.username).toBe('newuser');
    });
  });

  describe('update', () => {
    it('updates user fields', async () => {
      mockPrisma.user.update.mockResolvedValue({ id: 'u1', fullName: 'Updated' });
      const result = await userRepository.update('u1', { fullName: 'Updated' });
      expect(result.fullName).toBe('Updated');
    });
  });

  describe('countByStatus', () => {
    it('returns status counts', async () => {
      mockPrisma.user.count
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(7)  // enabled
        .mockResolvedValueOnce(2)  // disabled
        .mockResolvedValueOnce(1)  // locked
        .mockResolvedValueOnce(0); // expired
      const result = await userRepository.countByStatus({});
      expect(result.total).toBe(10);
      expect(result.enabled).toBe(7);
    });
  });

  describe('terminateSessions', () => {
    it('terminates all active sessions', async () => {
      mockPrisma.session.updateMany.mockResolvedValue({ count: 3 });
      const result = await userRepository.terminateSessions('u1', 'admin_action');
      expect(result.count).toBe(3);
    });
  });
});
