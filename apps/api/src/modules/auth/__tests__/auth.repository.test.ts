import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    session: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    systemConfig: { findUnique: vi.fn() },
    passwordHistory: { findMany: vi.fn(), create: vi.fn() },
    passwordResetRequest: { findFirst: vi.fn(), create: vi.fn() },
    role: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));

const { mockInvalidateSession } = vi.hoisted(() => ({ mockInvalidateSession: vi.fn() }));
vi.mock('../../../plugins/auth.js', () => ({
  invalidateUserAuthCache: vi.fn(),
  invalidateSessionAuthCache: mockInvalidateSession,
}));

import { authRepository } from '../auth.repository.js';

describe('auth.repository', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('findUserByUsername', () => {
    it('queries user by username', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', username: 'admin' });
      const result = await authRepository.findUserByUsername('admin');
      expect(result?.username).toBe('admin');
    });

    it('returns null when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const result = await authRepository.findUserByUsername('missing');
      expect(result).toBeNull();
    });
  });

  describe('findUserById', () => {
    it('queries user by id', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      const result = await authRepository.findUserById('u1');
      expect(result?.id).toBe('u1');
    });
  });

  describe('updateUser', () => {
    it('updates user data', async () => {
      mockPrisma.user.update.mockResolvedValue({ id: 'u1', status: 'DISABLED' });
      const result = await authRepository.updateUser('u1', { status: 'DISABLED' });
      expect(result.status).toBe('DISABLED');
    });
  });

  describe('createSession', () => {
    it('creates a new session', async () => {
      mockPrisma.session.create.mockResolvedValue({ id: 's1', userId: 'u1' });
      const result = await authRepository.createSession('u1', '127.0.0.1', 'test-agent', 8);
      expect(result.id).toBe('s1');
    });
  });

  describe('terminateActiveSessions', () => {
    it('deactivates all user sessions AND evicts each from the auth cache', async () => {
      mockPrisma.session.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
      mockPrisma.session.updateMany.mockResolvedValue({ count: 2 });
      const result = await authRepository.terminateActiveSessions('u1', 'logout');
      expect(result.count).toBe(2);
      // The fix: terminated sessions must be evicted from sessionAuthCache so
      // they can't keep passing auth for the 30s cache TTL.
      expect(mockInvalidateSession).toHaveBeenCalledWith('s1');
      expect(mockInvalidateSession).toHaveBeenCalledWith('s2');
    });
  });

  describe('terminateSession', () => {
    it('deactivates a single session and evicts it from the auth cache', async () => {
      mockPrisma.session.update.mockResolvedValue({ id: 's1', isActive: false });
      const result = await authRepository.terminateSession('s1', 'logout');
      expect(result.isActive).toBe(false);
      expect(mockInvalidateSession).toHaveBeenCalledWith('s1');
    });
  });

  describe('terminateOtherSessions', () => {
    it('deactivates other sessions and evicts them from the auth cache', async () => {
      mockPrisma.session.findMany.mockResolvedValue([{ id: 's2' }]);
      mockPrisma.session.updateMany.mockResolvedValue({ count: 1 });
      const result = await authRepository.terminateOtherSessions('u1', 's1', 'password_changed');
      expect(result.count).toBe(1);
      expect(mockInvalidateSession).toHaveBeenCalledWith('s2');
      expect(mockInvalidateSession).not.toHaveBeenCalledWith('s1');
    });
  });

  describe('findActiveSessions', () => {
    it('returns active sessions for user', async () => {
      mockPrisma.session.findMany.mockResolvedValue([{ id: 's1' }]);
      const result = await authRepository.findActiveSessions('u1');
      expect(result).toHaveLength(1);
    });
  });

  describe('getLoginSecurityConfig', () => {
    it('returns login security config', async () => {
      mockPrisma.systemConfig.findUnique.mockResolvedValue({
        configValue: { maxLoginAttempts: 5, lockoutDuration: 15 },
      });
      const result = await authRepository.getLoginSecurityConfig();
      expect(result.maxLoginAttempts).toBe(5);
    });
  });

  describe('getSessionConfig', () => {
    it('returns session config', async () => {
      mockPrisma.systemConfig.findUnique.mockResolvedValue({
        configValue: { sessionDuration: 8, idleTimeout: 15 },
      });
      const result = await authRepository.getSessionConfig();
      expect(result.sessionDuration).toBe(8);
    });
  });

  describe('getPasswordHistory', () => {
    it('returns recent password hashes', async () => {
      mockPrisma.passwordHistory.findMany.mockResolvedValue([
        { passwordHash: 'hash1' },
        { passwordHash: 'hash2' },
      ]);
      const result = await authRepository.getPasswordHistory('u1', 5);
      expect(result).toHaveLength(2);
    });
  });

  describe('changePassword', () => {
    it('updates password and adds to history in transaction', async () => {
      const updated = { id: 'u1' };
      const history = { id: 'ph1' };
      mockPrisma.$transaction.mockResolvedValue([updated, history]);
      const result = await authRepository.changePassword('u1', 'newhash', new Date());
      expect(result).toHaveLength(2);
    });
  });

  describe('findPendingResetRequest', () => {
    it('finds pending reset request by username', async () => {
      mockPrisma.passwordResetRequest.findFirst.mockResolvedValue({ id: 'r1', status: 'PENDING' });
      const result = await authRepository.findPendingResetRequest('admin');
      expect(result?.status).toBe('PENDING');
    });
  });

  describe('createResetRequest', () => {
    it('creates a new reset request', async () => {
      mockPrisma.passwordResetRequest.create.mockResolvedValue({ id: 'r1' });
      const result = await authRepository.createResetRequest('admin');
      expect(result.id).toBe('r1');
    });
  });
});
