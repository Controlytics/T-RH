import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockUserRepo,
  mockAuditLog,
  mockHashPassword,
  mockValidateUserId,
  mockCreateNotification,
} = vi.hoisted(() => ({
  mockUserRepo: {
    findMany: vi.fn(),
    findById: vi.fn(),
    findByIdFull: vi.fn(),
    findByUsername: vi.fn(),
    findByEmail: vi.fn(),
    findByUsernameOrEmail: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    findManyByIds: vi.fn(),
    countByStatus: vi.fn(),
    addPasswordHistory: vi.fn(),
    findRole: vi.fn(),
    terminateSessions: vi.fn(),
    getPasswordExpiresAt: vi.fn(),
    unlockUser: vi.fn(),
    resetPassword: vi.fn(),
    findResetRequests: vi.fn(),
    countPendingResetRequests: vi.fn(),
    findResetRequestById: vi.fn(),
    approveResetRequest: vi.fn(),
    rejectResetRequest: vi.fn(),
    findUsersByUsernames: vi.fn(),
  },
  mockAuditLog: vi.fn(),
  mockHashPassword: vi.fn(),
  mockValidateUserId: vi.fn(),
  mockCreateNotification: vi.fn(),
}));

vi.mock('../user.repository.js', () => ({ userRepository: mockUserRepo }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));
// `prisma` is NOT mocked: the service opens a real `$transaction` (audit
// 2026-10-03, API-7) and hands its client to the mocked repository and the
// mocked auditLog, so the tests can assert the two received the SAME client.
vi.mock('../../../lib/password.js', () => ({ hashPassword: mockHashPassword }));
vi.mock('../../../lib/user-id-validator.js', () => ({ validateUserId: mockValidateUserId }));
vi.mock('../../notifications/notification.service.js', () => ({ createNotification: mockCreateNotification }));

import { userService, hiddenRolesFor } from '../user.service.js';

const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' };

