import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockConfigFindUnique, mockUserFindUnique, mockUserUpdate, mockVerifyPassword, mockApplyFailed } = vi.hoisted(() => ({
  mockConfigFindUnique: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserUpdate: vi.fn(),
  mockVerifyPassword: vi.fn(),
  mockApplyFailed: vi.fn(),
}));

vi.mock('./prisma.js', () => ({
  prisma: {
    systemConfig: { findUnique: mockConfigFindUnique },
    user: { findUnique: mockUserFindUnique, update: mockUserUpdate },
  },
}));

vi.mock('./password.js', () => ({
  verifyPassword: mockVerifyPassword,
}));

// reauth failures run the shared account-lockout policy — mock it so this unit
// test stays isolated from the lockout internals (config/audit/notifications).
vi.mock('../modules/auth/auth.service.js', () => ({
  applyFailedPasswordAttempt: mockApplyFailed,
}));

import {
  getActionReauthConfig,
  invalidateReauthCache,
  isReauthRequired,
  enforceReauth,
} from './reauth-check.js';

// ── Helpers ─────────────────────────────────────────────────

function mockRequest(overrides: Record<string, unknown> = {}) {
  return {
    user: { sub: 'user-1', role: 'ADMIN', ...overrides.user as object },
    body: overrides.body ?? {},
    headers: overrides.headers ?? {},
    ...overrides,
  } as any;
}

function mockReply() {
  const reply: any = {
    statusCode: 0,
    body: null,
    code(c: number) {
      reply.statusCode = c;
      return reply;
    },
    send(b: unknown) {
      reply.body = b;
      return reply;
    },
  };
  return reply;
}

// ── Tests ───────────────────────────────────────────────────

