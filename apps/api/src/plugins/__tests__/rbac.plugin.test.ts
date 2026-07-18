import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPrisma, mockAuditLog } = vi.hoisted(() => ({
  mockPrisma: {
    role: {
      // rbac.ts uses role.findFirst (WHERE name=$role), so mock that.
      // findUnique kept for forward-compat if a call-site switches to
      // exact-PK lookup later.
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
  },
  mockAuditLog: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import rbacPlugin, { invalidateRolePermsCache } from '../rbac.js';

function makeReq(user: any = { sub: 'u1', username: 'admin', role: 'ADMIN', sessionId: 's1' }) {
  return {
    user,
    ip: '127.0.0.1',
    headers: { 'user-agent': 'test' },
  } as any;
}

function makeReply() {
  const reply: any = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
}

describe('rbacPlugin', () => {
  let requirePermission: (perm: string) => Function;
  let requireRole: (...roles: string[]) => Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Audit 2026-05-04 fix (api-supporting M11): rbac plugin caches role
    // permissions for 5s. Tests reuse the same role name across cases with
    // different mockPrisma.role.findFirst return values; clear the cache
    // before each test so the new mock is observed.
    invalidateRolePermsCache();
    mockAuditLog.mockResolvedValue(undefined);

    const app = {
      decorate: vi.fn((name: string, fn: Function) => {
        if (name === 'requirePermission') requirePermission = fn as any;
        if (name === 'requireRole') requireRole = fn as any;
      }),
      auditLog: mockAuditLog,
    } as any;

    await rbacPlugin(app, {});
  });

  describe('requirePermission', () => {
    it('allows SUPER_ADMIN for any permission (bypass)', async () => {
      const middleware = requirePermission('ASSET_VIEW');
      const req = makeReq({ sub: 'u1', username: 'super', role: 'SUPER_ADMIN', sessionId: 's1' });
      const reply = makeReply();

      await middleware(req, reply);
      expect(reply.code).not.toHaveBeenCalled();
      expect(mockPrisma.role.findFirst).not.toHaveBeenCalled();
    });

    it('allows when role has required permission', async () => {
      const middleware = requirePermission('ASSET_VIEW');
      const req = makeReq();
      const reply = makeReply();

      mockPrisma.role.findFirst.mockResolvedValue({
        permissions: ['ASSET_VIEW', 'ASSET_CREATE'],
      });

      await middleware(req, reply);
      expect(reply.code).not.toHaveBeenCalled();
    });

    it('denies when role lacks permission', async () => {
      const middleware = requirePermission('ASSET_DELETE');
      const req = makeReq();
      const reply = makeReply();

      mockPrisma.role.findFirst.mockResolvedValue({
        permissions: ['ASSET_VIEW'],
      });

      await middleware(req, reply);
      expect(reply.code).toHaveBeenCalledWith(403);
    });

    it('denies when role not found in DB', async () => {
      const middleware = requirePermission('ASSET_VIEW');
      const req = makeReq();
      const reply = makeReply();

      mockPrisma.role.findFirst.mockResolvedValue(null);

      await middleware(req, reply);
      expect(reply.code).toHaveBeenCalledWith(403);
    });

    it('returns 401 when no user on request', async () => {
      const middleware = requirePermission('ASSET_VIEW');
      const req = makeReq(null);
      const reply = makeReply();

      await middleware(req, reply);
      expect(reply.code).toHaveBeenCalledWith(401);
    });

    it('handles null permissions array gracefully', async () => {
      const middleware = requirePermission('ASSET_VIEW');
      const req = makeReq();
      const reply = makeReply();

      mockPrisma.role.findFirst.mockResolvedValue({
        permissions: null,
      });

      await middleware(req, reply);
      expect(reply.code).toHaveBeenCalledWith(403);
    });
  });

  describe('requireRole', () => {
    it('allows when user role matches', async () => {
      const middleware = requireRole('ADMIN', 'SUPER_ADMIN');
      const req = makeReq();
      const reply = makeReply();

      await middleware(req, reply);
      expect(reply.code).not.toHaveBeenCalled();
    });

    it('denies when user role does not match', async () => {
      const middleware = requireRole('SUPER_ADMIN');
      const req = makeReq({ sub: 'u1', username: 'viewer', role: 'VIEWER', sessionId: 's1' });
      const reply = makeReply();

      await middleware(req, reply);
      expect(reply.code).toHaveBeenCalledWith(403);
    });

    it('denies when no user on request', async () => {
      const middleware = requireRole('ADMIN');
      const req = makeReq(null);
      const reply = makeReply();

      await middleware(req, reply);
      expect(reply.code).toHaveBeenCalledWith(403);
    });
  });
});