describe('userService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditLog.mockResolvedValue(undefined);
    mockCreateNotification.mockResolvedValue(undefined);
  });

  // ── list ──
  describe('list', () => {
    it('returns paginated users', async () => {
      mockUserRepo.findMany.mockResolvedValue({ users: [{ id: '1' }], total: 1 });
      const result = await userService.list({ page: 1, limit: 20 });
      expect(result.data).toHaveLength(1);
      expect(result.totalPages).toBe(1);
    });

    it('passes search and role filters', async () => {
      mockUserRepo.findMany.mockResolvedValue({ users: [], total: 0 });
      // callerRole matters now: the route (routes.ts) always stamps it from the
      // JWT, and an explicit ?role= must be intersected with the caller's
      // hidden-role exclusions rather than replacing them.
      await userService.list({ page: 1, limit: 10, role: 'ADMIN', search: 'john', callerRole: 'SUPER_ADMIN' });
      const where = mockUserRepo.findMany.mock.calls[0][0];
      expect(where.role).toBe('ADMIN');
      expect(where.OR).toBeDefined();
    });

    it('does not let ?role= bypass the SUPER_ADMIN hiding for an ADMIN caller', async () => {
      mockUserRepo.findMany.mockResolvedValue({ users: [], total: 0 });
      await userService.list({ page: 1, limit: 10, role: 'SUPER_ADMIN', callerRole: 'ADMIN' });
      const where = mockUserRepo.findMany.mock.calls[0][0];
      // Previously `where.role = query.role` — asking for the hidden role handed
      // it straight over. It must now match nothing.
      expect(where.role).toEqual({ in: [] });
    });

    it('still hides SUPER_ADMIN from an ADMIN caller when no role filter is given', async () => {
      mockUserRepo.findMany.mockResolvedValue({ users: [], total: 0 });
      await userService.list({ page: 1, limit: 10, callerRole: 'ADMIN' });
      const where = mockUserRepo.findMany.mock.calls[0][0];
      expect(where.role).toEqual({ notIn: ['SUPER_ADMIN'] });
    });

    it('narrows to a permitted role for an ADMIN caller', async () => {
      mockUserRepo.findMany.mockResolvedValue({ users: [], total: 0 });
      await userService.list({ page: 1, limit: 10, role: 'OPERATOR', callerRole: 'ADMIN' });
      const where = mockUserRepo.findMany.mock.calls[0][0];
      expect(where.role).toBe('OPERATOR');
    });

    it('honours ?role= for a SUPER_ADMIN caller (nothing is excluded)', async () => {
      mockUserRepo.findMany.mockResolvedValue({ users: [], total: 0 });
      // Regression: with no exclusions the role filter used to be dropped
      // entirely, so a SUPER_ADMIN filtering by role silently saw everyone.
      await userService.list({ page: 1, limit: 10, role: 'OPERATOR', callerRole: 'SUPER_ADMIN' });
      const where = mockUserRepo.findMany.mock.calls[0][0];
      expect(where.role).toBe('OPERATOR');
    });
  });

  // ── getStats ──
  describe('getStats', () => {
    it('passes empty filter for SUPER_ADMIN', async () => {
      mockUserRepo.countByStatus.mockResolvedValue({ total: 10 });
      await userService.getStats('SUPER_ADMIN');
      expect(mockUserRepo.countByStatus).toHaveBeenCalledWith({});
    });

    it('filters out SUPER_ADMIN users for ADMIN caller', async () => {
      mockUserRepo.countByStatus.mockResolvedValue({ total: 5 });
      await userService.getStats('ADMIN');
      const filter = mockUserRepo.countByStatus.mock.calls[0][0];
      expect(filter.role).toBeDefined();
    });
  });

  // ── getById ──
  describe('getById', () => {
    it('returns user by id', async () => {
      mockUserRepo.findById.mockResolvedValue({ id: '1', username: 'user1' });
      const result = await userService.getById('1');
      expect(result.username).toBe('user1');
    });

    it('throws NotFoundError', async () => {
      mockUserRepo.findById.mockResolvedValue(null);
      await expect(userService.getById('missing')).rejects.toThrow('not found');
    });
  });

  // ── create ──
  describe('create', () => {
    it('creates user with validation', async () => {
      mockValidateUserId.mockResolvedValue({ valid: true, errors: [] });
      mockUserRepo.findRole.mockResolvedValue({ name: 'OPERATOR', hierarchyLevel: 2, isActive: true });
      mockUserRepo.findByUsernameOrEmail.mockResolvedValue(null);
      mockHashPassword.mockResolvedValue('hashed');
      mockUserRepo.getPasswordExpiresAt.mockResolvedValue(new Date());
      mockUserRepo.create.mockResolvedValue({ id: 'new-1', username: 'EMP001', fullName: 'Test', email: 't@t.com', role: 'OPERATOR', status: 'ENABLED', department: null, createdAt: new Date() });
      mockUserRepo.addPasswordHistory.mockResolvedValue({});

      // Creator has higher hierarchy than target role
      const adminCtx = { ...ctx, userRole: 'ADMIN' };
      mockUserRepo.findRole.mockResolvedValueOnce({ name: 'ADMIN', hierarchyLevel: 5, isActive: true });
      mockUserRepo.findRole.mockResolvedValueOnce({ name: 'OPERATOR', hierarchyLevel: 2, isActive: true });

      const result = await userService.create({
        // Password must satisfy the active password-policy systemConfig
        // (minLength is 10 in the seeded dev DB). 'Pass@123' was 8 chars.
        username: 'EMP001', fullName: 'Test', email: 't@t.com', role: 'OPERATOR', password: 'Test@Pass1234',
      }, adminCtx);

      expect(result.username).toBe('EMP001');
      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'USER_CREATED' }), expect.anything());
      // The row, its password history and its audit row share ONE transaction
      // client (API-7).
      const tx = mockAuditLog.mock.calls[0][1];
      expect(tx).toBeDefined();
      expect(mockUserRepo.create.mock.calls[0][1]).toBe(tx);
      expect(mockUserRepo.addPasswordHistory.mock.calls[0][2]).toBe(tx);
    });

    it('rejects invalid user ID', async () => {
      mockValidateUserId.mockResolvedValue({ valid: false, errors: ['Too short'] });

      await expect(userService.create({ username: 'ab', fullName: 'T', email: 't@t.com', role: 'OP', password: 'p' }, ctx))
        .rejects.toThrow('Too short');
    });

    it('rejects duplicate username', async () => {
      mockValidateUserId.mockResolvedValue({ valid: true, errors: [] });
      mockUserRepo.findRole.mockResolvedValue({ name: 'ADMIN', hierarchyLevel: 5, isActive: true });
      mockUserRepo.findByUsernameOrEmail.mockResolvedValue({ username: 'dup' });

      await expect(userService.create({ username: 'dup', fullName: 'T', email: 't@t.com', role: 'ADMIN', password: 'p' }, ctx))
        .rejects.toThrow('already exists');
    });

    it('rejects creating higher hierarchy role', async () => {
      mockValidateUserId.mockResolvedValue({ valid: true, errors: [] });
      mockUserRepo.findRole.mockResolvedValueOnce({ name: 'ADMIN', hierarchyLevel: 5, isActive: true });
      mockUserRepo.findRole.mockResolvedValueOnce({ name: 'SUPER_ADMIN', hierarchyLevel: 6, isActive: true });
      mockUserRepo.findByUsernameOrEmail.mockResolvedValue(null);

      await expect(userService.create({ username: 'new', fullName: 'T', email: 't@t.com', role: 'SUPER_ADMIN', password: 'p' }, ctx))
        .rejects.toThrow('Cannot create');
    });
  });

  // ── update ──
  describe('update', () => {
    it('updates user fields', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: '1', fullName: 'Old', email: 'old@t.com', role: 'OP', status: 'ENABLED', department: null, username: 'u1' });
      mockUserRepo.update.mockResolvedValue({ id: '1', fullName: 'New', email: 'old@t.com', role: 'OP', status: 'ENABLED', username: 'u1' });

      const result = await userService.update('1', { fullName: 'New' }, ctx);
      expect(result.fullName).toBe('New');
      // Write and audit row on the same transaction client (API-7).
      expect(mockUserRepo.update.mock.calls[0][2]).toBe(mockAuditLog.mock.calls[0][1]);
    });

    it('throws NotFoundError for missing user', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue(null);
      await expect(userService.update('bad', {}, ctx)).rejects.toThrow('not found');
    });

    it('normalizes a blank email to null (no @unique collision across no-email users)', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: '1', fullName: 'Old', email: 'old@t.com', role: 'OP', status: 'ENABLED', department: null, username: 'u1' });
      mockUserRepo.update.mockResolvedValue({ id: '1', fullName: 'Old', email: null, role: 'OP', status: 'ENABLED', username: 'u1' });

      // The reported bug's core: an emailless user's edit form submits an empty
      // email. Update must succeed and store NULL, not '' (which would collide
      // on the @unique index across multiple no-email users).
      await userService.update('1', { email: '' }, ctx);
      expect(mockUserRepo.update).toHaveBeenCalledWith('1', expect.objectContaining({ email: null }), expect.anything());
      // The blank email must NOT trigger the duplicate-email probe.
      expect(mockUserRepo.findByEmail).not.toHaveBeenCalled();
    });
  });

  // ── delete ──
  describe('delete', () => {
    it('deletes user and logs audit IN THE SAME TRANSACTION, with the reason', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: '2', username: 'u2', fullName: 'F', email: 'e', role: 'OP', status: 'ENABLED' });
      mockUserRepo.delete.mockResolvedValue({});

      await userService.delete('2', 'different-user', ctx, 'left the company');
      expect(mockUserRepo.delete).toHaveBeenCalledWith('2', expect.anything());
      // Audit 2026-10-03, API-7: the USER_DELETED row used to be written
      // BEFORE the delete, standalone — a delete that then failed left a
      // chained row asserting the account was gone.
      const [entry, tx] = mockAuditLog.mock.calls[0];
      expect(entry.action).toBe('USER_DELETED');
      expect(entry.reason).toBe('left the company');
      expect(mockUserRepo.delete.mock.calls[0][1]).toBe(tx);
    });

    // DATA-11: the reason is the control, in the service.
    it('refuses a delete with no reason and deletes nothing', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: '2', username: 'u2', fullName: 'F', email: 'e', role: 'OP', status: 'ENABLED' });
      await expect(userService.delete('2', 'different-user', ctx)).rejects.toMatchObject({ code: 'REASON_REQUIRED', statusCode: 400 });
      await expect(userService.delete('2', 'different-user', ctx, '   ')).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
      expect(mockUserRepo.delete).not.toHaveBeenCalled();
      expect(mockAuditLog).not.toHaveBeenCalled();
    });

    it('prevents self-deletion', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: 'me' });
      await expect(userService.delete('me', 'me', ctx, 'x')).rejects.toThrow('own account');
    });
  });

  // ── bulkDelete ──
  describe('bulkDelete', () => {
    it('deletes multiple users, one audit row each, all on the delete\'s transaction', async () => {
      mockUserRepo.findManyByIds.mockResolvedValue([
        { id: '1', username: 'u1', fullName: 'F1', role: 'OP', status: 'ENABLED' },
        { id: '2', username: 'u2', fullName: 'F2', role: 'OP', status: 'ENABLED' },
      ]);
      mockUserRepo.deleteMany.mockResolvedValue({ count: 2 });

      const result = await userService.bulkDelete(['1', '2'], 'admin-id', ctx, 'contract ended');
      expect(result.deletedCount).toBe(2);
      expect(mockAuditLog).toHaveBeenCalledTimes(2);
      const tx = mockUserRepo.deleteMany.mock.calls[0][1];
      for (const [entry, auditTx] of mockAuditLog.mock.calls) {
        expect(entry.action).toBe('BULK_USER_DELETED');
        expect(entry.reason).toBe('contract ended');
        expect(auditTx).toBe(tx);
      }
    });

    it('refuses a bulk delete with no reason', async () => {
      mockUserRepo.findManyByIds.mockResolvedValue([{ id: '1', username: 'u1', fullName: 'F1', role: 'OP', status: 'ENABLED' }]);
      await expect(userService.bulkDelete(['1'], 'admin-id', ctx)).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
      expect(mockUserRepo.deleteMany).not.toHaveBeenCalled();
    });

    it('prevents deleting SUPER_ADMIN users', async () => {
      mockUserRepo.findManyByIds.mockResolvedValue([{ id: '1', username: 'sa', role: 'SUPER_ADMIN', status: 'ENABLED' }]);

      await expect(userService.bulkDelete(['1'], 'admin-id', ctx)).rejects.toThrow('SUPER_ADMIN');
    });

    it('prevents deleting own account', async () => {
      await expect(userService.bulkDelete(['me'], 'me', ctx)).rejects.toThrow('own account');
    });
  });

  // ── enable/disable ──
  describe('enable', () => {
    it('enables user and creates notification', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: '1', username: 'u1', fullName: 'F', status: 'DISABLED' });
      mockUserRepo.update.mockResolvedValue({});

      await userService.enable('1', ctx);
      expect(mockUserRepo.update).toHaveBeenCalledWith('1', expect.objectContaining({ status: 'ENABLED' }), expect.anything());
      expect(mockCreateNotification).toHaveBeenCalled();
    });
  });

  describe('disable', () => {
    it('disables user and terminates sessions, reason on the audit row, one transaction', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: '1', username: 'u1', fullName: 'F', status: 'ENABLED' });
      mockUserRepo.update.mockResolvedValue({});
      mockUserRepo.terminateSessions.mockResolvedValue({ count: 1 });

      await userService.disable('1', ctx, 'on leave');
      expect(mockUserRepo.terminateSessions).toHaveBeenCalledWith('1', 'account_disabled', expect.anything());
      const [entry, tx] = mockAuditLog.mock.calls[0];
      expect(entry).toMatchObject({ action: 'USER_DISABLED', reason: 'on leave' });
      expect(mockUserRepo.update.mock.calls[0][2]).toBe(tx);
      expect(mockUserRepo.terminateSessions.mock.calls[0][2]).toBe(tx);
    });

    it('refuses a disable with no reason and changes nothing', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: '1', username: 'u1', fullName: 'F', status: 'ENABLED' });
      await expect(userService.disable('1', ctx)).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
      expect(mockUserRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── unlock ──
  describe('unlock', () => {
    it('unlocks with new temp password', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: '1', username: 'u1', fullName: 'F', status: 'LOCKED', failedLoginAttempts: 5 });
      mockHashPassword.mockResolvedValue('new-hash');
      mockUserRepo.getPasswordExpiresAt.mockResolvedValue(new Date());
      mockUserRepo.unlockUser.mockResolvedValue([]);

      await userService.unlock('1', 'TempPass@1', ctx);
      expect(mockUserRepo.unlockUser).toHaveBeenCalled();
    });

    it('terminates the target user\'s active sessions (compromise response)', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: '1', username: 'u1', fullName: 'F', status: 'LOCKED', failedLoginAttempts: 5 });
      mockHashPassword.mockResolvedValue('new-hash');
      mockUserRepo.getPasswordExpiresAt.mockResolvedValue(new Date());
      mockUserRepo.unlockUser.mockResolvedValue([]);
      mockUserRepo.terminateSessions.mockResolvedValue({ count: 2 });

      await userService.unlock('1', 'TempPass@1', ctx);
      expect(mockUserRepo.terminateSessions).toHaveBeenCalledWith('1', 'account_unlocked', expect.anything());
    });
  });

  describe('resetPassword', () => {
    it('terminates the target user\'s active sessions (compromise response)', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: '1', username: 'u1', fullName: 'F', status: 'ENABLED' });
      mockHashPassword.mockResolvedValue('new-hash');
      mockUserRepo.getPasswordExpiresAt.mockResolvedValue(new Date());
      mockUserRepo.resetPassword.mockResolvedValue([]);
      mockUserRepo.terminateSessions.mockResolvedValue({ count: 1 });

      await userService.resetPassword('1', 'NewPass@1', ctx);
      expect(mockUserRepo.terminateSessions).toHaveBeenCalledWith('1', 'password_reset', expect.anything());
    });
  });

  // ── the hidden-roles rule is ONE list for the list and the stats (API-20) ──
  describe('hiddenRolesFor', () => {
    it('SUPER_ADMIN hides nothing; ADMIN hides SUPER_ADMIN; everyone else hides both', () => {
      expect(hiddenRolesFor('SUPER_ADMIN')).toEqual([]);
      expect(hiddenRolesFor('ADMIN')).toEqual(['SUPER_ADMIN']);
      expect(hiddenRolesFor('OPERATOR')).toEqual(['SUPER_ADMIN', 'ADMIN']);
      expect(hiddenRolesFor(undefined)).toEqual(['SUPER_ADMIN', 'ADMIN']);
    });

    it('getStats applies the same exclusion as list for a non-admin caller', async () => {
      mockUserRepo.countByStatus.mockResolvedValue({ total: 1 });
      await userService.getStats('OPERATOR');
      expect(mockUserRepo.countByStatus).toHaveBeenCalledWith({ role: { notIn: ['SUPER_ADMIN', 'ADMIN'] } });
    });
  });

  // ── processResetRequest ──
  describe('processResetRequest', () => {
    it('approves reset request', async () => {
      mockUserRepo.findResetRequestById.mockResolvedValue({ id: 'req-1', userId: 'admin', status: 'PENDING' });
      mockUserRepo.findById.mockResolvedValue({ id: 'user-1', username: 'admin' });
      mockHashPassword.mockResolvedValue('hash');
      mockUserRepo.getPasswordExpiresAt.mockResolvedValue(null);
      mockUserRepo.approveResetRequest.mockResolvedValue([]);

      const result = await userService.processResetRequest('req-1', 'approve', 'NewPass@1', undefined, ctx);
      expect(result.message).toContain('approved');
    });

    it('rejects reset request', async () => {
      mockUserRepo.findResetRequestById.mockResolvedValue({ id: 'req-1', userId: 'admin', status: 'PENDING' });
      mockUserRepo.findById.mockResolvedValue({ id: 'user-1', username: 'admin' });
      mockUserRepo.rejectResetRequest.mockResolvedValue({});

      const result = await userService.processResetRequest('req-1', 'reject', undefined, 'reason', ctx);
      expect(result.message).toContain('rejected');
    });

    it('throws for already processed request', async () => {
      mockUserRepo.findResetRequestById.mockResolvedValue({ id: 'req-1', status: 'APPROVED' });

      await expect(userService.processResetRequest('req-1', 'approve', 'pass', undefined, ctx))
        .rejects.toThrow('already been processed');
    });
  });

  // ── privilege boundary (audit C2 fix) ──
  // A non-SUPER_ADMIN caller must not be able to reset/unlock/disable a user
  // whose role is higher than theirs (the ADMIN -> SUPER_ADMIN takeover).
  describe('privilege boundary (audit C2)', () => {
    const adminCtx = { ...ctx, userRole: 'ADMIN' };
    const levels: Record<string, number> = { ADMIN: 5, SUPER_ADMIN: 6, OPERATOR: 2 };
    const byLevel = (name: string) => Promise.resolve({ name, hierarchyLevel: levels[name], isActive: true });

    beforeEach(() => {
      mockUserRepo.findRole.mockImplementation((n: string) => byLevel(n));
      mockHashPassword.mockResolvedValue('new-hash');
      mockUserRepo.getPasswordExpiresAt.mockResolvedValue(new Date());
      mockUserRepo.resetPassword.mockResolvedValue([]);
      mockUserRepo.unlockUser.mockResolvedValue([]);
      mockUserRepo.update.mockResolvedValue({ id: 'sa', username: 'superadmin' });
    });

    it('ADMIN cannot resetPassword a SUPER_ADMIN', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: 'sa', username: 'superadmin', fullName: 'SA', role: 'SUPER_ADMIN', status: 'ENABLED' });
      await expect(userService.resetPassword('sa', 'NewPass@1', adminCtx)).rejects.toThrow(/higher than yours/);
      expect(mockUserRepo.resetPassword).not.toHaveBeenCalled();
    });

    it('ADMIN cannot unlock a SUPER_ADMIN', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: 'sa', username: 'superadmin', fullName: 'SA', role: 'SUPER_ADMIN', status: 'LOCKED', failedLoginAttempts: 5 });
      await expect(userService.unlock('sa', 'NewPass@1', adminCtx)).rejects.toThrow(/higher than yours/);
      expect(mockUserRepo.unlockUser).not.toHaveBeenCalled();
    });

    it('ADMIN cannot disable a SUPER_ADMIN', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: 'sa', username: 'superadmin', fullName: 'SA', role: 'SUPER_ADMIN', status: 'ENABLED' });
      await expect(userService.disable('sa', adminCtx, 'takeover attempt')).rejects.toThrow(/higher than yours/);
      expect(mockUserRepo.update).not.toHaveBeenCalled();
    });

    it('ADMIN CAN resetPassword a lower-level user', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: 'op', username: 'op1', fullName: 'Op', role: 'OPERATOR', status: 'ENABLED' });
      await userService.resetPassword('op', 'NewPass@1', adminCtx);
      expect(mockUserRepo.resetPassword).toHaveBeenCalled();
    });

    // The C2 remediation missed processResetRequest — the reset-request approval
    // path also sets an attacker-chosen password on the target. A PENDING request
    // for a SUPER_ADMIN can be created via the public forgot-password flow, so an
    // ADMIN approving it would be a second ADMIN -> SUPER_ADMIN takeover door.
    it('ADMIN cannot approve a reset request for a SUPER_ADMIN', async () => {
      mockUserRepo.findResetRequestById.mockResolvedValue({ id: 'req-1', userId: 'sa', status: 'PENDING' });
      mockUserRepo.findById.mockResolvedValue({ id: 'sa', username: 'superadmin', role: 'SUPER_ADMIN' });
      await expect(userService.processResetRequest('req-1', 'approve', 'NewPass@1', undefined, adminCtx)).rejects.toThrow(/higher than yours/);
      expect(mockUserRepo.approveResetRequest).not.toHaveBeenCalled();
    });

    it('ADMIN cannot reject a reset request for a SUPER_ADMIN', async () => {
      mockUserRepo.findResetRequestById.mockResolvedValue({ id: 'req-1', userId: 'sa', status: 'PENDING' });
      mockUserRepo.findById.mockResolvedValue({ id: 'sa', username: 'superadmin', role: 'SUPER_ADMIN' });
      await expect(userService.processResetRequest('req-1', 'reject', undefined, 'no', adminCtx)).rejects.toThrow(/higher than yours/);
      expect(mockUserRepo.rejectResetRequest).not.toHaveBeenCalled();
    });

    it('ADMIN CAN approve a reset request for a lower-level user', async () => {
      mockUserRepo.findResetRequestById.mockResolvedValue({ id: 'req-1', userId: 'op', status: 'PENDING' });
      mockUserRepo.findById.mockResolvedValue({ id: 'op', username: 'op1', role: 'OPERATOR' });
      mockUserRepo.approveResetRequest.mockResolvedValue([]);
      await userService.processResetRequest('req-1', 'approve', 'NewPass@1', undefined, adminCtx);
      expect(mockUserRepo.approveResetRequest).toHaveBeenCalled();
    });
  });

  // ── password-policy parity on administrator-set credentials ──
  // create() has always called validatePasswordPolicy; unlock/resetPassword/
  // approve did not, so the configured complexity policy was silently bypassed
  // for every admin-set temporary password (the route's minLength 8 is a floor,
  // not the policy). These run the REAL validator against the test DB's policy
  // (minLength 8, all complexity flags on) rather than a mock, so they assert
  // enforcement and not merely that a function was called.
  describe('password policy on admin-set credentials', () => {
    // 8 chars, lowercase only: passes the route's minLength, fails the policy.
    const WEAK = 'weakpass';

    beforeEach(() => {
      mockUserRepo.findRole.mockResolvedValue({ name: 'OPERATOR', hierarchyLevel: 2, isActive: true });
      mockHashPassword.mockResolvedValue('new-hash');
      mockUserRepo.getPasswordExpiresAt.mockResolvedValue(new Date());
      mockUserRepo.unlockUser.mockResolvedValue([]);
      mockUserRepo.resetPassword.mockResolvedValue([]);
      mockUserRepo.approveResetRequest.mockResolvedValue([]);
    });

    it('unlock rejects a password that violates the policy', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: '1', username: 'u1', fullName: 'F', role: 'OPERATOR', status: 'LOCKED', failedLoginAttempts: 5 });
      await expect(userService.unlock('1', WEAK, ctx)).rejects.toThrow(/uppercase letter/);
      expect(mockUserRepo.unlockUser).not.toHaveBeenCalled();
    });

    it('resetPassword rejects a password that violates the policy', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: '1', username: 'u1', fullName: 'F', role: 'OPERATOR', status: 'ENABLED' });
      await expect(userService.resetPassword('1', WEAK, ctx)).rejects.toThrow(/uppercase letter/);
      expect(mockUserRepo.resetPassword).not.toHaveBeenCalled();
    });

    it('processResetRequest approve rejects a password that violates the policy', async () => {
      mockUserRepo.findResetRequestById.mockResolvedValue({ id: 'req-1', userId: 'user-1', status: 'PENDING' });
      mockUserRepo.findById.mockResolvedValue({ id: 'user-1', username: 'u1', role: 'OPERATOR' });
      await expect(userService.processResetRequest('req-1', 'approve', WEAK, undefined, ctx))
        .rejects.toThrow(/uppercase letter/);
      expect(mockUserRepo.approveResetRequest).not.toHaveBeenCalled();
    });

    it('resetPassword rejects a password containing the target User ID', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: '1', username: 'emp001', fullName: 'F', role: 'OPERATOR', status: 'ENABLED' });
      // Policy-complex but built around the username — the check the bare
      // minLength floor could never make.
      await expect(userService.resetPassword('1', 'Emp001@2026', ctx)).rejects.toThrow(/cannot contain User ID/);
      expect(mockUserRepo.resetPassword).not.toHaveBeenCalled();
    });

    it('still accepts a policy-compliant password', async () => {
      mockUserRepo.findByIdFull.mockResolvedValue({ id: '1', username: 'u1', fullName: 'F', role: 'OPERATOR', status: 'ENABLED' });
      await userService.resetPassword('1', 'NewPass@1', ctx);
      expect(mockUserRepo.resetPassword).toHaveBeenCalled();
    });
  });
});