describe('reauth-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateReauthCache();
    mockApplyFailed.mockResolvedValue({ locked: false });
  });

  // ── getActionReauthConfig ──
  describe('getActionReauthConfig', () => {
    it('reads config from DB', async () => {
      mockConfigFindUnique.mockResolvedValue({
        configValue: { CREATE_USER: ['ADMIN', 'SUPER_ADMIN'] },
      });

      const config = await getActionReauthConfig();
      expect(config).toEqual({ CREATE_USER: ['ADMIN', 'SUPER_ADMIN'] });
    });

    it('returns empty object when no config exists', async () => {
      mockConfigFindUnique.mockResolvedValue(null);
      const config = await getActionReauthConfig();
      expect(config).toEqual({});
    });

    it('caches result for 10 seconds', async () => {
      mockConfigFindUnique.mockResolvedValue({
        configValue: { DELETE_USER: ['SUPER_ADMIN'] },
      });

      await getActionReauthConfig();
      await getActionReauthConfig();

      // Only one DB call due to cache
      expect(mockConfigFindUnique).toHaveBeenCalledTimes(1);
    });
  });

  // ── isReauthRequired ──
  describe('isReauthRequired', () => {
    it('returns true when role is in action config', async () => {
      mockConfigFindUnique.mockResolvedValue({
        configValue: { DELETE_USER: ['ADMIN', 'SUPER_ADMIN'] },
      });

      expect(await isReauthRequired('DELETE_USER', 'ADMIN')).toBe(true);
    });

    it('returns false when role is not in action config', async () => {
      mockConfigFindUnique.mockResolvedValue({
        configValue: { DELETE_USER: ['SUPER_ADMIN'] },
      });

      expect(await isReauthRequired('DELETE_USER', 'OPERATOR')).toBe(false);
    });

    it('returns false when action not configured', async () => {
      mockConfigFindUnique.mockResolvedValue({ configValue: {} });
      expect(await isReauthRequired('NONEXISTENT_ACTION', 'ADMIN')).toBe(false);
    });

    it('returns false when action has empty roles array', async () => {
      mockConfigFindUnique.mockResolvedValue({
        configValue: { DELETE_USER: [] },
      });
      expect(await isReauthRequired('DELETE_USER', 'ADMIN')).toBe(false);
    });
  });

  // ── enforceReauth ──
  describe('enforceReauth', () => {
    it('returns ok:true when reauth not required for action', async () => {
      mockConfigFindUnique.mockResolvedValue({ configValue: {} });

      const req = mockRequest();
      const reply = mockReply();
      const result = await enforceReauth('CREATE_USER', req, reply);

      expect(result.ok).toBe(true);
    });

    it('returns ok:false and sends 401 when password missing', async () => {
      mockConfigFindUnique.mockResolvedValue({
        configValue: { CREATE_USER: ['ADMIN'] },
      });

      const req = mockRequest({ body: {}, headers: {} });
      const reply = mockReply();
      const result = await enforceReauth('CREATE_USER', req, reply);

      expect(result.ok).toBe(false);
      expect(reply.statusCode).toBe(401);
      expect(reply.body.error).toBe('REAUTH_REQUIRED');
    });

    it('returns ok:true when password from header is valid', async () => {
      mockConfigFindUnique.mockResolvedValue({
        configValue: { CREATE_USER: ['ADMIN'] },
      });
      mockUserFindUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'hash' });
      mockVerifyPassword.mockResolvedValue(true);

      const req = mockRequest({
        headers: { 'x-reauth-password': 'Admin@123' },
      });
      const reply = mockReply();
      const result = await enforceReauth('CREATE_USER', req, reply);

      expect(result.ok).toBe(true);
      expect(mockVerifyPassword).toHaveBeenCalledWith('Admin@123', 'hash');
    });

    it('returns ok:true when password from body._currentPassword is valid', async () => {
      mockConfigFindUnique.mockResolvedValue({
        configValue: { CREATE_USER: ['ADMIN'] },
      });
      mockUserFindUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'hash' });
      mockVerifyPassword.mockResolvedValue(true);

      const body: Record<string, unknown> = { _currentPassword: 'Admin@123', name: 'test' };
      const req = mockRequest({ body });
      const reply = mockReply();
      const result = await enforceReauth('CREATE_USER', req, reply);

      expect(result.ok).toBe(true);
      // Should strip _currentPassword from body
      expect(body._currentPassword).toBeUndefined();
    });

    it('returns ok:false, sends REAUTH_FAILED, AND counts the attempt toward lockout', async () => {
      mockConfigFindUnique.mockResolvedValue({
        configValue: { CREATE_USER: ['ADMIN'] },
      });
      mockUserFindUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'hash', failedLoginAttempts: 0 });
      mockVerifyPassword.mockResolvedValue(false);

      const req = mockRequest({ headers: { 'x-reauth-password': 'wrong' } });
      const reply = mockReply();
      const result = await enforceReauth('CREATE_USER', req, reply);

      expect(result.ok).toBe(false);
      expect(reply.statusCode).toBe(401);
      expect(reply.body.error).toBe('REAUTH_FAILED');
      // The fix: reauth guesses run the shared lockout policy.
      expect(mockApplyFailed).toHaveBeenCalledTimes(1);
    });

    it('sends 403 ACCOUNT_LOCKED when the reauth attempt trips the lockout threshold', async () => {
      mockConfigFindUnique.mockResolvedValue({ configValue: { CREATE_USER: ['ADMIN'] } });
      mockUserFindUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'hash', failedLoginAttempts: 4 });
      mockVerifyPassword.mockResolvedValue(false);
      mockApplyFailed.mockResolvedValue({ locked: true });

      const req = mockRequest({ headers: { 'x-reauth-password': 'wrong' } });
      const reply = mockReply();
      const result = await enforceReauth('CREATE_USER', req, reply);

      expect(result.ok).toBe(false);
      expect(reply.statusCode).toBe(403);
      expect(reply.body.error).toBe('ACCOUNT_LOCKED');
    });

    it('returns ok:false when user not found', async () => {
      mockConfigFindUnique.mockResolvedValue({
        configValue: { CREATE_USER: ['ADMIN'] },
      });
      mockUserFindUnique.mockResolvedValue(null);

      const req = mockRequest({ headers: { 'x-reauth-password': 'Admin@123' } });
      const reply = mockReply();
      const result = await enforceReauth('CREATE_USER', req, reply);

      expect(result.ok).toBe(false);
      expect(reply.statusCode).toBe(401);
      expect(reply.body.error).toBe('REAUTH_FAILED');
    });
  });
});
